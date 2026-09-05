import { createHash } from 'node:crypto'

/**
 * 盘预览图的缓存。
 *
 * 历史列表一屏就有七八行，每行一张缩略图。每张图要开两次 FTP 读
 * （先读 ZIP 尾部找中央目录，再读条目本身），而打印机同时只接受 4 个读，
 * 于是整屏缩略图一起发出去必然全军覆没 —— 实测就是一片 503。
 *
 * 三件事一起做：
 *  - 缓存。同一个 3mf 的同一盘反复要，本就不该反复去打印机取。
 *  - 合并在途请求。整屏同时要同一张图时，只应该有一次真实读取。
 *  - 限流。首次加载时若干张不同的图仍会并发，这里排队慢慢来，
 *    让它们陆续出现，而不是一起失败。
 */

/** 取图函数交回来的东西。ETag 由缓存自己算，调用方不必操心 */
export interface LoadedImage {
  data: Buffer
  contentType: string
}

export interface PlateImage extends LoadedImage {
  /**
   * 内容哈希，用作 HTTP 的 ETag。浏览器本地缓存过期之后可以只问一句
   * 「还是这张吗」，没变就回 304 不带 body —— 而不是整张重下。
   */
  etag: string
}

/** 只用来判断「变没变」，不承担安全职责，截短即可 */
function hashOf(data: Buffer): string {
  return `"${createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`
}

interface Entry extends PlateImage {
  at: number
}

/** 单张预览图几 KB 到几十 KB，留 48 张也就几 MB */
const MAX_ENTRIES = 48
/** 3mf 一旦写好基本不再变，缓存久一点无妨；给个上限只是防着文件被替换 */
const TTL_MS = 30 * 60_000
/** 同时真正去读打印机的数量。留出余量给下载、预览这些更要紧的请求 */
const MAX_INFLIGHT = 2
/** 排队上限。再多就直接拒，而不是让请求无限积压 */
const MAX_QUEUE = 24

export class PlateCache {
  private entries = new Map<string, Entry>()
  private inflight = new Map<string, Promise<PlateImage>>()
  private running = 0
  private queue: (() => void)[] = []

  constructor(
    private readonly maxEntries = MAX_ENTRIES,
    private readonly ttlMs = TTL_MS,
    private readonly maxInflight = MAX_INFLIGHT,
    private readonly maxQueue = MAX_QUEUE,
  ) {}

  private hit(key: string): PlateImage | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    // 重新插一遍，让最近用过的排到后面 —— 淘汰时从最前面丢
    this.entries.delete(key)
    this.entries.set(key, e)
    return { data: e.data, contentType: e.contentType, etag: e.etag }
  }

  private store(key: string, img: LoadedImage): PlateImage {
    const full: PlateImage = { ...img, etag: hashOf(img.data) }
    this.entries.set(key, { ...full, at: Date.now() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
    return full
  }

  /** 缓存里有没有这一张（且没过期）。预热时用来跳过已有的 */
  has(key: string): boolean {
    return this.hit(key) !== null
  }

  /**
   * 忘掉某个文件的所有盘。
   *
   * 文件被同名重传、删除、或切片产物落盘时必须调 —— 否则 TTL 内一直是旧图，
   * 而这恰恰是用户在这个 App 里自己做的操作，看到旧图会以为没成功。
   */
  invalidate(path: string): void {
    const prefix = `${path}|`
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k)
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxInflight) {
      this.running += 1
      return Promise.resolve()
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError())
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.running -= 1
    this.queue.shift()?.()
  }

  /** @param load 真正去打印机取。只有缓存未命中且没有同 key 在途时才会被调用 */
  async get(key: string, load: () => Promise<LoadedImage>): Promise<PlateImage> {
    const cached = this.hit(key)
    if (cached) return cached

    const running = this.inflight.get(key)
    if (running) return running

    const task = (async () => {
      await this.acquire()
      try {
        // 排队期间可能已经有人把它取回来了
        const again = this.hit(key)
        if (again) return again
        return this.store(key, await load())
      } finally {
        this.release()
      }
    })()

    this.inflight.set(key, task)
    try {
      return await task
    } finally {
      this.inflight.delete(key)
    }
  }

  /** 仅供测试与排查 */
  get size(): number {
    return this.entries.size
  }
}

/**
 * 全局唯一一份。files.ts 的取图路由和 slice.ts 的产物落盘都要碰它 ——
 * 后者写完文件得让对应的预览失效。
 */
export const plateCache = new PlateCache()

export class QueueFullError extends Error {
  constructor() {
    super('预览图请求排队过多，请稍后再试')
    this.name = 'QueueFullError'
  }
}
