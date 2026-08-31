import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { History } from '../src/history/index.js'
import { config } from '../src/config.js'
import type { PrinterState, Summary } from '../src/printer/state.js'

function sum(p: Partial<Summary> = {}): Summary {
  return {
    online: true, state: 'IDLE', progress: 0, remainingMin: 0, layer: 0, totalLayers: 0,
    taskName: '', file: '',
    nozzle: { cur: 20, target: 0, type: 'HS01', diameter: '0.4' },
    bed: { cur: 20, target: 0 }, chamber: 20,
    fans: { cooling: 0, aux: 0, chamber: 0, heatbreak: 0 },
    speedLevel: 2, speedPct: 100, lights: [], errors: [], printError: 0,
    wifi: '', sdcard: true, ams: [], amsUnits: [], dryBlockers: [], updatedAt: 1,
    ...p,
  } as Summary
}

function make() {
  config.history.path = join(mkdtempSync(join(tmpdir(), 'bambu-hist-')), 'jobs.jsonl')
  return new History(new EventEmitter() as unknown as PrinterState, async () => ({
    weightG: 59.1,
    estimateMin: 179,
  }))
}

const run = (p: Partial<Summary> = {}) =>
  sum({ state: 'RUNNING', taskName: 'M82', file: '/data/Metadata/plate_8.gcode', ...p })

test('完整观测到的一单：起止、结果、盘号、克重都记下来', async () => {
  const h = make()
  await h.feed(sum())
  await h.feed(run({ progress: 1 }))
  await h.feed(run({ progress: 60, layer: 500, totalLayers: 979 }))
  await h.feed(sum({ state: 'FINISH', taskName: 'M82' }))

  const [j] = h.list()
  assert.equal(j.name, 'M82')
  assert.equal(j.plate, 8)
  assert.equal(j.result, 'finished')
  assert.equal(j.progress, 100)
  assert.equal(j.partial, false)
  assert.equal(j.weightG, 59.1)
  // 结束帧常把进度层数清零，取最后一帧运行中的快照
  assert.equal(j.layer, 500)
  assert.equal(j.totalLayers, 979)
})

test('失败保留停在哪一步，不当成完成', async () => {
  const h = make()
  await h.feed(sum())
  await h.feed(run({ progress: 37 }))
  await h.feed(sum({ state: 'FAILED', taskName: 'M82', printError: 0x07008012 }))
  const [j] = h.list()
  assert.equal(j.result, 'failed')
  assert.equal(j.progress, 37)
  assert.equal(j.printError, 0x07008012)
})

test('桥接在打印中途起来时标记 partial，不记一单假的 0 分钟', async () => {
  const h = make()
  // 第一帧就是 RUNNING —— 没见过开始
  await h.feed(run({ progress: 40 }))
  await h.feed(run({ progress: 41 }))
  assert.ok(h.running(), '应当认领这一单')
  await h.feed(sum({ state: 'FINISH', taskName: 'M82' }))
  const [j] = h.list()
  assert.equal(j.partial, true)
  assert.equal(j.minutes, 0)
})

test('没收到过 report 的空状态不参与判断', async () => {
  const h = make()
  await h.feed(sum({ state: '', updatedAt: 0 }))
  await h.feed(sum({ state: 'FAILED' }))
  assert.deepEqual(h.list(), [])
})

test('暂停再继续不算两单', async () => {
  const h = make()
  await h.feed(sum())
  await h.feed(run())
  await h.feed(sum({ state: 'PAUSE', taskName: 'M82' }))
  await h.feed(run({ progress: 50 }))
  await h.feed(sum({ state: 'FINISH', taskName: 'M82' }))
  assert.equal(h.list().length, 1)
})

test('统计只把已完成的克重计入，并数出有几单查不到用量', async () => {
  const h = make()
  await h.feed(sum())
  await h.feed(run())
  await h.feed(sum({ state: 'FINISH', taskName: 'A' }))
  await h.feed(run({ taskName: 'B' }))
  await h.feed(sum({ state: 'FAILED', taskName: 'B' }))

  const s = h.stats()
  assert.equal(s.all.count, 2)
  assert.equal(s.all.finished, 1)
  assert.equal(s.all.failed, 1)
  // 失败那单的克重不计入用量
  assert.equal(s.all.grams, 59)
  assert.equal(s.all.weighed, 2)
})

test('查不到切片文件时仍然记账，克重留空', async () => {
  config.history.path = join(mkdtempSync(join(tmpdir(), 'bambu-hist-')), 'jobs.jsonl')
  const h = new History(new EventEmitter() as unknown as PrinterState, async () => null)
  await h.feed(sum())
  await h.feed(run())
  await h.feed(sum({ state: 'FINISH', taskName: 'M82' }))
  const [j] = h.list()
  assert.equal(j.weightG, null)
  assert.equal(j.result, 'finished')
})

// ---- 文件名 ↔ 任务名 匹配 ----
import { normalizeJobName } from '../src/history/index.js'

/*
 * 打印机上报的 taskName 会把下划线换成空格：文件叫
 * M107_Barret_Sniper_rifle.gcode.3mf，任务名却是 "M107 Barret Sniper rifle"。
 * 这是实测数据，直接比字符串永远对不上。
 */
test('归一化后文件名与任务名能对上', () => {
  assert.equal(
    normalizeJobName('M107_Barret_Sniper_rifle.gcode.3mf'),
    normalizeJobName('M107 Barret Sniper rifle'),
  )
  // 中文名本来就一致
  assert.equal(normalizeJobName('M82 巴雷特.gcode.3mf'), normalizeJobName('M82 巴雷特'))
  // 三种扩展名都要剥掉
  for (const ext of ['.gcode.3mf', '.3mf', '.gcode']) {
    assert.equal(normalizeJobName('foo bar' + ext), 'foo bar')
  }
  // 名字相近的不能混为一谈
  assert.notEqual(
    normalizeJobName('M107_Barret_Sniper_rifle.gcode.3mf'),
    normalizeJobName('M107_Barret_V3_.gcode.3mf'),
  )
})

test('上次打印时间取最近一次，正在打印的那单也算', async () => {
  const h = make()
  await h.feed(sum())
  await h.feed(run({ taskName: 'A' }))
  await h.feed(sum({ state: 'FINISH', taskName: 'A' }))
  const first = h.lastPrintedAt('A.gcode.3mf')
  assert.ok(first && first > 0)
  assert.equal(h.lastPrintedAt('没打过的.3mf'), null)

  // 又开了一单，正在打印中也要能查到
  await h.feed(run({ taskName: 'B_two' }))
  await h.feed(run({ taskName: 'B_two', progress: 5 }))
  assert.ok(h.lastPrintedAt('B two.gcode.3mf'), '下划线与空格要能对上')
})
