/**
 * 用打印头把打完的件推下热床。
 *
 * 推件的是**整个打印头组件的前脸**，不是喷嘴尖 —— 喷嘴只探出 4.2mm，
 * 拿它当推头既够不着稍高的件，也把接触点顶到了重心之上。
 *
 * 前脸靠下有一个倒角，接触落在哪一段取决于件有多高。记推的高度为 z、
 * 喷嘴探出量 n=4.2、倒角自身高度 c：
 *
 *   z   < 件高 < z+n      喷嘴单独接触 —— 能推，但是个点
 *   z+n ≤ 件高 ≤ z+n+c    沿倒角的一条线 —— 能推（11.2mm 的件就是这种）
 *       件高 > z+n+c      整个竖直面 —— 最优
 *
 * 喷嘴是整个组件的最低点，所以不存在「太矮反被顶得爬上去」的高度区间，
 * 每一档都推得动。唯一的硬上限是龙门杆（喷嘴上方 32.5mm）。
 *
 * 这也定死了推的高度该取多少：要吃到整面需要 件高 > z+n+c，z 越低越容易
 * 够到；而喷嘴接触需要 件高 > z，z 越低越矮的件也能碰到。两头都指向
 * 尽量低，所以取 1mm。
 *
 * 这仍是有真实机械风险的动作 —— 真机上顶掉过一次前盖。所以这个模块只负责
 * 「算」和「生成」，不负责下发；下发要显式走另一条路。
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
  /**
   * 推的时候喷嘴离板面多高。缺省会按件高自动算：
   * 既要高到让壳体越过件顶（≥ 件高 − 4.2），又要低到在重心之下。
   * 显式给值就用给的值，不再自动推算。
   */
  pushZ?: number
  /** 横移高度 = maxZ + 这个间隙 */
  clearance?: number
  /** 推之前要等热床冷到多少度 */
  bedTarget?: number
  /** 推进速度 mm/min。慢一点，给件脱开的时间 */
  pushFeed?: number
  /**
   * 起点落在件后方多少 mm。
   *
   * 缺省是打印头半径 + 余量（72 + 15），不是随手取的 10mm。
   *
   * 「退到件后方」得让**整个打印头**都在件后方 —— 只让喷嘴在后方是不够的：
   * 降 Z 的那一刻壳体正压在件上方，抬床顶上去的是壳体。真机上就是这么
   * 把前盖顶掉的：退 10mm、降 Z，前盖直接撞在 11.2mm 高的件上。
   *
   * 顺序也因此固定为「先在远处降到推的高度，再平移过去推」，
   * 而不是「先移到件旁边再降 Z」。
   */
  approach?: number
  /** 推到哪个 Y。0 是前沿 */
  exitY?: number
  /**
   * 切片时的 brim 宽度（mm），取自 project_settings.config 的 brim_width。
   * 大于 0 就会告警 —— 见 hasBrim。
   */
  brimWidth?: number
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
  /**
   * 又长又窄。喷嘴只能顶住一个点，而件在推的方向上很浅、在垂直方向上很长 ——
   * 两端脱开的先后只要有一点差别，就会绕还粘着的那端转起来，原地打转而不是
   * 往前滑。实测：56×10mm 的长条转了 60-70 度。
   */
  | 'mayRotate'
/**
   * 件高过龙门杆。用壳体前脸推的话，件只要不超过杆高就行；
   * 超过了就会在推的过程中撞到杆上（杆在喷嘴上方 32.5mm）。
   */
  | 'tooTallForGantry'
  /** 件已经压在前沿上，推出去的行程很短 */
  | 'alreadyAtEdge'
  /** standalone 模式必须先回零，而 Z 探测点默认在床中心 —— 见 safeHomePoint */
  | 'homingHazard'
  /** 找不到能避开所有件的 Z 探测位置，standalone 模式无法安全执行 */
  | 'noSafeHomePoint'
  /**
   * 件带 brim。实测这是推不下去的主因：brim 只有一层（约 0.2mm），
   * 喷嘴在推的高度上整个从它上方飞过，从头到尾没碰到它 —— brim 不是
   * 被推走的，是被主体拽着走的。扯不断的那部分就成了橡皮筋，
   * 主体被推出去又被拉回来。
   */
  | 'hasBrim'

/**
 * error 表示这一条会让收菜做不成，warn 是「能做但要有心理准备」，
 * info 只是把将要发生的事说清楚。分级放在服务端 —— 哪条算硬伤属于
 * 领域判断，不该让每个客户端各猜一遍。
 */
export type EjectWarningLevel = 'error' | 'warn' | 'info'

