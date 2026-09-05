/**
 * 从 BambuStudio 自带的配置树里挑出 P2S 能用的 profile，并补齐 CLI 漏掉的部分。
 *
 * 这里最要紧的是 mergeGcodeTemplates —— 没有它切出来的文件是**不能打的**。
 *
 * 机器 profile（`Bambu Lab P2S 0.4 nozzle.json`）里一条 gcode 都没有：首尾段
 * 被拆在同名的 `... template machine_start_gcode.json` 等六个兄弟文件里。
 * Studio 自己按厂商索引把它们拼起来，而 CLI 用 `--load-settings <路径>` 加载时
 * 只跟 `inherits` 链走，不会去找这些兄弟文件。结果是切片器拿默认值兜底，生成：
 *
 *   起始：M190 S70 / M104 S250 / G28 / G1 Z5        ← 没有调平、没有 AMS 重映射
 *   结束：M104 S0 / G28 X0 / M84                     ← 没有把料退回 AMS
 *
 * 这两段都是实测确认过的。所以切片前先把六个模板合并进机器 profile，
 * 让切片器自己生成正确的首尾段 —— 比事后改写 gcode 再重算 md5 干净得多。
 *
 * 合并时 name / from / inherits 一个都不能动：CLI 会拿 name 去跟 3mf 里记录的
 * 打印机做兼容校验，改成「... merged」直接被拒
 * （`current 3mf file not support the new printer`）。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/** 厂商配置树在 AppImage 里的相对位置 */
const VENDOR_DIR = 'resources/profiles/BBL'

/** inherits 链最多往上翻这么多层，防着配置里出现环 */
const MAX_INHERIT_DEPTH = 8

/** 这台机器。整个项目只服务 P2S，不做多机型抽象 */
export const MACHINE_FAMILY = 'Bambu Lab P2S'

/**
 * `slice_info.config` 里的 printer_model_id 应有的值，取自
 * `machine/Bambu Lab P2S.json` 的 model_id。
 *
 * CLI 不填这个字段，而且往机器 profile 里塞 model_id 也没用 —— 实测过，
 * 它是从厂商预设包里查的。只能切完之后改 3mf（见 postprocess.ts）。
 */
export const PRINTER_MODEL_ID = 'N7'

export interface ProfileRef {
  /** profile 的 name 字段，也是展示用的名字 */
  name: string
  /** 绝对路径，直接喂给 --load-settings / --load-filaments */
  file: string
}

export interface MachineProfile extends ProfileRef {
  nozzle: number
}

/**
 * 把若干模板文件里的 gcode 键合并进机器 profile。
 *
 * 只取键名含 `gcode` 的字段，其余一概不动 —— 模板文件里还有 name/instantiation，
 * 覆盖过去会把机器名改掉，兼容校验就过不了了。
 */
export function mergeGcodeTemplates(
  base: Record<string, unknown>,
  templates: Record<string, unknown>[],
): Record<string, unknown> {
  const out = { ...base }
  for (const t of templates) {
    for (const [k, v] of Object.entries(t)) {
      if (k.includes('gcode')) out[k] = v
    }
  }
  return out
}

/**
 * 一个 profile 文件名是否属于指定喷嘴。
 *
 * 命名规律：带 `0.6 nozzle` 后缀的是该喷嘴专用；不带后缀的属于默认的 0.4。
 * 所以 0.4 要同时认两种写法，其余口径只认带后缀的。
 */
export function matchesNozzle(fileName: string, nozzle: number): boolean {
  const suffix = ` ${nozzle.toFixed(1)} nozzle.json`
  if (fileName.endsWith(suffix)) return true
  if (nozzle !== 0.4) return false
  return !/ \d\.\d nozzle\.json$/.test(fileName)
}

/** `<机器名> template <什么>.json` —— 属于这台机器的模板文件 */
export function isTemplateOf(fileName: string, machineName: string): boolean {
  return fileName.startsWith(`${machineName} template `) && fileName.endsWith('.json')
}

/**
 * 把继承链摊平成一份完整配置。
 *
 * **CLI 只覆盖文件里字面存在的键，`inherits` 一律不解析。** 这一条是实测钉死的：
 * 传 `0.08mm High Quality @BBL P2S.json` 进去，产物的 print_settings_id 变成了它，
 * 但 layer_height 仍是模型自带的 0.2 —— 因为 0.08 这个值在链上第二层的
 * `fdm_process_single_0.08` 里，叶子只是一份差异。
 *
 * 机器 profile 碰巧没被这个坑打中（printable_height 这些恰好写在叶子里），
 * 但 `extruder_clearance_radius` 就丢了，它只在父级。
 *
 * 从最远的祖先开始逐层覆盖，叶子最后写 —— 这样叶子的 name/from 一定是最终值。
 */
