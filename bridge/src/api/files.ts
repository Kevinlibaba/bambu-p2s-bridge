/**
 * 文件相关路由：列目录、带 Range 的流式读取、3MF 预览。
 *
 * 后端（FileBackend）是注入的 —— 生产环境是 FTPS，测试里是一段内存 Buffer。
 * Range 这类容易写错的逻辑必须能在没有打印机的情况下验证。
 *
 * 这里不注册任何鉴权豁免：路由挂在根实例上，server.ts 的 onRequest 钩子照常生效。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import * as ftp from '../printer/ftp.js'
import { RangeNotSatisfiableError, parseRangeHeader } from '../util/range.js'
import type { RangeSpec } from '../util/range.js'
import {
  ZipFormatError,
  readCentralDirectory,
  readEntry,
  withTail,
  type ZipEntry,
  type ZipSource,
} from '../util/zip.js'
import {
  MAX_PLATE_IMAGE_BYTES,
  describeThreeMf,
  plateImageEntry,
} from '../printer/threemf.js'

export interface FileBackend {
  listDir(path: string): Promise<ftp.RemoteFile[]>
  stat(path: string): Promise<number>
  openRead(path: string, spec?: RangeSpec): Promise<ftp.RemoteStream>
  readRange(path: string, spec?: RangeSpec): Promise<{ size: number; start: number; data: Buffer }>
  uploadStream(path: string, source: Readable): Promise<void>
  remove(path: string): Promise<void>
}

/** 文件名来自客户端，必须彻底清洗后才能拼进 FTP 路径 */
const MAX_NAME = 120
function safeName(raw: unknown): string {
  const base = String(raw ?? '')
    .split(/[/\\]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!base || base === '.' || base === '..') throw new BadRequest('文件名非法')
  if (!base.toLowerCase().endsWith('.3mf')) throw new BadRequest('只支持 .3mf 文件')
  if (base.length > MAX_NAME) throw new BadRequest('文件名过长')
  return base
}

/** 尾部预读长度。EOCD 加注释最多 64 KB，3MF 的中央目录只有几 KB，一次读完就不用再开连接。 */
const ZIP_TAIL_BYTES = 96 * 1024
/**
 * 缓存的是中央目录，不是文件内容 —— 主要为了让紧随元数据之后的取图请求不再读一次尾部。
 * 存活时间刻意压得很短：包被同名覆盖后，旧的偏移量会指向错的位置。
 */
const ZIP_CACHE_TTL_MS = 60 * 1000
const ZIP_CACHE_MAX = 8

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  gcode: 'text/plain; charset=utf-8',
  '3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
}

export function mimeOf(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return MIME[ext] ?? 'application/octet-stream'
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? 'file'
}

/** RFC 5987。原实现用 filename="…" 包着百分号编码，客户端会原样显示转义串。 */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

interface ZipCacheItem {
  size: number
  tailStart: number
  tail: Buffer
  entries: ZipEntry[]
  at: number
}

