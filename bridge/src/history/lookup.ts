/**
 * 从 SD 卡上的切片文件里补全预估克重与时长。
 *
 * 打印机上报的 file 只是 /data/Metadata/plate_8.gcode，看不出原始文件名；
 * 但 taskName 就是不带扩展名的文件名，据此回查即可。
 * 查不到就返回 null —— 历史记录本身不该因为这一步失败而写不进去。
 */
import * as ftp from '../printer/ftp.js'
import { readCentralDirectory, withTail } from '../util/zip.js'
import { describeThreeMf } from '../printer/threemf.js'

export async function lookupPlate(
  name: string,
  plate: number | null,
): Promise<{ weightG: number | null; estimateMin: number | null } | null> {
  if (!name || plate === null) return null
  // Studio 导出的是 xxx.gcode.3mf，手动上传的可能只有 xxx.3mf
  for (const suffix of ['.gcode.3mf', '.3mf']) {
    const path = `/${name}${suffix}`
    try {
      await ftp.stat(path)
      const read = async (start: number, end: number) =>
        (await ftp.readRange(path, { start, end })).data
      const tail = await ftp.readRange(path, { suffix: 96 * 1024 })
      const src = withTail(tail.size, tail.start, tail.data, read)
      const info = await describeThreeMf(src, await readCentralDirectory(src))
      const p = info.plates.find((x) => x.index === plate)
      if (!p) return null
      return {
        weightG: p.weight ?? null,
        estimateMin: p.prediction === null ? null : Math.round(p.prediction / 60),
      }
    } catch {
      // 换下一个后缀继续试
    }
  }
  return null
}
