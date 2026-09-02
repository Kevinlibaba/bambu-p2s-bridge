import test from 'node:test'
import assert from 'node:assert/strict'
import { planEject, safeHomePoint, type PlateObject, type EjectGeometry } from '../src/eject/plan.js'

const BED: EjectGeometry = { bed: { width: 256, depth: 256 }, maxZ: 30 }

const obj = (id: number, bbox: [number, number, number, number], name = `o${id}`): PlateObject =>
  ({ id, name, bbox })

const codes = (p: ReturnType<typeof planEject>) => p.warnings.map((w) => w.code).sort()
const line = (p: ReturnType<typeof planEject>, re: RegExp) => p.gcode.find((l) => re.test(l))

/*
 * 起点要退到「整个打印头都在件后方」，不是「喷嘴在件后方」。
 * 打印头半径 72mm（机器配置里的 extruder_clearance_radius），
 * 只退 10mm 的话，降 Z 时壳体会先压到件上。
 */
test('起点按打印头半径退到件后方，X 取 bbox 中心', () => {
  const p = planEject([obj(1, [100, 80, 140, 160])], BED)
  assert.deepEqual(p.order, [{ id: 1, name: 'o1', pushX: 120, startY: 247 }])
  assert.match(line(p, /^G0 X120 Y247/)!, /F12000/)
  assert.ok(line(p, /^G1 Y0 F1000/), '要一路推到前沿')
})

/*
 * 推的方向是 -Y。先推后面那个的话，它会一路撞上前面那个 ——
 * 所以永远从最靠前的开始。
 */
test('多个件按从前到后的顺序推', () => {
  const p = planEject(
    [obj(1, [10, 120, 50, 160], '后'), obj(2, [10, 20, 50, 60], '前'), obj(3, [10, 75, 50, 105], '中')],
    BED,
  )
  assert.deepEqual(p.order.map((o) => o.name), ['前', '中', '后'])
})

/*
 * 打印头要整个退到件后方才能降 Z，而它半径 72mm。所以件的后缘必须落在
 * 床深 − 72 = 184mm 以内，再靠后就绕不过去了。这条约束是把 approach
 * 从随手取的 10mm 改成机器声明的 72mm 之后才暴露出来的。
 */
test('件的后缘超过 169mm 就够不着了', () => {
  const ok = planEject([obj(1, [10, 130, 50, 168])], BED)
  assert.equal(ok.order.length, 1, '168mm 还够得着')

  const bad = planEject([obj(1, [10, 130, 50, 170])], BED)
  assert.equal(bad.order.length, 0, '170mm 够不着')
  assert.ok(bad.warnings.some((w) => w.code === 'noApproachRoom'))
})

test('横移高度要高过整盘最高点', () => {
  const p = planEject([obj(1, [10, 20, 50, 70])], { ...BED, maxZ: 42 })
  assert.ok(line(p, /^G0 Z47 F1200/), '42 + 5 的间隙')
})

/*
 * 降电流只该包住「推」这一下。45% 电流下以 F12000 走位有丢步风险，
 * 而它要防的是件没脱开时硬顶 —— 那只发生在推的过程里。
 */
test('降电流紧贴着推，走位在满电流下完成', () => {
  const p = planEject([obj(1, [10, 20, 50, 70])], BED)
  const travel = p.gcode.findIndex((l) => l.startsWith('G0 X'))
  const lo = p.gcode.findIndex((l) => l.startsWith('M17 X0.8'))
  const push = p.gcode.findIndex((l) => l.startsWith('G1 Y0'))
  const hi = p.gcode.findIndex((l, i) => i > push && l.startsWith('M17 R'))
  assert.ok(travel < lo, '走位要在降电流之前完成')
  assert.ok(lo < push && push < hi, '推被降电流与恢复夹住')
})