export async function flattenChain(
  dir: string,
  name: string,
  depth = 0,
): Promise<Record<string, unknown>> {
  if (depth > MAX_INHERIT_DEPTH) return {}
  let d: Record<string, unknown>
  try {
    d = JSON.parse(await readFile(path.join(dir, `${name}.json`), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
  const parent = typeof d.inherits === 'string' && d.inherits
    ? await flattenChain(dir, d.inherits, depth + 1)
    : {}
  const out = { ...parent, ...d }
  // 已经摊平了。留着 inherits 的话，万一将来某个版本真去解析它，就会被再叠一遍
  delete out.inherits
  return out
}

/** 去掉 `.json`，得到 profile 的展示名 */
function stem(fileName: string): string {
  return fileName.replace(/\.json$/, '')
}

export class SlicerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlicerUnavailableError'
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    throw new SlicerUnavailableError(`读不到切片器配置目录: ${dir}`)
  }
}

export class Profiles {
  private readonly vendor: string
  private readonly filamentIdCache = new Map<number, Map<string, ProfileRef>>()

  constructor(root: string) {
    this.vendor = path.join(root, VENDOR_DIR)
  }

  private dir(kind: 'machine' | 'process' | 'filament'): string {
    return path.join(this.vendor, kind)
  }

  /** 这台机器的各个喷嘴口径。文件名形如 `Bambu Lab P2S 0.4 nozzle.json` */
  async machines(): Promise<MachineProfile[]> {
    const files = await listJson(this.dir('machine'))
    const out: MachineProfile[] = []
    for (const f of files) {
      const m = new RegExp(`^${MACHINE_FAMILY} (\\d\\.\\d) nozzle\\.json$`).exec(f)
      if (!m) continue
      out.push({ name: stem(f), file: path.join(this.dir('machine'), f), nozzle: Number(m[1]) })
    }
    return out.sort((a, b) => a.nozzle - b.nozzle)
  }

  /** 层高等打印参数。只列出该喷嘴能用的 */
  async processes(nozzle: number): Promise<ProfileRef[]> {
    const files = await listJson(this.dir('process'))
    return files
      .filter((f) => f.includes(`@BBL P2S`) && matchesNozzle(f, nozzle))
      .map((f) => ({ name: stem(f), file: path.join(this.dir('process'), f) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 耗材。P2S 有一百多个，交给调用方去按 AMS 里的实际料筛 */
  async filaments(nozzle: number): Promise<ProfileRef[]> {
    const files = await listJson(this.dir('filament'))
    return files
      .filter((f) => f.includes(`@BBL P2S`) && matchesNozzle(f, nozzle))
      .map((f) => ({ name: stem(f), file: path.join(this.dir('filament'), f) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 顺着 `inherits` 链找出一个耗材 profile 的 filament_id。
   *
   * 机型专属的叶子（`Bambu PLA Basic @BBL P2S.json`）只是一份差异，实测 174 个
   * P2S 耗材 profile 里**没有一个**自带 filament_id —— 它在父级
   * `Bambu PLA Basic @base` 上。只读叶子的话整张表会全空。
   */
  private async resolveFilamentId(file: string, depth = 0): Promise<string | null> {
    if (depth > MAX_INHERIT_DEPTH) return null
    let d: Record<string, unknown>
    try {
      d = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
    const raw = d.filament_id
    const id = Array.isArray(raw) ? raw[0] : raw
    if (typeof id === 'string' && id) return id
    const parent = d.inherits
    if (typeof parent !== 'string' || !parent) return null
    return this.resolveFilamentId(path.join(path.dirname(file), `${parent}.json`), depth + 1)
  }

  /**
   * 生成把 `filament_id` 补进去的耗材 profile 内容。
   *
   * 跟机器 profile 的首尾 G-code 是同一个病根：叶子只是一份差异，filament_id
   * 在父级，而 CLI 按路径加载时不解析继承链。直接把叶子喂过去，切出来的文件
   * `slice_info.config` 里 `tray_info_idx` 是空的 —— 打印时 AMS 就只能按材料
   * 类型去猜该用哪一盘，而不是按厂商编号精确对上（见 PROTOCOL §5.4）。
   *
   * 实测：注入前 `tray_info_idx=""`，注入后 `GFG01`。
   */
  async mergedFilament(ref: ProfileRef): Promise<string> {
    // 摊平就把 filament_id 一起带进来了（它在父级），温度、流量这些同理
    return JSON.stringify(await flattenChain(this.dir('filament'), ref.name), null, 1)
  }

  /**
   * 摊平后的工艺 profile。
   *
   * **只在用户显式选了工艺时才用。** 默认不传摊平版是有意的：模型自带的
   * project_settings 是作者调好的，而摊平的标准 profile 会覆盖 67 个键，
   * 其中包括 `enable_support: 1 → 0` —— 把作者开的支撑关掉，悬空处直接打废。
   * 默认传未摊平的叶子，它几乎不定义什么键，等于不覆盖，作者的设置原样保留。
   */
  async mergedProcess(ref: ProfileRef): Promise<Record<string, unknown>> {
    return flattenChain(this.dir('process'), ref.name)
  }

  /**
   * `filament_id`（如 GFA01）到 profile 的索引。
   *
   * AMS 上报的 trayInfoIdx 和切片文件里的 tray_info_idx 是同一个东西，所以
   * 有了这张表就能按料盘里的实际耗材自动选 profile，而不是按类型名去猜 ——
   * 「PLA」对应十几个 profile，猜错一个温度就差几十度。
   *
   * P2S 有一百多个耗材 profile，每个还要往上翻父级，全读一遍上百毫秒，缓存起来。
   */
  async filamentIndex(nozzle: number): Promise<Map<string, ProfileRef>> {
    const cached = this.filamentIdCache.get(nozzle)
    if (cached) return cached
    const out = new Map<string, ProfileRef>()
    for (const ref of await this.filaments(nozzle)) {
      const key = await this.resolveFilamentId(ref.file)
      if (!key) continue
      // 同一个 filament_id 可能对应多个 profile（不同喷嘴变体等），先到先得：
      // filaments() 已按名字排序，取到的是稳定的那一个
      if (!out.has(key)) out.set(key, ref)
    }
    this.filamentIdCache.set(nozzle, out)
    return out
  }

  /**
   * 生成合并了首尾 G-code 的机器 profile 内容。
   *
   * 返回的是 JSON 文本，由调用方写进本次切片的临时目录 —— 厂商配置树是只读
   * 挂载的，也不该被我们污染。
   */
  async mergedMachine(machine: MachineProfile): Promise<string> {
    const base = await flattenChain(this.dir('machine'), machine.name)
    const files = await listJson(this.dir('machine'))
    const templates: Record<string, unknown>[] = []
    for (const f of files) {
      if (!isTemplateOf(f, machine.name)) continue
      templates.push(
        JSON.parse(await readFile(path.join(this.dir('machine'), f), 'utf8')) as Record<
          string,
          unknown
        >,
      )
    }
    if (templates.length === 0) {
      throw new SlicerUnavailableError(`找不到 ${machine.name} 的 G-code 模板，切出来的文件不能打`)
    }
    return JSON.stringify(mergeGcodeTemplates(base, templates), null, 1)
  }
}

/**
 * 换用一套工艺会改掉模型里的哪些关键设置。
 *
 * 摊平的标准 profile 会覆盖几十个键，绝大多数（速度、加速度、各种阈值）
 * 换了也就是换了。但有几个换掉的后果完全不同层级 —— `enable_support`
 * 从 1 变 0 意味着作者开的支撑没了，悬空处直接打废，而界面上一个字都不会说。
 *
 * 所以不替用户决定，把这几个摆出来让他自己看。Bambu Studio 里切换预设时
 * 勾选框会当场变化，用户看得见；这里没有界面，只能显式报出来。
 */
export const NOTABLE_KEYS = [
  'enable_support',
  'support_type',
  'layer_height',
  'sparse_infill_density',
  'wall_loops',
  'brim_type',
] as const

export interface SettingChange {
  key: string
  from: string
  to: string
}

/** 取出用于展示的标量值。这些键在配置里既可能是标量也可能是单元素数组 */
function scalar(v: unknown): string {
  if (Array.isArray(v)) return v.length === 1 ? String(v[0]) : v.join(',')
  return v === undefined || v === null ? '' : String(v)
}

/**
 * 比出关键设置的差异。只看 NOTABLE_KEYS，且只报**两边都有值**的键 ——
 * 模型里没有的键谈不上「被改掉」。
 */
export function notableChanges(
  model: Record<string, unknown>,
  process: Record<string, unknown>,
): SettingChange[] {
  const out: SettingChange[] = []
  for (const k of NOTABLE_KEYS) {
    const a = scalar(model[k])
    const b = scalar(process[k])
    if (!a || !b || a === b) continue
    out.push({ key: k, from: a, to: b })
  }
  return out
}