export function registerFileRoutes(
  app: FastifyInstance,
  backend: FileBackend = ftp,
  /** 查某个文件上次打印的时间。只传一个函数，不把整个 History 拖进来。 */
  lastPrintedAt?: (name: string) => number | null,
): void {
  const zipCache = new Map<string, ZipCacheItem>()

  function queryPath(req: FastifyRequest): string {
    const raw = (req.query as Record<string, unknown> | undefined)?.path
    if (typeof raw !== 'string' || raw === '') throw new BadRequest('缺少 path')
    try {
      return ftp.normalizePath(raw)
    } catch {
      throw new BadRequest('非法路径')
    }
  }

  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof BadRequest) return reply.code(400).send({ error: e.message })
    if (e instanceof ftp.TooManyReadsError) return reply.code(503).send({ error: e.message })
    if (e instanceof ftp.NotAFileError) return reply.code(e.status).send({ error: e.message })
    if (e instanceof ZipFormatError) return reply.code(422).send({ error: e.message })
    return reply.code(502).send({ error: `FTPS 失败: ${(e as Error).message}` })
  }

  // ---- 列目录 ----
  app.get('/api/files', async (req, reply) => {
    const raw = ((req.query as Record<string, unknown> | undefined)?.path as string) ?? '/'
    let path: string
    try {
      // 走和其他路由同一套包装：非法路径是客户端错误(400)，不能混进上游故障(502)
      path = ftp.normalizePath(raw)
    } catch {
      return fail(reply, new BadRequest('非法路径'))
    }
    try {
      const files = await backend.listDir(path)
      // 给切片文件补上「上次打印时间」，界面据此排序。
      // 这是个只读的内存查表，不额外访问打印机。
      return {
        path,
        files: files.map((f) =>
          f.isDirectory ? f : { ...f, lastPrintedAt: lastPrintedAt?.(f.name) ?? null },
        ),
      }
    } catch (e) {
      return fail(reply, e)
    }
  })

  // ---- 流式读取（支持 Range）----
  /**
   * 视频要能拖进度条，就必须正确实现 206：Content-Range、Accept-Ranges、
   * 以及与实际返回字节数一致的 Content-Length。少一样 <video> 都会退化成不可 seek。
   */
  async function serve(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: 'inline' | 'attachment',
  ): Promise<unknown> {
    let path: string
    try {
      path = queryPath(req)
    } catch (e) {
      return fail(reply, e)
    }

    const parsed = parseRangeHeader(req.headers.range)
    const spec = parsed.kind === 'spec' ? parsed.spec : undefined

    let s: ftp.RemoteStream
    try {
      s = await backend.openRead(path, spec)
    } catch (e) {
      if (e instanceof RangeNotSatisfiableError) {
        return reply
          .code(416)
          .header('accept-ranges', 'bytes')
          .header('content-range', `bytes */${e.size}`)
          .send({ error: '请求的字节范围无法满足' })
      }
      return fail(reply, e)
    }

    // FTP 不能中途停止传输 —— 客户端一走就得把连接销毁，否则每次 seek 漏一条
    req.raw.on('close', () => s.destroy())
    // 开连接期间对方就走了的话，上面这个 close 已经错过了
    if (req.raw.destroyed) s.destroy()

    reply
      .header('accept-ranges', 'bytes')
      .header('content-type', mimeOf(path))
      .header('content-length', String(s.length))
      .header('content-disposition', contentDisposition(kind, baseName(path)))
      .header('cache-control', 'private, no-store')

    if (spec) {
      reply.code(206).header('content-range', `bytes ${s.start}-${s.end}/${s.size}`)
    }
    return reply.send(s.stream)
  }

  /**
   * HEAD 必须显式注册，而且要在 GET 之前 ——
   * Fastify 的 exposeHeadRoutes 会拿 GET 处理器去跑 HEAD，那意味着为一个空响应
   * 白开一条 FTP 连接、把整个视频拉一遍。
   */
  async function head(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    let path: string
    try {
      path = queryPath(req)
    } catch (e) {
      return fail(reply, e)
    }
    try {
      const size = await backend.stat(path)
      return reply
        .code(200)
        .header('accept-ranges', 'bytes')
        .header('content-type', mimeOf(path))
        .header('content-length', String(size))
        .send()
    } catch (e) {
      return fail(reply, e)
    }
  }

  app.head('/api/files/stream', head)
  app.get('/api/files/stream', (req, reply) => serve(req, reply, 'inline'))

  app.head('/api/files/download', head)
  app.get('/api/files/download', (req, reply) => serve(req, reply, 'attachment'))

  // ---- 3MF 预览 ----
  function prune() {
    if (zipCache.size <= ZIP_CACHE_MAX) return
    const oldest = [...zipCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) zipCache.delete(oldest[0])
  }

  /** 打开 3MF 的中央目录。命中缓存时不产生任何 FTP 连接。 */
  async function openZip(path: string): Promise<{ src: ZipSource; entries: ZipEntry[] }> {
    const read: ZipSource['read'] = async (start, end) =>
      (await backend.readRange(path, { start, end })).data

    const hit = zipCache.get(path)
    if (hit && Date.now() - hit.at < ZIP_CACHE_TTL_MS) {
      return { src: withTail(hit.size, hit.tailStart, hit.tail, read), entries: hit.entries }
    }

    const tail = await backend.readRange(path, { suffix: ZIP_TAIL_BYTES })
    const src = withTail(tail.size, tail.start, tail.data, read)
    const entries = await readCentralDirectory(src)
    zipCache.set(path, {
      size: tail.size,
      tailStart: tail.start,
      tail: tail.data,
      entries,
      at: Date.now(),
    })
    prune()
    return { src, entries }
  }

  function requireThreeMf(path: string): void {
    if (!path.toLowerCase().endsWith('.3mf')) throw new BadRequest('只支持 .3mf 文件')
  }

  app.get('/api/files/3mf', async (req, reply) => {
    try {
      const path = queryPath(req)
      requireThreeMf(path)
      const { src, entries } = await openZip(path)
      const info = await describeThreeMf(src, entries)
      return { path, name: baseName(path), size: src.size, ...info }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get('/api/files/3mf/plate.png', async (req, reply) => {
    try {
      const path = queryPath(req)
      requireThreeMf(path)
      const raw = (req.query as Record<string, unknown>)?.plate
      const plate = Number(raw ?? 1)
      if (!Number.isInteger(plate) || plate < 1) throw new BadRequest('plate 必须是正整数')

      const { src, entries } = await openZip(path)
      const entry = plateImageEntry(entries, plate)
      if (!entry) return reply.code(404).send({ error: '该盘没有预览图' })

      const data = await readEntry(src, entry, MAX_PLATE_IMAGE_BYTES)
      return reply
        .header('content-type', 'image/png')
        .header('content-length', String(data.length))
        // 包内容按路径固定，短缓存能挡掉切盘时的重复取图
        .header('cache-control', 'private, max-age=300')
        .send(data)
    } catch (e) {
      return fail(reply, e)
    }
  })

  // ---- 导入与删除 ----
  /**
   * 上传后必须校验：改个扩展名就能把任意文件塞进打印机的 SD 卡，
   * 打印机自己不做检查。校验不过就删掉，不留垃圾。
   */
  async function verifyOrRemove(path: string) {
    try {
      const { src, entries } = await openZip(path)
      const info = await describeThreeMf(src, entries)
      if (!info.hasModel) throw new ZipFormatError('不是有效的 3MF：缺少 3D/3dmodel.model')
      return info
    } catch (e) {
      await backend.remove(path).catch(() => {})
      zipCache.delete(path)
      throw e
    }
  }

  app.post('/api/files/upload', async (req, reply) => {
    try {
      const mp = await (
        req as unknown as { file(): Promise<{ filename: string; file: Readable } | undefined> }
      ).file()
      if (!mp) throw new BadRequest('缺少文件')
      const name = safeName(mp.filename)
      const path = '/' + name
      await backend.uploadStream(path, mp.file)
      const info = await verifyOrRemove(path)
      return { path, name, size: await backend.stat(path).catch(() => 0), ...info }
    } catch (e) {
      return fail(reply, e)
    }
  })

  /**
   * 由桥接去取链接，而不是让手机先下载再上传 —— 桥接是有线千兆，
   * 手机上行往往才是瓶颈，移动网络下尤其明显。
   */
  app.post('/api/files/import', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { url?: unknown; name?: unknown }
      let url: URL
      try {
        url = new URL(String(body.url ?? ''))
      } catch {
        throw new BadRequest('链接格式不正确')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BadRequest('只支持 http/https 链接')
      }
      let fallback = ''
      try {
        fallback = decodeURIComponent(url.pathname)
      } catch {
        fallback = url.pathname
      }
      const name = safeName(body.name || fallback)

      let res: Response
      try {
        res = await fetch(url, { redirect: 'follow' })
      } catch (e) {
        // 兜底分支会把这类错误说成 "FTPS 失败"，与实际原因南辕北辙
        throw new BadRequest(`无法访问该链接：${(e as Error).message}`)
      }
      if (!res.ok || !res.body) throw new BadRequest(`下载失败：HTTP ${res.status}`)

      const path = '/' + name
      await backend.uploadStream(
        path,
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      )
      const info = await verifyOrRemove(path)
      return { path, name, size: await backend.stat(path).catch(() => 0), ...info }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete('/api/files', async (req, reply) => {
    try {
      const path = queryPath(req)
      await backend.remove(path)
      zipCache.delete(path)
      return { ok: true, path }
    } catch (e) {
      return fail(reply, e)
    }
  })

}

class BadRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequest'
  }
}
