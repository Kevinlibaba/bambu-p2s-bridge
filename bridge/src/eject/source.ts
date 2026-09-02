/**
 * 从打印机上的 3mf 里解出推件需要的三样东西。
 *
 * App 不该知道 bbox 是什么。它只知道「刚打完的那一单」，剩下的由这里补齐：
 *
 *   plate_N.json          → bbox_objects，件的位置和轮廓（床坐标 mm）
 *   plate_N.gcode 头部    → max_z_height，整盘最高点
 *   project_settings.config → brim_width，带 brim 的件推不动（实测过）
 *
 * 三处都在同一个 zip 里，读的都是很小的片段，所以一次打开顺路全取出来。
 */
import * as ftp from '../printer/ftp.js'
import {
  readCentralDirectory, readEntry, readEntryHead, withTail,
  type ZipEntry, type ZipSource,
} from '../util/zip.js'
import type { PlateObject } from './plan.js'

/** plate_N.json 里 bbox_objects 的上限。正常一盘几十个，给个上界防着畸形文件 */
const MAX_OBJECTS = 200
/*
 * 只解压 gcode 开头这么多字节。要在里面找两样东西：
 *   max_z_height  —— 文件头的注释，几 KB 内就有
 *   `; FEATURE: Brim` —— 第一层的开头，所以要读得比头部多一些
 * 256KB 解压后大约对应十几 KB 压缩数据，代价可以忽略。
 */
const GCODE_HEAD_BYTES = 256 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024

export interface EjectSource {
  objects: PlateObject[]
  maxZ: number
  brimWidth: number
}

function find(entries: ZipEntry[], name: string): ZipEntry | undefined {
  const lower = name.toLowerCase()
  return entries.find((e) => e.name.toLowerCase() === lower)
}

/** gcode 头部的 `; max_z_height: 11.20` */
export function parseMaxZ(head: string): number | null {
  const m = /^;\s*max_z_height:\s*([\d.]+)\s*$/m.exec(head)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * brim 宽度，取自 project_settings.config。
 *
 * 注意这只是**设置值**，不等于真的生成了 brim：brim_type=auto_brim 时由切片器
 * 逐件决定。实测就撞见过 brim_width=5 而 gcode 里一条 brim 挤出都没有的情况，
 * 照设置值报警就是误报。所以真正的判断以 gcode 为准（见 hasBrimExtrusion），
 * 这个函数只在读不到 gcode 时兜底。
 */
export function parseBrimWidth(json: string): number {
  try {
    const c = JSON.parse(json) as Record<string, unknown>
    if (c.brim_type === 'no_brim') return 0
    const v = Number(c.brim_width)
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    return 0
  }
}

/**
 * gcode 里有没有真的挤出 brim。
 *
 * 这是唯一可靠的判断 —— 设置里写着要 brim 不代表切片器真的加了。
 * brim 属于第一层且通常排在最前，所以在解压出来的头部里找得到。
 */
export function hasBrimExtrusion(head: string): boolean {
  return /^; FEATURE: Brim\s*$/im.test(head)
}

/** plate_N.json 里的 bbox_objects */
export function parsePlateObjects(json: string): PlateObject[] {
  let d: unknown
  try {
    d = JSON.parse(json)
  } catch {
    return []
  }
  const raw = (d as { bbox_objects?: unknown })?.bbox_objects
  if (!Array.isArray(raw)) return []
  const out: PlateObject[] = []
  for (const o of raw.slice(0, MAX_OBJECTS)) {
    const bbox = (o as { bbox?: unknown }).bbox
    if (!Array.isArray(bbox) || bbox.length !== 4) continue
    const nums = bbox.map(Number)
    if (nums.some((n) => !Number.isFinite(n))) continue
    // 退化成一条线或一个点的 bbox 没有意义，多半是解析出了问题
    if (nums[2] <= nums[0] || nums[3] <= nums[1]) continue
    out.push({
      id: Number((o as { id?: unknown }).id) || out.length + 1,
      name: String((o as { name?: unknown }).name ?? ''),
      bbox: [nums[0], nums[1], nums[2], nums[3]],
    })
  }
  return out
}

export class EjectSourceError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message)
    this.name = 'EjectSourceError'
  }
}

export async function readEjectSource(path: string, plate: number): Promise<EjectSource> {
  const read = async (start: number, end: number) =>
    (await ftp.readRange(path, { start, end })).data
  const tail = await ftp.readRange(path, { suffix: 96 * 1024 })
  const src: ZipSource = withTail(tail.size, tail.start, tail.data, read)
  const entries = await readCentralDirectory(src)

  const plateJson = find(entries, `Metadata/plate_${plate}.json`)
  if (!plateJson) throw new EjectSourceError(`这个文件里没有第 ${plate} 盘的轮廓数据`)
  const objects = parsePlateObjects(
    (await readEntry(src, plateJson, MAX_JSON_BYTES)).toString('utf8'),
  )
  if (objects.length === 0) throw new EjectSourceError('这一盘里没有可识别的零件轮廓')

  /*
   * max_z_height 在 gcode 的头部注释里。gcode 动辄几十 MB，只读开头几 KB，
   * 不要为了一行注释把整个条目解出来。
   */
  let maxZ: number | null = null
  let gcodeHead: string | null = null
  const gcode = find(entries, `Metadata/plate_${plate}.gcode`)
  if (gcode) {
    const head = await readEntryHead(src, gcode, GCODE_HEAD_BYTES).catch(() => null)
    if (head) {
      gcodeHead = head.toString('utf8')
      maxZ = parseMaxZ(gcodeHead)
    }
  }
  if (maxZ === null) throw new EjectSourceError('读不出这一盘的最高点（max_z_height）')

  /*
   * brim 以 gcode 里的实际挤出为准。设置里的 brim_width 只在读不到 gcode 时兜底 ——
   * auto_brim 会让设置值和实际生成对不上，照设置报警就是误报。
   */
  let brimWidth = 0
  if (gcodeHead !== null) {
    if (hasBrimExtrusion(gcodeHead)) {
      const settings = find(entries, 'Metadata/project_settings.config')
      const raw = settings ? await readEntry(src, settings, MAX_JSON_BYTES).catch(() => null) : null
      brimWidth = raw ? parseBrimWidth(raw.toString('utf8')) || 1 : 1
    }
  } else {
    const settings = find(entries, 'Metadata/project_settings.config')
    const raw = settings ? await readEntry(src, settings, MAX_JSON_BYTES).catch(() => null) : null
    if (raw) brimWidth = parseBrimWidth(raw.toString('utf8'))
  }

  return { objects, maxZ, brimWidth }
}
