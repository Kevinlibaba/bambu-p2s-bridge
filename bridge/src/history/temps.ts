/**
 * 温度采样。
 *
 * 打印机每秒推一次状态，全存下来一天就是八万多个点，对「看一眼曲线」
 * 这个需求毫无意义。这里按固定间隔降采样。
 *
 * 内存里留一个环形缓冲供实时查看；同时按天落盘，这样历史里的某一单
 * 结束很久之后仍然能把它那段曲线翻出来 —— 环形缓冲只有三小时，
 * 六小时的活打到一半前半段就被挤掉了，进程一重启更是全没。
 *
 * 按天分文件是为了两件事都便宜：查某一单只需要读它横跨的那一两天，
 * 清理过期数据只是删文件。落盘是攒着写的，别让 SD 卡上的部署每十秒
 * 挨一次写入。
 */
import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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

/** 用 UTC 切天。本地时区会因为夏令时出现 23/25 小时的天，没必要给自己找麻烦 */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** 一个时间区间横跨了哪几天。上限防止一个坏参数把整个目录读一遍 */
export function daysBetween(from: number, to: number, max = 32): string[] {
  const out: string[] = []
  const DAY = 86_400_000
  // 从 from 所在那天的零点起步，避免 from 落在当天中间时漏掉这一天
  let cur = Date.parse(dayKey(from) + 'T00:00:00.000Z')
  while (cur <= to && out.length < max) {
    out.push(dayKey(cur))
    cur += DAY
  }
  return out
}

export class Temps {
  private buf: TempSample[] = []
  private lastAt = 0
  /** 还没落盘的采样 */
  private pending: TempSample[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: PrinterState,
    /** 采样间隔（毫秒） */
    private readonly intervalMs = 10_000,
    /** 内存保留点数。10 秒一个点、1080 个点 = 3 小时 */
    private readonly max = 1080,
    /** 落盘目录。为空表示不落盘（测试用） */
    private readonly dir: string | null = null,
    /** 攒够这么多点写一次 */
    private readonly batch = 6,
    /** 落盘保留天数 */
    private readonly keepDays = 60,
  ) {}

  async start(): Promise<void> {
    if (this.dir) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 }).catch(() => {})
      // 重启后曲线不该是空的：把最近的点读回内存
      await this.warm()
      await this.prune()
    }
    this.state.on('update', (s: Summary) => this.push(s))
  }

  private push(s: Summary): void {
    if (s.updatedAt === 0) return // 还没收到过 report
    const now = Date.now()
    if (now - this.lastAt < this.intervalMs) return
    this.lastAt = now
    const sample: TempSample = {
      t: now,
      n: Math.round(s.nozzle.cur),
      b: Math.round(s.bed.cur),
      c: s.chamber === null ? null : Math.round(s.chamber),
      p: s.progress,
    }
    this.buf.push(sample)
    if (this.buf.length > this.max) this.buf.shift()

    if (!this.dir) return
    this.pending.push(sample)
    if (this.pending.length >= this.batch) void this.flush()
  }

  /**
   * 把攒着的点写下去。
   *
   * 串在一条 promise 上，避免两次 flush 交错把行写乱 —— JSONL 只有在
   * 每行完整时才有意义。
   */
  flush(): Promise<void> {
    if (!this.dir || this.pending.length === 0) return this.writing
    const take = this.pending
    this.pending = []
    const dir = this.dir
    this.writing = this.writing.then(async () => {
      // 一批点几乎总在同一天，但跨零点时要分开写
      const byDay = new Map<string, string[]>()
      for (const s of take) {
        const k = dayKey(s.t)
        const arr = byDay.get(k) ?? []
        arr.push(JSON.stringify(s))
        byDay.set(k, arr)
      }
      for (const [k, lines] of byDay) {
        await appendFile(join(dir, `${k}.jsonl`), lines.join('\n') + '\n', { mode: 0o600 })
          .catch((e) => console.error('[temps] 落盘失败:', e))
      }
    })
    return this.writing
  }

  /** @param minutes 只要最近这些分钟的点，0 或缺省表示全部 */
  list(minutes = 0): TempSample[] {
    if (minutes <= 0) return this.buf
    const from = Date.now() - minutes * 60_000
    return this.buf.filter((x) => x.t >= from)
  }

  /**
   * 取某个时间区间的曲线，用来回看历史里的某一单。
   *
   * 先把没落盘的点冲下去，否则刚结束的那一单尾巴会缺一截。
   */
  async range(from: number, to: number): Promise<TempSample[]> {
    if (!this.dir || !(to > from)) return []
    await this.flush()
    /*
     * 按时间戳去重。同一个点可能出现两次 —— 进程在写完但还没清空待写缓冲
     * 时被杀，重启后那批点会再写一遍。曲线上表现为一段零长度的竖线，
     * 不致命，但没有理由留着。
     */
    const seen = new Map<number, TempSample>()
    for (const day of daysBetween(from, to)) {
      for (const s of await this.readDay(day)) {
        if (s.t >= from && s.t <= to) seen.set(s.t, s)
      }
    }
    return [...seen.values()].sort((a, b) => a.t - b.t)
  }

  private async readDay(day: string): Promise<TempSample[]> {
    if (!this.dir) return []
    const text = await readFile(join(this.dir, `${day}.jsonl`), 'utf8').catch(() => '')
    const out: TempSample[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      // 断电可能留下半行，跳过就是了，不该让整条曲线取不出来
      try {
        out.push(JSON.parse(line) as TempSample)
      } catch {
        /* ignore */
      }
    }
    return out
  }

  /** 删掉过期的天文件 */
  private async prune(): Promise<void> {
    if (!this.dir) return
    const cutoff = dayKey(Date.now() - this.keepDays * 86_400_000)
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
      if (m && m[1] < cutoff) await unlink(join(this.dir, f)).catch(() => {})
    }
  }

  /** 启动时把最近两天的点读回内存，重启后实时曲线不至于是空白 */
  private async warm(): Promise<void> {
    const now = Date.now()
    const days = [dayKey(now - 86_400_000), dayKey(now)]
    const all: TempSample[] = []
    for (const d of days) all.push(...(await this.readDay(d)))
    this.buf = all.sort((a, b) => a.t - b.t).slice(-this.max)
  }
}