test('每个件都各自降一次、恢复一次，末尾还有一道兜底', () => {
  const p = planEject([obj(1, [10, 20, 50, 60]), obj(2, [10, 110, 50, 160])], BED)
  assert.equal(p.order.length, 2, '两个件都该够得着')
  assert.equal(p.gcode.filter((l) => l.startsWith('M17 X0.8')).length, 2)
  assert.equal(p.gcode.filter((l) => l.startsWith('M17 R')).length, 3, '两次恢复 + 一次兜底')
  assert.ok(p.gcode[p.gcode.length - 2].startsWith('M17 R'), '最后一定以恢复电流收尾')
})

test('推之前一定要等热床冷透', () => {
  const p = planEject([obj(1, [10, 20, 50, 70])], BED, { bedTarget: 22 })
  const wait = p.gcode.findIndex((l) => /^M190 [RS]22/.test(l))
  assert.ok(wait >= 0, '必须有等待降温')
  assert.ok(wait < p.gcode.findIndex((l) => l.startsWith('G1 Y0')), '等待要在推之前')
})

test('整盘最高点低于推的高度时报 tooFlat —— 喷嘴够不到件', () => {
  const p = planEject([obj(1, [10, 20, 50, 70])], { ...BED, maxZ: 0.6 }, { pushZ: 1 })
  assert.ok(codes(p).includes('tooFlat'))
})

test('件贴着后沿时放弃它，而不是把喷嘴顶上去', () => {
  const p = planEject([obj(1, [10, 20, 50, 200])], BED)
  assert.equal(p.order.length, 0, '绕不到背后就不生成动作')
  assert.ok(codes(p).includes('noApproachRoom'))
  assert.deepEqual(p.gcode, [], '没有可推的件就不该吐出任何 G-code')
})

test('又高又窄的件提示可能翻倒', () => {
  const p = planEject([obj(1, [10, 100, 50, 110])], { ...BED, maxZ: 60 })
  assert.ok(codes(p).includes('mayTipOver'))
  const tall = p.warnings.find((w) => w.code === 'mayTipOver')!
  assert.equal(tall.objectId, 1)
})

test('已经贴在前沿的件提示行程很短', () => {
  const p = planEject([obj(1, [10, 5, 50, 60])], BED)
  assert.ok(codes(p).includes('alreadyAtEdge'))
})

/*
 * P2S 的结束 G-code 最后一条是 M18，电机断电、位置丢失。
 * 所以事后单独下发必须先 G28 —— 而 Z 轴回零靠喷嘴触碰热床，
 * 件压在探测点上就是一次撞击。这条风险必须显式吐给用户。
 */
/*
 * 这台机器的 Z 回零在床正中心探测 —— 机器自己的启动 G-code 就是
 *   G1 X128 Y128 / G28 Z P0 T400
 * 件压在中心时直接发 G28 就是把喷嘴扎进件里。实测遇到过：一个
 * 69×79mm 的漏斗居中摆放，正好把 (128,128) 罩住。
 */
/*
 * Z 回零是床往上升到触发力传感器。喷嘴不是一个点 —— 打印头是个几十毫米
 * 大的组件，件只要在它的投影范围内就会先顶上去，Z 基准直接偏掉一个件高。
 * 真机上就是这么栽的：11.2mm 的件、探测点只离它 21mm，后面 G0 Z1 实际
 * 停在板面上方 12mm，喷嘴从件顶掠过，推了个空。
 */
const clearanceOf = (pt: { x: number; y: number }, b: [number, number, number, number]) => {
  const dx = Math.max(b[0] - pt.x, 0, pt.x - b[2])
  const dy = Math.max(b[1] - pt.y, 0, pt.y - b[3])
  return Math.hypot(dx, dy)
}

test('探测点要离件足够远，21mm 那种距离必须被拒绝', () => {
  const bar: [number, number, number, number] = [86.5, 96.7, 142.7, 106.7]
  const pt = safeHomePoint([obj(1, bar)], BED.bed)!
  assert.ok(pt, '应当找得到落点')
  assert.ok(clearanceOf(pt, bar) >= 70,
    `落点 ${JSON.stringify(pt)} 离件只有 ${clearanceOf(pt, bar).toFixed(1)}mm`)
})

