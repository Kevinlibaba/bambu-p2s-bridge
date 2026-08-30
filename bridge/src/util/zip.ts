/**
 * 只读 ZIP 中央目录读取器。
 *
 * 3MF 就是一个 ZIP。我们要的只是包里的两三个小条目（预览图 PNG、slice_info.config），
 * 没有必要为此把整包搬到桥接机上，更不该搬到手机上 —— 所以这里按中央目录随机读取，
 * 解压交给 node:zlib 的 inflateRaw。全程零第三方依赖。
 *
 * 支持 ZIP64：切片产物一般远不到 4 GB，但读取器认不出 ZIP64 时会给出误导性的
 * "不是有效的 ZIP"，成本很低，索性一起处理掉。
 */
import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const inflate = promisify(inflateRaw)

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** EOCD 固定 22 字节，后面还可能跟最长 65535 字节的注释 */
const EOCD_SCAN_BYTES = 22 + 0xffff

/** 本地文件头的 extra 字段长度事先不知道，预读这么多，几乎总是够 */
const LOCAL_EXTRA_SLACK = 4096

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/**
 * 随机读取抽象，闭区间 [start, end]。
 * 生产环境由 FTP 的 REST 实现，测试里直接由 Buffer 实现 —— 这样 ZIP 逻辑不依赖打印机。
 */
export interface ZipSource {
  size: number
  read(start: number, end: number): Promise<Buffer>
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

/** 用 Buffer 直接做 source，测试与小文件走这条路 */
export function bufferSource(buf: Buffer): ZipSource {
  return {
    size: buf.length,
    async read(start, end) {
      return buf.subarray(Math.max(0, start), Math.min(buf.length, end + 1))
    },
  }
}

/**
 * 把已经读到手的尾部数据挡在 source 前面。
 * 中央目录基本都落在尾部这一段里，命中就不用再开一条 FTP 连接。
 */
export function withTail(
  size: number,
  tailStart: number,
  tail: Buffer,
  read: ZipSource['read'],
): ZipSource {
  return {
    size,
    async read(start, end) {
      if (start >= tailStart && end < tailStart + tail.length) {
        return tail.subarray(start - tailStart, end - tailStart + 1)
      }
      return read(start, end)
    },
  }
}

function u32(buf: Buffer, at: number): number {
  return buf.readUInt32LE(at)
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('ZIP64 数值超出安全整数范围')
  return Number(v)
}

/** ZIP64 扩展字段：0xffffffff 的字段按固定顺序在这里给出真值 */
function applyZip64Extra(extra: Buffer, e: ZipEntry): void {
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    const body = extra.subarray(p + 4, p + 4 + len)
    if (id === 0x0001) {
      let q = 0
      if (e.uncompressedSize === 0xffffffff && q + 8 <= body.length) {
        e.uncompressedSize = u64(body, q)
        q += 8
      }
      if (e.compressedSize === 0xffffffff && q + 8 <= body.length) {
        e.compressedSize = u64(body, q)
        q += 8
      }
      if (e.localHeaderOffset === 0xffffffff && q + 8 <= body.length) {
        e.localHeaderOffset = u64(body, q)
      }
      return
    }
    p += 4 + len
  }
}

/** 读并解析中央目录。通常只产生一次读取（尾部那一段）。 */
export async function readCentralDirectory(src: ZipSource): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipFormatError('不是有效的 ZIP：文件过小')

  const scan = Math.min(src.size, EOCD_SCAN_BYTES)
  const tailStart = src.size - scan
  const tail = await src.read(tailStart, src.size - 1)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipFormatError('不是有效的 ZIP：未找到中央目录结尾记录')

  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = u32(tail, eocd + 12)
  let cdOffset = u32(tail, eocd + 16)

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20
    if (loc < 0 || u32(tail, loc) !== SIG_EOCD64_LOCATOR) {
      throw new ZipFormatError('ZIP64 定位记录缺失')
    }
    const at = u64(tail, loc + 8)
    const rec = await src.read(at, at + 55)
    if (rec.length < 56 || u32(rec, 0) !== SIG_EOCD64) {
      throw new ZipFormatError('ZIP64 中央目录结尾记录无效')
    }
    count = u64(rec, 32)
    cdSize = u64(rec, 40)
    cdOffset = u64(rec, 48)
  }

  if (cdSize === 0) return []
  if (cdOffset + cdSize > src.size) throw new ZipFormatError('中央目录越界')

  const cd = await src.read(cdOffset, cdOffset + cdSize - 1)
  const entries: ZipEntry[] = []
  let p = 0
  while (p + 46 <= cd.length && u32(cd, p) === SIG_CENTRAL) {
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const entry: ZipEntry = {
      // ZIP 规范里路径分隔符恒为 /，个别打包器会带上前导斜杠
      name: cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/^\/+/, ''),
      method: cd.readUInt16LE(p + 10),
      compressedSize: u32(cd, p + 20),
      uncompressedSize: u32(cd, p + 24),
      localHeaderOffset: u32(cd, p + 42),
    }
    if (extraLen > 0) {
      applyZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry)
    }
    entries.push(entry)
    p += 46 + nameLen + extraLen + commentLen
  }

  if (count > 0 && entries.length === 0) throw new ZipFormatError('中央目录解析失败')
  return entries
}

/**
 * 取出单个条目并解压。
 *
 * maxBytes 是必需的：包是远端来的，不能让一个声称解压后有几个 G 的条目把桥接进程撑爆。
 */
export async function readEntry(src: ZipSource, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    throw new ZipFormatError(`条目过大: ${entry.name}`)
  }
  if (entry.compressedSize === 0) return Buffer.alloc(0)

  const nameLen = Buffer.byteLength(entry.name, 'utf8')
  const probeEnd = Math.min(
    src.size - 1,
    entry.localHeaderOffset + 30 + nameLen + LOCAL_EXTRA_SLACK + entry.compressedSize - 1,
  )
  const head = await src.read(entry.localHeaderOffset, probeEnd)
  if (head.length < 30 || u32(head, 0) !== SIG_LOCAL) {
    throw new ZipFormatError(`本地文件头无效: ${entry.name}`)
  }
  const dataAt = 30 + head.readUInt16LE(26) + head.readUInt16LE(28)

  let data: Buffer
  if (dataAt + entry.compressedSize <= head.length) {
    data = head.subarray(dataAt, dataAt + entry.compressedSize)
  } else {
    // 本地 extra 字段超出了预留空间，按精确偏移再读一次
    const abs = entry.localHeaderOffset + dataAt
    data = await src.read(abs, abs + entry.compressedSize - 1)
  }
  if (data.length !== entry.compressedSize) {
    throw new ZipFormatError(`条目数据不完整: ${entry.name}`)
  }

  if (entry.method === METHOD_STORE) return Buffer.from(data)
  if (entry.method === METHOD_DEFLATE) return await inflate(data)
  throw new ZipFormatError(`不支持的压缩方式 ${entry.method}: ${entry.name}`)
}

/** 按名字找条目，大小写不敏感 —— 切片器版本之间大小写并不完全一致 */
export function findEntry(entries: ZipEntry[], name: string): ZipEntry | null {
  const want = name.toLowerCase()
  return entries.find((e) => e.name.toLowerCase() === want) ?? null
}
