import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IDENTITY, MAX_SCALE, clampScale, clampTranslate, scaleAround,
  translateBy, toCss, pinchOf, toggleScale, containBox, DOUBLE_TAP_SCALE,
} from '../src/util/zoompan'

const BOX = { w: 400, h: 300 }
const near = (a: number, b: number, msg?: string) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} 期望 ${b}，实际 ${a}`)

test('缩放倍数被夹在允许区间内', () => {
  assert.equal(clampScale(0.2), 1, '不允许缩得比原始还小')
  assert.equal(clampScale(99), MAX_SCALE)
  assert.equal(clampScale(2.5), 2.5)
  assert.equal(clampScale(NaN), 1, '算出 NaN 时退回 1，而不是把画面弄没')
})

/*
 * 不夹位移的话，一划就能把画面甩到屏幕外，只剩一片黑，
 * 用户还得盲猜怎么划回来。
 */
test('位移不能让内容边缘越过容器边缘', () => {
  // 放大 2 倍时两侧各多出 W/2 = 200
  const t = clampTranslate({ s: 2, tx: 9999, ty: -9999 }, BOX)
  assert.equal(t.tx, 200)
  assert.equal(t.ty, -150)
})

test('未放大时位移一律归零', () => {
  assert.deepEqual(clampTranslate({ s: 1, tx: 50, ty: 50 }, BOX), { s: 1, tx: 0, ty: 0 })
})

/*
 * 锚点必须停在原地，否则画面会从指尖底下溜走 —— 这是捏合手感好坏的关键。
 * 验证方式：反推锚点对应的内容坐标，缩放前后应当一致。
 */
test('以锚点为中心缩放时，锚点下的内容保持不动', () => {
  const cur = { s: 1, tx: 0, ty: 0 }
  const ax = 100
  const ay = -60
  const next = scaleAround(cur, 2, ax, ay, BOX)
  // c = (m - t)/s，缩放前后要相等
  near((ax - cur.tx) / cur.s, (ax - next.tx) / next.s, 'x 方向锚点漂移')
  near((ay - cur.ty) / cur.s, (ay - next.ty) / next.s, 'y 方向锚点漂移')
})

test('从已放大状态继续缩放，锚点同样不漂', () => {
  const cur = { s: 2, tx: 40, ty: -20 }
  const ax = -80
  const ay = 30
  const next = scaleAround(cur, 3, ax, ay, BOX)
  near((ax - cur.tx) / cur.s, (ax - next.tx) / next.s)
  near((ay - cur.ty) / cur.s, (ay - next.ty) / next.s)
})

test('缩回 1 倍时画面自动回正', () => {
  const next = scaleAround({ s: 3, tx: 120, ty: 80 }, 0.5, 50, 50, BOX)
  assert.deepEqual(next, { s: 1, tx: 0, ty: 0 })
})

test('拖动累加并受同样的边界约束', () => {
  const a = translateBy({ s: 2, tx: 0, ty: 0 }, 50, 20, BOX)
  assert.deepEqual(a, { s: 2, tx: 50, ty: 20 })
  const b = translateBy(a, 1000, 1000, BOX)
  assert.deepEqual(b, { s: 2, tx: 200, ty: 150 }, '越界时贴边而不是继续跑')
})

test('双击在 1 倍与放大之间切换', () => {
  const up = toggleScale({ ...IDENTITY }, 60, 40, BOX)
  assert.equal(up.s, DOUBLE_TAP_SCALE)
  const down = toggleScale(up, 60, 40, BOX)
  assert.deepEqual(down, { s: 1, tx: 0, ty: 0 }, '收回时必须回正，不能留着偏移')
})

test('两指的距离与中点换算成相对容器中心的坐标', () => {
  const rect = { left: 10, top: 20, width: 400, height: 300 }
  const p = pinchOf({ x: 110, y: 120 }, { x: 310, y: 120 }, rect)
  assert.equal(p.dist, 200)
  // 中点 (210,120) → 减去 left/top 得 (200,100)，再减去半宽半高
  assert.equal(p.midX, 0)
  assert.equal(p.midY, -50)
})

test('未变换时不输出 transform，免得平白多一个合成层', () => {
  assert.equal(toCss(IDENTITY), '')
  assert.match(toCss({ s: 2, tx: 10, ty: -5 }), /translate\(10\.00px, -5\.00px\) scale\(2\.0000\)/)
})

/*
 * 16:9 的画面放进竖屏容器，上下本来就有黑边。若按容器高度给拖动余量，
 * 竖直方向能一路拖到只剩黑边 —— 真机上就是这么翻车的。
 */
test('黑边场景：竖直余量按实际画面算，而不是按容器算', () => {
  const container = { w: 390, h: 844 }
  const content = { w: 390, h: 219 } // 16:9 铺满宽度，上下留黑
  // 放大 2 倍后画面高 438，仍然没铺满 844 —— 竖直方向不该能拖
  const t = clampTranslate({ s: 2, tx: 0, ty: 300 }, container, content)
  assert.equal(t.ty, 0, '画面没填满容器高度时，竖直不该有余量')
  assert.equal(clampTranslate({ s: 2, tx: 9999, ty: 0 }, container, content).tx, 195,
    '水平方向照常给余量')
})

test('画面铺满容器高度后，竖直方向才开始给余量', () => {
  const container = { w: 390, h: 844 }
  const content = { w: 390, h: 219 }
  // s = 5 时画面高 1095 > 844，单边余量 (1095-844)/2 = 125.5
  const t = clampTranslate({ s: 5, tx: 0, ty: 9999 }, container, content)
  assert.equal(t.ty, 125.5)
})

test('不传 content 时退化为按容器算，老行为不变', () => {
  const box = { w: 400, h: 300 }
  assert.deepEqual(clampTranslate({ s: 2, tx: 9999, ty: 9999 }, box),
    { s: 2, tx: 200, ty: 150 })
})

/*
 * aspectFit 的元素框永远满容器，画面只占其中一块。直接量元素框会把黑边
 * 也算成画面，于是竖直方向给出根本不存在的拖动余量，一拖就只剩黑。
 */
test('contain 规则：16:9 源放进竖屏，画面高度远小于元素框', () => {
  const box = containBox(390, 844, 1920, 1080)
  assert.equal(Math.round(box.w), 390, '宽度受限，铺满')
  assert.equal(Math.round(box.h), 219, '高度按比例，远小于 844')
})

test('contain 规则：源比容器更瘦时改由高度受限', () => {
  const box = containBox(400, 300, 100, 200)
  assert.equal(Math.round(box.h), 300)
  assert.equal(Math.round(box.w), 150)
})

test('拿不到原始尺寸时退回元素框，不去瞎算', () => {
  assert.deepEqual(containBox(390, 844, 0, 0), { w: 390, h: 844 })
  assert.deepEqual(containBox(390, 844, 1920, 0), { w: 390, h: 844 })
})
