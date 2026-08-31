/**
 * Bambu 切片产物 `.gcode.3mf` 的只读解析。
 *
 * 包内结构（Bambu Studio / Orca 一致）：
 *   Metadata/plate_N.png          每块热床的渲染预览图
 *   Metadata/plate_N_small.png    同上的小图
 *   Metadata/plate_N.json         逐层信息，这里用不到
 *   Metadata/slice_info.config    打印时长、耗材用量、逐盘信息（XML）
 *   3D/3dmodel.model              网格本体（XML），体积大，这里只探测存在性
 *
 * 只取预览图与 slice_info.config：这两样加起来几百 KB，覆盖了用户在手机上
 * 真正想确认的信息（这是哪个模型、要打多久、吃多少料）。网格不解析，理由见 README。
 */
import { findEntry, readEntry, type ZipEntry, type ZipSource } from '../util/zip.js'

/** slice_info.config 是纯文本 XML，几十 KB 封顶 */
const MAX_SLICE_INFO_BYTES = 4 * 1024 * 1024
/** 预览 PNG 实测在 200 KB 量级 */
export const MAX_PLATE_IMAGE_BYTES = 16 * 1024 * 1024

const SLICE_INFO = 'Metadata/slice_info.config'
const MODEL = '3D/3dmodel.model'

export interface ThreeMfFilament {
  /** 切片项目里的耗材序号，1 起。ams_mapping 的下标就是 id - 1 */
  id: number | null
  /** 耗材型号 ID，如 GFA01，用来和 AMS 里的料盘自动配对 */
  trayInfoIdx: string
  type: string
  /** #RRGGBB，直接给前端当色块 */
  color: string
  usedM: number | null
  usedG: number | null
}

export interface ThreeMfPlate {
  index: number
  /** 预计打印时长，秒 */
  prediction: number | null
  /** 预计耗材重量，克 */
  weight: number | null
  nozzleDiameters: string | null
  printerModel: string | null
  supportUsed: boolean | null
  objects: string[]
  filaments: ThreeMfFilament[]
  /**
   * 切片项目里一共定义了几种耗材 —— 不是这个盘用了几种。
   * ams_mapping 的长度必须等于它，缺项打印机会报「获取 AMS 映射表失败」。
   * 取自 slice_info.config 里的 filament_maps（形如 "1 1 1 1"）。
   */
  filamentCount: number
  /** 有没有可取的预览图。有则调用 /api/files/3mf/plate.png */
  hasThumbnail: boolean
}

export interface ThreeMfInfo {
  plates: ThreeMfPlate[]
  entryCount: number
  /** 包里是否带网格。带则说明这是完整 3MF，而不只是 G-code 壳。 */
  hasModel: boolean
  /** 没有 slice_info.config 时为 true，此时只能给出预览图 */
  metadataMissing: boolean
}

/** 极简属性抓取。slice_info.config 是切片器生成的定型 XML，不值得为它引一个 XML 库。 */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2]
  return out
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function bool(v: string | undefined): boolean | null {
  if (v == null) return null
  const s = v.trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return null
}

function normalizeColor(v: string | undefined): string {
  if (!v) return ''
  const s = v.trim()
  const hex = s.startsWith('#') ? s.slice(1) : s
  return /^[0-9a-fA-F]{6,8}$/.test(hex) ? '#' + hex.slice(0, 6).toUpperCase() : ''
}

/**
 * 解析 slice_info.config。纯函数，可脱机测试。
 *
 * 形如：
 *   <plate>
 *     <metadata key="index" value="1"/>
 *     <metadata key="prediction" value="4231"/>
 *     <metadata key="weight" value="18.62"/>
 *     <object identify_id="..." name="foo.stl" skipped="false"/>
 *     <filament id="1" type="PLA" color="#000000" used_m="6.21" used_g="18.62"/>
 *   </plate>
 */
