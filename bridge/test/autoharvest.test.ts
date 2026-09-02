import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AutoHarvest } from '../src/eject/auto.js'
import type { PrinterState, Summary } from '../src/printer/state.js'

function rig(bedTarget = 30) {
  const e = new EventEmitter()
  const calls: string[] = []
  let now = 0
  const auto = new AutoHarvest(
    e as unknown as PrinterState,
    {
      cool: async () => { calls.push('cool') },
      eject: async () => { calls.push('eject') },
      now: () => now,
    },
    bedTarget,
  )
  auto.start()
  return {
    auto,
    calls,
    advance: (ms: number) => { now += ms },
    tick: async (state: string, bed: number) => {
      e.emit('update', { state, bed: { cur: bed } } as unknown as Summary)
      // onUpdate 里有 await，让微任务跑完
      await new Promise((r) => setImmediate(r))
    },
  }
}

test('没预约时什么都不做', async () => {
  const r = rig()
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 25)
  assert.deepEqual(r.calls, [])
})

test('打印结束先开风扇，冷透之后才推', async () => {
  const r = rig()
  r.auto.arm(true)
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 58)
  assert.deepEqual(r.calls, ['cool'], '刚结束时只开风扇，不推')
  assert.equal(r.auto.status().phase, 'cooling')

  await r.tick('FINISH', 45)
  assert.deepEqual(r.calls, ['cool'], '还热着就不该推')

  await r.tick('FINISH', 29)
  assert.deepEqual(r.calls, ['cool', 'eject'])
  assert.equal(r.auto.status().phase, 'done')
})

/*
 * 热的时候件粘在板上推不动，硬推只会把力顶在热端上 —— 这是实测结论，
 * 所以温度这一关必须挡住。
 */
test('温度差一点都不放行', async () => {
  const r = rig(30)
  r.auto.arm(true)
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 31)
  assert.deepEqual(r.calls, ['cool'], '31℃ 高于 30℃，不推')
  await r.tick('FINISH', 30)
  assert.deepEqual(r.calls, ['cool', 'eject'], '到 30℃ 才推')
})

/*
 * 预约的那一刻打印机可能已经是 FINISH（上一单还在板上）。
 * 若把这个也当成跃迁，预约瞬间就会对着旧的一单动起来。
 */
test('只认「打印中 → 结束」的跃迁，已经是 FINISH 不算', async () => {
  const r = rig()
  await r.tick('FINISH', 25)
  r.auto.arm(true)
  await r.tick('FINISH', 25)
  await r.tick('FINISH', 25)
  assert.deepEqual(r.calls, [], '没有经历打印过程就不该触发')
})

test('执行完自动解除，不会顺延到下一单', async () => {
  const r = rig()
  r.auto.arm(true)
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 25)   // 跃迁这一拍只开风扇
  await r.tick('FINISH', 25)   // 下一拍才判断温度并推
  assert.equal(r.auto.status().armed, false)

  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 25)
  await r.tick('FINISH', 25)
  assert.deepEqual(r.calls, ['cool', 'eject'], '第二单不该再动')
})

test('降温期间又开打，预约作废', async () => {
  const r = rig()
  r.auto.arm(true)
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 55)
  await r.tick('RUNNING', 60)
  assert.equal(r.auto.status().armed, false)
  assert.equal(r.auto.status().phase, 'failed')
  await r.tick('FINISH', 25)
  assert.deepEqual(r.calls, ['cool'], '作废之后不该再推')
})

test('降温等太久就放弃，不无限等下去', async () => {
  const r = rig()
  r.auto.arm(true)
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 55)
  r.advance(46 * 60_000)
  await r.tick('FINISH', 40)
  assert.equal(r.auto.status().phase, 'failed')
  assert.match(r.auto.status().error!, /热床/)
  assert.deepEqual(r.calls, ['cool'])
})

test('取消预约后不再触发', async () => {
  const r = rig()
  r.auto.arm(true)
  r.auto.arm(false)
  await r.tick('RUNNING', 60)
  await r.tick('FINISH', 25)
  assert.deepEqual(r.calls, [])
})

test('推件失败时如实记下原因，并解除预约', async () => {
  const e = new EventEmitter()
  const auto = new AutoHarvest(
    e as unknown as PrinterState,
    { cool: async () => {}, eject: async () => { throw new Error('打印机正忙') } },
  )
  auto.start()
  auto.arm(true)
  const tick = async (state: string, bed: number) => {
    e.emit('update', { state, bed: { cur: bed } } as unknown as Summary)
    await new Promise((r) => setImmediate(r))
  }
  await tick('RUNNING', 60)
  await tick('FINISH', 25)
  await tick('FINISH', 25)
  assert.equal(auto.status().phase, 'failed')
  assert.equal(auto.status().error, '打印机正忙')
  assert.equal(auto.status().armed, false)
})
