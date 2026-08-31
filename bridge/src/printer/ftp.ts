import { Client, type FileInfo } from 'basic-ftp'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import { createTruncatedStream } from '../util/stream.js'
import { RangeNotSatisfiableError, resolveRange, type RangeSpec } from '../util/range.js'

/**
 * 打印机的 vsftpd 开了 require_ssl_reuse，数据连接必须复用控制连接的 TLS session。
 * basic-ftp 会自动处理（Python 的 ftplib 则需手动传 session）。
 */
async function connect(): Promise<Client> {
  const c = new Client(20_000)
  await c.access({
    host: config.printer.host,
    port: config.printer.ftpPort,
    user: 'bblp',
    password: config.printer.accessCode,
    secure: 'implicit',
    secureOptions: { rejectUnauthorized: false },
  })
  return c
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect()
  try {
    return await fn(c)
  } finally {
    c.close()
  }
}

export interface RemoteFile {
  name: string
  size: number
  isDirectory: boolean
  modifiedAt: string | null
}

/**
 * 每个 Range 请求都要单开一条 FTP 连接（REST 只能定起点，没法在一条连接上复用），
 * 而打印机能同时接受的连接数很有限。超过就直接拒绝，好过把打印机的 FTP 拖垮。
 */
const MAX_CONCURRENT_READS = 4
let activeReads = 0

export class TooManyReadsError extends Error {
  constructor() {
    super('并发读取已达上限，请稍后再试')
    this.name = 'TooManyReadsError'
  }
}

export class BadPathError extends Error {
  constructor(msg = '非法路径') {
    super(msg)
    this.name = 'BadPathError'
  }
}

function normalize(path: string): string {
  // 控制字符会被原样拼进 FTP 命令行，CRLF 等同于命令注入
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new BadPathError('路径含控制字符')

  /*
   * 路径穿越要按「路径段」判，不能用子串。
   * 原来写的是 path.includes('..')，把任何含两个连续点的文件名都当成攻击 ——
   * 「Cool Model....3mf」这种从模型站下下来的名字直接被拒，
   * 而它和 ../ 毫无关系。实测就是这个把导入卡住的。
   */
  const parts = path.split('/').filter((seg) => seg !== '' && seg !== '.')
  if (parts.some((seg) => seg === '..')) throw new BadPathError('路径不能包含上级目录')
  return '/' + parts.join('/')
}

/** 供路由层在进 FTP 之前就做同一套校验 */
export { normalize as normalizePath }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * 解析 Unix LIST 的日期。
 *
 * basic-ftp 只有走 MLSD 才会填 modifiedAt；这台打印机走的是 LIST，
 * 日期只出现在 rawModifiedAt 里，两种形态：
 *   "Jan 27 2026"    半年以前 —— 带年份，没有时刻
 *   "Aug 31 17:11"   半年以内 —— 带时刻，没有年份
 * 后一种得自己补年份：先按当年算，若落在未来（跨年了）就退一年。
 *
 * 时区是打印机本地的，报文里没有，这里按 UTC 解析。用来排序足够，
 * 但不要当成精确时刻展示。
 */
export function parseListDate(raw: string | undefined, now = new Date()): Date | null {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec((raw ?? '').trim())
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase())
  if (month < 0) return null
  const day = Number(m[2])
  if (day < 1 || day > 31) return null

  if (m[3]) return new Date(Date.UTC(Number(m[3]), month, day))

  const hh = Number(m[4])
  const mm = Number(m[5])
  if (hh > 23 || mm > 59) return null
  let d = new Date(Date.UTC(now.getUTCFullYear(), month, day, hh, mm))
  // 允许一天的余量：打印机与本机时区不同，边界上可能显得"稍微未来"
  if (d.getTime() - now.getTime() > 86400000) {
    d = new Date(Date.UTC(now.getUTCFullYear() - 1, month, day, hh, mm))
  }
  return d
}

export async function listDir(path = '/'): Promise<RemoteFile[]> {
  const dir = normalize(path)
  const items: FileInfo[] = await withClient((c) => c.list(dir))
  return items.map((f) => {
    // MLSD 会填 modifiedAt，LIST 只给 rawModifiedAt，两种都认
    const at = f.modifiedAt ?? parseListDate(f.rawModifiedAt)
    return {
      name: f.name,
      size: f.size,
      isDirectory: f.isDirectory,
      modifiedAt: at ? at.toISOString() : null,
    }
  })
}

