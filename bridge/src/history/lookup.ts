/**
 * 从 SD 卡上的切片文件里补全预估克重与时长。
 *
 * 打印机上报的 file 只是 /data/Metadata/plate_8.gcode，看不出原始文件名；
 * taskName 接近文件名，但**不能直接拿来拼路径** —— 打印机已经把下划线
 * 换成了空格。盘上是 M107_Barret_Sniper_rifle.gcode.3mf，taskName 却是
 * 「M107 Barret Sniper rifle」，按名字拼出来的路径一律取不到。
 * 这正是界面上「N 单查不到耗材用量」的成因：凡是文件名带下划线的单，
 * 克重和预估时长全是 null。所以要去目录里按归一化后的名字找。
 *
 * 查不到就返回 null —— 历史记录本身不该因为这一步失败而写不进去。
 */
import * as ftp from '../printer/ftp.js'
import { readCentralDirectory, withTail } from '../util/zip.js'
import { describeThreeMf } from '../printer/threemf.js'
import { resolveJobFile } from './resolve.js'

export async function lookupPlate(
  name: string,
  plate: number | null,
): Promise<{ weightG: number | null; estimateMin: number | null } | null> {
  if (!name || plate === null) return null
  try {
    const root = await ftp.listDir('/')
    const path = resolveJobFile(
      name,
      root.map((f) => ({ name: f.name, isDirectory: f.isDirectory })),
    )
    if (!path) return null

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
    return null
  }
}
