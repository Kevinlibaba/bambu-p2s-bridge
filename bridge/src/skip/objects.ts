/**
 * 打印中跳过某个零件：零件清单与护栏。
 *
 * 一盘多件时某一件翘了，跳过它保住其余的。协议见 PROTOCOL.md §2.6 ——
 * 命令是 `{"print":{"command":"skip_objects","obj_list":[…]}}`，ID 取
 * `Metadata/slice_info.config` 里每个 `<object identify_id=…>`。
 *
 * **不要用 plate_N.json 的 bbox_objects[].id。** 那是另一套编号（同一个件
 * 实测一个是 899、一个是 757），只喂给 BambuStudio 的点选画布，命令不认。
 * 收菜那边用 bbox 是因为它要的是位置，不是身份 —— 两处各取所需，别混。
 *
 * 【已实现、未真机验证】：验证要牺牲一个真实零件，所以命令格式、护栏和
 * s_obj 的回读全部对照 BambuStudio 源码与打印机状态写成，没有在打印中
 * 真的发过一次。第一次真机使用时请守在机器旁。
 */
import * as ftp from '../printer/ftp.js'
import { findEntry, readCentralDirectory, readEntry, withTail, type ZipSource } from '../util/zip.js'

const SLICE_INFO = 'Metadata/slice_info.config'
/** slice_info.config 是几十 KB 封顶的 XML，这个上限只是防畸形文件 */
const MAX_SLICE_INFO_BYTES = 4 * 1024 * 1024
/** 一盘的零件数上限。正常几十个，给个上界防着畸形文件 */
const MAX_OBJECTS = 500

export interface SkipObject {
  /** slice_info.config 里的 identify_id，也就是 skip_objects 命令要的值 */
  id: number
  name: string
}

export interface SkipSource {
  objects: SkipObject[]
  /**
   * 这一盘切片时有没有打零件标签（label_object_enabled）。
   * 没有的话 G-code 里没有逐件标记，打印机无从跳过 —— Studio 只在
   * 一盘多件时才写 true，单件盘一律 false。
   */
  labelObjectEnabled: boolean
}

export class SkipError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'SkipError'
  }
}

/** 极简属性抓取，与 threemf.ts 一致：切片器生成的定型 XML，不值得引 XML 库 */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2]
  return out
}

/**
 * 从 slice_info.config 里解出第 plate 盘的零件清单。纯函数，可脱机测试。
 *
 * 没有这一盘返回 null —— 和「有这一盘但没有零件」区分开，
 * 前者是文件对不上，后者是切片产物本身如此。
 */
export function parseSkipSource(xml: string, plate: number): SkipSource | null {
  let fallbackIndex = 0
  for (const block of xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/gi)) {
    const body = block[1]
    fallbackIndex += 1

    const meta: Record<string, string> = {}
    for (const m of body.matchAll(/<metadata\b([^>]*?)\/?>/gi)) {
      const a = attrs(m[1])
      if (a.key) meta[a.key] = a.value ?? ''
    }
    const index = Number(meta.index)
    if ((Number.isFinite(index) ? index : fallbackIndex) !== plate) continue

    const objects: SkipObject[] = []
    for (const m of body.matchAll(/<object\b([^>]*?)\/?>/gi)) {
      const a = attrs(m[1])
      const id = Number(a.identify_id)
      // 没有 identify_id 的条目没法下命令，列出来只会误导
      if (!Number.isInteger(id)) continue
      if (objects.some((o) => o.id === id)) continue
      objects.push({ id, name: a.name ?? '' })
      if (objects.length >= MAX_OBJECTS) break
    }

    const label = (meta.label_object_enabled ?? '').trim().toLowerCase()
    return { objects, labelObjectEnabled: label === 'true' || label === '1' }
  }
  return null
}

/** /data/Metadata/plate_8.gcode → 8。解不出为 null */
export function plateOfFile(file: string): number | null {
  const m = /plate_(\d+)\.gcode/i.exec(file ?? '')
  return m ? Number(m[1]) : null
}