test('没有件时用默认的床中心', () => {
  assert.deepEqual(safeHomePoint([], BED.bed), { x: 128, y: 128 })
})

test('选的是离件最远的点，不是最靠近中心的点', () => {
  const bar: [number, number, number, number] = [86.5, 96.7, 142.7, 106.7]
  const pt = safeHomePoint([obj(1, bar)], BED.bed)!
  // 中心 (128,128) 离件只有 21mm，绝不能被选中
  assert.ok(!(pt.x === 128 && pt.y === 128))
})

test('件占掉大半个床时找不到足够远的落点 —— 宁可什么都不做', () => {
  const p = planEject([obj(1, [5, 5, 251, 251])], BED, { mode: 'standalone' })
  assert.ok(codes(p).includes('noSafeHomePoint'))
  assert.deepEqual(p.gcode, [], '撞机风险面前不生成任何动作')
})

test('standalone 模式按机器自己的做法回零：先 X，挪到空地，再探 Z', () => {
  const p = planEject([obj(1, [93, 87, 162, 166])], BED, { mode: 'standalone' })
  const gx = p.gcode.findIndex((l) => l.startsWith('G28 X'))
  const move = p.gcode.findIndex((l) => l.startsWith('G1 X'))
  const gz = p.gcode.findIndex((l) => l.startsWith('G28 Z'))
  assert.ok(gx >= 0 && move > gx && gz > move, '顺序必须是 G28 X → 移动 → G28 Z')
  assert.ok(!p.gcode.some((l) => l.trim() === 'G28'), '不能出现裸的 G28 —— 那会在床中心探测')
  assert.ok(codes(p).includes('homingHazard'))
  assert.ok(gz < p.gcode.findIndex((l) => l.startsWith('G0 Z')), '回零必须在任何 Z 移动之前')
})

test('endGcode 模式不含 G28，也不报回中风险', () => {
  const p = planEject([obj(1, [10, 20, 50, 70])], BED)
  assert.ok(!p.gcode.includes('G28'))
  assert.ok(!codes(p).includes('homingHazard'))
})

test('没有件时什么都不生成，也不报回中风险', () => {
  const p = planEject([], BED, { mode: 'standalone' })
  assert.deepEqual(p.gcode, [])
  assert.deepEqual(p.warnings, [])
})

/*
 * 真机首测的失败原因：件带 5mm 的 brim。brim 只有一层（约 0.2mm），
 * 喷嘴在 Z=1 推的时候整个从它上方飞过，从头到尾没碰到它 —— brim 不是
 * 被推走的，是被主体拽着走的。扯不断的那部分成了橡皮筋，把主体拉了回来。
 */
test('件带 brim 时告警 —— 这是推不下去的主因', () => {
  const p = planEject([obj(1, [93, 87, 162, 166])], BED, { brimWidth: 5 })
  assert.ok(codes(p).includes('hasBrim'))
  const w = p.warnings.find((x) => x.code === 'hasBrim')!
  assert.deepEqual(w.params, { width: 5, pushZ: 1 })
})

test('没有 brim 就不告警', () => {
  assert.ok(!codes(planEject([obj(1, [93, 87, 162, 166])], BED)).includes('hasBrim'))
  assert.ok(!codes(planEject([obj(1, [93, 87, 162, 166])], BED, { brimWidth: 0 })).includes('hasBrim'))
})

test('没有件时即使给了 brim 宽度也不告警', () => {
  assert.deepEqual(planEject([], BED, { brimWidth: 5 }).warnings, [])
})

test('三个降温风扇都要开，并且事后都要关', () => {
  const g = planEject([obj(1, [10, 20, 50, 70])], BED).gcode
  for (const p of ['P2', 'P3', 'P10']) {
    assert.ok(g.includes(`M106 ${p} S255`) || g.some((l) => l.startsWith(`M106 ${p} S255`)),
      `缺少 M106 ${p} S255`)
    assert.ok(g.some((l) => l.startsWith(`M106 ${p} S0`)), `缺少 M106 ${p} S0`)
  }
  // 关风扇必须在推之前 —— 推的时候还在猛吹没有意义，也吵
  const push = g.findIndex((l) => l.startsWith('G1 Y0'))
  assert.ok(g.findIndex((l) => l.startsWith('M106 P3 S0')) < push)
})

