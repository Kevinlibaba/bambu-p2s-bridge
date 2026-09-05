/**
 * 最小 ZIP 写入器，专门用来「改包里的某一个条目，其余原样保留」。
 *
 * 为什么要自己写：项目零第三方依赖，而 node 没有内置的 ZIP 写入。要做的事又很窄 ——
 * 不需要通用打包器，只需要把读出来的条目按原顺序重新码一遍，中间换掉一两个。
 *
 * 为什么要保持原顺序：3MF 是 OPC 包，`[Content_Types].xml` 按规范应当在最前。
 * 打印机大概率不在乎，但重排一个能用的文件去赌这一点没有任何好处。
 *
 * 刻意不支持的：ZIP64（切片产物离 4GB 很远，超了直接报错而不是写出坏包）、
 * 加密、数据描述符（我们自己写的包，长度事先都知道，不需要）。
 */
import { deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { bufferSource, readCentralDirectory, readEntry, ZipFormatError } from './zip.js'

const deflate = promisify(deflateRaw)

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** ZIP 的 32 位字段上限。超过就不是这个写入器该处理的文件 */
const MAX_U32 = 0xffffffff

/** 单个条目解压后的上限，防着畸形包把内存吃光。gcode 常见十几 MB，给到 256MB */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

export interface ZipItem {
  name: string
  data: Buffer
  /** 不给就按原方法；新条目默认 deflate */
  method?: number
}

/** CRC-32（ZIP 用的那个多项式）。查表法，表只算一次 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Staged {
  name: Buffer
  data: Buffer
  method: number
  crc: number
  uncompressedSize: number
}

/**
 * 按给定顺序打出一个 ZIP。
 *
 * 时间戳一律写 0（1980-01-01）。真实修改时间对打印机没有意义，而写死能让
 * 同样的输入产出同样的字节 —— 出问题时可以直接比对两次产物。
 */
export async function writeZip(items: ZipItem[]): Promise<Buffer> {
  const staged: Staged[] = []
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8')
    const method = it.method ?? METHOD_DEFLATE
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipFormatError(`不支持的压缩方法: ${method}（条目 ${it.name}）`)
    }
    const data = method === METHOD_DEFLATE ? await deflate(it.data) : it.data
    staged.push({
      name,
      data,
      method,
      crc: crc32(it.data),
      uncompressedSize: it.data.length,
    })
  }

  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const s of staged) {
    if (offset > MAX_U32 || s.data.length > MAX_U32 || s.uncompressedSize > MAX_U32) {
      throw new ZipFormatError('文件超过 4GB，这个写入器不支持 ZIP64')
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0, 6) // 标志位：不用数据描述符，也不加密
    local.writeUInt16LE(s.method, 8)
    local.writeUInt16LE(0, 10) // 修改时间
    local.writeUInt16LE(0, 12) // 修改日期
    local.writeUInt32LE(s.crc, 14)
    local.writeUInt32LE(s.data.length, 18)
    local.writeUInt32LE(s.uncompressedSize, 22)
    local.writeUInt16LE(s.name.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度
    chunks.push(local, s.name, s.data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(SIG_CENTRAL, 0)
    cen.writeUInt16LE(20, 4) // 生成者版本
    cen.writeUInt16LE(20, 6) // 解压所需版本
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(s.method, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(s.crc, 16)
    cen.writeUInt32LE(s.data.length, 20)
    cen.writeUInt32LE(s.uncompressedSize, 24)
    cen.writeUInt16LE(s.name.length, 28)
    cen.writeUInt16LE(0, 30) // extra
    cen.writeUInt16LE(0, 32) // 注释
    cen.writeUInt16LE(0, 34) // 所在分卷
    cen.writeUInt16LE(0, 36) // 内部属性
    cen.writeUInt32LE(0, 38) // 外部属性
    cen.writeUInt32LE(offset, 42)
    central.push(cen, s.name)

    offset += local.length + s.name.length + s.data.length
  }

  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4) // 本分卷号
  eocd.writeUInt16LE(0, 6) // 中央目录起始分卷
  eocd.writeUInt16LE(staged.length, 8)
  eocd.writeUInt16LE(staged.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...chunks, cd, eocd])
}

/**
 * 换掉包里的若干条目，其余按原顺序原方法保留。
 *
 * `overrides` 里出现但包中没有的名字会被**追加**到末尾 —— 静默丢弃一个调用方
 * 明确要求写入的条目，比多一个条目危险得多。
 */
export async function patchZip(src: Buffer, overrides: Map<string, Buffer>): Promise<Buffer> {
  const source = bufferSource(src)
  const entries = await readCentralDirectory(source)
  const items: ZipItem[] = []
  const seen = new Set<string>()

  for (const e of entries) {
    seen.add(e.name)
    const replacement = overrides.get(e.name)
    items.push({
      name: e.name,
      data: replacement ?? (await readEntry(source, e, MAX_ENTRY_BYTES)),
      // 换过内容的条目一律重新 deflate；没换的沿用原方法，避免把
      // 本来 STORE 的东西（比如已经压过的 PNG）白压一遍
      method: replacement ? METHOD_DEFLATE : e.method,
    })
  }
  for (const [name, data] of overrides) {
    if (!seen.has(name)) items.push({ name, data })
  }
  return writeZip(items)
}
