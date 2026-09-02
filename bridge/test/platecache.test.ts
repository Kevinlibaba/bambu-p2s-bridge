import test from 'node:test'
import assert from 'node:assert/strict'
import { PlateCache, QueueFullError } from '../src/api/platecache.js'

const img = (s: string) => ({ data: Buffer.from(s), contentType: 'image/png' })
const defer = () => {
  let resolve!: () => void
  const p = new Promise<void>((r) => { resolve = r })
  return { p, resolve }
}

test('命中缓存后不再去读', async () => {
  const c = new PlateCache()
  let calls = 0
  const load = async () => { calls++; return img('a') }
  assert.equal((await c.get('k', load)).data.toString(), 'a')
  assert.equal((await c.get('k', load)).data.toString(), 'a')
  assert.equal(calls, 1)
})

/*
 * 历史列表一屏七八行，整屏同时索取同一张图。不合并的话每一行都会
 * 开两次 FTP 读，而打印机同时只接受 4 个 —— 实测就是一片 503。
 */
test('同一个 key 的并发请求只触发一次真实读取', async () => {
  const c = new PlateCache()
  const gate = defer()
  let calls = 0
  const load = async () => { calls++; await gate.p; return img('x') }

  const all = Promise.all(Array.from({ length: 8 }, () => c.get('same', load)))
  gate.resolve()
  const got = await all
  assert.equal(calls, 1, '八个并发只该读一次')
  assert.ok(got.every((g) => g.data.toString() === 'x'))
})

test('不同 key 的并发被限流，但都能成功 —— 慢一点好过一起失败', async () => {
  const c = new PlateCache(48, 60_000, 2)
  let peak = 0
  let now = 0
  const load = async () => {
    now++; peak = Math.max(peak, now)
    await new Promise((r) => setTimeout(r, 5))
    now--
    return img('y')
  }
  const got = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((k) => c.get(k, load)))
  assert.equal(got.length, 5, '五个都该拿到')
  assert.ok(peak <= 2, `同时在读的不该超过 2，实际 ${peak}`)
})

test('排队超过上限时明确拒绝，而不是无限积压', async () => {
  const c = new PlateCache(48, 60_000, 1, 2)
  const gate = defer()
  const load = async () => { await gate.p; return img('z') }
  // 1 个在跑 + 2 个排队 = 满，第 4 个该被拒
  const running = [c.get('a', load), c.get('b', load), c.get('c', load)]
  await assert.rejects(() => c.get('d', load), QueueFullError)
  gate.resolve()
  await Promise.all(running)
})

test('超过条数上限时淘汰最久未用的', async () => {
  const c = new PlateCache(2, 60_000)
  await c.get('a', async () => img('a'))
  await c.get('b', async () => img('b'))
  await c.get('a', async () => img('should not run')) // a 变成最近使用
  await c.get('c', async () => img('c'))              // 该淘汰 b
  assert.equal(c.size, 2)
  // 先验 a 还在 —— 再去重载 b 的话，b 会把 a 挤掉，那是容量为 2 的正常行为
  await c.get('a', async () => { throw new Error('a 不该被淘汰') })
  let reloaded = false
  await c.get('b', async () => { reloaded = true; return img('b2') })
  assert.ok(reloaded, 'b 应已被淘汰')
})

test('过期后重新读取', async () => {
  const c = new PlateCache(48, 1)
  await c.get('k', async () => img('old'))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((await c.get('k', async () => img('new'))).data.toString(), 'new')
})

test('读取失败不写缓存，下次仍会重试', async () => {
  const c = new PlateCache()
  await assert.rejects(() => c.get('k', async () => { throw new Error('boom') }), /boom/)
  assert.equal((await c.get('k', async () => img('ok'))).data.toString(), 'ok')
})

test('一次失败不会连累同时在等的其它 key', async () => {
  const c = new PlateCache(48, 60_000, 1)
  const bad = c.get('bad', async () => { throw new Error('boom') })
  const good = c.get('good', async () => img('fine'))
  await assert.rejects(() => bad, /boom/)
  assert.equal((await good).data.toString(), 'fine', '限流槽位要被正确释放')
})
