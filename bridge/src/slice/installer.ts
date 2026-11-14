/**
 * 切片器一键安装：从 BambuStudio 的 GitHub Releases 下载 Linux AppImage，校验、解包到数据卷。
 *
 * 以前要用户自己下 229MB 的 AppImage、解包、放到 /opt/slicer —— 新手基本卡死在这一步。
 *
 * 版本钉死在实测切片可用的那一个（v02.08.02.61，CT102 上一直在用的就是它，sha256 一致）。
 * 新版本的 CLI 行为、P2S profile 名字都可能变，切片代码是照着这一版写的，不跟着 latest 走。
 * 想换版本用环境变量 SLICER_URL + SLICER_SHA256（两个一起给）。
 *
 * 只能在 x86_64 上用：BambuStudio 只发 x86_64 的 Linux 版，arm64 镜像里也没装它要的系统库。
 *
 * 解包用 AppImage 自带的 --appimage-extract，不需要 FUSE，也不需要额外装 squashfs-tools。
 * 解到临时目录、确认 AppRun 和 P2S 的 profile 都在，再整体改名替换 —— 中途失败不会留下半套。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const PINNED = {
  version: '02.08.02.61',
  url: 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.61/BambuStudio_ubuntu22.04-v02.08.02.61-20260820225108.AppImage',
  sha256: '69426a59682574591590f51c913d3889baa19252d1c8e9fcae2497eb0ed6bf92',
  size: 229_153_272,
}

/** 解包后约 540MB，加上下载的 AppImage 本身，留足余量 */
const NEED_BYTES = 900 * 1024 * 1024

export type InstallState = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'

export interface InstallStatus {
  state: InstallState
  /** 0–100，只在 downloading 时有意义 */
  pct: number
  error: string | null
  /** 错误分类，前端据此翻译 */
  code: string | null
}

export interface SlicerSource {
  url: string
  sha256: string
  version: string
  size: number
}

export function sourceFromEnv(env = process.env): SlicerSource {
  if (env.SLICER_URL && env.SLICER_SHA256) {
    const v = /v(\d+\.\d+\.\d+\.\d+)/.exec(env.SLICER_URL)?.[1] ?? 'custom'
    return { url: env.SLICER_URL, sha256: env.SLICER_SHA256.toLowerCase(), version: v, size: 0 }
  }
  return PINNED
}

export class InstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

export interface InstallerDeps {
  /** 解包到哪：<dir>/squashfs-root 就是切片器根目录 */
  dir: string
  source?: SlicerSource
  fetchImpl?: typeof fetch
  /** 测试里替换掉真正的解包 */
  extract?: (appImage: string, cwd: string) => Promise<void>
  arch?: string
  freeBytes?: (dir: string) => Promise<number>
}

function extractAppImage(appImage: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(appImage, ['--appimage-extract'], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 }, (err) => {
      if (err) reject(new InstallError('extract', `解包失败：${err.message}`))
      else resolve()
    })
  })
}

async function statfsFree(dir: string): Promise<number> {
  try {
    const { statfs } = await import('node:fs/promises')
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return Number.MAX_SAFE_INTEGER // 量不出来就不拦
  }
}

/**
 * 用哪一份切片器：手动挂载的（老安装，/opt/slicer）优先，其次是一键下载到数据卷里的。
 * 两份都没有时返回挂载路径 —— 后面读目录失败，报的就是「切片器不可用」。
 */
export function resolveSlicerRoot(mounted: string, downloaded: string): string {
  if (looksInstalled(mounted)) return mounted
  if (looksInstalled(downloaded)) return downloaded
  return mounted
}

/** 切片器根目录里这两样都在，才算装好了 */
export function looksInstalled(root: string): boolean {
  return existsSync(path.join(root, 'AppRun'))
    && existsSync(path.join(root, 'resources/profiles/BBL/machine/Bambu Lab P2S 0.4 nozzle.json'))
}

export class SlicerInstaller {
  private status: InstallStatus = { state: 'idle', pct: 0, error: null, code: null }
  private running: Promise<void> | null = null

  constructor(private readonly deps: InstallerDeps) {}

  get root(): string {
    return path.join(this.deps.dir, 'squashfs-root')
  }

  get source(): SlicerSource {
    return this.deps.source ?? sourceFromEnv()
  }

  get supported(): boolean {
    return (this.deps.arch ?? process.arch) === 'x64'
  }

  current(): InstallStatus {
    return { ...this.status }
  }

