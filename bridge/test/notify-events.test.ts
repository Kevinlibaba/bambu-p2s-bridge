import test from 'node:test'
import assert from 'node:assert/strict'

// ---- 首层 / 进度 ----
test('层号从 1 到 2 报「首层完成」，只报一次', async () => {
  const { detect } = await import('../src/notify/events.js')
  const base = { online: true, state: 'RUNNING', taskName: 'x', progress: 1, layer: 1, totalLayers: 100, updatedAt: 1 } as never
  const next = { ...(base as object), layer: 2 } as never
  const ev = detect(base, next)
  assert.deepEqual(ev.map((e) => e.kind), ['firstLayer'])
  assert.deepEqual(detect(next, { ...(next as object), layer: 3 } as never).map((e) => e.kind), [])
})

test('进度每跨过一个刻度报一次，跨多个只报最新', async () => {
  const { detect } = await import('../src/notify/events.js')
  const at = (progress: number) => ({ online: true, state: 'RUNNING', taskName: 'x', progress, layer: 5, totalLayers: 100, updatedAt: 1 }) as never
  assert.deepEqual(detect(at(24), at(26), { progressStep: 25 }).map((e) => e.title), ['打印进度 25%'])
  assert.deepEqual(detect(at(26), at(30), { progressStep: 25 }), [])
  assert.deepEqual(detect(at(10), at(80), { progressStep: 25 }).map((e) => e.title), ['打印进度 75%'])
  assert.deepEqual(detect(at(24), at(26)), [], '默认关着')
})
