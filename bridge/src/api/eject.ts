/**
 * 推件：把打完的件用打印头推下热床。
 *
 * 单独开一个接口，而不是让调用方走原始 G-code 通道。原因有两个：
 *  · 原始 G-code 等于把任意指令权限交给持有 token 的人，为了一个具体
 *    功能去打开它不划算；
 *  · 这个动作有真实机械风险，前置条件必须由服务端强制，不能指望调用方
 *    自觉。轨迹可以商量，护栏不行。
 *
 * 强制的前置条件：
 *  · 打印机必须空闲。打印中推件等于直接撞进正在打的件里。
 *  · 有未清除的报错时不动。状态不明的时候让机器动起来是最坏的选择。
 *  · 必须显式 confirm。默认只回 G-code 不下发。
 *
 * 冷却那一步默认开着。PEI 板在热的时候附着力极强，不冷到 ~25℃ 根本推不动，
 * 硬推只会把力全顶在热端上。允许关掉，但仅用于「床上没有任何东西」的
 * 空跑验证 —— 那时没有件可粘，也就没有可顶坏的东西。
 */
import type { FastifyInstance } from 'fastify'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState } from '../printer/state.js'
import { planEject, type EjectOptions, type PlateObject } from '../eject/plan.js'
import { readEjectSource, EjectSourceError, type EjectSource } from '../eject/source.js'
import { resolveJobFile } from '../history/resolve.js'
import * as ftp from '../printer/ftp.js'
import type { History } from '../history/index.js'

class EjectError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'EjectError'
  }
}

/** 这些状态下机器正在动，绝对不能插进去 */
const BUSY = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'])

export interface EjectRequest {
  /**
   * 打印机上的 3mf 路径与盘号。给了就由服务端自己解出轮廓、最高点和 brim ——
   * App 不该知道 bbox 是什么。不给就退回「最近打完的那一单」。
   */
  path?: string
  plate?: number
  /** 直接给轮廓。调试用；正常路径走 path/plate */
  objects?: PlateObject[]
  /** 整盘最高点，取自 gcode 头部的 max_z_height */
  maxZ?: number
  mode?: EjectOptions['mode']
  pushZ?: number
  bedTarget?: number
  /** 切片时的 brim 宽度（mm）。大于 0 会告警：brim 是推不下去的主因 */
  brimWidth?: number
  /**
   * 是否等热床冷却。默认 true。
   * 只有在床上确实空无一物、纯粹验证运动路径时才允许关。
   */
  cool?: boolean
  /** 不显式确认就只回 G-code，不下发 */
  confirm?: boolean
  /**
   * 只发回零那一段就停。
   *
   * 用来在真正动 Z 之前先确认 X/Y 确实归零了。机器自己的启动 G-code
   * 是「G28 X 之后直接 G1 X128 Y128」，看上去 G28 X 会把 Y 也带上，
   * 但那是推断不是实证。万一 Y 没归零而固件又接受了移动，Z 探测就会
   * 落到计划外的位置 —— 件正好在那儿的话就是撞机。分两步走，中间查
   * home_flag，比赌一把便宜得多。
   */
  homeOnly?: boolean
  /**
   * 只下发降温那几行，不做任何运动。
   *
   * 自然散热从 55℃ 到环境温度要二十分钟以上；三个风扇全开快得多。
   * 但**不能在打印过程中用** —— 中途猛吹会影响层间粘接和翘边，
   * 所以调用方必须自己确保打印已经结束。
   */
  coolOnly?: boolean
}

const BED = { width: 256, depth: 256 }

/**
 * 决定要推哪一盘。
 *
 * 优先级：显式 objects（调试）→ 显式 path/plate → 最近打完的那一单。
 * 最后这条是 App 走的路径：用户只知道「刚打完的东西还在板上」。
 */
async function resolveSource(
  body: EjectRequest,
  history: History,
): Promise<EjectSource & { path: string | null; plate: number | null }> {
  if (Array.isArray(body.objects) && body.objects.length > 0) {
    for (const o of body.objects) {
      if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || o.bbox.some((n) => !Number.isFinite(n)))
        throw new EjectError('bbox 必须是四个数：[xmin, ymin, xmax, ymax]')
    }
    const maxZ = Number(body.maxZ)
    if (!Number.isFinite(maxZ) || maxZ <= 0) throw new EjectError('maxZ 必须是正数')
    return { objects: body.objects, maxZ, brimWidth: body.brimWidth ?? 0, path: null, plate: null }
  }

  let path = body.path
  let plate = body.plate
  if (!path) {
    const last = history.list(1)[0]
    if (!last) throw new EjectError('还没有打印记录，不知道要推什么', 409)
    const file = await resolveLastFile(last.name)
    if (!file) throw new EjectError(`在打印机上找不到「${last.name}」对应的模型文件`, 404)
    path = file
    plate = plate ?? last.plate ?? 1
  }
  const src = await readEjectSource(path, plate ?? 1)
  return { ...src, path, plate: plate ?? 1 }
}

