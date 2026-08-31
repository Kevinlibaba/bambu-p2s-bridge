/**
 * 远程启动打印。
 *
 * 这是整套 API 里唯一会让机器真的加热并运动的接口，所以校验放在服务端，
 * 不依赖客户端自觉：
 *   · 文件必须已经在 SD 卡上（不接受"边传边打"）
 *   · 必须是能解析的 3MF，且请求的盘确实存在
 *   · 打印机空闲时才受理，正在打印/暂停中一律拒绝
 *   · AMS 映射长度必须等于切片项目里定义的耗材数
 *
 * 关于 ams_mapping：它的下标是「切片项目里的耗材序号 - 1」，不是「这个盘
 * 用到的第几种耗材」。项目里定义了 4 种耗材、盘只用到第 4 种时，正确的
 * 映射是 [-1, -1, -1, slot]，长度 4。长度对不上时打印机会反复取映射表失败，
 * 报 07008012「多次获取 AMS 映射表失败」并暂停 —— 这是实测踩到的。
 * -1 表示该序号本盘不用，值为料盘全局序号（AMS 编号 * 4 + 槽位）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import * as ftp from '../printer/ftp.js'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState, AmsTray } from '../printer/state.js'
import { ZipFormatError, readCentralDirectory, withTail } from '../util/zip.js'
import { describeThreeMf } from '../printer/threemf.js'
import type { ThreeMfPlate, ThreeMfFilament } from '../printer/threemf.js'
import { preflight, blocking, type Check } from './preflight.js'

class PrintError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'PrintError'
  }
}

/** 这些状态下再下发打印指令，轻则被忽略，重则打断正在进行的打印 */
const BUSY_STATES = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'])

export interface PrintRequest {
  path: string
  plate?: number
  useAms?: boolean
  /** 完整映射数组，下标 = 耗材序号 - 1。给了就原样用，长度必须等于项目耗材数 */
  amsMapping?: number[]
  /** 只指定「哪号耗材用哪个料盘」，其余自动补 -1。比 amsMapping 好写 */
  slots?: Record<string, number>
  bedLeveling?: boolean
  flowCali?: boolean
  timelapse?: boolean
  /** 跳过自检里的阻断项。只有用户在界面上明确确认过才该带上 */
  force?: boolean
}

/** 料盘全局序号：AMS 编号 * 4 + 槽位，与固件 ams_mapping 的取值一致 */
const trayIndex = (unit: number, slot: number) => unit * 4 + slot
/** 外置料盘（vt_slot）。固件用 254 表示 */
const EXTERNAL_TRAY = 254

/**
 * 给某一号耗材挑一个料盘。优先级：
 *   1. tray_info_idx 完全一致 —— 同一款耗材，最稳
 *   2. 类型 + 颜色一致
 *   3. 仅类型一致
 * 都对不上就返回 null，交由调用方报错要求手动指定，而不是随便塞一个槽位。
 */
