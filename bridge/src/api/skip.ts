/**
 * 打印中跳过零件。协议与取舍见 PROTOCOL.md §2.6 和 skip/objects.ts 顶部。
 *
 * 和收菜一样单独开接口，不走原始 G-code / 原始命令通道：这个动作不可逆
 * （被跳过的件永远不会再打），前置条件必须由服务端强制，护栏在 planSkip 里。
 *
 * 【已实现、未真机验证】—— 验证要牺牲一个真实零件。
 */
import type { FastifyInstance } from 'fastify'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState } from '../printer/state.js'
import { resolveJobFile } from '../history/resolve.js'
import { rootListing } from '../history/enrich.js'
import {
  planSkip, plateOfFile, readSkipSource, skipCommand, SkipError, type SkipSource,
} from '../skip/objects.js'

/**
 * 当前正在打的是哪个文件的哪一盘。
 *
 * 打印机只报 subtask_name（文件名去掉扩展名、下划线换成空格）和
 * gcode_file（…/Metadata/plate_N.gcode），文件本身要回根目录里按归一化的
 * 名字找 —— 与收菜、历史用的是同一套查找，见 history/resolve.ts。
 */
async function resolveCurrent(state: PrinterState): Promise<{ path: string; plate: number }> {
  const s = state.summary()
  if (!s.taskName) throw new SkipError('打印机没有上报当前任务名', 409)
  const plate = plateOfFile(s.file)
  if (plate === null) throw new SkipError(`从 gcode 路径里解不出盘号（${s.file || '空'}）`, 409)
  const path = resolveJobFile(s.taskName, await rootListing())
  if (!path) throw new SkipError(`在打印机上找不到「${s.taskName}」对应的模型文件`, 404)
  return { path, plate }
}

/** 只有打印中和暂停时清单才有意义；空闲时 subtask_name 是上一单的，列出来会误导 */
const ACTIVE = new Set(['RUNNING', 'PAUSE'])

export function registerSkipRoutes(
  app: FastifyInstance,
  state: PrinterState,
  mqtt: PrinterMqtt,
): void {
  const load = async (): Promise<{ path: string; plate: number; source: SkipSource }> => {
    const cur = await resolveCurrent(state)
    return { ...cur, source: await readSkipSource(cur.path, cur.plate) }
  }

  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (e instanceof SkipError) return reply.code(e.status).send({ error: e.message })
    return reply.code(500).send({ error: (e as Error).message })
  }

  /** 当前这一单的零件清单，已跳过的按 s_obj 标出 */
  app.get('/api/print/objects', async (_req, reply) => {
    try {
      const s = state.summary()
      if (!ACTIVE.has(s.state)) throw new SkipError(`没有正在进行的打印（当前 ${s.state}）`, 409)
      const { path, plate, source } = await load()
      const skipped = new Set(s.skippedObjects)
      return {
        path,
        plate,
        supported: s.skipSupported,
        labelObjectEnabled: source.labelObjectEnabled,
        objects: source.objects.map((o) => ({ ...o, skipped: skipped.has(o.id) })),
      }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post('/api/print/skip', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { ids?: unknown }
      const { path, plate, source } = await load()
      /*
       * 状态在读完文件之后再取一次：读 FTP 要几百毫秒，这期间打印
       * 可能刚好结束。护栏看的必须是下发前一刻的状态。
       */
      const s = state.summary()
      const ids = planSkip({
        state: s.state,
        connected: mqtt.connected,
        supported: s.skipSupported,
        source,
        skipped: s.skippedObjects,
        ids: body.ids,
      })
      const sequenceId = mqtt.publish(skipCommand(ids))
      return { sent: true, sequenceId, path, plate, ids, alreadySkipped: s.skippedObjects }
    } catch (e) {
      return fail(reply, e)
    }
  })
}
