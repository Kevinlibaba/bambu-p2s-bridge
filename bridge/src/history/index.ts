/**
 * 打印历史。
 *
 * 局域网模式下打印机不给任何历史 —— 关掉界面这一单就查无对证。
 * 桥接看得见每一次状态跃迁，顺手记下来就有了。
 *
 * 存成 JSONL：一行一单，追加写，天然抗截断（进程被杀最多丢最后一行，
 * 不会像 JSON 数组那样整个文件解析失败）。每条几百字节，一年也就几十 KB，
 * 不值得为它引数据库。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config.js'
import type { PrinterState, Summary } from '../printer/state.js'

export interface JobRecord {
  id: string
  /** 任务名，通常是不带扩展名的文件名 */
  name: string
  /** 打印机上报的 gcode 路径，形如 /data/Metadata/plate_8.gcode */
  file: string
  /** 从 file 里解出的盘号，解不出为 null */
  plate: number | null
  startedAt: number
  endedAt: number
  /** 实际耗时（分钟），按状态跃迁的时间差算 */
  minutes: number
  result: 'finished' | 'failed'
  /** 结束时的进度。正常完成是 100，中途失败能看出打到哪 */
  progress: number
  layer: number
  totalLayers: number
  /** 结束时的错误码，无则 0 */
  printError: number
  /** 切片文件里的预估耗材克重，查不到为 null */
  weightG: number | null
  /** 切片文件里的预估时长（分钟），查不到为 null */
  estimateMin: number | null
  /**
   * 没有观测到这一单的开始 —— 桥接是在打印中途起来的。
   * 此时耗时无从得知，minutes 为 0 但不代表真的只打了 0 分钟，
   * 界面要显示「耗时未知」而不是「0 分钟」。
   */
  partial: boolean
}

const ACTIVE = new Set(['RUNNING', 'PREPARE'])
/** 内存里保留的条数，接口按需再读文件 */
const RECENT_MAX = 500

/** /data/Metadata/plate_8.gcode → 8 */
function plateOf(file: string): number | null {
  const m = /plate_(\d+)\.gcode/i.exec(file ?? '')
  return m ? Number(m[1]) : null
}

export class History {
  private jobs: JobRecord[] = []
  private open: { started: number; snap: Summary; partial: boolean } | null = null
  private prev: Summary | null = null

  constructor(
    private readonly state: PrinterState,
    /** 用来补全预估克重/时长；拿不到就留 null，不阻塞记录 */
    private readonly lookup?: (name: string, plate: number | null) =>
      Promise<{ weightG: number | null; estimateMin: number | null } | null>,
  ) {}

  private get file() {
    return config.history.path
  }

  async start(): Promise<void> {
    await this.load()
    this.state.on('update', (s: Summary) => {
      void this.feed(s)
    })
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8')
      this.jobs = text
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as JobRecord
          } catch {
            return null // 单行损坏不该毁掉整份历史
          }
        })
        .filter((x): x is JobRecord => !!x)
        .slice(-RECENT_MAX)
    } catch {
      this.jobs = []
    }
  }

  private async append(rec: JobRecord): Promise<void> {
    this.jobs.push(rec)
    if (this.jobs.length > RECENT_MAX) this.jobs.shift()
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 })
    } catch (e) {
      console.error('[history] 写入失败', e)
    }
  }

  /** 供测试直接驱动。生产里由 state 的 update 事件调用。 */
  async feed(next: Summary): Promise<void> {
    const prev = this.prev
    this.prev = next
    // 与通知同一个道理：没收到过 report 的空状态不算一次跃迁
    if (!prev || prev.updatedAt === 0) return

    if (prev.state === next.state) {
      if (!ACTIVE.has(next.state)) return
      // 桥接在打印中途起来时没见过这一单的开始，认领它但标记为 partial，
      // 否则结束时会拿 Date.now() 当起点，记成一单「0 分钟」的假账
      if (!this.open) this.open = { started: Date.now(), snap: next, partial: true }
      else this.open.snap = next
      return
    }

    if (ACTIVE.has(next.state) && !ACTIVE.has(prev.state)) {
      this.open = { started: Date.now(), snap: next, partial: false }
      return
    }

    const ended = next.state === 'FINISH' || next.state === 'FAILED'
    if (!ended || !ACTIVE.has(prev.state)) return

    const partial = this.open?.partial ?? true
    const started = this.open?.started ?? Date.now()
    // 结束帧的 progress/layer 常被清零，用最后一帧运行中的快照更准
    const snap = this.open?.snap ?? prev
    const name = snap.taskName || prev.taskName || ''
    const plate = plateOf(snap.file || prev.file)

    let extra: { weightG: number | null; estimateMin: number | null } | null = null
    try {
      extra = (await this.lookup?.(name, plate)) ?? null
    } catch {
      extra = null
    }

    await this.append({
      id: `${started}`,
      name,
      file: snap.file || prev.file || '',
      plate,
      startedAt: started,
      endedAt: Date.now(),
      minutes: partial ? 0 : Math.max(0, Math.round((Date.now() - started) / 60000)),
      result: next.state === 'FINISH' ? 'finished' : 'failed',
      progress: next.state === 'FINISH' ? 100 : snap.progress,
      layer: snap.layer,
      totalLayers: snap.totalLayers,
      printError: next.printError,
      weightG: extra?.weightG ?? null,
      estimateMin: extra?.estimateMin ?? null,
      partial,
    })
    this.open = null
  }

  list(limit = 50): JobRecord[] {
    return this.jobs.slice(-limit).reverse()
  }

  /** 当前是否有一单在记录中 —— 界面据此显示「进行中」 */
  running(): { name: string; startedAt: number } | null {
    return this.open ? { name: this.open.snap.taskName, startedAt: this.open.started } : null
  }

  /**
   * 汇总。按自然月分组，只统计已完成与失败的单。
   * 耗材克重只有能从切片文件里查到的才计入，查不到的不猜。
   */
  stats() {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const pick = (from: number) => this.jobs.filter((j) => j.endedAt >= from)
    const sum = (list: JobRecord[]) => ({
      count: list.length,
      finished: list.filter((j) => j.result === 'finished').length,
      failed: list.filter((j) => j.result === 'failed').length,
      minutes: list.reduce((a, j) => a + j.minutes, 0),
      grams: Math.round(
        list.reduce((a, j) => a + (j.result === 'finished' ? (j.weightG ?? 0) : 0), 0),
      ),
      /** 有几单能查到克重 —— 用量是不是完整，界面要说清楚 */
      weighed: list.filter((j) => j.weightG !== null).length,
    })
    return { month: sum(pick(monthStart)), all: sum(this.jobs) }
  }
}