  /** 开始安装；已在进行就直接返回。不等它完成 —— 前端轮询 current() */
  start(): InstallStatus {
    if (!this.supported) throw new InstallError('arch', 'BambuStudio 只有 x86_64 的 Linux 版，这台机器（arm64）用不了切片')
    if (!this.running) {
      // 当场就切到「下载中」：界面点完立刻有反馈，不用等第一次轮询
      this.status = { state: 'downloading', pct: 0, error: null, code: null }
      this.running = this.run()
        .catch((e: unknown) => {
          const err = e instanceof InstallError ? e : new InstallError('unknown', (e as Error).message)
          this.status = { state: 'error', pct: 0, error: err.message, code: err.code }
        })
        .finally(() => { this.running = null })
    }
    return this.current()
  }

  /** 等当前这一轮跑完（测试用） */
  async settle(): Promise<void> {
    await this.running
  }

  private async run(): Promise<void> {
    const { dir } = this.deps
    const src = this.source
    await mkdir(dir, { recursive: true })
    const free = await (this.deps.freeBytes ?? statfsFree)(dir)
    if (free < NEED_BYTES) {
      throw new InstallError('space', `磁盘空间不够：需要约 ${Math.round(NEED_BYTES / 1048576)} MB，只剩 ${Math.round(free / 1048576)} MB`)
    }

    const file = path.join(dir, 'bambu-studio.AppImage.part')
    const work = path.join(dir, '.extract')
    await rm(file, { force: true })
    await rm(work, { recursive: true, force: true })

    // ---- 下载，边下边算哈希 ----
    this.status = { state: 'downloading', pct: 0, error: null, code: null }
    let res: Response
    try {
      res = await (this.deps.fetchImpl ?? fetch)(src.url, { redirect: 'follow' })
    } catch (e) {
      throw new InstallError('network', `连不上 GitHub：${(e as Error).message}`)
    }
    if (!res.ok || !res.body) throw new InstallError('network', `下载失败：HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || src.size || 0
    const hash = createHash('sha256')
    let got = 0
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      got += chunk.length
      if (total) this.status.pct = Math.min(99, Math.floor((got / total) * 100))
    })
    try {
      await pipeline(body, createWriteStream(file))
    } catch (e) {
      throw new InstallError('network', `下载中断：${(e as Error).message}`)
    }

    // ---- 校验 ----
    this.status = { state: 'verifying', pct: 100, error: null, code: null }
    const digest = hash.digest('hex')
    if (digest !== src.sha256) {
      await rm(file, { force: true })
      throw new InstallError('checksum', `文件校验不对（sha256 ${digest.slice(0, 12)}…），已删除，没有安装`)
    }

    // ---- 解包到临时目录，确认完整再换上 ----
    this.status = { state: 'extracting', pct: 100, error: null, code: null }
    await chmod(file, 0o755)
    await mkdir(work, { recursive: true })
    await (this.deps.extract ?? extractAppImage)(file, work)
    const fresh = path.join(work, 'squashfs-root')
    if (!looksInstalled(fresh)) {
      await rm(work, { recursive: true, force: true })
      throw new InstallError('extract', '解包出来的内容不完整（缺 AppRun 或 P2S 的配置）')
    }
    const old = path.join(dir, '.old')
    await rm(old, { recursive: true, force: true })
    if (existsSync(this.root)) await rename(this.root, old)
    await rename(fresh, this.root)
    await rm(old, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
    await rm(file, { force: true })
    await writeFile(this.markerPath, JSON.stringify({ version: src.version, sha256: src.sha256, installedAt: Date.now() }))
    this.status = { state: 'done', pct: 100, error: null, code: null }
  }

  private get markerPath(): string {
    return path.join(this.deps.dir, 'installed.json')
  }

  /** 一键安装的那份是哪个版本；没装过（或手动挂载的）是 null */
  async installedVersion(): Promise<string | null> {
    try {
      return (JSON.parse(await readFile(this.markerPath, 'utf8')) as { version?: string }).version ?? null
    } catch {
      return null
    }
  }

  /** 删掉一键安装的那份（手动挂载的不碰） */
  async remove(): Promise<void> {
    if (this.running) throw new InstallError('busy', '正在安装，等它结束')
    await rm(this.root, { recursive: true, force: true })
    await rm(this.markerPath, { force: true })
    this.status = { state: 'idle', pct: 0, error: null, code: null }
  }
}
