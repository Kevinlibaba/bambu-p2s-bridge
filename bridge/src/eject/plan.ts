/**
 * 用打印头把打完的件推下热床。
 *
 * 这是有真实机械风险的动作 —— 推力经由喷嘴传递，是热端的侧向受力。
 * 所以这个模块只负责「算」和「生成」，不负责下发；下发要显式走另一条路。
 *
 * 两个前提比轨迹本身重要得多：
 *
 *  1. 热床必须冷透。PEI 板在热的时候附着力极强，不冷到 ~25℃ 根本推不动，
 *     硬推只会顶坏热端。所以序列里 M190 是必须的，不是可选项。
 *  2. 先把电机电流降下来（M17 X0.8 Y0.8 Z0.5，约 45%）。这样件万一没脱开，
 *     电机丢步而不是硬顶 —— 这是整个方案的安全底线。
 *
 * 数据来源是已有的 plate_N.json（bbox）和 gcode 头部的 max_z_height，
 * 不额外访问任何东西。文案照例只给 code，本地化交给前端。
 */

/** plate_N.json 里的 bbox，顺序是 [xmin, ymin, xmax, ymax]，床坐标 mm */
export type Bbox = [number, number, number, number]

export interface PlateObject {
  id: number
  name: string
  bbox: Bbox
}

export interface EjectGeometry {
  /** 热床可打印范围，P2S 是 256×256 */
  bed: { width: number; depth: number }
  /** gcode 头部的 max_z_height —— 整盘最高点，用来定安全横移高度 */
  maxZ: number
}

export interface EjectOptions {
  /** 推的时候喷嘴离板面多高。太高会推倒件，太低会蹭到板 */
  pushZ?: number
  /** 横移高度 = maxZ + 这个间隙 */
  clearance?: number
  /** 推之前要等热床冷到多少度 */
  bedTarget?: number
  /** 推进速度 mm/min。慢一点，给件脱开的时间 */
  pushFeed?: number
  /** 起点落在件后方多少 mm */
  approach?: number
  /** 推到哪个 Y。0 是前沿 */
  exitY?: number
  /**
   * 下发方式。
   *
   * endGcode —— 塞进打印任务的结束 G-code、M18 之前。那时机器仍已归零、
   *   电机带电，不需要 G28，也就没有「带件回中」的撞击风险。首选。
   * standalone —— 打印结束后单独下发。P2S 的结束 G-code 最后一条是 M18，
   *   电机已断电、位置丢失，所以必须先 G28。而 Z 轴回零是靠喷嘴触碰热床
   *   探测的，件要是压在探测点上就是一次撞击 —— 会连带一条告警。
   */
  mode?: 'endGcode' | 'standalone'
}

export type EjectWarningCode =
  /** 整盘最高点比推的高度还低，喷嘴够不到件 */
  | 'tooFlat'
  /** 件太靠后，后方没有足够空间让喷嘴绕到它背后 */
  | 'noApproachRoom'
  /** 又高又窄，推的时候大概率是翻倒而不是滑走 */
  | 'mayTipOver'
  /** 件已经压在前沿上，推出去的行程很短 */
  | 'alreadyAtEdge'
  /** standalone 模式必须先 G28，而 Z 轴回零靠喷嘴触碰热床，件压在探测点上就是撞击 */
  | 'homingHazard'

export interface EjectWarning {
  code: EjectWarningCode
  objectId?: number
  params?: Record<string, string | number>
}

export interface EjectPlan {
  /** 按推的先后排好序的件 */
  order: { id: number; name: string; pushX: number; startY: number }[]
  /** 生成的 G-code，逐行 */
  gcode: string[]
  warnings: EjectWarning[]
}

