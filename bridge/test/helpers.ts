/**
 * 脱机测试用的夹具：一个最小 ZIP 写入器，和一个内存版 FileBackend。
 *
 * 没有真机可用，所以 Range 与 3MF 这两块的正确性必须靠本地夹具证明：
 * ZIP 由这里现场合成（可用系统 unzip 交叉验证），文件后端由 Buffer 顶替。
 */
import { deflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import type { FileBackend } from '../src/api/files.js'
import { RangeNotSatisfiableError, resolveRange, type RangeSpec } from '../src/util/range.js'

// ---------- 最小 ZIP 写入器 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export interface ZipInput {
  name: string
  data: Buffer
  /** true 表示不压缩（method 0），默认 deflate（method 8） */
  store?: boolean
}

export function makeZip(files: ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const store = f.store ?? false
    const body = store ? f.data : deflateRawSync(f.data)
    const crc = crc32(f.data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(store ? 0 : 8, 8)
    lh.writeUInt16LE(0, 10) // time
    lh.writeUInt16LE(0x21, 12) // date (1980-01-01 是非法值，用一个合法的)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(store ? 0 : 8, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)

    offset += lh.length + name.length + body.length
  }

  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cd, eocd])
}

// ---------- 合成的 .gcode.3mf ----------

export const SLICE_INFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="01.09.05.51"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="C13"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="8130"/>
    <metadata key="weight" value="42.75"/>
    <metadata key="support_used" value="false"/>
    <object identify_id="102" name="bracket.stl" skipped="false"/>
    <object identify_id="118" name="cap.stl" skipped="false"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#2C2C2E" used_m="14.31" used_g="42.75"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="printer_model_id" value="C13"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="1260"/>
    <metadata key="weight" value="6.10"/>
    <metadata key="support_used" value="true"/>
    <object identify_id="204" name="spacer.stl" skipped="false"/>
    <filament id="2" tray_info_idx="GFG00" type="PETG" color="#FF9F0A" used_m="2.04" used_g="6.10"/>
  </plate>
</config>
`

/** 一个足够真实的 PNG 头，内容不重要，重要的是它能原样往返 */
export function fakePng(seed: number, bytes = 4096): Buffer {
  const png = Buffer.alloc(bytes)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  for (let i = 8; i < bytes; i++) png[i] = (i * 31 + seed * 17) & 0xff
  return png
}

export const PLATE_1_PNG = fakePng(1)
export const PLATE_2_PNG = fakePng(2, 9000)

export function makeThreeMf(): Buffer {
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: '3D/3dmodel.model', data: Buffer.from('<model><resources/></model>', 'utf8') },
    { name: 'Metadata/slice_info.config', data: Buffer.from(SLICE_INFO_XML, 'utf8') },
    // 图片走 store，模拟真实包里 PNG 不再二次压缩的情形
    { name: 'Metadata/plate_1.png', data: PLATE_1_PNG, store: true },
    { name: 'Metadata/plate_2.png', data: PLATE_2_PNG, store: true },
    { name: 'Metadata/plate_1.json', data: Buffer.from('{"layers":[]}', 'utf8') },
  ])
}

// ---------- 内存版 FileBackend ----------

export function memoryBackend(files: Record<string, Buffer>): FileBackend & {
  /** 打开过、但没被 destroy 的流数量。用来证明不会漏连接。 */
  openStreams(): number
} {
  let open = 0

  const sizeOf = (path: string): number => {
    const f = files[path]
    if (!f) throw new Error(`没有这个文件: ${path}`)
    return f.length
  }

  return {
    async listDir(path) {
      const prefix = path.endsWith('/') ? path : path + '/'
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({
          name: k.slice(prefix.length),
          size: files[k].length,
          isDirectory: false,
          modifiedAt: null,
        }))
    },
    async stat(path) {
      return sizeOf(path)
    },
    async openRead(path: string, spec?: RangeSpec) {
      const buf = files[path]
      if (!buf) throw new Error(`没有这个文件: ${path}`)
      const range = resolveRange(spec, buf.length)
      if (!range) throw new RangeNotSatisfiableError(buf.length)
      const slice = buf.subarray(range.start, range.end + 1)
      open += 1
      let closed = false
      const destroy = () => {
        if (!closed) {
          closed = true
          open -= 1
        }
      }
      const stream = Readable.from([slice])
      stream.on('end', destroy)
      stream.on('close', destroy)
      return {
        size: buf.length,
        start: range.start,
        end: range.end,
        length: slice.length,
        stream,
        destroy,
      }
    },
    async readRange(path: string, spec?: RangeSpec) {
      const s = await this.openRead(path, spec)
      const chunks: Buffer[] = []
      for await (const c of s.stream) chunks.push(Buffer.from(c as Buffer))
      return { size: s.size, start: s.start, data: Buffer.concat(chunks) }
    },
    openStreams: () => open,
  }
}