/*
 * 实测第三轮：56×10mm 的长条被推动了，但绕着还粘住的那端转了 60-70 度，
 * 原地打转而不是往前滑。喷嘴是单点接触，约束不了旋转。
 */
test('又长又窄的件告警会打转', () => {
  const p = planEject([obj(1, [86.5, 96.7, 142.7, 106.7])], { ...BED, maxZ: 11.2 })
  assert.ok(codes(p).includes('mayRotate'))
  const w = p.warnings.find((x) => x.code === 'mayRotate')!
  assert.deepEqual(w.params, { width: 56.2, depth: 10 })
})

test('接近方形的件不报打转', () => {
  assert.ok(!codes(planEject([obj(1, [93, 87, 162, 166])], BED)).includes('mayRotate'))
})

/*
 * 机器配置声明 nozzle_height = 4.2：喷嘴只比周围结构低这么多。
 * 要让喷嘴而不是壳体接触件，推的高度得 ≥ 件高 − 4.2；
 * 要让件滑而不是翻，又得低于重心（件高的一半）。
 * 两者同时成立需要 件高 < 8.4mm。真机上 11.2mm 的件就卡在做不到的区间。
 */
/*
 * 推件的是打印头前脸，不是喷嘴尖。所以推的高度贴着板走（1mm），
 * 让前脸的下沿（5.2mm）去承力 —— 竖直大平面比一个点稳得多。
 * 之前为了迁就喷嘴把高度抬到「件高 − 4.2」，反而把接触点顶到重心之上。
 */
test('推的高度贴着板，不随件高变化', () => {
  for (const maxZ of [4, 11.2, 25]) {
    const p = planEject([obj(1, [10, 20, 50, 70])], { ...BED, maxZ })
    assert.ok(line(p, /^G0 Z1 F900/), `maxZ=${maxZ} 时推的高度应为 1mm`)
  }
})

test('件高过龙门杆时告警', () => {
  const ok = planEject([obj(1, [10, 20, 50, 70])], { ...BED, maxZ: 30 })
  assert.ok(!codes(ok).includes('tooTallForGantry'), '30mm 还在杆下')

  const bad = planEject([obj(1, [10, 20, 50, 70])], { ...BED, maxZ: 40 })
  assert.ok(codes(bad).includes('tooTallForGantry'))
  assert.equal(bad.warnings.find((w) => w.code === 'tooTallForGantry')!.params!.limit, 33.5)
})

test('Z 探测点的余量用机器声明的打印头半径 72mm', () => {
  const bar: [number, number, number, number] = [86.5, 96.7, 142.7, 106.7]
  const pt = safeHomePoint([obj(1, bar)], BED.bed)!
  assert.ok(clearanceOf(pt, bar) >= 72)
})

/*
 * 事故复盘：退 10mm 就降 Z，壳体正压在件上方，抬床顶掉了前盖。
 * 顺序必须是「先在远处降到推的高度，再平移过去推」。
 */
test('降 Z 必须发生在远离件的位置，而不是件旁边', () => {
  const p = planEject([obj(1, [86.5, 96.7, 142.7, 106.7])], { ...BED, maxZ: 11.2 })
  const xy = p.gcode.findIndex((l) => l.startsWith('G0 X'))
  const down = p.gcode.findIndex((l, i) => i > xy && /^G0 Z[\d.]+ F900/.test(l))
  const push = p.gcode.findIndex((l) => l.startsWith('G1 Y0'))
  assert.ok(xy < down && down < push, '顺序应为 走位 → 降 Z → 平移推')

  const startY = Number(/Y([\d.]+)/.exec(p.gcode[xy])![1])
  assert.ok(startY - 106.7 >= 86.9,
    `降 Z 的位置离件只有 ${(startY - 106.7).toFixed(1)}mm，不足打印头半径 72 + 余量 15`)
})
