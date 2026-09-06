import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSkipSource, planSkip, plateOfFile, skipCommand, SkipError, type SkipSource,
} from '../src/skip/objects.js'
import { funBit, skippedObjectsOf } from '../src/printer/state.js'

/*
 * 这个功能没法在这里真机验证（要牺牲一个真实零件），所以护栏逻辑必须
 * 靠脱机测试钉死：每一条都对应 PROTOCOL.md §2.6 里的一条约束。
 */

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="label_object_enabled" value="false"/>
    <object identify_id="102" name="bracket.stl" skipped="false"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="label_object_enabled" value="true"/>
    <object identify_id="504" name="Mündungsbremse R.stp" skipped="false"/>
    <object identify_id="592" name="Mündungsbremse L.stp" skipped="false"/>
    <object identify_id="757" name="Griff.stp" skipped="false"/>
    <object identify_id="757" name="重复的" skipped="false"/>
    <object name="没有 id" skipped="false"/>
  </plate>
</config>`

test('按盘号解出 identify_id 与名字，重复和缺 id 的丢掉', () => {
  const got = parseSkipSource(XML, 2)
  assert.deepEqual(got, {
    labelObjectEnabled: true,
    objects: [
      { id: 504, name: 'Mündungsbremse R.stp' },
      { id: 592, name: 'Mündungsbremse L.stp' },
      { id: 757, name: 'Griff.stp' },
    ],
  })
})

test('单件盘没有零件标签', () => {
  const got = parseSkipSource(XML, 1)
  assert.equal(got?.labelObjectEnabled, false)
  assert.deepEqual(got?.objects, [{ id: 102, name: 'bracket.stl' }])
})

test('没有这一盘返回 null，不是空清单', () => {
  assert.equal(parseSkipSource(XML, 9), null)
  assert.equal(parseSkipSource('', 1), null)
})

test('缺 index 时按出现顺序编号', () => {
  const xml = '<config><plate><object identify_id="1" name="a"/></plate><plate><object identify_id="2" name="b"/></plate></config>'
  assert.deepEqual(parseSkipSource(xml, 2)?.objects, [{ id: 2, name: 'b' }])
})

test('盘号从 gcode 路径里解', () => {
  assert.equal(plateOfFile('/data/Metadata/plate_6.gcode'), 6)
  assert.equal(plateOfFile(''), null)
  assert.equal(plateOfFile('/data/Metadata/plate_x.gcode'), null)
})

/* print.fun 超过 32 位，第 49 位用 Number 的位运算根本取不到 —— 这条测的就是 BigInt 路径 */
test('fun 位域：P2S 实测值第 49 位为 1', () => {
  assert.equal(funBit('29FD183FF9CB7', 49), true)
  assert.equal(funBit('29FD183FF9CB7', 51), false, '高位也要取得到，不是只看低 32 位')
  assert.equal(funBit('0', 49), false)
  assert.equal(funBit(undefined, 49), false)
  assert.equal(funBit('not-hex', 49), false)
})

test('s_obj 只认整数数组', () => {
  assert.deepEqual(skippedObjectsOf([504, '592']), [504, 592])
  assert.deepEqual(skippedObjectsOf(undefined), [])
  assert.deepEqual(skippedObjectsOf('504'), [])
  assert.deepEqual(skippedObjectsOf([1.5, 'x', 7]), [7])
})

test('命令体与 PROTOCOL.md §2.6 一致', () => {
  assert.deepEqual(skipCommand([504, 592]), {
    print: { command: 'skip_objects', obj_list: [504, 592] },
  })
})

// ---- 护栏 ----

const source: SkipSource = {
  labelObjectEnabled: true,
  objects: [{ id: 504, name: 'R' }, { id: 592, name: 'L' }, { id: 757, name: 'G' }],
}
const ok = { state: 'RUNNING', connected: true, supported: true, source, skipped: [] as number[] }

function rejects(input: Parameters<typeof planSkip>[0], status: number, re: RegExp) {
  assert.throws(() => planSkip(input), (e: unknown) => {
    assert.ok(e instanceof SkipError, '要是 SkipError')
    assert.equal(e.status, status)
    assert.match(e.message, re)
    return true
  })
}

test('正常路径：返回要发的 id，去重', () => {
  assert.deepEqual(planSkip({ ...ok, ids: [504, 504, 592] }), [504, 592])
})

test('暂停中也能跳', () => {
  assert.deepEqual(planSkip({ ...ok, state: 'PAUSE', ids: [504] }), [504])
})

test('只有 RUNNING / PAUSE 放行', () => {
  for (const state of ['IDLE', 'FINISH', 'FAILED', 'PREPARE', 'SLICING', 'UNKNOWN']) {
    rejects({ ...ok, state, ids: [504] }, 409, /打印中或暂停/)
  }
})

test('没连上打印机先报连接，不报别的', () => {
  rejects({ ...ok, connected: false, ids: [] }, 503, /未连接/)
})

test('固件不支持（fun 第 49 位为 0）拒绝', () => {
  rejects({ ...ok, supported: false, ids: [504] }, 409, /固件不支持/)
})

/* 没有零件标签的盘 G-code 里没有逐件标记，发了也跳不了 —— §2.6.3 */
test('切片时没开零件标签拒绝', () => {
  rejects({ ...ok, source: { ...source, labelObjectEnabled: false }, ids: [504] }, 409, /零件标签/)
})

test('ids 必须是非空整数数组', () => {
  rejects({ ...ok, ids: undefined }, 400, /非空数组/)
  rejects({ ...ok, ids: [] }, 400, /非空数组/)
  rejects({ ...ok, ids: 504 }, 400, /非空数组/)
  rejects({ ...ok, ids: ['abc'] }, 400, /整数/)
  rejects({ ...ok, ids: [1.5] }, 400, /整数/)
})

test('不在当前盘里的 id 拒绝 —— 不能拿别的盘的编号来蒙', () => {
  rejects({ ...ok, ids: [504, 899] }, 400, /899 不在当前这一盘/)
})

test('已跳过的忽略；全是已跳过的就没东西可发', () => {
  assert.deepEqual(planSkip({ ...ok, skipped: [504], ids: [504, 592] }), [592])
  rejects({ ...ok, skipped: [504], ids: [504] }, 409, /都已经跳过/)
})

/*
 * 跳过全部剩余零件不是跳过，是停止。BambuStudio 在这种情况下改发 print.stop；
 * 我们不替用户改，直接拒绝 —— §2.6.4。
 */
test('不能跳过全部剩余零件', () => {
  rejects({ ...ok, ids: [504, 592, 757] }, 409, /等于停止/)
  // 已经跳过两个，再跳最后一个同样等于停止
  rejects({ ...ok, skipped: [504, 592], ids: [757] }, 409, /等于停止/)
  // 剩两个跳一个可以
  assert.deepEqual(planSkip({ ...ok, skipped: [504], ids: [592] }), [592])
})

test('单件盘上唯一的件也不能跳', () => {
  const single: SkipSource = { labelObjectEnabled: true, objects: [{ id: 102, name: 'x' }] }
  rejects({ ...ok, source: single, ids: [102] }, 409, /等于停止/)
})