/** 按归一化后的名字在打印机根目录里找回源文件 —— taskName 把下划线换成了空格 */
async function resolveLastFile(name: string): Promise<string | null> {
  const root = await ftp.listDir('/')
  return resolveJobFile(name, root.map((f) => ({ name: f.name, isDirectory: f.isDirectory })))
}

export function registerEjectRoutes(
  app: FastifyInstance,
  state: PrinterState,
  mqtt: PrinterMqtt,
  history: History,
): void {
  app.post('/api/eject', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as EjectRequest
      const src = await resolveSource(body, history)
      const { objects, maxZ } = src
      const brimWidth = body.brimWidth ?? src.brimWidth

      const plan = planEject(objects, { bed: BED, maxZ }, {
        mode: body.mode ?? 'standalone',
        ...(Number.isFinite(body.pushZ as number) ? { pushZ: Number(body.pushZ) } : {}),
        ...(Number.isFinite(body.bedTarget as number) ? { bedTarget: Number(body.bedTarget) } : {}),
        brimWidth,
      })

      // 冷却是安全措施，去掉它要显式说，并且只在空跑时有意义
      const cool = body.cool !== false
      /*
       * 「关风扇」永远保留。
       *
       * cool:false 时把降温整段滤掉是对的，但关风扇不属于降温 —— 它属于
       * 收尾。滤掉的话，先用 coolOnly 吹上的风就再也没人关了。
       */
      const isFanOff = (l: string) => /^M106 P(2|3|10) S0\b/.test(l)
      const isCoolingOn = (l: string) => !isFanOff(l) && /^M(190\b|140\b|106 P(2|3|10)\b)/.test(l)
      let gcode = cool ? plan.gcode : plan.gcode.filter((l) => !isCoolingOn(l))

      if (body.coolOnly) {
        /*
         * 只吹风，不动任何轴，**也不带 M190 等待**。
         *
         * M190 的 R/S 语义还没验证过；万一它不按预期返回，就会把打印机的
         * 指令队列一直卡着。等温度这件事交给调用方自己盯 bed_temper，
         * 比赌固件行为可靠。
         */
        if (!cool) throw new EjectError('coolOnly 与 cool:false 矛盾')
        gcode = plan.gcode.filter((l) => isCoolingOn(l) && !/^M190\b/.test(l))
      }

      if (body.homeOnly) {
        /*
         * 停在 G28 Z **之前**。
         *
         * 这一步存在的全部意义就是：在探 Z 之前先确认 X/Y 真的归零了、
         * 打印头真的停在了避开件的位置。把 G28 Z 也发出去就等于白检查了。
         */
        const end = gcode.findIndex((l) => l.startsWith('G28 Z'))
        if (end < 0) throw new EjectError('这个模式下没有回零步骤，homeOnly 无意义')
        gcode = gcode.slice(0, end)
      }

      if (plan.order.length === 0) {
        return reply.code(409).send({ error: '没有可推的件', warnings: plan.warnings })
      }

      /*
       * 只回数据，不回拼好的中文 —— 「第 N 盘」这种话由前端按当前语言出，
       * 桥接不该决定界面语言。
       */
      const info = {
        path: src.path,
        plate: src.plate,
        bedTemp: state.summary().bed.cur,
        objectCount: objects.length,
        maxZ,
        brimWidth,
      }

      if (!body.confirm) {
        return { dryRun: true, cool, ...info, order: plan.order, warnings: plan.warnings, gcode }
      }

      const s = state.summary()
      if (!mqtt.connected) throw new EjectError('打印机未连接', 503)
      if (BUSY.has(s.state)) throw new EjectError(`打印机正忙（${s.state}），不能推件`, 409)
      if (s.printError) throw new EjectError('打印机有未清除的报错，先处理再推件', 409)

      const sequenceId = mqtt.publish({
        print: { command: 'gcode_line', param: gcode.join('\n') + '\n' },
      })
      return { sent: true, sequenceId, cool, ...info, order: plan.order, warnings: plan.warnings, gcode }
    } catch (e) {
      if (e instanceof EjectError) return reply.code(e.status).send({ error: e.message })
      if (e instanceof EjectSourceError) return reply.code(e.status).send({ error: e.message })
      return reply.code(500).send({ error: (e as Error).message })
    }
  })
}
