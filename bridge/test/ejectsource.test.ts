import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMaxZ, parseBrimWidth, parsePlateObjects, hasBrimExtrusion,
} from '../src/eject/source.js'

/*
 * max_z_height 藏在 gcode 头部的注释里。gcode 动辄几十 MB 且是 deflate 压缩的，
 * 所以只解压开头几 KB —— 意味着拿到的文本可能在任意位置被截断。
 */
test('从 gcode 头部读出最高点', () => {
  assert.equal(parseMaxZ('; total layer number: 56\n; max_z_height: 11.20\n; filament: 1\n'), 11.2)
  assert.equal(parseMaxZ('; max_z_height: 4\n'), 4)
})

test('截断、缺失、畸形时返回 null，不猜', () => {
  assert.equal(parseMaxZ(''), null)
  assert.equal(parseMaxZ('; total layer number: 56\n; max_z_hei'), null, '截断在关键行中间')
  assert.equal(parseMaxZ('; max_z_height: 0\n'), null, '0 不是合法高度')
  assert.equal(parseMaxZ('; max_z_height: abc\n'), null)
})

test('brim 宽度：no_brim 一律算 0', () => {
  assert.equal(parseBrimWidth('{"brim_type":"no_brim","brim_width":5}'), 0)
  assert.equal(parseBrimWidth('{"brim_type":"outer_only","brim_width":5}'), 5)
  assert.equal(parseBrimWidth('{"brim_type":"auto_brim","brim_width":"5"}'), 5, '字符串数字也认')
})

test('brim 信息读不到时当 0 —— 只影响告警，不该让整件事失败', () => {
  assert.equal(parseBrimWidth('不是 json'), 0)
  assert.equal(parseBrimWidth('{}'), 0)
  assert.equal(parseBrimWidth('{"brim_width":-3}'), 0)
})

test('解出 bbox_objects', () => {
  const json = JSON.stringify({
    bbox_objects: [
      { id: 7, name: '立方体', bbox: [86.5, 96.7, 142.7, 106.7] },
      { id: 8, name: '另一个', bbox: [10, 20, 30, 40] },
    ],
  })
  assert.deepEqual(parsePlateObjects(json), [
    { id: 7, name: '立方体', bbox: [86.5, 96.7, 142.7, 106.7] },
    { id: 8, name: '另一个', bbox: [10, 20, 30, 40] },
  ])
})

/*
 * 退化的 bbox（一条线、一个点、反向）多半是解析出了问题。让它进到轨迹计算里，
 * 算出来的推件起点会落在莫名其妙的地方 —— 而那是要驱动机器的。
 */
test('退化或畸形的 bbox 一律丢掉', () => {
  const json = JSON.stringify({
    bbox_objects: [
      { id: 1, bbox: [10, 20, 10, 40] },        // 宽度为 0
      { id: 2, bbox: [10, 20, 30, 20] },        // 深度为 0
      { id: 3, bbox: [30, 20, 10, 40] },        // 反向
      { id: 4, bbox: [10, 20, 30] },            // 少一个数
      { id: 5, bbox: [10, 20, 'x', 40] },       // 非数字
      { id: 6, bbox: [10, 20, 30, 40] },        // 唯一合法的
    ],
  })
  const got = parsePlateObjects(json)
  assert.equal(got.length, 1)
  assert.equal(got[0].id, 6)
})

test('缺 bbox_objects 或不是 json 时返回空数组', () => {
  assert.deepEqual(parsePlateObjects('{}'), [])
  assert.deepEqual(parsePlateObjects('{"bbox_objects":"不是数组"}'), [])
  assert.deepEqual(parsePlateObjects('坏掉的'), [])
})

test('没有 id 时按顺序补，不至于全是 0', () => {
  const json = JSON.stringify({ bbox_objects: [{ bbox: [1, 2, 3, 4] }, { bbox: [5, 6, 7, 8] }] })
  assert.deepEqual(parsePlateObjects(json).map((o) => o.id), [1, 2])
})

/*
 * 设置里写着要 brim ≠ 真的生成了 brim：brim_type=auto_brim 时由切片器逐件决定。
 * 实测撞见过 brim_width=5 而 gcode 里一条 brim 挤出都没有 —— 照设置报警是误报。
 */
test('brim 以 gcode 里的实际挤出为准', () => {
  assert.ok(hasBrimExtrusion('; FEATURE: Brim\nG1 X1 Y1 E1\n'))
  assert.ok(hasBrimExtrusion('; feature: brim\n'), '大小写不敏感')
  assert.ok(!hasBrimExtrusion('; FEATURE: Outer wall\n; FEATURE: Inner wall\n'))
  assert.ok(!hasBrimExtrusion(''))
})

test('不要把 Brim 之外的 FEATURE 误判成 brim', () => {
  assert.ok(!hasBrimExtrusion('; FEATURE: Bridge\n'))
  assert.ok(!hasBrimExtrusion('; FEATURE: Bottom surface\n'))
})
