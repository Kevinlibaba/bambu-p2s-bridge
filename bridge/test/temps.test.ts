import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Temps, dayKey, daysBetween } from '../src/history/temps.js'
import type { PrinterState, Summary } from '../src/printer/state.js'

const dir = () => mkdtemp(join(tmpdir(), 'temps-'))

/** 假状态源：只要能 on('update') 并手动触发就够了 */
function fakeState() {
  const e = new EventEmitter()
  return {
    state: e as unknown as PrinterState,
    emit(nozzle: number, bed: number, at = Date.now()) {
      e.emit('update', {
        updatedAt: at,
        nozzle: { cur: nozzle },
        bed: { cur: bed },
        chamber: null,
        progress: 50,
      } as unknown as Summary)
    },
  }
}

test('dayKey 用 UTC 切天', () => {
  assert.equal(dayKey(Date.parse('2026-09-01T23:59:59Z')), '2026-09-01')
  assert.equal(dayKey(Date.parse('2026-09-02T00:00:00Z')), '2026-09-02')
})

test('daysBetween 覆盖起止两端，from 落在当天中间也不漏', () => {
  const from = Date.parse('2026-08-31T22:00:00Z')
  const to = Date.parse('2026-09-02T03:00:00Z')
  assert.deepEqual(daysBetween(from, to), ['2026-08-31', '2026-09-01', '2026-09-02'])
})

test('daysBetween 有上限，坏参数不会把整个目录读一遍', () => {
  const from = Date.parse('2020-01-01T00:00:00Z')
  const to = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(daysBetween(from, to).length, 32)
})

test('采样按间隔降频，密集上报不会每条都记', async () => {
  const f = fakeState()
  const t = new Temps(f.state, 10_000, 1080, null)
  await t.start()
  for (let i = 0; i < 5; i++) f.emit(220, 60)
  assert.equal(t.list().length, 1, '10 秒内只留一个点')
})

test('updatedAt 为 0 的状态不采 —— 那是还没收到过 report', async () => {
  const e = new EventEmitter()
  const t = new Temps(e as unknown as PrinterState, 0, 1080, null)
  await t.start()
  e.emit('update', { updatedAt: 0, nozzle: { cur: 0 }, bed: { cur: 0 }, chamber: null, progress: 0 } as unknown as Summary)
  assert.equal(t.list().length, 0)
})

test('内存缓冲不超过上限', async () => {
  const f = fakeState()
  const t = new Temps(f.state, 0, 3, null)
  await t.start()
  for (let i = 0; i < 10; i++) f.emit(200 + i, 60)
  assert.equal(t.list().length, 3)
  assert.equal(t.list()[2].n, 209, '留下的是最新的')
})