/** 允许下发的状态。PREPARE 阶段 G-code 还没开始走，命令去了也没有对象可跳 */
const SKIPPABLE = new Set(['RUNNING', 'PAUSE'])

export interface SkipGuardInput {
  /** gcode_state */
  state: string
  connected: boolean
  /** print.fun 第 49 位 */
  supported: boolean
  source: SkipSource
  /** print.s_obj —— 已经跳过的 */
  skipped: number[]
  /** 客户端给的原始 ids，形状不可信 */
  ids: unknown
}

/**
 * 护栏。全部在服务端强制，不信客户端。通过则返回真正要下发的 id 列表。
 *
 * 顺序有讲究：先看机器能不能收（连接、状态、能力），再看请求本身。
 * 打印机根本不在打印时，告诉用户「id 不对」只会把人带偏。
 */
export function planSkip(input: SkipGuardInput): number[] {
  if (!input.connected) throw new SkipError('打印机未连接', 503)
  if (!SKIPPABLE.has(input.state)) {
    throw new SkipError(`只能在打印中或暂停时跳过零件（当前 ${input.state}）`, 409)
  }
  if (!input.supported) throw new SkipError('这台打印机的固件不支持中途跳过零件', 409)
  if (!input.source.labelObjectEnabled) {
    throw new SkipError('这一盘切片时没有开启零件标签，无法单独跳过', 409)
  }

  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    throw new SkipError('ids 必须是非空数组')
  }
  const ids: number[] = []
  for (const raw of input.ids) {
    const id = Number(raw)
    if (!Number.isInteger(id)) throw new SkipError('ids 里必须都是整数')
    if (!input.source.objects.some((o) => o.id === id)) {
      throw new SkipError(`零件 ${id} 不在当前这一盘里`)
    }
    if (!ids.includes(id)) ids.push(id)
  }

  // 已经跳过的忽略；全是已跳过的就没什么可发的了
  const skipped = new Set(input.skipped)
  const fresh = ids.filter((id) => !skipped.has(id))
  if (fresh.length === 0) throw new SkipError('所选零件都已经跳过了', 409)

  /*
   * 跳过全部剩余零件不是「跳过」，是停止。BambuStudio 在这种情况下改发
   * print.stop；发一份全列表会让机器继续跑一单什么都不打的活。
   * 这里不替用户改成停止 —— 停止有自己的按钮和自己的确认。
   */
  const remaining = input.source.objects.filter((o) => !skipped.has(o.id))
  if (remaining.every((o) => fresh.includes(o.id))) {
    throw new SkipError('不能跳过全部剩余零件 —— 那等于停止打印，请直接停止', 409)
  }
  return fresh
}

/** 与 planSkip 配套的 MQTT 命令体，见 PROTOCOL.md §2.6 */
export function skipCommand(ids: number[]): { print: { command: 'skip_objects'; obj_list: number[] } } {
  return { print: { command: 'skip_objects', obj_list: ids } }
}

/*
 * 解析结果缓存，理由同 eject/source.ts：每次重读要走两次 FTP 范围读，
 * 而同一个文件的同一盘，零件清单不会变。打印中反复开弹层不该每次都等。
 */
const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX = 16
const cache = new Map<string, { at: number; value: SkipSource }>()

/** 仅供测试 */
export function clearSkipSourceCache(): void {
  cache.clear()
}

export async function readSkipSource(path: string, plate: number): Promise<SkipSource> {
  const key = `${path}|${plate}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const read = async (start: number, end: number) =>
    (await ftp.readRange(path, { start, end })).data
  const tail = await ftp.readRange(path, { suffix: 96 * 1024 })
  const src: ZipSource = withTail(tail.size, tail.start, tail.data, read)
  const entries = await readCentralDirectory(src)

  const entry = findEntry(entries, SLICE_INFO)
  if (!entry) throw new SkipError('这个文件里没有 slice_info.config，读不出零件清单', 404)
  const xml = (await readEntry(src, entry, MAX_SLICE_INFO_BYTES)).toString('utf8')
  const value = parseSkipSource(xml, plate)
  if (!value) throw new SkipError(`这个文件里没有第 ${plate} 盘`, 404)

  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  return value
}
