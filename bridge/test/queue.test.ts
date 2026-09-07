import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrintQueue, QueueError, type QueueDeps } from '../src/queue/index.js'
import type { Summary } from '../src/printer/state.js'

function rig(over: Partial<QueueDeps> = {}, opts: { warn?: boolean; injected?: boolean; pushable?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'q-'))
  let now = 1_000_000
  const log: string[] = []
  const notes: string[] = []
  let ready = true
  const deps: QueueDeps = {
    start: async (b) => { log.push('start:' + b.path) },
    plan: async (p) => ({
      injected: opts.injected ?? /\.harvest\./.test(p),
      warnings: opts.warn ? [{ code: 'hasBrim', level: 'warn', params: {} }] : [],
      pushable: opts.pushable ?? true,
    }),
    cool: async () => { log.push('cool') },
    eject: async (p) => { log.push('eject:' + p) },
    snapshot: async () => ({ url: '/api/snapshots/x.jpg', file: '/x.jpg' }),
    notify: async (e) => { notes.push(e.kind) },
    printerReady: () => (ready ? { ok: true, why: '' } : { ok: false, why: '打印机正忙' }),
    autoHarvestArmed: () => false,
    now: () => now,
    sleep: async (ms) => { now += ms },
    ...over,
  }
  const q = new PrintQueue(path.join(dir, 'q.json'), deps)
  const sum = (state: string, bed = 60) => ({ state, bed: { cur: bed }, printError: 0, taskName: 'x' }) as unknown as Summary
  // 状态机每一步之间都会真写一次落盘文件，微任务一轮不够，等一小段真实时间
  const settle = () => new Promise((r) => setTimeout(r, 40))
  return { q, log, notes, sum, settle, setReady: (v: boolean) => { ready = v }, dir, now: () => now }
}

test('两件都能自动衔接：打完 → 冷却 → 推 → 拍照 → 起下一件 → 全部完成', async () => {
  const r = rig()
  await r.q.add({ path: '/a.gcode.3mf', plate: 1 })
  await r.q.add({ path: '/b.gcode.3mf', plate: 2 })
  await r.q.onUpdate(r.sum('IDLE'))          // 第一份状态：对账
  await r.q.start(); await r.settle(); await r.settle()
  assert.deepEqual(r.log, ['start:/a.gcode.3mf'])
  assert.equal(r.q.status().phase, 'printing')

  await r.q.onUpdate(r.sum('RUNNING'))
  await r.q.onUpdate(r.sum('FINISH', 60))     // 打完，床还热
  assert.equal(r.q.status().phase, 'cooling')
  assert.ok(r.log.includes('cool'))
  await r.q.onUpdate(r.sum('FINISH', 40))
  assert.ok(!r.log.some((l) => l.startsWith('eject')), '40℃ 还不能推')
  await r.q.onUpdate(r.sum('FINISH', 25))     // 冷透 → 推 → 等 60s → 拍照 → 起下一件
  await r.settle(); await r.settle(); await r.settle()
  assert.ok(r.log.includes('eject:/a.gcode.3mf'))
  const st = r.q.status()
  assert.equal(st.items[0].status, 'done')
  assert.equal(st.items[0].photo, '/api/snapshots/x.jpg')
  assert.ok(r.notes.includes('harvestDone'))
  assert.deepEqual(r.log.filter((l) => l.startsWith('start')), ['start:/a.gcode.3mf', 'start:/b.gcode.3mf'])

  await r.q.onUpdate(r.sum('RUNNING'))
  await r.q.onUpdate(r.sum('FINISH', 25))
  await r.settle(); await r.settle(); await r.settle()
  assert.equal(r.q.status().state, 'idle')
  assert.ok(r.notes.includes('queueDone'))
})

/*
 * 安全门：收菜规划有 warn 级告警（这里是 brim）的件，打完必须停下等人看照片。
 * 机器没法确认件真的掉下去了，实测见过被 brim 拽回来的。
 */
test('有告警的件打完停下等人，resume 之后才起下一件', async () => {
  const r = rig({}, { warn: true })
  await r.q.add({ path: '/a.gcode.3mf' }); await r.q.add({ path: '/b.gcode.3mf' })
  assert.equal(r.q.status().items[0].harvestAuto, false)
  await r.q.onUpdate(r.sum('IDLE')); await r.q.start(); await r.settle(); await r.settle()
  await r.q.onUpdate(r.sum('RUNNING')); await r.q.onUpdate(r.sum('FINISH', 25))
  await r.settle(); await r.settle(); await r.settle()
  const st = r.q.status()
  assert.equal(st.state, 'paused')
  assert.equal(st.pause?.reason, 'safety')
  assert.equal(st.pause?.photo, '/api/snapshots/x.jpg', '停下时要把照片一起给人看')
  assert.ok(r.notes.includes('queuePaused'))
  assert.equal(r.log.filter((l) => l.startsWith('start')).length, 1, '没确认之前不能起 b')
  await r.q.resume(); await r.settle(); await r.settle()
  assert.equal(r.log.filter((l) => l.startsWith('start')).length, 2)
})

test('注入型文件（.harvest）打完不再推，只拍照', async () => {
  const r = rig()
  await r.q.add({ path: '/a.harvest.gcode.3mf' })
  await r.q.onUpdate(r.sum('IDLE')); await r.q.start(); await r.settle(); await r.settle()
  await r.q.onUpdate(r.sum('RUNNING')); await r.q.onUpdate(r.sum('FINISH', 25))
  await r.settle(); await r.settle(); await r.settle()
  assert.ok(!r.log.includes('cool') && !r.log.some((l) => l.startsWith('eject')))
  assert.equal(r.q.status().items[0].status, 'done')
})

