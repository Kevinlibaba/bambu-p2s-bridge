/**
 * 打印机自带「视频录制」的录像配额。
 *
 * 打印机开着录制时会按 256MB 一段往 /ipcam 里写 1080p 录像，但不会自己删旧的。
 * 实测两天就写了 17 段、近 4GB，把卡占到 91%，报 HMS 0500_0100_0003_0004
 * （空间不足，无法录像和延时摄影）—— 这条是状态码，卡不腾出来就一直挂着，
 * 而且这一单的延时摄影也跟着没了。
 *
 * 规则：
 *   · /ipcam 下已完成的 .mp4 总量超过配额，就从最旧的开始删，删到配额以下；
 *   · 正在写的 .temp 永远不碰；
 *   · 最新的一段永远保留 —— 刚出事时最想回看的就是它；
 *   · 顺手删掉对应录像已经不在的缩略图（/ipcam/thumbnail/<同名>.jpg）；
 *   · 一次删一个，删之前先让用户的读走完。打印中照样跑：打印读的是根目录的
 *     任务文件，跟 /ipcam 没关系。
 */

export interface RemoteEntry {
  name: string
  size: number
  isDirectory: boolean
}

export interface RecordingDeps {
  list: (path: string) => Promise<RemoteEntry[]>
  remove: (path: string) => Promise<void>
  readsActive: () => number
  log?: (msg: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface PrunePlan {
  /** 要删的录像，最旧的在前 */
  delete: RemoteEntry[]
  /** 录像已不在的孤儿缩略图 */
  orphanThumbs: string[]
  before: number
  after: number
}

const DIR = '/ipcam'
const THUMB_DIR = '/ipcam/thumbnail'
const IDLE_WAIT_MS = 3000

/** 录像文件名里自带时间戳：ipcam-record.2026-10-29_01-51-23.mp4，按名字排序就是按时间排序 */
const isRecording = (n: string) => /^ipcam-record\..+\.mp4$/i.test(n)
const stem = (n: string) => n.replace(/\.(mp4|temp|jpg)$/i, '')

/** 纯函数：给定目录内容和配额，算出该删什么 */
export function planPrune(files: RemoteEntry[], thumbs: string[], quotaBytes: number): PrunePlan {
  const recs = files.filter((f) => !f.isDirectory && isRecording(f.name)).sort((a, b) => a.name.localeCompare(b.name))
  const before = recs.reduce((s, f) => s + f.size, 0)
  const del: RemoteEntry[] = []
  let total = before
  // 最新一段永远留着，所以最多删到只剩一段
  for (const f of recs.slice(0, Math.max(0, recs.length - 1))) {
    if (total <= quotaBytes) break
    del.push(f)
    total -= f.size
  }
  // 录像还在（含正在写的 .temp）的缩略图都保留
  const alive = new Set(
    files.filter((f) => !f.isDirectory && !del.includes(f)).map((f) => stem(f.name)),
  )
  const orphanThumbs = thumbs.filter((t) => /^ipcam-record\..+\.jpg$/i.test(t) && !alive.has(stem(t)))
  return { delete: del, orphanThumbs, before, after: total }
}

export class RecordingQuota {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly deps: RecordingDeps,
    private readonly quotaBytes: number,
    private readonly intervalMs = 10 * 60_000,
  ) {}

  start(): void {
    if (this.quotaBytes <= 0) return
    void this.run().catch(() => {})
    this.timer = setInterval(() => void this.run().catch(() => {}), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  private async yieldToUser(): Promise<void> {
    const now = this.deps.now ?? Date.now
    const until = now() + IDLE_WAIT_MS
    while (this.deps.readsActive() > 0 && now() < until) await this.sleep(150)
  }

  /** 跑一轮。返回实际删掉的字节数 */
  async run(): Promise<number> {
    if (this.running || this.quotaBytes <= 0) return 0
    this.running = true
    try {
      const files = await this.deps.list(DIR)
      const thumbs = files.some((f) => f.isDirectory && f.name === 'thumbnail')
        ? (await this.deps.list(THUMB_DIR)).filter((f) => !f.isDirectory).map((f) => f.name)
        : []
      const plan = planPrune(files, thumbs, this.quotaBytes)
      let freed = 0
      for (const f of plan.delete) {
        await this.yieldToUser()
        await this.deps.remove(`${DIR}/${f.name}`)
        freed += f.size
      }
      for (const t of plan.orphanThumbs) {
        await this.yieldToUser()
        await this.deps.remove(`${THUMB_DIR}/${t}`).catch(() => {})
      }
      if (plan.delete.length || plan.orphanThumbs.length) {
        this.deps.log?.(
          `[recordings] 删了 ${plan.delete.length} 段旧录像（${Math.round(freed / 1048576)} MB）` +
            `、${plan.orphanThumbs.length} 张孤儿缩略图；录像从 ${Math.round(plan.before / 1048576)} MB 降到 ${Math.round(plan.after / 1048576)} MB`,
        )
      }
      return freed
    } finally {
      this.running = false
    }
  }
}