/**
 * 项目耗材数。首选 filament_maps —— 它的元素个数就是项目里定义的耗材数；
 * 老文件没有这个字段时退回「这个盘用到的最大耗材序号」，至少保证
 * ams_mapping 覆盖得到被引用的那一个。
 */
function filamentCountOf(maps: string | undefined, filaments: ThreeMfFilament[]): number {
  const n = (maps ?? '').trim().split(/\s+/).filter(Boolean).length
  if (n > 0) return n
  return filaments.reduce((max, f) => Math.max(max, f.id ?? 0), 0)
}

export function parseSliceInfo(xml: string): ThreeMfPlate[] {
  const plates: ThreeMfPlate[] = []
  const blocks = xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/gi)

  let fallbackIndex = 0
  for (const block of blocks) {
    const body = block[1]
    fallbackIndex += 1

    const meta: Record<string, string> = {}
    for (const m of body.matchAll(/<metadata\b([^>]*?)\/?>/gi)) {
      const a = attrs(m[1])
      if (a.key) meta[a.key] = a.value ?? ''
    }

    const objects: string[] = []
    for (const m of body.matchAll(/<object\b([^>]*?)\/?>/gi)) {
      const a = attrs(m[1])
      if (a.name) objects.push(a.name)
    }

    const filaments: ThreeMfFilament[] = []
    for (const m of body.matchAll(/<filament\b([^>]*?)\/?>/gi)) {
      const a = attrs(m[1])
      filaments.push({
        id: num(a.id),
        trayInfoIdx: a.tray_info_idx ?? '',
        type: a.type ?? '',
        color: normalizeColor(a.color),
        usedM: num(a.used_m),
        usedG: num(a.used_g),
      })
    }

    plates.push({
      index: num(meta.index) ?? fallbackIndex,
      prediction: num(meta.prediction),
      weight: num(meta.weight),
      nozzleDiameters: meta.nozzle_diameters || null,
      printerModel: meta.printer_model_id || null,
      supportUsed: bool(meta.support_used),
      objects,
      filaments,
      filamentCount: filamentCountOf(meta.filament_maps, filaments),
      hasThumbnail: false,
    })
  }

  return plates.sort((a, b) => a.index - b.index)
}

/** 某一盘的预览图条目。优先大图，退而求其次用小图。 */
export function plateImageEntry(entries: ZipEntry[], index: number): ZipEntry | null {
  return (
    findEntry(entries, `Metadata/plate_${index}.png`) ??
    findEntry(entries, `Metadata/plate_${index}_small.png`)
  )
}

/** 从条目名反推有哪些盘 —— 缺 slice_info.config 时的兜底 */
function platesFromImages(entries: ZipEntry[]): number[] {
  const found = new Set<number>()
  for (const e of entries) {
    const m = /^metadata\/plate_(\d+)(_small)?\.png$/i.exec(e.name)
    if (m) found.add(Number(m[1]))
  }
  return [...found].sort((a, b) => a - b)
}

/** 读取并汇总。至多产生一次额外读取（slice_info.config）。 */
export async function describeThreeMf(src: ZipSource, entries: ZipEntry[]): Promise<ThreeMfInfo> {
  const infoEntry = findEntry(entries, SLICE_INFO)
  let plates: ThreeMfPlate[] = []

  if (infoEntry) {
    const xml = (await readEntry(src, infoEntry, MAX_SLICE_INFO_BYTES)).toString('utf8')
    plates = parseSliceInfo(xml)
  }

  if (plates.length === 0) {
    plates = platesFromImages(entries).map((index) => ({
      index,
      prediction: null,
      weight: null,
      nozzleDiameters: null,
      printerModel: null,
      supportUsed: null,
      objects: [],
      filaments: [],
      filamentCount: 0,
      hasThumbnail: false,
    }))
  }

  for (const p of plates) p.hasThumbnail = plateImageEntry(entries, p.index) !== null

  return {
    plates,
    entryCount: entries.length,
    hasModel: findEntry(entries, MODEL) !== null,
    metadataMissing: infoEntry === null,
  }
}
