import test from 'node:test'
import assert from 'node:assert/strict'
import { HarvestSnapshot } from '../src/notify/afterharvest.js'

/*
 * 推件序列先等热床冷到目标才推（M190）。拍早了照片里件还在板上，反而误导。
 * 所以要等热床到目标、再等推件动作走完，才拍。
 */
function rig(temps: number[]) {
  let now = 0; let i = 0
  const sent: string[] = []
  const h = new HarvestSnapshot({
    bedTemp: () => temps[Math.min(i, temps.length - 1)],
    notify: async (e) => { sent.push(e.kind) },
    now: () => now,
    sleep: async (ms) => { now += ms; i += 1 },
  })
  return { h, sent, now: () => now }
}

test('热床冷到目标之后再等一会儿才拍', async () => {
  const r = rig([60, 45, 30, 26, 25, 25])
  r.h.schedule(25)
  await new Promise((res) => setTimeout(res, 5))
  assert.deepEqual(r.sent, ['harvestDone'])
  assert.ok(r.now() >= 60_000, '至少等了推件那一分钟')
})

test('热床一直冷不下来就放弃，不拍', async () => {
  const r = rig([60])
  r.h.schedule(25)
  await new Promise((res) => setTimeout(res, 20))
  assert.deepEqual(r.sent, [])
})

test('同一时刻只安排一次', async () => {
  const r = rig([25])
  r.h.schedule(25); r.h.schedule(25)
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(r.sent.length, 1)
})