/** 只走控制连接的 SIZE，不开数据连接 */
export async function stat(path: string): Promise<number> {
  const file = normalize(path)
  return withClient((c) => c.size(file))
}

export interface RemoteStream {
  /** 文件总大小 */
  size: number
  start: number
  /** 闭区间末字节 */
  end: number
  length: number
  stream: Readable
  /** 客户端提前断开时必须调用，否则这条 FTP 连接会一直挂着 */
  destroy(): void
}

/**
 * 按字节区间流式读取。
 *
 * SIZE 与 RETR 走同一条连接，所以调用方不必事先知道文件大小 —— 把客户端原样的
 * Range 意图（RangeSpec）交进来即可，对齐在这里完成。
 * 区间落在文件之外时抛 RangeNotSatisfiableError，其中带着真实大小供应答 416。
 */
export async function openRead(path: string, spec?: RangeSpec): Promise<RemoteStream> {
  const file = normalize(path)
  if (activeReads >= MAX_CONCURRENT_READS) throw new TooManyReadsError()

  activeReads += 1
  let released = false
  let client: Client | null = null
  const release = () => {
    if (released) return
    released = true
    activeReads -= 1
    client?.close()
  }

  try {
    client = await connect()
    const size = await client.size(file)
    const range = resolveRange(spec, size)
    if (!range) throw new RangeNotSatisfiableError(size)

    const length = range.end - range.start + 1
    const pipe = createTruncatedStream(length, release)

    // FTP 传输一旦开始就停不下来，只能靠 release() 销毁连接把它掐掉。
    // 提前收工时 downloadTo 必然以错误 reject，此时 finish 已是 no-op。
    void client.downloadTo(pipe.sink, file, range.start).then(
      () => pipe.finish(),
      (e: unknown) => pipe.finish(e as Error),
    )

    return {
      size,
      start: range.start,
      end: range.end,
      length,
      stream: pipe.out,
      destroy: () => pipe.finish(),
    }
  } catch (e) {
    release()
    throw e
  }
}

/** 读一小段到内存。ZIP 中央目录这类小体量随机读走这里，视频永远不要走。 */
export async function readRange(
  path: string,
  spec?: RangeSpec,
): Promise<{ size: number; start: number; data: Buffer }> {
  const s = await openRead(path, spec)
  const chunks: Buffer[] = []
  try {
    for await (const chunk of s.stream) chunks.push(Buffer.from(chunk as Buffer))
  } catch (e) {
    s.destroy()
    throw e
  }
  return { size: s.size, start: s.start, data: Buffer.concat(chunks) }
}

/**
 * 整包读进内存。只适用于 3MF 这类小文件。
 * 视频动辄 268 MB，一律走 openRead。
 */
export async function download(path: string): Promise<Buffer> {
  return (await readRange(path)).data
}

export async function upload(path: string, data: Buffer): Promise<void> {
  await uploadStream(path, Readable.from(data))
}

/**
 * 流式写入 —— 导入的切片文件动辄几十 MB，不能先读进内存再传。
 * 上传同样占用打印机的 FTP 连接，所以走和读取一样的并发闸门。
 */
export async function uploadStream(path: string, source: Readable): Promise<void> {
  const file = normalize(path)
  if (activeReads >= MAX_CONCURRENT_READS) throw new TooManyReadsError()
  activeReads++
  try {
    await withClient((c) => c.uploadFrom(source, file))
  } finally {
    activeReads--
  }
}

export class NotAFileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'NotAFileError'
  }
}

/** 删除文件。目录不走这里 —— 打印机上的目录都是系统目录，没有删除的理由。 */
export async function remove(path: string): Promise<void> {
  const file = normalize(path)
  if (file === '/') throw new NotAFileError('不能删除根目录')
  await withClient(async (c) => {
    const parent = file.slice(0, file.lastIndexOf('/')) || '/'
    const name = file.slice(file.lastIndexOf('/') + 1)
    const entry = (await c.list(parent)).find((f) => f.name === name)
    if (!entry) throw new NotAFileError('文件不存在', 404)
    if (entry.isDirectory) throw new NotAFileError('不能删除目录')
    await c.remove(file)
  })
}
