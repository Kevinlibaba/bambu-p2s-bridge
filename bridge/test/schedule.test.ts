import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrintSchedule, ScheduleError } from '../src/schedule/index.js'

function rig() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sch-'))
  let now = 1_000_000
  const sent: string[] = []
  const started: unknown[] = []
  const s = new PrintSchedule(path.join(dir, 'schedule.json'), { notify: async (e) => { sent.push(e.kind) }, now: () => now })
  return { s, sent, started, advance: (ms: number) => { now += ms }, now: () => now, dir }
}

test('太近或太远的时间不接受', async () => {
  const r = rig()
  await assert.rejects(() => r.s.set(r.now() + 30_000, { path: '/a' }, 'a'), ScheduleError)
  await assert.rejects(() => r.s.set(r.now() + 8 * 86_400_000, { path: '/a' }, 'a'), ScheduleError)
  await r.s.set(r.now() + 120_000, { path: '/a' }, 'a')
  assert.equal(r.s.status().pending?.name, 'a')
})

test('到点才开，开完作废，不会开第二次', async () => {
  const r = rig()
  r.s.attach(async (b) => { r.started.push(b) })
  await r.s.set(r.now() + 120_000, { path: '/a', plate: 1 }, 'a')
  await r.s.tick()
  assert.equal(r.started.length, 0, '没到点')
  r.advance(120_000)
  await r.s.tick()
  assert.deepEqual(r.started, [{ path: '/a', plate: 1 }])
  assert.equal(r.s.status().pending, null)
  await r.s.tick()
  assert.equal(r.started.length, 1)
  assert.equal(r.s.status().last?.ok, true)
})

/*
 * 半夜没人守着：自检拦下了就该推一条并作废，而不是每 15 秒重试一次，
 * 更不该带 force 硬开。
 */
test('开打失败就推送并作废', async () => {
  const r = rig()
  r.s.attach(async () => { throw new Error('打印前自检未通过') })
  await r.s.set(r.now() + 120_000, { path: '/a' }, 'a')
  r.advance(120_000)
  await r.s.tick()
  assert.deepEqual(r.sent, ['scheduleFailed'])
  assert.equal(r.s.status().pending, null)
  assert.match(r.s.status().last?.error ?? '', /自检/)
})

test('预约落盘，重启后还在', async () => {
  const r = rig()
  await r.s.set(r.now() + 120_000, { path: '/a' }, 'a')
  const again = new PrintSchedule(path.join(r.dir, 'schedule.json'), { notify: async () => {}, now: r.now })
  await again.start(); again.stop()
  assert.equal(again.status().pending?.name, 'a')
})
