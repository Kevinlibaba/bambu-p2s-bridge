/**
 * 温度采样。
 *
 * 打印机每秒推一次状态，全存下来一天就是八万多个点，对「看一眼曲线」
 * 这个需求毫无意义。这里按固定间隔降采样，只保留一个环形缓冲，
 * 进程重启就没了 —— 温度曲线是用来看当下这一单的，不是长期档案。
 */
import type { PrinterState, Summary } from '../printer/state.js'

export interface TempSample {
  /** 毫秒时间戳 */
  t: number
  /** 喷嘴、热床、腔温。腔温取不到时为 null */
  n: number
  b: number
  c: number | null
  /** 打印进度，用来在曲线上对齐「打到哪了」 */
  p: number
}

export class Temps {
  private buf: TempSample[] = []
  private lastAt = 0

  constructor(
    private readonly state: PrinterState,
    /** 采样间隔（毫秒） */
    private readonly intervalMs = 10_000,
    /** 保留点数。10 秒一个点、1080 个点 = 3 小时 */
    private readonly max = 1080,
  ) {}

  start(): void {
    this.state.on('update', (s: Summary) => this.push(s))
  }

  private push(s: Summary): void {
    if (s.updatedAt === 0) return // 还没收到过 report
    const now = Date.now()
    if (now - this.lastAt < this.intervalMs) return
    this.lastAt = now
    this.buf.push({
      t: now,
      n: Math.round(s.nozzle.cur),
      b: Math.round(s.bed.cur),
      c: s.chamber === null ? null : Math.round(s.chamber),
      p: s.progress,
    })
    if (this.buf.length > this.max) this.buf.shift()
  }

  /** @param minutes 只要最近这些分钟的点，0 或缺省表示全部 */
  list(minutes = 0): TempSample[] {
    if (minutes <= 0) return this.buf
    const from = Date.now() - minutes * 60_000
    return this.buf.filter((x) => x.t >= from)
  }
}
