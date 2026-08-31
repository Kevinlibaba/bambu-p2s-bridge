/**
 * 打印机错误的查看与清除。
 *
 * 两类错误来源不同，处理方式也不同：
 *
 *   · print_error —— 当前这一个错误，是弹窗那种「需要你确认」的。
 *     清除命令取自 BambuStudio 的 command_clean_print_error_uiop：
 *     走 system.uiop 通道把对应的 dialog 关掉。真机验证过，
 *     发完 print_error 立即归零。
 *
 *   · hms[] —— 健康管理条目，反映的是当前仍然成立的状态
 *     （比如某个槽位的 RFID 读不出来）。BambuStudio 里也没有任何
 *     清除 HMS 的 MQTT 命令，条件消失时打印机自己会撤下来，
 *     所以这里只读不写。
 */
import type { FastifyInstance } from 'fastify'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState } from '../printer/state.js'
import { describe, hmsCode, printErrorCode, toErrorLang, wikiUrl } from '../printer/errors.js'

export interface PrinterErrorItem {
  /** 'print' 可清除，'hms' 只能等条件消失 */
  kind: 'print' | 'hms'
  /** 十六进制码，print 为 8 位、hms 为 16 位 */
  code: string
  /** 官方错误库的中文/英文说明；外网不通或库里没有时为 null */
  text: string | null
  /** 官方错误页，前端可以直接开浏览器 */
  url: string
}

export function registerErrorRoutes(
  app: FastifyInstance,
  mqtt: PrinterMqtt,
  state: PrinterState,
): void {
  app.get('/api/errors', async (req) => {
    const lang = toErrorLang((req.query as { lang?: string } | undefined)?.lang)
    const s = state.summary()

    const codes: { kind: 'print' | 'hms'; code: string }[] = []
    if (s.printError) codes.push({ kind: 'print', code: printErrorCode(s.printError) })
    for (const e of s.errors ?? []) {
      const attr = Number((e as { attr?: unknown }).attr)
      const code = Number((e as { code?: unknown }).code)
      if (Number.isFinite(attr) && Number.isFinite(code)) {
        codes.push({ kind: 'hms', code: hmsCode(attr, code) })
      }
    }

    // 逐条查文案，外网慢也不至于串行叠加
    const items: PrinterErrorItem[] = await Promise.all(
      codes.map(async ({ kind, code }) => ({
        kind,
        code,
        text: await describe(code, lang),
        url: wikiUrl(code, lang),
      })),
    )
    return { items, clearable: !!s.printError, state: s.state }
  })

  app.post('/api/errors/clear', async (req, reply) => {
    if (!mqtt.connected) return reply.code(503).send({ error: '打印机未连接' })
    const s = state.summary()
    // 不带 code 时清当前那条；带了就清指定的那条（BambuStudio 也是带码清除的）
    const asked = (req.body as { code?: string } | undefined)?.code
    if (asked !== undefined && !/^[0-9a-fA-F]{8}$/.test(asked)) {
      return reply.code(400).send({ error: '错误码必须是 8 位十六进制' })
    }
    if (!asked && !s.printError) {
      // HMS 条目不是这里能清的，明确告诉前端，别让按钮装作有用
      return { ok: true, cleared: 0, note: 'no-print-error' }
    }
    const err = asked ? asked.toUpperCase() : printErrorCode(s.printError)
    const sequenceId = mqtt.publish({
      system: {
        command: 'uiop',
        name: 'print_error',
        action: 'close',
        source: 1, // 0-Mushu 1-Studio
        type: 'dialog',
        err,
      },
    })
    return { ok: true, cleared: 1, code: err, sequenceId }
  })
}
