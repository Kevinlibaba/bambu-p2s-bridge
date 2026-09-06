/**
 * 切片前先验一遍模型文件是不是完整的。
 *
 * 起因是一次真实的失败：打印机上某个 3mf 有 7 段损坏（每段都从 512 字节扇区
 * 边界开始、长度是 1024 的整数倍，典型的块级损坏），切片器报出来的是
 *
 *     Error (not well-formed (invalid token)) while parsing '3D/3dmodel.model' at line 28283
 *
 * 这句话会把人引向「模型有问题」，而实际上是文件在存储上坏了 —— 换个模型重试
 * 一样会失败，重新上传这一个文件才有用。差别很大，值得在切片之前就说清楚。
 *
 * 只验 `3D/3dmodel.model` 这一条：它是切片器唯一必须完整解析的条目，也是块级
 * 损坏最容易打中的（它通常是包里最大的一块）。全包校验要把几十 MB 全解压一遍，
 * 换来的额外覆盖面很小。
 */
import { readFile } from 'node:fs/promises'
import { bufferSource, findEntry, readCentralDirectory, readEntry } from '../util/zip.js'

/** 3MF 规范规定的模型主体 */
export const MODEL_ENTRY = '3D/3dmodel.model'

/** 模型条目的解压上限。实测 4.5MB 的包解出来 4.7MB，给到 512MB */
const MAX_MODEL_BYTES = 512 * 1024 * 1024

export class ModelCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelCorruptError'
  }
}

/**
 * 校验模型条目能否完整解压。
 *
 * 解压失败几乎只有一个原因 —— 压缩数据被破坏了。zlib 的报错
 * （`invalid literal/length/distance code` 之类）对用户没有意义，这里换成
 * 能指导下一步动作的说法。
 */
export async function verifyModel(file: string): Promise<void> {
  const buf = await readFile(file)
  const src = bufferSource(buf)
  const entries = await readCentralDirectory(src).catch(() => null)
  if (!entries) {
    throw new ModelCorruptError('这个文件不是有效的 3mf 压缩包，可能在传输或存储中损坏了')
  }
  // 大小写不敏感：zip.ts 的 findEntry 注释里说明过，有的切片器版本会写成小写路径
  const model = findEntry(entries, MODEL_ENTRY)
  if (!model) {
    throw new ModelCorruptError(`包里没有 ${MODEL_ENTRY}，这不是一个 3mf 模型文件`)
  }
  let data: Buffer
  try {
    data = await readEntry(src, model, MAX_MODEL_BYTES)
  } catch {
    throw new ModelCorruptError(
      '模型数据已损坏，解压不出来。这是文件本身的问题，换个切片参数重试没有用 —— 请重新上传这个文件',
    )
  }
  if (data.length !== model.uncompressedSize) {
    throw new ModelCorruptError(
      `模型数据不完整（解出 ${data.length} 字节，应有 ${model.uncompressedSize} 字节），请重新上传这个文件`,
    )
  }
}

/**
 * 切片**产物**的完整性。
 *
 * 切片器被超时杀掉时可能正写到一半：文件在，中央目录还没写或者写了一半。
 * runSlice 只看「文件存不存在」，这种半成品会被当成功传上打印机。
 * 所以产物也要验：能读出中央目录，且至少有一盘 gcode。
 */
export async function verifySliced(file: string): Promise<void> {
  const buf = await readFile(file)
  const entries = await readCentralDirectory(bufferSource(buf)).catch(() => null)
  if (!entries) {
    throw new ModelCorruptError('切片产物不是完整的压缩包，多半是切片器中途被终止了')
  }
  if (!entries.some((e) => /^metadata\/plate_\d+\.gcode$/i.test(e.name))) {
    throw new ModelCorruptError('切片产物里没有任何一盘的 gcode')
  }
}