const DEFAULTS: Required<EjectOptions> = {
  pushZ: 1,
  clearance: 5,
  bedTarget: 25,
  pushFeed: 1000,
  approach: 10,
  exitY: 0,
  mode: 'endGcode',
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * 推的顺序：Y 最小的先推。
 *
 * 推的方向是 -Y（朝前门）。若先推后面的件，它一路会撞上前面那个；
 * 先把最靠前的推走，后面的路就是空的。X 不重叠时顺序无所谓，
 * 但统一按前后排不会错，就不去做重叠判断了。
 */
function frontFirst(objects: PlateObject[]): PlateObject[] {
  return [...objects].sort((a, b) => a.bbox[1] - b.bbox[1])
}

export function planEject(
  objects: PlateObject[],
  geom: EjectGeometry,
  opts: EjectOptions = {},
): EjectPlan {
  const o = { ...DEFAULTS, ...opts }
  const warnings: EjectWarning[] = []
  const order: EjectPlan['order'] = []

  // 整盘最高点都够不到，后面算什么都没意义
  if (geom.maxZ <= o.pushZ) {
    warnings.push({ code: 'tooFlat', params: { maxZ: r2(geom.maxZ), pushZ: o.pushZ } })
  }

  const safeZ = r2(Math.max(geom.maxZ + o.clearance, o.pushZ + o.clearance))

  if (o.mode === 'standalone' && objects.length > 0) {
    warnings.push({ code: 'homingHazard' })
  }

  for (const obj of frontFirst(objects)) {
    const [xmin, ymin, xmax, ymax] = obj.bbox
    const pushX = r2((xmin + xmax) / 2)
    const startY = r2(ymax + o.approach)

    if (startY > geom.bed.depth) {
      // 绕不到背后就只能放弃这一个，硬来会把喷嘴顶到件上
      warnings.push({
        code: 'noApproachRoom',
        objectId: obj.id,
        params: { needY: startY, bedDepth: geom.bed.depth },
      })
      continue
    }

    // 高度远大于进深的件，推的是上半身，会翻倒
    const depth = ymax - ymin
    if (depth > 0 && geom.maxZ > depth * 2) {
      warnings.push({
        code: 'mayTipOver',
        objectId: obj.id,
        params: { height: r2(geom.maxZ), depth: r2(depth) },
      })
    }

    if (ymin - o.exitY < 20) {
      warnings.push({ code: 'alreadyAtEdge', objectId: obj.id, params: { ymin: r2(ymin) } })
    }

    order.push({ id: obj.id, name: obj.name, pushX, startY })
  }

  return { order, gcode: render(order, safeZ, o), warnings }
}

function render(
  order: EjectPlan['order'],
  safeZ: number,
  o: Required<EjectOptions>,
): string[] {
  if (order.length === 0) return []
  const g: string[] = ['; ==== 推件开始 ====']

  if (o.mode === 'standalone') {
    // 打印早已结束、M18 把电机放了，不回零固件不会接受任何 G1
    g.push(
      '; standalone：打印已结束，电机被 M18 放掉了，必须先回零',
      '; 注意 Z 轴回零靠喷嘴触碰热床 —— 件压在探测点上会撞',
      'G28',
    )
  }

  g.push(
    'M400 ; 等前面的动作走完',
    'M17 X0.8 Y0.8 Z0.5 ; 电机电流降到 45%：件没脱开时丢步，而不是硬顶',
    `G0 Z${safeZ} F1200 ; 先抬到所有件之上，再开始横移`,
    'M106 P2 S255 ; 辅助风扇全速，加快热床降温',
    'M140 S0',
    // Marlin 里 M190 S 只在升温时等待，降温不等；等降温要用 M190 R。
    // 社区那份 P1S 方案用的是 S 并声称可用，但 Bambu 固件不是原版 Marlin，
    // 这条没有验证过。万一 S 不等待，就会在热床还烫的时候去推 —— 件推不动，
    // 力全顶在热端上。所以 standalone 模式不依赖它：桥接自己盯着 bed_temper，
    // 冷到目标值再下发后面的动作（见 waitForCool）。
    // endGcode 模式没有这个余地，只能靠固件，因此两条都发：R 若不被支持，
    // S 仍是社区验证过的行为。
    `M190 R${o.bedTarget} ; 等热床冷透 —— 不冷透件还粘在板上，推不动`,
    `M190 S${o.bedTarget} ; 兜底：固件若不认 R，这条至少是社区验证过的写法`,
    'M106 P2 S0',
  )

  for (const p of order) {
    g.push(
      `; -- ${p.name} --`,
      `G0 X${p.pushX} Y${p.startY} F12000 ; 绕到件正后方`,
      `G0 Z${o.pushZ} F900 ; 降到推的高度`,
      `G1 Y${o.exitY} F${o.pushFeed} ; 推出前沿`,
      `G0 Z${safeZ} F1200 ; 抬起`,
    )
  }

  g.push('M400', 'M17 R ; 恢复电机电流', '; ==== 推件结束 ====')
  return g
}
