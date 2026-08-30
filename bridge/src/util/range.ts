/**
 * HTTP Range 解析与求解。
 *
 * 这里刻意拆成两步：解析不需要知道文件大小，求解才需要。
 * FTP 那边文件大小和数据连接是同一条链路上拿到的（SIZE 之后紧接着 RETR），
 * 先解析、后求解才能只开一条连接。
 */

/** 客户端请求的区间，尚未与文件大小对齐 */
export interface RangeSpec {
  start?: number
  /** 闭区间末字节 */
  end?: number
  /** bytes=-N 形式：末尾 N 字节 */
  suffix?: number
}

/** 已经与文件大小对齐的闭区间 */
export interface ByteRange {
  start: number
  end: number
}

export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'spec'; spec: RangeSpec }

/** 请求的区间落在文件之外。调用方应答 416 并带上 `Content-Range: bytes *\/size`。 */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super('请求的字节范围无法满足')
    this.name = 'RangeNotSatisfiableError'
  }
}

const DIGITS = /^\d+$/

/**
 * 解析 Range 头。
 *
 * 只支持单区间：multipart/byteranges 对播放场景没有价值，多区间一律按
 * RFC 9110 允许的方式忽略掉，整体返回 200。语法非法同样忽略。
 */
export function parseRangeHeader(header: string | undefined): ParsedRange {
  if (!header) return { kind: 'none' }
  const m = /^bytes\s*=\s*(.+)$/i.exec(header.trim())
  if (!m) return { kind: 'none' }

  const parts = m[1].split(',')
  if (parts.length !== 1) return { kind: 'none' }

  const spec = parts[0].trim()
  const dash = spec.indexOf('-')
  if (dash < 0) return { kind: 'none' }

  const rawStart = spec.slice(0, dash).trim()
  const rawEnd = spec.slice(dash + 1).trim()

  if (rawStart === '') {
    if (!DIGITS.test(rawEnd)) return { kind: 'none' }
    return { kind: 'spec', spec: { suffix: Number(rawEnd) } }
  }
  if (!DIGITS.test(rawStart)) return { kind: 'none' }
  if (rawEnd === '') return { kind: 'spec', spec: { start: Number(rawStart) } }
  if (!DIGITS.test(rawEnd)) return { kind: 'none' }
  return { kind: 'spec', spec: { start: Number(rawStart), end: Number(rawEnd) } }
}

/** 把请求区间对齐到实际文件大小。无法满足时返回 null。 */
export function resolveRange(spec: RangeSpec | undefined, size: number): ByteRange | null {
  if (size <= 0) return null
  if (!spec) return { start: 0, end: size - 1 }

  if (spec.suffix != null) {
    if (spec.suffix <= 0) return null
    return { start: Math.max(0, size - spec.suffix), end: size - 1 }
  }

  const start = spec.start ?? 0
  const end = spec.end != null ? Math.min(spec.end, size - 1) : size - 1
  if (start < 0 || start >= size || start > end) return null
  return { start, end }
}