test('攒够一批才落盘，flush 能把余下的冲干净', async () => {
  const d = await dir()
  const f = fakeState()
  const t = new Temps(f.state, 0, 1080, d, 3)
  await t.start()

  f.emit(200, 60)
  f.emit(201, 60)
  assert.equal((await readdir(d)).length, 0, '没攒够就不该写盘')

  // 第三个点凑满一批，触发自动落盘；flush() 返回写入链，可以等它落定
  f.emit(202, 60)
  await t.flush()
  const day = dayKey(Date.now())
  const lines = (await readFile(join(d, `${day}.jsonl`), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(lines[0]).n, 200)
})

test('range 取得出某一单的区间，并把边界外的排除', async () => {
  const d = await dir()
  const day = '2026-09-01'
  const base = Date.parse(`${day}T10:00:00Z`)
  await writeFile(join(d, `${day}.jsonl`), [0, 60, 120, 180]
    .map((s) => JSON.stringify({ t: base + s * 1000, n: 200 + s, b: 60, c: null, p: 0 }))
    .join('\n') + '\n')

  const t = new Temps(fakeState().state, 0, 1080, d)
  const got = await t.range(base + 30_000, base + 150_000)
  assert.deepEqual(got.map((x) => x.n), [260, 320], '只要落在区间内的')
})

test('range 跨天时把两天的文件拼起来并按时间排序', async () => {
  const d = await dir()
  await writeFile(join(d, '2026-09-01.jsonl'),
    JSON.stringify({ t: Date.parse('2026-09-01T23:59:00Z'), n: 1, b: 0, c: null, p: 0 }) + '\n')
  await writeFile(join(d, '2026-09-02.jsonl'),
    JSON.stringify({ t: Date.parse('2026-09-02T00:01:00Z'), n: 2, b: 0, c: null, p: 0 }) + '\n')

  const t = new Temps(fakeState().state, 0, 1080, d)
  const got = await t.range(Date.parse('2026-09-01T23:00:00Z'), Date.parse('2026-09-02T01:00:00Z'))
  assert.deepEqual(got.map((x) => x.n), [1, 2])
})

/*
 * 断电可能在文件尾留下半行。整条曲线不该因此取不出来 ——
 * 丢掉坏行、其余照常返回。
 */
test('半行 JSON 被跳过，不影响其余的点', async () => {
  const d = await dir()
  const day = '2026-09-01'
  const base = Date.parse(`${day}T10:00:00Z`)
  await writeFile(join(d, `${day}.jsonl`),
    JSON.stringify({ t: base, n: 7, b: 0, c: null, p: 0 }) + '\n' + '{"t":123,"n":')

  const t = new Temps(fakeState().state, 0, 1080, d)
  const got = await t.range(base - 1000, base + 1000)
  assert.deepEqual(got.map((x) => x.n), [7])
})

test('range 参数颠倒或相等时返回空，不去扫盘', async () => {
  const t = new Temps(fakeState().state, 0, 1080, await dir())
  assert.deepEqual(await t.range(2000, 1000), [])
  assert.deepEqual(await t.range(1000, 1000), [])
})

test('重启后把最近的点读回内存，实时曲线不是空白', async () => {
  const d = await dir()
  const now = Date.now()
  await writeFile(join(d, `${dayKey(now)}.jsonl`),
    JSON.stringify({ t: now - 1000, n: 55, b: 60, c: null, p: 0 }) + '\n')

  const t = new Temps(fakeState().state, 0, 1080, d)
  await t.start()
  assert.deepEqual(t.list().map((x) => x.n), [55])
})

test('过期的天文件在启动时被删掉，未过期的留着', async () => {
  const d = await dir()
  const old = dayKey(Date.now() - 90 * 86_400_000)
  const recent = dayKey(Date.now() - 2 * 86_400_000)
  await writeFile(join(d, `${old}.jsonl`), '')
  await writeFile(join(d, `${recent}.jsonl`), '')
  await writeFile(join(d, 'notes.txt'), 'x')

  const t = new Temps(fakeState().state, 0, 1080, d, 6, 60)
  await t.start()
  const left = (await readdir(d)).sort()
  assert.ok(!left.includes(`${old}.jsonl`), '90 天前的该删')
  assert.ok(left.includes(`${recent}.jsonl`), '2 天前的该留')
  assert.ok(left.includes('notes.txt'), '不认识的文件别动')
})

/*
 * 进程在写完盘但还没清空待写缓冲时被杀，重启后那批点会再写一遍。
 * 曲线上表现为零长度的竖线 —— 读的时候按时间戳去重。
 */
test('重复的时间戳只保留一个', async () => {
  const d = await dir()
  const day = '2026-09-01'
  const base = Date.parse(`${day}T10:00:00Z`)
  const one = JSON.stringify({ t: base, n: 5, b: 0, c: null, p: 0 })
  await writeFile(join(d, `${day}.jsonl`), [one, one, one].join('\n') + '\n')

  const t = new Temps(fakeState().state, 0, 1080, d)
  assert.deepEqual((await t.range(base - 1, base + 1)).map((x) => x.n), [5])
})