test('开打失败：这件标失败，队列停下，不会跳到下一件', async () => {
  const r = rig({ start: async () => { throw new Error('打印前自检未通过') } })
  await r.q.add({ path: '/a.gcode.3mf' }); await r.q.add({ path: '/b.gcode.3mf' })
  await r.q.onUpdate(r.sum('IDLE')); await r.q.start(); await r.settle(); await r.settle()
  const st = r.q.status()
  assert.equal(st.items[0].status, 'failed'); assert.match(st.items[0].error!, /自检/)
  assert.equal(st.state, 'paused'); assert.equal(st.pause?.reason, 'failed')
  assert.equal(st.items[1].status, 'waiting')
})

test('打印失败 / 队列外有人开打 / 冷却超时 —— 都停下', async () => {
  const a = rig(); await a.q.add({ path: '/a.gcode.3mf' })
  await a.q.onUpdate(a.sum('IDLE')); await a.q.start(); await a.settle(); await a.settle()
  await a.q.onUpdate(a.sum('RUNNING')); await a.q.onUpdate(a.sum('FAILED'))
  assert.equal(a.q.status().pause?.reason, 'failed')

  const b = rig(); await b.q.add({ path: '/a.gcode.3mf' }); await b.q.add({ path: '/b.gcode.3mf' })
  await b.q.onUpdate(b.sum('IDLE')); await b.q.start(); await b.settle(); await b.settle()
  await b.q.onUpdate(b.sum('RUNNING')); await b.q.onUpdate(b.sum('FINISH', 60))
  await b.q.onUpdate(b.sum('RUNNING'))   // 冷却中有人开了打印
  assert.equal(b.q.status().pause?.reason, 'foreign')

  const c = rig(); await c.q.add({ path: '/a.gcode.3mf' })
  await c.q.onUpdate(c.sum('IDLE')); await c.q.start(); await c.settle(); await c.settle()
  await c.q.onUpdate(c.sum('RUNNING')); await c.q.onUpdate(c.sum('FINISH', 60))
  ;(c as unknown as { now: () => number })
  await c.q.onUpdate(c.sum('FINISH', 60)); // 未超时
  // 推进 46 分钟
  for (let i = 0; i < 46; i++) await (c.q as unknown as { deps: QueueDeps })['deps'].sleep!(60_000)
  await c.q.onUpdate(c.sum('FINISH', 60))
  assert.equal(c.q.status().pause?.reason, 'blocked')
})

test('start 的护栏：没待打项、打印机忙、预约收菜开着', async () => {
  const r = rig()
  await r.q.onUpdate(r.sum('IDLE'))
  await assert.rejects(() => r.q.start(), QueueError)
  await r.q.add({ path: '/a.gcode.3mf' })
  r.setReady(false)
  await assert.rejects(() => r.q.start(), /正忙/)
  r.setReady(true)
  const armed = rig({ autoHarvestArmed: () => true }); await armed.q.add({ path: '/a.gcode.3mf' })
  await armed.q.onUpdate(armed.sum('IDLE'))
  await assert.rejects(() => armed.q.start(), /打完这一件后收菜/)
})

test('暂停：打完当前这件就停，不评价床空没空；正在进行的不能删；重排只认 waiting', async () => {
  const r = rig()
  await r.q.add({ path: '/a.gcode.3mf' }); await r.q.add({ path: '/b.gcode.3mf' }); await r.q.add({ path: '/c.gcode.3mf' })
  const ids = r.q.status().items.map((i) => i.id)
  await r.q.reorder([ids[2], ids[1], ids[0]])
  assert.deepEqual(r.q.status().items.map((i) => i.path), ['/c.gcode.3mf', '/b.gcode.3mf', '/a.gcode.3mf'])
  await assert.rejects(() => r.q.reorder([ids[0]]), QueueError)
  await r.q.onUpdate(r.sum('IDLE')); await r.q.start(); await r.settle(); await r.settle()
  await assert.rejects(() => r.q.remove(ids[2]), /正在进行/)
  await r.q.pause()
  await r.q.onUpdate(r.sum('RUNNING')); await r.q.onUpdate(r.sum('FINISH', 25))
  await r.settle(); await r.settle(); await r.settle()
  const st = r.q.status()
  assert.equal(st.items[0].status, 'done')
  assert.equal(st.state, 'paused'); assert.equal(st.phase, 'idle')
  assert.equal(r.log.filter((l) => l.startsWith('start')).length, 1)
})

/*
 * 桥接重启（部署）不该把队列丢掉。正在打印的继续盯；收菜到一半的直接转安全停 ——
 * 推没推不知道，让人看。
 */
test('落盘与重启对账', async () => {
  const r = rig()
  await r.q.add({ path: '/a.gcode.3mf' }); await r.q.add({ path: '/b.gcode.3mf' })
  await r.q.onUpdate(r.sum('IDLE')); await r.q.start(); await r.settle(); await r.settle()
  // 「重启」：从同一个文件重建
  const again = rig()
  const q2 = new PrintQueue(path.join(r.dir, 'q.json'), { ...again.q['deps' as never] as QueueDeps, start: async (b) => { again.log.push('start:' + b.path) } })
  await q2.load()
  assert.equal(q2.status().phase, 'printing')
  await q2.onUpdate(r.sum('FINISH', 25))      // 重启期间打完了：直接进收菜
  await r.settle(); await r.settle(); await r.settle()
  assert.equal(q2.status().items[0].status, 'done')
})