function autoMatch(want: ThreeMfFilament, trays: AmsTray[]): AmsTray | null {
  const usable = trays.filter((t) => !t.empty)
  const norm = (c: string) => c.replace(/^#/, '').slice(0, 6).toUpperCase()
  return (
    usable.find((t) => t.trayInfoIdx && t.trayInfoIdx === want.trayInfoIdx) ??
    usable.find((t) => t.type === want.type && norm(t.color) === norm(want.color)) ??
    usable.find((t) => t.type === want.type) ??
    null
  )
}

/**
 * 拼 ams_mapping。长度取项目耗材数，未被本盘使用的位置留 -1。
 * 客户端可以用 amsMapping 直接给整条，或用 slots 只点名用到的那几号。
 */
export function buildMapping(
  body: Partial<PrintRequest>,
  plate: ThreeMfPlate | undefined,
  trays: AmsTray[],
): number[] {
  if (body.amsMapping) {
    if (!Array.isArray(body.amsMapping) || body.amsMapping.some((n) => !Number.isInteger(n))) {
      throw new PrintError('AMS 映射必须是整数数组')
    }
    const want = plate?.filamentCount ?? 0
    if (want > 0 && body.amsMapping.length !== want) {
      throw new PrintError(
        `AMS 映射长度必须是 ${want}（切片项目里定义的耗材数），收到的是 ${body.amsMapping.length}`,
      )
    }
    return body.amsMapping
  }

  // 拿不到盘信息时不猜，交给客户端显式指定
  if (!plate || plate.filamentCount <= 0) {
    throw new PrintError('无法从文件里读出耗材信息，请显式指定 amsMapping')
  }

  const valid = new Set(trays.filter((t) => !t.empty).map((t) => trayIndex(t.unit, t.slot)))
  const mapping = new Array<number>(plate.filamentCount).fill(-1)

  for (const f of plate.filaments) {
    const id = f.id ?? 0
    if (id < 1 || id > mapping.length) {
      throw new PrintError(`文件里的耗材序号 ${id} 超出项目耗材数 ${mapping.length}`)
    }
    const asked = body.slots?.[String(id)]
    if (asked !== undefined) {
      if (!Number.isInteger(asked)) throw new PrintError(`耗材 ${id} 的料盘序号必须是整数`)
      if (asked !== EXTERNAL_TRAY && !valid.has(asked)) {
        throw new PrintError(`耗材 ${id} 指定的料盘 ${asked} 不存在或为空`)
      }
      mapping[id - 1] = asked
      continue
    }
    const hit = autoMatch(f, trays)
    if (!hit) {
      throw new PrintError(
        `AMS 里找不到与耗材 ${id}（${f.type} ${f.color}）匹配的料盘，请手动指定料盘`,
      )
    }
    mapping[id - 1] = trayIndex(hit.unit, hit.slot)
  }
  return mapping
}

export function registerPrintRoutes(
  app: FastifyInstance,
  mqtt: PrinterMqtt,
  state: PrinterState,
  backend: Pick<typeof ftp, 'stat' | 'readRange' | 'normalizePath'> = ftp,
): void {
  /** 校验路径、确认文件在卡上、定位到请求的那个盘。开打与预演共用。 */
  async function locate(rawPath: unknown, rawPlate: unknown) {
    let path: string
    try {
      path = backend.normalizePath(String(rawPath ?? ''))
    } catch {
      throw new PrintError('非法路径')
    }
    if (!path.toLowerCase().endsWith('.3mf')) throw new PrintError('只能打印 .3mf 文件')

    try {
      await backend.stat(path)
    } catch {
      throw new PrintError('文件不在打印机上', 404)
    }

    const plate = Number(rawPlate ?? 1)
    if (!Number.isInteger(plate) || plate < 1) throw new PrintError('盘号必须是正整数')

    let plateCount = 0
    let target: ThreeMfPlate | undefined
    try {
      const read = async (start: number, end: number) =>
        (await backend.readRange(path, { start, end })).data
      const tail = await backend.readRange(path, { suffix: 96 * 1024 })
      const src = withTail(tail.size, tail.start, tail.data, read)
      const entries = await readCentralDirectory(src)
      const info = await describeThreeMf(src, entries)
      plateCount = info.plates.length
      target = info.plates.find((p) => p.index === plate)
    } catch (e) {
      if (e instanceof ZipFormatError) throw new PrintError('文件不是有效的 3MF')
      throw e
    }
    if (plateCount > 0 && plate > plateCount) {
      throw new PrintError(`该文件只有 ${plateCount} 个盘，请求的是第 ${plate} 个`)
    }
    return { path, plate, plateCount, target }
  }

  /**
   * 配料预演。开打之前让界面知道每一号耗材会落到哪个料盘，
   * 也把「AMS 里没有能用的料」这类问题提前暴露出来，而不是等打印机暂停报错。
   */
  app.get('/api/print/plan', async (req, reply) => {
    try {
      const q = (req.query ?? {}) as { path?: string; plate?: string }
      const { path, plate, plateCount, target } = await locate(q.path, q.plate ?? 1)
      const trays = state.summary().ams

      let mapping: number[] | null = null
      let error: string | null = null
      try {
        mapping = buildMapping({}, target, trays)
      } catch (e) {
        error = (e as Error).message
      }

      const filaments = (target?.filaments ?? []).map((f) => {
        const slot = f.id && mapping ? mapping[f.id - 1] : -1
        const hit = trays.find((t) => trayIndex(t.unit, t.slot) === slot)
        return {
          id: f.id,
          type: f.type,
          color: f.color,
          trayInfoIdx: f.trayInfoIdx,
          usedG: f.usedG,
          usedM: f.usedM,
          slot: slot ?? -1,
          trayType: hit?.subBrand || hit?.type || '',
        }
      })

      return {
        path,
        plate,
        plateCount,
        filamentCount: target?.filamentCount ?? 0,
        filaments,
        mapping,
        error,
        checks: preflight(target, mapping, trays, state.summary()),
        trays: trays.map((t) => ({
          slot: trayIndex(t.unit, t.slot),
          unit: t.unit,
          index: t.slot,
          type: t.type,
          subBrand: t.subBrand,
          color: t.color,
          empty: t.empty,
        })),
      }
    } catch (e) {
      const err = e as PrintError
      return reply
        .code(err.name === 'PrintError' ? (err.status ?? 400) : 500)
        .send({ error: err.message })
    }
  })

  app.post('/api/print/start', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Partial<PrintRequest>

      const gcodeState = String(state.summary().state ?? '')
      if (BUSY_STATES.has(gcodeState)) {
        throw new PrintError(`打印机当前状态为 ${gcodeState}，无法开始新任务`, 409)
      }
      if (!mqtt.connected) throw new PrintError('打印机未连接', 503)

      const { path, plate, plateCount, target } = await locate(body.path, body.plate ?? 1)

      const trays = state.summary().ams
      const amsMapping = buildMapping(body, target, trays)
      const useAms = body.useAms !== false && amsMapping.some((v) => v >= 0 && v !== EXTERNAL_TRAY)

      // 自检不通过就不下发。远程开打没人在旁边，代价是几小时的空跑或废件，
      // 所以默认拦住；确实想强打的话得显式带 force。
      const checks = preflight(target, amsMapping, trays, state.summary())
      const stop = blocking(checks)
      if (stop.length && body.force !== true) {
        return reply.code(409).send({ error: '打印前自检未通过', checks: stop })
      }

      const name = path.slice(path.lastIndexOf('/') + 1)
      const sequenceId = mqtt.publish({
        print: {
          command: 'project_file',
          param: `Metadata/plate_${plate}.gcode`,
          // 局域网模式下三斜杠代表 SD 卡根目录
          url: `ftp:///${name}`,
          subtask_name: name.replace(/\.gcode\.3mf$|\.3mf$/i, ''),
          use_ams: useAms,
          ams_mapping: amsMapping,
          bed_type: 'auto',
          bed_leveling: body.bedLeveling !== false,
          flow_cali: body.flowCali !== false,
          vibration_cali: true,
          layer_inspect: false,
          timelapse: body.timelapse === true,
          profile_id: '0',
          project_id: '0',
          subtask_id: '0',
          task_id: '0',
        },
      })

      return { ok: true, sequenceId, path, plate, plateCount, useAms, amsMapping, checks }
    } catch (e) {
      const err = e as PrintError
      return reply
        .code(err.name === 'PrintError' ? (err.status ?? 400) : 500)
        .send({ error: err.message })
    }
  })
}

export type { FastifyReply }
