/**
 * 通知器：把状态跃迁变成推送。
 *
 * 噪声控制是这里的主要工作：
 *   · 只在跃迁时触发，不做轮询式播报
 *   · 同一个 key 在冷却期内只响一次（打印机报错时会连续重复上报同一码）
 *   · 错误类事件顺手查一次官方释义，让通知直接可读，而不是甩一串十六进制
 */
import { config } from '../config.js'
import type { PrinterState, Summary } from '../printer/state.js'
import { describe, toErrorLang } from '../printer/errors.js'
import { detect, NOTIFY_KINDS, type NotifyEvent, type NotifyKind } from './events.js'
import { configuredSinks, deliver } from './sinks.js'
import { PushStore } from './store.js'

/** 同一件事的冷却时间。打印机报错时会每秒重复上报同一个码 */
const COOLDOWN_MS = 10 * 60 * 1000
/** 最近推送的留存条数，供界面回看 */
const HISTORY_MAX = 50

export interface NotifyRecord extends NotifyEvent {
  at: number
  results: { name: string; ok: boolean; detail?: string }[]
}

export class Notifier {
  readonly store: PushStore
  private prev: Summary | null = null
  private lastAt = new Map<string, number>()
  private history: NotifyRecord[] = []

  constructor(private readonly state: PrinterState) {
    this.store = new PushStore(config.notify.storePath)
  }

  async start(): Promise<void> {
    await this.store.load()
    this.state.on('update', (s: Summary) => {
      void this.onUpdate(s)
    })
  }

  private enabled(kind: NotifyKind): boolean {
    if (!config.notify.enabled) return false
    const want = config.notify.events
    return want.includes('all') || want.includes(kind)
  }

  private async onUpdate(next: Summary): Promise<void> {
    const prev = this.prev
    this.prev = next
    let events: NotifyEvent[]
    try {
      events = detect(prev, next)
    } catch (e) {
      console.error('[notify] 事件识别失败', e)
      return
    }
    for (const e of events) {
      if (!this.enabled(e.kind)) continue
      const last = this.lastAt.get(e.key) ?? 0
      if (Date.now() - last < COOLDOWN_MS) continue
      this.lastAt.set(e.key, Date.now())
      await this.send(e)
    }
  }

  /** 把错误码换成人话。查不到就保留原样，不要因为外网不通就不推送。 */
  private async humanize(e: NotifyEvent): Promise<NotifyEvent> {
    if (!e.code) return e
    const text = await describe(e.code, toErrorLang(config.notify.lang))
    return text ? { ...e, body: e.body ? `${e.body}\n${text}` : text } : e
  }

  async send(raw: NotifyEvent): Promise<NotifyRecord> {
    const e = await this.humanize(raw)
    let results: NotifyRecord['results'] = []
    try {
      results = await deliver(e, this.store)
    } catch (err) {
      console.error('[notify] 投递失败', err)
    }
    const rec: NotifyRecord = { ...e, at: Date.now(), results }
    this.history.unshift(rec)
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX
    const ok = results.filter((r) => r.ok).map((r) => r.name)
    console.log(`[notify] ${e.kind} ${e.title} → ${ok.length ? ok.join(',') : '无出口'}`)
    return rec
  }

  status() {
    return {
      enabled: config.notify.enabled,
      events: config.notify.events.includes('all') ? NOTIFY_KINDS : config.notify.events,
      kinds: NOTIFY_KINDS,
      sinks: configuredSinks(this.store),
      vapidPublicKey: config.notify.vapid.publicKey || null,
      recent: this.history.slice(0, 20),
    }
  }
}
