/**
 * 事件流水。
 *
 * events.ts 一直在识别暂停、恢复、报错、离线这些事件，但识别完推送出去
 * 就扔了。存下来之后，历史里的一单才从「看一眼」变成「能查案」——
 * 配上温度曲线，能看出 16:02 暂停的那一刻喷嘴温度是不是同时掉了。
 * 单看曲线或单看事件都推不出因果，叠在一起才行。
 *
 * 量很小（一单几条），所以来一条写一条，不像温度那样攒批。
 * 同样按天分文件：查某一单只读它横跨的那一两天，清理只是删文件。
 */
import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dayKey, daysBetween } from './temps.js'
import type { NotifyEvent } from '../notify/events.js'

export interface LoggedEvent {
  /** 毫秒时间戳 */
  t: number
  /** 事件类型。前端按它出文案 —— 桥接里的中文标题不该决定界面语言 */
  kind: string
  /** 错误类事件带错误码 */
  code?: string
  /** 桥接侧的原文，仅作排查用，界面不直接展示 */
  title: string
}

export class EventLog {
  /** key → 上次记录时间，用于短窗去重 */
  private lastAt = new Map<string, number>()

  constructor(
    private readonly dir: string | null,
    private readonly keepDays = 60,
    /**
     * 同一个 key 在这个窗口内只记一次。
     *
     * detect 基本是按状态跃迁走的，本不会重复；但 prev 尚未就绪且打印机
     * 离线时那个分支会每次 update 都吐一条 offline。窗口取得很短，
     * 真正间隔几分钟的第二次暂停仍然会各记一条。
     */
    private readonly dedupeMs = 60_000,
  ) {}

  async start(): Promise<void> {
    if (!this.dir) return
    await mkdir(this.dir, { recursive: true, mode: 0o700 }).catch(() => {})
    await this.prune()
  }

  /**
   * 记一条。
   *
   * 不受推送开关和冷却时间影响 —— 那些是「要不要打扰你」的策略，
   * 和「这一单到底发生过什么」是两回事。用户把某类推送关掉，不代表
   * 事后不想在时间轴上看到它发生过。
   *
   * 只有一道极短的同 key 去重（见 dedupeMs），防的是同一件事被反复吐出来，
   * 不是防重复通知。
   */
  async append(e: NotifyEvent, at = Date.now()): Promise<void> {
    if (!this.dir) return
    const last = this.lastAt.get(e.key) ?? 0
    if (at - last < this.dedupeMs) return
    this.lastAt.set(e.key, at)
    const rec: LoggedEvent = { t: at, kind: e.kind, title: e.title }
    if (e.code) rec.code = e.code
    await appendFile(join(this.dir, `${dayKey(at)}.jsonl`), JSON.stringify(rec) + '\n',
      { mode: 0o600 }).catch((err) => console.error('[events] 落盘失败:', err))
  }

  /** 取某一单期间发生的事件 */
  async range(from: number, to: number): Promise<LoggedEvent[]> {
    if (!this.dir || !(to > from)) return []
    const out: LoggedEvent[] = []
    for (const day of daysBetween(from, to)) {
      const text = await readFile(join(this.dir, `${day}.jsonl`), 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as LoggedEvent
          if (e.t >= from && e.t <= to) out.push(e)
        } catch {
          // 断电留下的半行，跳过
        }
      }
    }
    return out.sort((a, b) => a.t - b.t)
  }

  private async prune(): Promise<void> {
    if (!this.dir) return
    const cutoff = dayKey(Date.now() - this.keepDays * 86_400_000)
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
      if (m && m[1] < cutoff) await unlink(join(this.dir, f)).catch(() => {})
    }
  }
}
