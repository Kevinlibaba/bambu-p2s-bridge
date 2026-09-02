import test from 'node:test'
import assert from 'node:assert/strict'
import { planEject, type PlateObject, type EjectGeometry } from '../src/eject/plan.js'

const BED: EjectGeometry = { bed: { width: 256, depth: 256 }, maxZ: 30 }

const obj = (id: number, bbox: [number, number, number, number], name = `o${id}`): PlateObject =>
  ({ id, name, bbox })

const codes = (p: ReturnType<typeof planEject>) => p.warnings.map((w) => w.code).sort()
const line = (p: ReturnType<typeof planEject>, re: RegExp) => p.gcode.find((l) => re.test(l))

test('起点落在件正后方，X 取 bbox 中心', () => {
  const p = planEject([obj(1, [100, 80, 140, 160])], BED)
  assert.deepEqual(p.order, [{ id: 1, name: 'o1', pushX: 120, startY: 170 }])
  assert.match(line(p, /^G0 X120 Y170/)!, /F12000/)
  assert.ok(line(p, /^G1 Y0 F1000/), '要一路推到前沿')
})

/*
 * 推的方向是 -Y。先推后面那个的话，它会一路撞上前面那个 ——
 * 所以永远从最靠前的开始。
 */
test('多个件按从前到后的顺序推', () => {
  const p = planEject(
    [obj(1, [10, 150, 50, 200], '后'), obj(2, [10, 20, 50, 70], '前'), obj(3, [10, 90, 50, 130], '中')],
    BED,
  )
  assert.deepEqual(p.order.map((o) => o.name), ['前', '中', '后'])
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
  const p = planEject([obj(1, [10, 20, 50, 70]), obj(2, [10, 120, 50, 170])], BED)
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
  const p = planEject([obj(1, [10, 20, 50, 70])], { ...BED, maxZ: 0.6 })
  assert.ok(codes(p).includes('tooFlat'))
})

test('件贴着后沿时放弃它，而不是把喷嘴顶上去', () => {
  const p = planEject([obj(1, [10, 20, 50, 252])], BED)
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
test('standalone 模式要带 G28，并且报出回中撞击风险', () => {
  const p = planEject([obj(1, [10, 20, 50, 70])], BED, { mode: 'standalone' })
  assert.ok(p.gcode.includes('G28'))
  assert.ok(codes(p).includes('homingHazard'))
  assert.ok(p.gcode.indexOf('G28') < p.gcode.findIndex((l) => l.startsWith('G0 Z')),
    '回零必须在任何移动之前')
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
