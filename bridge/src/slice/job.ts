/**
 * 切片任务的状态机。
 *
 * 为什么不做成一个同步接口：实测 2 核容器上 4.5MB 的模型要 21 秒，复杂模型
 * 可以到几分钟。手机上挂着一个几分钟的 HTTP 请求，锁屏、切后台、换网都会断，
 * 而切片这边已经在跑了 —— 断了也没法知道结果。所以提交后立刻返回任务号，
 * 客户端自己轮询。
 *
 * 同一时刻只跑一个：切片是满载 CPU 的，这台机器只有 2 核，还要同时扛 MQTT、
 * 摄像头代理和 FTP。并发跑两个的结果是两个都慢，还可能把别的功能拖垮。
 *
 * 任务记录只在内存里。重启就没了 —— 这是有意的：重启后那个半成品也没了，
 * 留一条「进行中」的假记录只会误导人。
 */
export type SlicePhase = 'queued' | 'downloading' | 'slicing' | 'patching' | 'uploading' | 'done' | 'failed'

export interface SliceJob {
  id: string
  /** 源文件在打印机上的路径 */
  source: string
  /** 产物在打印机上的路径，done 之前为 null */
  output: string | null
  phase: SlicePhase
  error: string | null
  /** 切片器的输出，仅失败时保留，用来排查 */
  log: string | null
  startedAt: number
  endedAt: number | null
  /** 纯切片耗时（毫秒），不含上传下载 */
  sliceMs: number | null
}

/**
 * 切片本身按任务传入，不放进 SliceSteps。
 *
 * 每次提交用的 profile、盘号、耗材都不同，而 steps 是构造时定死的。让状态机
 * 只管流程、不认识切片有哪些选项，比把一堆参数穿过状态机干净。
 */
export type SliceFn = (model: string, workDir: string) => Promise<{ file: string; ms: number }>

export interface SliceSteps {
  /** 把源文件从打印机取到本地，返回本地路径 */
  download: (source: string, workDir: string) => Promise<string>
  /** 补 printer_model_id 之类 */
  patch: (file: string) => Promise<void>
  /** 传回打印机，返回打印机上的路径 */
  upload: (file: string, source: string) => Promise<string>
  /** 清理工作目录。失败也不该让整个任务算失败 */
  cleanup?: (workDir: string) => Promise<void>
  workDirFor: (id: string) => string
  now?: () => number
}

export class SliceBusyError extends Error {
  constructor() {
    super('已经有一个切片任务在跑了，等它结束再试')
    this.name = 'SliceBusyError'
  }
}

/** 最多留这么多条历史记录，防止长期运行把内存吃掉 */
const MAX_JOBS = 20

export class SliceQueue {
  private readonly jobs = new Map<string, SliceJob>()
  private running: string | null = null
  private seq = 0

  constructor(private readonly steps: SliceSteps) {}

  private now(): number {
    return this.steps.now ? this.steps.now() : Date.now()
  }

  get(id: string): SliceJob | null {
    return this.jobs.get(id) ?? null
  }

  list(): SliceJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /** 当前是否有任务在跑 */
  busy(): boolean {
    return this.running !== null
  }

  /**
   * 提交一个任务，立刻返回。忙的时候直接拒绝而不是排队 ——
   * 排队会让人以为很快就轮到，实际可能等上几分钟。
   */
  start(source: string, slice: SliceFn): SliceJob {
    if (this.running) throw new SliceBusyError()
    const id = `s${++this.seq}-${this.now().toString(36)}`
    const job: SliceJob = {
      id,
      source,
      output: null,
      phase: 'queued',
      error: null,
      log: null,
      startedAt: this.now(),
      endedAt: null,
      sliceMs: null,
    }
    this.jobs.set(id, job)
    this.running = id
    void this.run(job, slice)
    this.trim()
    return job
  }

  private trim(): void {
    while (this.jobs.size > MAX_JOBS) {
      // 最旧的一条，但绝不动正在跑的那个
      let oldest: SliceJob | null = null
      for (const j of this.jobs.values()) {
        if (j.id === this.running) continue
        if (!oldest || j.startedAt < oldest.startedAt) oldest = j
      }
      if (!oldest) break
      this.jobs.delete(oldest.id)
    }
  }

  private async run(job: SliceJob, slice: SliceFn): Promise<void> {
    const workDir = this.steps.workDirFor(job.id)
    try {
      job.phase = 'downloading'
      const model = await this.steps.download(job.source, workDir)

      job.phase = 'slicing'
      const sliced = await slice(model, workDir)
      job.sliceMs = sliced.ms

      job.phase = 'patching'
      await this.steps.patch(sliced.file)

      job.phase = 'uploading'
      job.output = await this.steps.upload(sliced.file, job.source)
      job.phase = 'done'
    } catch (e) {
      job.phase = 'failed'
      job.error = (e as Error).message
      const log = (e as { log?: string }).log
      if (log) job.log = log
    } finally {
      job.endedAt = this.now()
      this.running = null
      // 清理失败不该改变任务结果 —— 文件切出来了就是切出来了
      try {
        await this.steps.cleanup?.(workDir)
      } catch {
        /* 留着占点磁盘，比把一个成功的任务标成失败强 */
      }
    }
  }
}
