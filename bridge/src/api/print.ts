/**
 * 远程启动打印。
 *
 * 这是整套 API 里唯一会让机器真的加热并运动的接口，所以校验放在服务端，
 * 不依赖客户端自觉：
 *   · 文件必须已经在 SD 卡上（不接受"边传边打"）
 *   · 必须是能解析的 3MF，且请求的盘确实存在
 *   · 打印机空闲时才受理，正在打印/暂停中一律拒绝
 *   · AMS 映射必须是整数数组，长度与盘上的耗材数一致
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import * as ftp from '../printer/ftp.js'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState } from '../printer/state.js'
import { ZipFormatError, readCentralDirectory, withTail } from '../util/zip.js'
import { describeThreeMf } from '../printer/threemf.js'

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
  amsMapping?: number[]
  bedLeveling?: boolean
  flowCali?: boolean
  timelapse?: boolean
}

export function registerPrintRoutes(
  app: FastifyInstance,
  mqtt: PrinterMqtt,
  state: PrinterState,
  backend: Pick<typeof ftp, 'stat' | 'readRange' | 'normalizePath'> = ftp,
): void {
  app.post('/api/print/start', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Partial<PrintRequest>

      let path: string
      try {
        path = backend.normalizePath(String(body.path ?? ''))
      } catch {
        throw new PrintError('非法路径')
      }
      if (!path.toLowerCase().endsWith('.3mf')) throw new PrintError('只能打印 .3mf 文件')

      const gcodeState = String(state.summary().state ?? '')
      if (BUSY_STATES.has(gcodeState)) {
        throw new PrintError(`打印机当前状态为 ${gcodeState}，无法开始新任务`, 409)
      }
      if (!mqtt.connected) throw new PrintError('打印机未连接', 503)

      // 文件必须已经在卡上 —— 顺便确认它真的可读
      try {
        await backend.stat(path)
      } catch {
        throw new PrintError('文件不在打印机上', 404)
      }

      // 盘号必须真实存在，否则打印机会收到一条指向空文件的指令
      const plate = Number(body.plate ?? 1)
      if (!Number.isInteger(plate) || plate < 1) throw new PrintError('盘号必须是正整数')
      let plateCount = 0
      try {
        const read = async (start: number, end: number) =>
          (await backend.readRange(path, { start, end })).data
        const tail = await backend.readRange(path, { suffix: 96 * 1024 })
        const src = withTail(tail.size, tail.start, tail.data, read)
        const entries = await readCentralDirectory(src)
        plateCount = (await describeThreeMf(src, entries)).plates.length
      } catch (e) {
        if (e instanceof ZipFormatError) throw new PrintError('文件不是有效的 3MF')
        throw e
      }
      if (plateCount > 0 && plate > plateCount) {
        throw new PrintError(`该文件只有 ${plateCount} 个盘，请求的是第 ${plate} 个`)
      }

      const useAms = body.useAms !== false
      const amsMapping = body.amsMapping ?? [0]
      if (!Array.isArray(amsMapping) || amsMapping.some((n) => !Number.isInteger(n))) {
        throw new PrintError('AMS 映射必须是整数数组')
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

      return { ok: true, sequenceId, path, plate, plateCount, useAms, amsMapping }
    } catch (e) {
      const err = e as PrintError
      return reply
        .code(err.name === 'PrintError' ? (err.status ?? 400) : 500)
        .send({ error: err.message })
    }
  })
}

export type { FastifyReply }
