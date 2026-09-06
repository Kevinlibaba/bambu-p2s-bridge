/**
 * 定时开打：到点了替用户按一下「开始打印」。
 *
 * 就一个预约，不做队列 —— 队列是另一件事，它需要先解决「上一件真的离开热床了」
 * 这个问题。这里只管时间。
 *
 * 到点时走的是和手动开打完全相同的路径：同样的自检、同样的 AMS 配料、不带
 * force。自检拦下了就推一条「定时打印未能开始」并作废 —— 半夜没人守着，
 * 硬开比不开危险。
 *
 * 落盘：桥接重启（部署）不该把预约丢掉。
 */
import { readFile, writeFile, unlink } from 'node:fs/promises'
import type { NotifyEvent } from '../notify/events.js'

export interface ScheduledPrint {
  /** 触发时刻（毫秒时间戳） */
  at: number
  /** 原样交给开打逻辑的请求体 */
  body: Record<string, unknown>
  /** 展示用 */
  name: string
  createdAt: number
}

export interface ScheduleStatus {
  pending: ScheduledPrint | null
  last: { at: number; name: string; ok: boolean; error: string | null } | null
}

export interface ScheduleDeps {
  notify: (e: NotifyEvent) => Promise<void>
  now?: () => number
}

/** 最早只能定到一分钟之后，最晚一周 —— 再远就不是「定时」而是「忘了」 */
const MIN_AHEAD_MS = 60_000
const MAX_AHEAD_MS = 7 * 86_400_000
const TICK_MS = 15_000

export class ScheduleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'ScheduleError'
  }
}

type Starter = (body: Record<string, unknown>) => Promise<unknown>

export class PrintSchedule {
  private pending: ScheduledPrint | null = null
  private last: ScheduleStatus['last'] = null
  private starter: Starter | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private firing = false

  constructor(private readonly path: string, private readonly deps: ScheduleDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** 开打逻辑在路由模块里，服务器建好之后再接上 */
  attach(starter: Starter): void {
    this.starter = starter
  }

  async start(): Promise<void> {
    try {
      const p = JSON.parse(await readFile(this.path, 'utf8')) as ScheduledPrint
      if (p && typeof p.at === 'number') this.pending = p
    } catch {
      /* 没有预约 */
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  status(): ScheduleStatus {
    return { pending: this.pending, last: this.last }
  }

  async set(at: number, body: Record<string, unknown>, name: string): Promise<ScheduleStatus> {
    if (!Number.isFinite(at)) throw new ScheduleError('时间不合法')
    const ahead = at - this.now()
    if (ahead < MIN_AHEAD_MS) throw new ScheduleError('至少要定到一分钟之后')
    if (ahead > MAX_AHEAD_MS) throw new ScheduleError('最多只能定到一周之内')
    this.pending = { at, body, name, createdAt: this.now() }
    await writeFile(this.path, JSON.stringify(this.pending), 'utf8')
    return this.status()
  }

  async cancel(): Promise<ScheduleStatus> {
    this.pending = null
    await unlink(this.path).catch(() => {})
    return this.status()
  }

  /** 到点就开。公开是为了测试能直接触发，不用等定时器 */
  async tick(): Promise<void> {
    if (!this.pending || this.firing || !this.starter) return
    if (this.now() < this.pending.at) return
    this.firing = true
    const job = this.pending
    try {
      await this.starter(job.body)
      this.last = { at: this.now(), name: job.name, ok: true, error: null }
    } catch (e) {
      const msg = (e as Error).message
      this.last = { at: this.now(), name: job.name, ok: false, error: msg }
      await this.deps.notify({
        kind: 'scheduleFailed',
        key: `sched:${job.name}:${job.at}`,
        title: '定时打印未能开始',
        body: `${job.name}\n${msg}`,
      }).catch(() => {})
    } finally {
      // 不管成败都作废：成功了不该再开一次，失败了也不该每 15 秒重试一次
      this.pending = null
      await unlink(this.path).catch(() => {})
      this.firing = false
    }
  }
}