const LEVELS: Record<EjectWarningCode, EjectWarningLevel> = {
  tooFlat: 'error',
  noApproachRoom: 'error',
  noSafeHomePoint: 'error',
  hasBrim: 'warn',
  mayRotate: 'warn',
  mayTipOver: 'warn',
  tooTallForGantry: 'warn',
  alreadyAtEdge: 'warn',
  // 不是问题，是告知：会先回零，且探测点已经避开了所有件
  homingHazard: 'info',
}

export interface EjectWarning {
  code: EjectWarningCode
  level: EjectWarningLevel
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

/*
 * 打印头的物理包络，取自 P2S 机器配置（切片器做「按件顺序打印」时用的
 * 就是这几个值，是机器自己声明的，不是估的）：
 *
 *   nozzle_height              4.2   喷嘴尖比周围结构低多少
 *   extruder_clearance_radius  72    打印头本体半径
 *
 * 「推头是个点」这个隐含假设就是在这里破掉的。喷嘴只探出 4.2mm，
 * 件只要比这高，顶上去的就是壳体而不是喷嘴 —— 真机上 11.2mm 的件在
 * Z=1 推，件顶高出喷嘴尖 10.2mm，全程是壳体在蹭，件只挪了几毫米。
 */
const NOZZLE_PROTRUSION = 4.2
const TOOLHEAD_RADIUS = 72
/** 龙门杆在喷嘴上方多高。件高过这个就会撞杆 */
const HEIGHT_TO_ROD = 32.5

/**
 * 在包络半径之外再留的余量。
 *
 * 72 是「刚好擦到」的距离，零余量。真机上顶掉过一次前盖，代价不是
 * 「重试一下」而是拆装维修，所以这里宁可保守。代价是可推区域缩小：
 * 件的后缘必须在 床深 − 72 − 15 = 169mm 以内。
 */
const TOOLHEAD_MARGIN = 15

const DEFAULTS: Required<EjectOptions> = {
  pushZ: 1,
  clearance: 5,
  bedTarget: 25,
  pushFeed: 1000,
  approach: TOOLHEAD_RADIUS + TOOLHEAD_MARGIN,
  exitY: 0,
  mode: 'endGcode',
  brimWidth: 0,
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * P2S 的 Z 轴回零就发生在这里 —— 床正中心。
 *
 * 取自机器自己的启动 G-code：
 *   G1 X128 Y128 F30000
 *   G28 Z P0 T400
 * 也就是说 G28 Z 探测的是**当前 XY 位置**，机器只是习惯性先挪到中心。
 * 件如果压在中心，直接发 G28 就是把喷嘴扎进件里 —— 实测遇到过：
 * 一个 69×79mm 的件居中摆放，正好把 (128,128) 罩住。
 */
const DEFAULT_Z_PROBE = { x: 128, y: 128 }


/**
 * Z 探测点离件至少留这么多余量。
 *
 * 一开始取的 15mm，只考虑了「喷嘴落点别压在件上」—— 这是错的。
 * Z 回零是床往上升到触发力传感器，而喷嘴不是一个点：打印头是个几十毫米
 * 大的组件。件只要在这个组件的投影范围内，就会先于喷嘴顶上去，
 * 力传感器照样触发，于是 Z=0 被设在高出板面「件高」那么多的位置。
 *
 * 实测代价：11.2mm 高的件、探测点离它 21mm，Z 基准整整高了一个件高，
 * 后面 G0 Z1 实际停在板面上方 12mm，喷嘴从件顶掠过，推了个空。
 * 从画面上看「推了但件没动」，很容易误判成附着力问题。
 */
const PROBE_MARGIN = TOOLHEAD_RADIUS

/** 点到某个 bbox 的最短距离，点在框内时为 0 */
function distToBox(x: number, y: number, [xmin, ymin, xmax, ymax]: Bbox): number {
  const dx = Math.max(xmin - x, 0, x - xmax)
  const dy = Math.max(ymin - y, 0, y - ymax)
  return Math.hypot(dx, dy)
}

/**
 * 找一个能安全探 Z 的位置。
 *
 * 既然 G28 Z 探的是当前 XY，那就先挪到空地再探。选点的标准是
 * **离所有件尽可能远**，而不是「尽可能靠近床中心」—— 后者是我一开始的
 * 想法（边角平整度差、Z 基准会偏），但那点偏差是零点几毫米，
 * 而探测点离件太近的代价是整整一个件高，差了两个数量级。
 */
export function safeHomePoint(
  objects: PlateObject[],
  bed: { width: number; depth: number },
  margin = PROBE_MARGIN,
): { x: number; y: number } | null {
  if (objects.length === 0) return { ...DEFAULT_Z_PROBE }

  const clearance = (x: number, y: number) =>
    Math.min(...objects.map((o) => distToBox(x, y, o.bbox)))

  const edge = 25
  let best: { x: number; y: number; d: number } | null = null
  for (let x = edge; x <= bed.width - edge; x += 10) {
    for (let y = edge; y <= bed.depth - edge; y += 10) {
      const d = clearance(x, y)
      if (!best || d > best.d) best = { x, y, d }
    }
  }
  if (!best || best.d < margin) return null
  return { x: best.x, y: best.y }
}

/**
 * 推的顺序：Y 最小的先推。
 *
 * 推的方向是 -Y（朝前门）。若先推后面的件，它一路会撞上前面那个；
 * 先把最靠前的推走，后面的路就是空的。X 不重叠时顺序无所谓，
 * 但统一按前后排不会错，就不去做重叠判断了。
 *
 * 倒角高度 c 没量过。它是「线接触」和「面接触」的分界，也就是要告诉别人
 * 「件做多高才最稳」时需要的那个数。
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
    warnings.push({ code: 'tooFlat', level: LEVELS.tooFlat, params: { maxZ: r2(geom.maxZ), pushZ: o.pushZ } })
  }

  /*
   * brim 比推的高度矮得多，喷嘴够不到它。真机首测就栽在这上面：
   * 主体被推出去，没扯断的 brim 又把它拉了回来。
   */
  if (o.brimWidth > 0 && objects.length > 0) {
    warnings.push({ code: 'hasBrim', level: LEVELS.hasBrim, params: { width: o.brimWidth, pushZ: o.pushZ } })
  }

  /*
   * 推的高度贴着板走。
   *
   * 推件的是**整个打印头组件的前脸**，不是喷嘴尖。喷嘴只探出 4.2mm，
   * 拿它当推头意味着接触点必须落在件高 4.2mm 以内的一小段上，
   * 件稍高一点就够不着 —— 之前为了迁就它把推的高度抬到「件高 − 4.2」，
   * 那反而把接触点顶到重心之上，件只会翻。
   *
   * 改成低位推：喷嘴离板 1mm，壳体前脸的下沿就在 5.2mm。件比这高的部分
   * 全由前脸承力。一个竖直的大平面比一个点稳得多 —— 件想翻，平面会在更高处
   * 顶回去，翻不起来；件想转，平面也约束着它。
   *
   * 代价是件不能高过龙门杆：杆在喷嘴上方 32.5mm。
   */
  if (objects.length > 0 && geom.maxZ > o.pushZ + HEIGHT_TO_ROD) {
    warnings.push({
      code: 'tooTallForGantry',
      level: LEVELS.tooTallForGantry,
      params: { maxZ: r2(geom.maxZ), limit: r2(o.pushZ + HEIGHT_TO_ROD) },
    })
  }

  const safeZ = r2(Math.max(geom.maxZ + o.clearance, o.pushZ + o.clearance))

  let homeAt: { x: number; y: number } | null = null
  if (o.mode === 'standalone' && objects.length > 0) {
    homeAt = safeHomePoint(objects, geom.bed)
    if (!homeAt) {
      // 没有能避开件的探测位置，硬回零就是撞机 —— 不生成任何动作
      warnings.push({ code: 'noSafeHomePoint', level: LEVELS.noSafeHomePoint })
      return { order: [], gcode: [], warnings }
    }
    warnings.push({ code: 'homingHazard', level: LEVELS.homingHazard, params: { x: homeAt.x, y: homeAt.y } })
  }

  for (const obj of frontFirst(objects)) {
    const [xmin, ymin, xmax, ymax] = obj.bbox
    const pushX = r2((xmin + xmax) / 2)
    const startY = r2(ymax + o.approach)

    if (startY > geom.bed.depth) {
      // 绕不到背后就只能放弃这一个，硬来会把喷嘴顶到件上
      warnings.push({
        code: 'noApproachRoom',
        level: LEVELS.noApproachRoom,
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
        level: LEVELS.mayTipOver,
        objectId: obj.id,
        params: { height: r2(geom.maxZ), depth: r2(depth) },
      })
    }

    /*
     * 推的方向上很浅、垂直方向上很长的件会打转。喷嘴是单点接触，
     * 约束不了旋转；两端脱开的先后稍有差别就变成一个力矩。
     */
    const width = xmax - xmin
    if (depth > 0 && width > depth * 3) {
      warnings.push({
        code: 'mayRotate',
        level: LEVELS.mayRotate,
        objectId: obj.id,
        params: { width: r2(width), depth: r2(depth) },
      })
    }

    if (ymin - o.exitY < 20) {
      warnings.push({ code: 'alreadyAtEdge', level: LEVELS.alreadyAtEdge, objectId: obj.id, params: { ymin: r2(ymin) } })
    }

    order.push({ id: obj.id, name: obj.name, pushX, startY })
  }

  return { order, gcode: render(order, safeZ, o, homeAt), warnings }
}

function render(
  order: EjectPlan['order'],
  safeZ: number,
  o: Required<EjectOptions>,
  homeAt: { x: number; y: number } | null = null,
): string[] {
  if (order.length === 0) return []
  const g: string[] = ['; ==== 推件开始 ====']

  if (o.mode === 'standalone' && homeAt) {
    /*
     * 打印早已结束、M18 把电机放了，不回零固件不会接受任何 G1。
     *
     * 但不能直接发 G28：这台机器的 Z 回零在床正中心探测（机器自己的
     * 启动 G-code 就是 G1 X128 Y128 然后 G28 Z），件压在那里就是撞机。
     * 好在从那段 G-code 也能看出 G28 Z 探的是**当前 XY** —— 机器只是
     * 习惯性先挪到中心。所以照它的做法来，只把落点换成避开件的空地：
     *   G28 X  →  挪到空地  →  G28 Z
     * 先回 X/Y 是安全的：此时床还停在低位，横移碰不到件。
     */
    g.push(
      '; standalone：打印已结束，电机被 M18 放掉了，必须先回零',
      'G28 X ; 只回 X/Y。此时床还在低位，横移不会碰到件',
      `G1 X${homeAt.x} Y${homeAt.y} F6000 ; 挪到避开所有件的空地再探 Z`,
      'G28 Z P0 ; 在当前位置探 Z —— 默认的床中心可能正压着件',
    )
  }

  g.push(
    'M400 ; 等前面的动作走完',
    `G0 Z${safeZ} F1200 ; 先抬到所有件之上，再开始横移`,
    /*
     * 三个降温风扇全开。编号取自机器自己的结束 G-code：
     *   M106 P2  远端零件冷却风扇
     *   M106 P3  腔体降温风扇
     *   M106 P10 左侧辅助风扇
     * 只靠自然散热的话，热床从 55℃ 降到环境温度要二十分钟以上。
     */
    'M106 P2 S255 ; 远端零件冷却风扇',
    'M106 P3 S255 ; 腔体降温风扇',
    'M106 P10 S255 ; 左侧辅助风扇',
    'M140 S0',
    // Marlin 里 M190 S 只在升温时等待，降温不等；等降温要用 M190 R。
    // 社区那份 P1S 方案用的是 S 并声称可用，但 Bambu 固件不是原版 Marlin，
    // 这条尚未验证。万一两条都不等待，就会在热床还烫的时候去推 —— 件推不动，
    // 力全顶在热端上。所以两条都发：R 若不被支持，S 至少是社区验证过的写法。
    // 真要更稳，应由调用方在下发之前自己确认 bed_temper 已经降下来。
    `M190 R${o.bedTarget} ; 等热床冷透 —— 不冷透件还粘在板上，推不动`,
    `M190 S${o.bedTarget} ; 兜底：固件若不认 R，这条至少是社区验证过的写法`,
    'M106 P2 S0',
    'M106 P3 S0',
    'M106 P10 S0',
  )

  /*
   * 降电流只包住「推」这一下，不包走位。
   *
   * 45% 电流下以 F12000 走位有丢步风险，而降电流要防的是件没脱开时
   * 硬顶 —— 那只发生在推的过程里。所以走位用满电流，推之前才降，
   * 推完立刻恢复。
   */
  for (const p of order) {
    g.push(
      `; -- ${p.name} --`,
      `G0 X${p.pushX} Y${p.startY} F12000 ; 满电流走位到件正后方`,
      `G0 Z${o.pushZ} F900 ; 降到推的高度`,
      'M17 X0.8 Y0.8 Z0.5 ; 推之前把电机电流降到 45%：件没脱开时丢步，而不是硬顶',
      `G1 Y${o.exitY} F${o.pushFeed} ; 推出前沿`,
      'M17 R ; 推完立刻恢复电流',
      `G0 Z${safeZ} F1200 ; 抬起`,
    )
  }

  g.push('M400', 'M17 R ; 兜底：确保电流已恢复', '; ==== 推件结束 ====')
  return g
}
