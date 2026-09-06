/**
 * 把推件序列写进打印任务自己的结束 G-code 里。
 *
 * 这是收菜的另一条路（plan.ts 里的 endGcode 模式）。standalone 模式的问题在于
 * 打印结束后 M18 已经把电机放掉、位置丢了，只能先 G28 —— 而 Z 回零靠喷嘴触碰
 * 热床探测，件要是压在探测点上就是一次撞击。注入到 M18 之前就没有这个问题：
 * 那一刻机器仍是归零的、电机带电，直接走位就行。
 *
 * 做法：把 plate_N.gcode 里最后一个 M18 之前插入序列，重算 plate_N.gcode.md5
 * （打印机会校验它），另存为一个新文件。不覆盖原文件 —— 原文件是没有收菜的
 * 干净版本，想不推的时候还要用它。
 *
 * 实测过 P2S 切片产物的结尾形态：
 *   M400
 *   M18
 *   M73 P100 R0
 *   ; EXECUTABLE_BLOCK_END
 * md5 文件内容是 32 位大写十六进制，末尾没有换行。
 */
import { createHash } from 'node:crypto'
import { bufferSource, findEntry, readCentralDirectory, readEntry } from '../util/zip.js'
import { patchZip } from '../util/zipwrite.js'

/** gcode 条目可能几十 MB */
const MAX_GCODE_BYTES = 512 * 1024 * 1024

export class InjectError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
    this.name = 'InjectError'
  }
}

/**
 * 在最后一个 `M18` 行之前插入若干行。找不到 M18 就拒绝 —— 不知道该往哪插的时候
 * 瞎插比不插危险：插到结束 G-code 中间可能落在 M400 之前、风扇还没关的时候。
 */
export function injectBeforeM18(gcode: string, lines: string[]): string {
  const rows = gcode.split('\n')
  let at = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^M18\s*(;.*)?\r?$/.test(rows[i])) { at = i; break }
  }
  if (at < 0) throw new InjectError('这个文件的结束 G-code 里找不到 M18，不知道该把推件序列插在哪')
  return [...rows.slice(0, at), ...lines, ...rows.slice(at)].join('\n')
}

/** 打印机校验用的 md5：大写、无换行 */
export function md5Upper(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex').toUpperCase()
}

/**
 * 生成带收菜的 3mf。返回新文件的字节。
 *
 * 只动两个条目（gcode 和它的 md5），其余原样 —— 缩略图、slice_info、
 * 作者参数都还在，打印机看到的就是一个普通的切片文件。
 */
export async function buildHarvestFile(src: Buffer, plate: number, sequence: string[]): Promise<Buffer> {
  const zsrc = bufferSource(src)
  const entries = await readCentralDirectory(zsrc)
  const gcodeName = `Metadata/plate_${plate}.gcode`
  const gcodeEntry = findEntry(entries, gcodeName)
  if (!gcodeEntry) throw new InjectError(`文件里没有第 ${plate} 盘的 gcode`)
  const md5Entry = findEntry(entries, `${gcodeName}.md5`)
  if (!md5Entry) throw new InjectError(`文件里没有第 ${plate} 盘的 md5，打印机会拒绝校验`)

  const original = (await readEntry(zsrc, gcodeEntry, MAX_GCODE_BYTES)).toString('utf8')
  // 已经注入过的不再叠加 —— 推两遍没有意义，还会把序列里的 M190 等两次
  if (original.includes('; ==== 推件开始 ====')) throw new InjectError('这个文件已经带收菜序列了')
  const patched = injectBeforeM18(original, sequence)
  const gcodeBuf = Buffer.from(patched, 'utf8')

  return patchZip(src, new Map([
    [gcodeEntry.name, gcodeBuf],
    [md5Entry.name, Buffer.from(md5Upper(gcodeBuf), 'ascii')],
  ]))
}

/** 产物文件名：原名去掉 .gcode.3mf，加 .harvest.gcode.3mf */
export function harvestName(path: string): string {
  return path.replace(/\.gcode\.3mf$/i, '') + '.harvest.gcode.3mf'
}
