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
  const w = new HumidityWatch({ pct: 50, level: 4, useLevel: true, sustainMs: 2 * H, repeatMs: 24 * H })
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
  const w = new HumidityWatch({ pct: 50, level: 4, useLevel: true, sustainMs: 0, repeatMs: 24 * H })
  assert.equal(w.update(sum([unit({ humidityPct: 70 })]), 0).length, 1)
  assert.equal(w.update(sum([unit({ humidityPct: 70 })]), 5 * H).length, 0)
  assert.equal(w.update(sum([unit({ humidityPct: 70 })]), 25 * H).length, 1)
})

test('烘干进行中不提醒 —— 湿度本来就在降', () => {
  const w = new HumidityWatch({ pct: 50, level: 4, useLevel: true, sustainMs: 0, repeatMs: 24 * H })
  assert.deepEqual(w.update(sum([unit({ humidityPct: 70, dryStatus: 'drying' })]), 0), [])
})

/*
 * 旧款 AMS 的 humidity_raw 恒为 0，只有等级是真的（实测这台就是：等级 5、0%）。
 * 只看百分比的话这种机器永远触发不了。
 */
/*
 * MQTT 报的等级方向是反的：5 = 干、1 = 湿（ha-bambulab 源码注释：
 * "printer sends 1 = wet, 5 = dry"）。实测这台 AMS 2 Pro 干燥剂新换时报 5。
 * 第一版直接拿 MQTT 值比，把「最干」当成「该烘干」—— 这个测试钉住方向。
 */
test('MQTT 等级 5 是最干，不提醒；1 是最湿，提醒', () => {
  const w = new HumidityWatch({ pct: 50, level: 3, useLevel: true, sustainMs: 0, repeatMs: 24 * H })
  assert.deepEqual(w.update(sum([unit({ humidity: 5, humidityPct: 0 })]), 0), [], '5 = 干')
  assert.deepEqual(w.update(sum([unit({ id: 1, humidity: 4, humidityPct: 0 })]), 0), [], '4 = 显示 B 级，未到 C')
  const ev = w.update(sum([unit({ id: 2, humidity: 3, humidityPct: 0 })]), 0)
  assert.equal(ev.length, 1, '3 = 显示 C 级，wiki 说 C 以上算湿')
  assert.match(ev[0].title, /AMS 3/)
  assert.match(ev[0].body, /C 级/)
  assert.match(ev[0].body, /0%（C 级）/, '和 Handy 一样以百分比为主，等级放括号里')
  assert.match(w.update(sum([unit({ id: 3, humidity: 1, humidityPct: 0 })]), 0)[0].body, /E 级/)
})

test('等级换算：MQTT 5→A、1→E，越界给 ?', async () => {
  const { displayLevel, humidityLetter } = await import('../src/notify/humidity.js')
  assert.equal(displayLevel(5), 1); assert.equal(displayLevel(1), 5); assert.equal(displayLevel(0), 0)
  assert.equal(humidityLetter(5), 'A'); assert.equal(humidityLetter(3), 'C'); assert.equal(humidityLetter(9), '?')
})

test('有真百分比时偏高也算，两个刻度任一超过即提醒', () => {
  const w = new HumidityWatch({ pct: 50, level: 3, useLevel: true, sustainMs: 0, repeatMs: 24 * H })
  const ev = w.update(sum([unit({ humidity: 5, humidityPct: 65 })]), 0)
  assert.equal(ev.length, 1)
  assert.match(ev[0].body, /65%/)
})

test('useLevel 关掉时只看百分比', () => {
  const w = new HumidityWatch({ pct: 50, level: 3, useLevel: false, sustainMs: 0, repeatMs: 24 * H })
  assert.deepEqual(w.update(sum([unit({ humidity: 1, humidityPct: 0 })]), 0), [])
})
