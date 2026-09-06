import test from 'node:test'
import assert from 'node:assert/strict'
import { HumidityWatch } from '../src/notify/humidity.js'
import type { Summary } from '../src/printer/state.js'

const H = 3_600_000
const unit = (o: Partial<Summary['amsUnits'][number]>) =>
  ({ id: 0, temp: 25, humidity: 3, humidityPct: null, dryStatus: 'off', dryRemainMin: 0, loadedSlot: null, ...o })
const sum = (units: Summary['amsUnits']) => ({ amsUnits: units }) as unknown as Summary

/*
 * 开盖换料那一会儿湿度会蹿一下，立刻响就是噪声。必须持续偏高够久才提醒。
 */
test('持续偏高超过阈值才提醒，中途降下来就重新计时', () => {
  const w = new HumidityWatch({ pct: 50, level: 4, sustainMs: 2 * H, repeatMs: 24 * H })
  assert.deepEqual(w.update(sum([unit({ humidityPct: 60 })]), 0), [])
  assert.deepEqual(w.update(sum([unit({ humidityPct: 60 })]), 1 * H), [], '才一小时')
  assert.deepEqual(w.update(sum([unit({ humidityPct: 30 })]), 1.5 * H), [], '降下来了')
  assert.deepEqual(w.update(sum([unit({ humidityPct: 60 })]), 2 * H), [], '重新计时，从 2h 起算')
  const ev = w.update(sum([unit({ humidityPct: 60 })]), 4 * H)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].kind, 'amsHumid')
  assert.match(ev[0].body, /60%/)
})

test('同一个仓一天最多响一次', () => {
  const w = new HumidityWatch({ pct: 50, level: 4, sustainMs: 0, repeatMs: 24 * H })
  assert.equal(w.update(sum([unit({ humidityPct: 70 })]), 0).length, 1)
  assert.equal(w.update(sum([unit({ humidityPct: 70 })]), 5 * H).length, 0)
  assert.equal(w.update(sum([unit({ humidityPct: 70 })]), 25 * H).length, 1)
})

test('烘干进行中不提醒 —— 湿度本来就在降', () => {
  const w = new HumidityWatch({ pct: 50, level: 4, sustainMs: 0, repeatMs: 24 * H })
  assert.deepEqual(w.update(sum([unit({ humidityPct: 70, dryStatus: 'drying' })]), 0), [])
})

/*
 * 旧款 AMS 的 humidity_raw 恒为 0，只有等级是真的（实测这台就是：等级 5、0%）。
 * 只看百分比的话这种机器永远触发不了。
 */
test('百分比恒为 0 的旧款按等级判断', () => {
  const w = new HumidityWatch({ pct: 50, level: 4, sustainMs: 0, repeatMs: 24 * H })
  assert.equal(w.update(sum([unit({ humidity: 2, humidityPct: 0 })]), 0).length, 0)
  const ev = w.update(sum([unit({ id: 1, humidity: 5, humidityPct: 0 })]), 0)
  assert.equal(ev.length, 1)
  assert.match(ev[0].title, /AMS 2/)
  assert.match(ev[0].body, /E 级/)
  assert.doesNotMatch(ev[0].body, /0%/, '0% 不是真读数，别写进去误导人')
})

test('新款百分比偏高也算，两个刻度任一超过即提醒', () => {
  const w = new HumidityWatch({ pct: 50, level: 3, sustainMs: 0, repeatMs: 24 * H })
  const ev = w.update(sum([unit({ humidity: 2, humidityPct: 65 })]), 0)
  assert.equal(ev.length, 1)
  assert.match(ev[0].body, /65%/)
})
