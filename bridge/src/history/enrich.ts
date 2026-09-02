/**
 * 给历史记录补上两样打印机不直接提供的东西：这一单的延时录像，
 * 和它的源 3mf（缩略图要用）。
 *
 * 两样都得去 FTP 列目录才知道，而历史列表是会被反复拉的，所以带一个
 * 短缓存。列目录失败时安静降级 —— 少一个缩略图是小事，让整个历史页
 * 打不开是大事。
 */
import * as ftp from '../printer/ftp.js'
import { resolveJobFile, type Candidate } from './resolve.js'
import { matchTimelapse, type JobWindow, type VideoFile } from './timelapse.js'

export interface JobExtras {
  /** 源 3mf 在打印机上的路径，用来取缩略图 */
  file3mf?: string
  /** 延时录像文件名，位于 /timelapse 下 */
  video?: string
}

const TTL_MS = 60_000

interface Cached<T> {
  at: number
  value: T
}

let rootCache: Cached<Candidate[]> | null = null
let videoCache: Cached<VideoFile[]> | null = null

async function cachedList<T>(
  cache: Cached<T> | null,
  load: () => Promise<T>,
  set: (c: Cached<T>) => void,
  empty: T,
): Promise<T> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  try {
    const value = await load()
    set({ at: Date.now(), value })
    return value
  } catch {
    // 列不出来就当没有。旧缓存还在的话继续用，总比什么都没有强
    return cache?.value ?? empty
  }
}

/** 仅供测试重置 */
export function resetCache(): void {
  rootCache = null
  videoCache = null
}

/**
 * 带缓存的根目录列表。
 *
 * 「按归一化后的名字找回源文件」这件事历史列表和收菜都要做，各列一次目录
 * 就是白花一次 FTP 往返（实测约 170ms）。共用同一份缓存。
 */
export async function rootListing(): Promise<Candidate[]> {
  return cachedList<Candidate[]>(
    rootCache,
    async () => (await ftp.listDir('/')).map((f) => ({ name: f.name, isDirectory: f.isDirectory })),
    (c) => { rootCache = c },
    [],
  )
}

export async function enrich(
  jobs: (JobWindow & { name: string })[],
): Promise<Map<string, JobExtras>> {
  const out = new Map<string, JobExtras>()
  if (jobs.length === 0) return out

  const [root, videos] = await Promise.all([
    rootListing(),
    cachedList<VideoFile[]>(
      videoCache,
      async () => (await ftp.listDir('/timelapse'))
        .filter((f) => !f.isDirectory)
        .map((f) => ({ name: f.name, modifiedAt: f.modifiedAt })),
      (c) => { videoCache = c },
      [],
    ),
  ])

  const byJob = matchTimelapse(videos, jobs)
  for (const j of jobs) {
    const extras: JobExtras = {}
    const file = resolveJobFile(j.name, root)
    if (file) extras.file3mf = file
    const video = byJob.get(j.id)
    if (video) extras.video = video
    if (extras.file3mf || extras.video) out.set(j.id, extras)
  }
  return out
}
