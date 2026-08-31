import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMapping } from '../src/api/print.js'
import type { ThreeMfPlate, ThreeMfFilament } from '../src/printer/threemf.js'
import type { AmsTray } from '../src/printer/state.js'

function fil(p: Partial<ThreeMfFilament>): ThreeMfFilament {
  return { id: 1, trayInfoIdx: '', type: 'PLA', color: '#000000', usedM: 1, usedG: 1, ...p }
}

function plate(filaments: ThreeMfFilament[], filamentCount: number): ThreeMfPlate {
  return {
    index: 1,
    prediction: null,
    weight: null,
    nozzleDiameters: null,
    printerModel: null,
    supportUsed: null,
    objects: [],
    filaments,
    filamentCount,
    hasThumbnail: false,
  }
}

function tray(p: Partial<AmsTray>): AmsTray {
  return {
    unit: 0,
    slot: 0,
    type: 'PLA',
    subBrand: '',
    trayInfoIdx: '',
    color: '000000FF',
    remainPct: 100,
    nozzleTempMin: 190,
    nozzleTempMax: 230,
    dryTemp: 0,
    dryHours: 0,
    empty: false,
    ...p,
  }
}

/*
 * 这就是 07008012「多次获取 AMS 映射表失败」的成因：项目里定义了 4 种耗材，
 * 盘只用第 4 种，我们却发了长度为 1 的 [0]。打印机拼不出映射表，暂停报错。
 */
test('映射长度取项目耗材数，未用到的位置留 -1', () => {
  const p = plate([fil({ id: 4, trayInfoIdx: 'GFA01' })], 4)
  const trays = [
    tray({ slot: 0, trayInfoIdx: 'GFA01' }),
    tray({ slot: 1, type: 'PETG', trayInfoIdx: 'GFG00' }),
  ]
  assert.deepEqual(buildMapping({}, p, trays), [-1, -1, -1, 0])
})

test('多耗材各归各位', () => {
  const p = plate(
    [fil({ id: 1, trayInfoIdx: 'GFA00' }), fil({ id: 3, type: 'PETG', trayInfoIdx: 'GFG00' })],
    3,
  )
  const trays = [
    tray({ slot: 0, trayInfoIdx: 'GFA01' }),
    tray({ slot: 2, trayInfoIdx: 'GFA00' }),
    tray({ slot: 3, type: 'PETG', trayInfoIdx: 'GFG00' }),
  ]
  assert.deepEqual(buildMapping({}, p, trays), [2, -1, 3])
})

test('料盘全局序号跨 AMS 计算为 编号*4+槽位', () => {
  const p = plate([fil({ id: 1, trayInfoIdx: 'GFA00' })], 1)
  const trays = [tray({ unit: 1, slot: 2, trayInfoIdx: 'GFA00' })]
  assert.deepEqual(buildMapping({}, p, trays), [6])
})

test('型号对不上时退回「类型 + 颜色」，再退回只看类型', () => {
  const byColor = plate([fil({ id: 1, type: 'PLA', color: '#FF0000' })], 1)
  assert.deepEqual(
    buildMapping({}, byColor, [
      tray({ slot: 0, type: 'PLA', color: '00FF00FF' }),
      tray({ slot: 1, type: 'PLA', color: 'FF0000FF' }),
    ]),
    [1],
  )

  const byType = plate([fil({ id: 1, type: 'PETG', color: '#FF0000' })], 1)
  assert.deepEqual(
    buildMapping({}, byType, [
      tray({ slot: 0, type: 'PLA' }),
      tray({ slot: 3, type: 'PETG', color: '00FF00FF' }),
    ]),
    [3],
  )
})

test('空槽不参与匹配', () => {
  const p = plate([fil({ id: 1, trayInfoIdx: 'GFA00' })], 1)
  const trays = [tray({ slot: 0, trayInfoIdx: 'GFA00', type: '', empty: true }), tray({ slot: 1 })]
  // 空槽被跳过，退回按类型命中槽 1
  assert.deepEqual(buildMapping({}, p, trays), [1])
})

test('匹配不到就报错，不随便塞一个槽位', () => {
  const p = plate([fil({ id: 1, type: 'PC' })], 1)
  assert.throws(() => buildMapping({}, p, [tray({ type: 'PLA' })]), /找不到.*匹配的料盘/)
})

test('slots 显式指定优先于自动匹配', () => {
  const p = plate([fil({ id: 2, trayInfoIdx: 'GFA00' })], 2)
  const trays = [tray({ slot: 0, trayInfoIdx: 'GFA00' }), tray({ slot: 3 })]
  assert.deepEqual(buildMapping({ slots: { 2: 3 } }, p, trays), [-1, 3])
})

test('指定到空槽或不存在的槽会被拒', () => {
  const p = plate([fil({ id: 1 })], 1)
  const trays = [tray({ slot: 0 })]
  assert.throws(() => buildMapping({ slots: { 1: 2 } }, p, trays), /不存在或为空/)
})

test('外置料盘 254 放行', () => {
  const p = plate([fil({ id: 1 })], 1)
  assert.deepEqual(buildMapping({ slots: { 1: 254 } }, p, [tray({ slot: 0 })]), [254])
})

test('直接给 amsMapping 时校验长度', () => {
  const p = plate([fil({ id: 4 })], 4)
  assert.deepEqual(buildMapping({ amsMapping: [-1, -1, -1, 2] }, p, []), [-1, -1, -1, 2])
  assert.throws(() => buildMapping({ amsMapping: [0] }, p, []), /长度必须是 4/)
  assert.throws(() => buildMapping({ amsMapping: [0.5, 1, 2, 3] }, p, []), /必须是整数数组/)
})

test('读不出耗材信息时不猜，要求显式指定', () => {
  assert.throws(() => buildMapping({}, undefined, []), /显式指定 amsMapping/)
  assert.throws(() => buildMapping({}, plate([], 0), []), /显式指定 amsMapping/)
})

test('耗材序号超出项目耗材数时报错', () => {
  const p = plate([fil({ id: 5 })], 4)
  assert.throws(() => buildMapping({}, p, [tray({})]), /超出项目耗材数 4/)
})
