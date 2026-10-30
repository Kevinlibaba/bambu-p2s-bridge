import test from 'node:test'
import assert from 'node:assert/strict'
import { planPrune, RecordingQuota, type RemoteEntry } from '../src/check/recordings.js'

const MB = 1048576
const rec = (ts: string, mb = 256): RemoteEntry => ({ name: `ipcam-record.${ts}.mp4`, size: mb * MB, isDirectory: false })
const tmp = (ts: string): RemoteEntry => ({ name: `ipcam-record.${ts}.temp`, size: 100 * MB, isDirectory: false })

test('超出配额从最旧的删起，删到配额以下就停', () => {
  const files = [rec('2026-10-29_01'), rec('2026-10-29_02'), rec('2026-10-30_01'), rec('2026-10-30_02')]
  const p = planPrune(files, [], 600 * MB)
  assert.deepEqual(p.delete.map((f) => f.name), ['ipcam-record.2026-10-29_01.mp4', 'ipcam-record.2026-10-29_02.mp4'])
  assert.equal(p.after, 512 * MB)
})

test('没超配额什么都不删', () => {
  assert.deepEqual(planPrune([rec('a'), rec('b')], [], 2048 * MB).delete, [])
})

/*
 * 正在写的 .temp 碰了会把打印机正在录的那一段弄坏；最新的一段是刚出事时
 * 最想回看的 —— 这两样无论配额多紧都不删。
 */
test('.temp 和最新一段永远不删', () => {
  const files = [rec('2026-10-29_01'), rec('2026-10-30_01'), tmp('2026-10-30_02')]
  const p = planPrune(files, [], 1)
  assert.deepEqual(p.delete.map((f) => f.name), ['ipcam-record.2026-10-29_01.mp4'])
})

test('录像已不在的缩略图算孤儿，在的（含 .temp）保留', () => {
  const files = [rec('2026-10-30_01'), tmp('2026-10-30_02')]
  const thumbs = ['ipcam-record.2026-08-03_07.jpg', 'ipcam-record.2026-10-30_01.jpg', 'ipcam-record.2026-10-30_02.jpg', 'other.jpg']
  assert.deepEqual(planPrune(files, thumbs, 2048 * MB).orphanThumbs, ['ipcam-record.2026-08-03_07.jpg'])
})

test('跑一轮：按计划删录像和孤儿缩略图，配额 0 等于关', async () => {
  const removed: string[] = []
  const q = new RecordingQuota({
    list: async (p) => (p === '/ipcam'
      ? [rec('2026-10-29_01'), rec('2026-10-30_01'), { name: 'thumbnail', size: 0, isDirectory: true }]
      : [{ name: 'ipcam-record.2026-10-29_01.jpg', size: 1, isDirectory: false }]),
    remove: async (p) => { removed.push(p) },
    readsActive: () => 0,
  }, 300 * MB)
  assert.equal(await q.run(), 256 * MB)
  assert.deepEqual(removed, ['/ipcam/ipcam-record.2026-10-29_01.mp4', '/ipcam/thumbnail/ipcam-record.2026-10-29_01.jpg'])
  assert.equal(await new RecordingQuota({ list: async () => [], remove: async () => {}, readsActive: () => 0 }, 0).run(), 0)
})
