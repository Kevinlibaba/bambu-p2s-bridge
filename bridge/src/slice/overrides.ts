/**
 * 让用户在模型作者的设置之上，只改自己关心的那几项。
 *
 * 这条路子成立，靠的正是 CLI 那个「只应用文件里字面存在的键」的特性
 * （见 profiles.ts 的 flattenChain）：把覆盖项合并进那个几乎是空的工艺叶子，
 * 传过去就只有这几个键生效，作者的层高之外的一切原样保留。
 *
 * 实测确认过：只覆盖 layer_height=0.12，产物里 enable_support 仍是作者的 1、
 * support_type 仍是 tree(auto)、wall_loops 仍是 3、填充仍是 15%。
 *
 * 为什么不做成「选一套预设」：预设是整套的，换过去会连支撑一起换掉
 * （标准工艺里 enable_support=0）。用户想要的是「层薄一点」，不是
 * 「顺便删掉我的支撑」。逐项覆盖没有这个副作用。
 *
 * 注意 `--load-settings` 每种类型只收一个文件 —— 想额外叠一个覆盖层会被
 * `duplicate process config file` 拒掉，所以只能合并进同一个文件。
 */

/** 用户能改的参数。刻意只开这几项 —— 每多一项都要想清楚它坏掉时会怎样 */
export interface SliceParams {
  /** 层高（mm）。范围随喷嘴口径变 */
  layerHeight?: number
  /** 填充密度，0-100 的百分数 */
  infillDensity?: number
  /** 支撑开关。作者开了支撑而这里关掉，悬空处会直接打废 */
  supports?: boolean
  /** 壁圈数 */
  wallLoops?: number
  /** 要不要 brim。带 brim 的件推不下热床（见收菜），所以值得能关 */
  brim?: boolean
}

/**
 * 层高相对喷嘴口径的上下限。
 *
 * 下限 20%：Bambu 自己给 0.4 喷嘴最细就到 0.08，正好是 20%。
 * 上限 75%：再厚层间就压不实了。
 *
 * 卡住上限还有个很实际的理由 —— 层高填小一位（比如 0.02）会让层数涨到几千，
 * 切片要跑很久，而机器上什么都还没发生。
 */
const LAYER_MIN_RATIO = 0.2
const LAYER_MAX_RATIO = 0.75

export class ParamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParamError'
  }
}

/** 层高在这个喷嘴口径下的合法区间，两端都含 */
export function layerRange(nozzle: number): { min: number; max: number } {
  const r = (x: number) => Math.round(x * 100) / 100
  return { min: r(nozzle * LAYER_MIN_RATIO), max: r(nozzle * LAYER_MAX_RATIO) }
}

function num(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new ParamError(`${name} 不是一个数`)
  return n
}

/**
 * 把用户填的参数转成配置里的键值。
 *
 * 配置里一律是字符串，连布尔也是 "0"/"1"、百分比带 `%` —— 写成数字类型
 * 切片器不认。返回的键会被合并进工艺 profile。
 */
export function toConfigKeys(p: SliceParams, nozzle: number): Record<string, string> {
  const out: Record<string, string> = {}

  if (p.layerHeight !== undefined) {
    const v = num(p.layerHeight, '层高')
    const { min, max } = layerRange(nozzle)
    if (v < min || v > max) {
      throw new ParamError(`层高要在 ${min}-${max}mm 之间（${nozzle}mm 喷嘴），给的是 ${v}`)
    }
    out.layer_height = String(v)
  }

  if (p.infillDensity !== undefined) {
    const v = num(p.infillDensity, '填充密度')
    if (v < 0 || v > 100) throw new ParamError(`填充密度要在 0-100 之间，给的是 ${v}`)
    // 小数在这里没有意义，取整免得写出 "15.7%" 这种
    out.sparse_infill_density = `${Math.round(v)}%`
  }

  if (p.wallLoops !== undefined) {
    const v = num(p.wallLoops, '壁圈数')
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      throw new ParamError(`壁圈数要是 1-10 的整数，给的是 ${p.wallLoops}`)
    }
    out.wall_loops = String(v)
  }

  if (p.supports !== undefined) out.enable_support = p.supports ? '1' : '0'

  /*
   * 关 brim 用 no_brim；开则用 auto_brim（由切片器逐件决定要不要加），
   * 而不是 outer_only —— 后者会给每个件都强加一圈。
   */
  if (p.brim !== undefined) out.brim_type = p.brim ? 'auto_brim' : 'no_brim'

  return out
}

/** 配置里这几个键对应的用户可读值，用来把作者的当前设置回给界面做默认值 */
export function fromConfig(cfg: Record<string, unknown>): SliceParams {
  const s = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? String(v[0]) : ''
    return v === undefined || v === null ? '' : String(v)
  }
  const out: SliceParams = {}

  /*
   * 先确认原始串非空再转数字 —— `Number('')` 是 0 而不是 NaN。填充密度 0 是个
   * 合法取值，光看数字分不出「作者设成了 0」和「作者根本没设」，界面就会显示
   * 一个作者从没定过的默认值。
   */
  const raw = (v: unknown): string | null => {
    const t = s(v).trim()
    return t === '' ? null : t
  }

  const lhs = raw(cfg.layer_height)
  if (lhs !== null) {
    const lh = Number(lhs)
    if (Number.isFinite(lh) && lh > 0) out.layerHeight = lh
  }

  const infs = raw(cfg.sparse_infill_density)
  if (infs !== null) {
    const inf = Number(infs.replace('%', ''))
    if (Number.isFinite(inf) && inf >= 0 && inf <= 100) out.infillDensity = inf
  }

  const wls = raw(cfg.wall_loops)
  if (wls !== null) {
    const wl = Number(wls)
    if (Number.isInteger(wl) && wl > 0) out.wallLoops = wl
  }

  const sup = s(cfg.enable_support)
  if (sup === '0' || sup === '1') out.supports = sup === '1'

  const brim = s(cfg.brim_type)
  if (brim) out.brim = brim !== 'no_brim'

  return out
}

/**
 * 只保留跟作者设置**不同**的那些覆盖项。
 *
 * 界面会把所有字段都发上来（它拿作者的值做默认），照单全收的话每次都会写进
 * 一堆其实没变的键。没变的键不写，产物就跟不改参数时逐字节一致，出问题时
 * 好比对；也让「这次改了什么」这个信息是准的。
 */
export function changedOnly(want: SliceParams, current: SliceParams): SliceParams {
  const out: SliceParams = {}
  for (const k of Object.keys(want) as (keyof SliceParams)[]) {
    const v = want[k]
    if (v === undefined) continue
    if (current[k] === v) continue
    // 浮点直接比会被 0.1+0.2 那类问题坑到，层高统一到两位小数再比
    if (typeof v === 'number' && typeof current[k] === 'number') {
      if (Math.abs(v - (current[k] as number)) < 1e-6) continue
    }
    ;(out[k] as unknown) = v
  }
  return out
}
