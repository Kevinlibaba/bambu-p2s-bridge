/**
 * 存储卡体检：把卡上每个 3mf 拉回来，逐条目核对 CRC。
 *
 * 起因是一次真实的排查：41 个文件里 16 个是坏的，7 个连打印用的 gcode 都损坏，
 * 损坏形态是整扇区被替换（每段从 512 字节边界开始、长度是 1024 的整数倍）。
 * 这种坏文件在列表里看不出任何异常，切片器报的是「XML 第 28283 行不合法」，
 * 打印机上打到一半才会出事。所以要主动查。
 *
 * 代价：每个文件整个下载一遍，卡上 250MB 走千兆约一分钟。规矩和预热一样 ——
 * 用户的请求永远优先：一次一个文件，每个文件之前先等打印机没有别的读；
 * 自动跑只在打印机空闲时。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { bufferSource, readCentralDirectory, readEntry } from '../util/zip.js'
import { crc32 } from '../util/zipwrite.js'
import type { NotifyEvent } from '../notify/events.js'

export type FileStatus = 'ok' | 'corrupt' | 'notZip' | 'error'

export interface FileCheckResult {
  name: string
  size: number
  status: FileStatus
  /** 坏掉的条目名，最多记几条，够指出「打印用的 gcode 坏了」就行 */
  badEntries?: string[]
  detail?: string
}

export interface FileCheckStatus {
  running: boolean
  startedAt: number | null
  finishedAt: number | null
  total: number
  done: number
  current: string | null
  results: FileCheckResult[]
  error: string | null
}

export interface CheckDeps {
  list: () => Promise<{ name: string; size: number; isDirectory: boolean }[]>
  download: (path: string) => Promise<Buffer>
  /** 打印机上此刻有几个读在进行。用户在读就让路 */
  readsActive: () => number
  /** 打印机是否空闲。自动体检只在空闲时跑 */
  idle: () => boolean
  notify: (e: NotifyEvent) => Promise<void>
  now?: () => number
}

/** 单个条目解压上限。gcode 常见十几 MB，给到 256MB */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024
const IDLE_WAIT_MS = 3000
const BAD_ENTRIES_MAX = 5

interface Persisted {
  at: number | null
  results: FileCheckResult[]
  /** 已经推送过的坏文件，别每天都响一遍 */
  reported: string[]
}

/** 只校验，不碰网络：拿到整个文件的字节，逐条目解压并核对 CRC 和长度 */
export async function verifyBuffer(buf: Buffer): Promise<Pick<FileCheckResult, 'status' | 'badEntries' | 'detail'>> {
  const src = bufferSource(buf)
  let entries
  try {
    entries = await readCentralDirectory(src)
  } catch (e) {
    return { status: 'notZip', detail: (e as Error).message }
  }
  const bad: string[] = []
  for (const en of entries) {
    if (en.name.endsWith('/')) continue
    try {
      const data = await readEntry(src, en, MAX_ENTRY_BYTES)
      if (data.length !== en.uncompressedSize || crc32(data) !== en.crc32) bad.push(en.name)
    } catch {
      bad.push(en.name)
    }
    if (bad.length >= BAD_ENTRIES_MAX) break
  }
  return bad.length ? { status: 'corrupt', badEntries: bad } : { status: 'ok' }
}

/** 值得体检的文件：3mf，且不是 macOS 顺手写上去的资源分叉 */
export function isCandidate(name: string): boolean {
  return /\.3mf$/i.test(name) && !name.startsWith('._')
}

export class FileChecker {
  private st: FileCheckStatus = {
    running: false, startedAt: null, finishedAt: null, total: 0, done: 0, current: null, results: [], error: null,
  }
  private reported = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly statePath: string,
    private readonly deps: CheckDeps,
    private readonly intervalMs: number,
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  async start(): Promise<void> {
    try {
      const p = JSON.parse(await readFile(this.statePath, 'utf8')) as Persisted
      this.st.results = p.results ?? []
      this.st.finishedAt = p.at ?? null
      this.reported = new Set(p.reported ?? [])
    } catch {
      /* 第一次跑，没有历史 */
    }
    if (this.intervalMs > 0) {
      // 每分钟看一眼「到点了没、打印机空不空」。到点但在打印就顺延，不硬跑
      this.timer = setInterval(() => void this.autoTick(), 60_000)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private async autoTick(): Promise<void> {
    if (this.st.running) return
    const last = this.st.finishedAt ?? 0
    if (this.now() - last < this.intervalMs) return
    if (!this.deps.idle()) return
    await this.run().catch(() => {})
  }

  status(): FileCheckStatus {
    return { ...this.st, results: [...this.st.results] }
  }

  private async waitIdle(): Promise<void> {
    const until = this.now() + IDLE_WAIT_MS
    while (this.deps.readsActive() > 0 && this.now() < until) {
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  /** 跑一轮。已经在跑就直接返回当前状态，不叠加 */
  async run(): Promise<FileCheckStatus> {
    if (this.st.running) return this.status()
    this.st = { running: true, startedAt: this.now(), finishedAt: null, total: 0, done: 0, current: null, results: [], error: null }
    try {
      const files = (await this.deps.list()).filter((f) => !f.isDirectory && isCandidate(f.name))
      this.st.total = files.length
      for (const f of files) {
        this.st.current = f.name
        await this.waitIdle()
        let r: FileCheckResult
        try {
          const buf = await this.deps.download(`/${f.name}`)
          r = { name: f.name, size: f.size, ...(await verifyBuffer(buf)) }
        } catch (e) {
          r = { name: f.name, size: f.size, status: 'error', detail: (e as Error).message }
        }
        this.st.results.push(r)
        this.st.done += 1
      }
      await this.report()
    } catch (e) {
      this.st.error = (e as Error).message
    } finally {
      this.st.running = false
      this.st.current = null
      this.st.finishedAt = this.now()
      await this.persist().catch(() => {})
    }
    return this.status()
  }

  /** 新发现的坏文件推一条；已经报过的不再响 */
  private async report(): Promise<void> {
    const bad = this.st.results.filter((r) => r.status === 'corrupt' || r.status === 'notZip')
    const fresh = bad.filter((r) => !this.reported.has(r.name))
    if (!fresh.length) return
    for (const r of fresh) this.reported.add(r.name)
    const names = fresh.slice(0, 5).map((r) => r.name)
    await this.deps.notify({
      kind: 'fileCorrupt',
      key: `corrupt:${fresh.map((r) => r.name).join('|')}`,
      title: `存储卡上有 ${fresh.length} 个损坏的文件`,
      body: names.join('\n') + (fresh.length > 5 ? `\n…共 ${fresh.length} 个` : ''),
    })
  }

  private async persist(): Promise<void> {
    const p: Persisted = { at: this.st.finishedAt, results: this.st.results, reported: [...this.reported] }
    await writeFile(this.statePath, JSON.stringify(p), 'utf8')
  }
}
