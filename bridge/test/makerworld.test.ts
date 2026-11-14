import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MakerWorld, MwError, parseLink, toDetail } from '../src/makerworld/client.js'
import { mwFileName } from '../src/api/makerworld.js'

test('认得各种 MakerWorld 链接写法', () => {
  assert.deepEqual(parseLink('https://makerworld.com/en/models/2416782-nike-jordan-2-keychain#profileId-688448867'), {
    designId: 2416782,
    profileId: 688448867,
  })
  assert.deepEqual(parseLink('https://makerworld.com/models/2416782?appSharePlatform=copy'), { designId: 2416782, profileId: null })
  assert.deepEqual(parseLink('https://makerworld.com/zh/models/123456'), { designId: 123456, profileId: null })
  assert.deepEqual(parseLink('快来看这个模型 https://makerworld.com/en/models/99887-x 太酷了'), { designId: 99887, profileId: null })
  assert.deepEqual(parseLink(' 2416782 '), { designId: 2416782, profileId: null })
})

test('国内版链接和乱七八糟的输入给出明确的错', () => {
  assert.throws(() => parseLink('https://makerworld.com.cn/zh/models/123'), (e: MwError) => e.code === 'cnRegion')
  assert.throws(() => parseLink('https://thingiverse.com/thing:1'), (e: MwError) => e.code === 'badLink')
})

const design = {
  id: 2416782,
  title: 'Keychain',
  coverUrl: 'https://cdn/cover.png',
  designCreator: { name: 'Derek' },
  likeCount: 5,
  downloadCount: 9,
  defaultInstanceId: 2,
  instances: [
    {
      id: 1, profileId: 101, title: 'A', isDefault: false, prediction: 600, weight: 10,
      instanceFilaments: [{ type: 'PLA', color: '#FFFFFF' }],
      extention: { modelInfo: { plates: [{}, {}], compatibility: { devModelName: 'N7', devProductName: 'P2S' }, projectSettings: { layerHeight: '0.2' } } },
    },
    { id: 2, profileId: 102, title: 'B', isDefault: true, extention: { modelInfo: { compatibility: { devModelName: 'C12', devProductName: 'P1S' } } } },
  ],
}

test('详情：链接点名的配置优先，否则默认配置；标出原生 P2S', () => {
  const d = toDetail(design, 101)
  assert.equal(d.selected, 1)
  assert.equal(toDetail(design, null).selected, 2)
  assert.equal(toDetail(design, 999).selected, 2, '点名的配置不存在就退回默认')
  assert.equal(d.instances[0].native, true)
  assert.equal(d.instances[0].plates, 2)
  assert.equal(d.instances[0].layerHeight, '0.2')
  assert.equal(d.instances[1].printer, 'P1S')
  assert.equal(d.instances[1].native, false)
})

test('文件名：去掉打印机不认的符号，保留中文，补 .3mf', () => {
  assert.equal(mwFileName('Nike Jordan 2 🔥 Keychain!.3mf', ''), 'Nike Jordan 2 Keychain.3mf')
  assert.equal(mwFileName('', '钥匙扣/挂件'), '钥匙扣 挂件.3mf')
  assert.equal(mwFileName('???', ''), 'makerworld.3mf')
  assert.ok(mwFileName('x'.repeat(300), '').length <= 120)
})

type Call = { url: string; body?: unknown; auth?: string | null }

function fakeFetch(routes: Record<string, (c: Call) => { status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const h = new Headers(init?.headers)
    const call: Call = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: h.get('authorization') }
    calls.push(call)
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) return new Response('{}', { status: 404 })
    const r = routes[key](call)
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers })
  }) as typeof fetch
  return { impl, calls }
}

async function store() {
  return join(await mkdtemp(join(tmpdir(), 'mw-')), 'mw.json')
}

test('密码登录要邮箱验证码时自动发码，填码后拿到 token，只把 token 落盘', async () => {
  const path = await store()
  const f = fakeFetch({
    '/user/login': (c) =>
      (c.body as { code?: string }).code === '123456'
        ? { json: { accessToken: 'tok', refreshToken: 'ref' } }
        : { json: { loginType: 'verifyCode' } },
    '/sendemail/code': () => ({ json: { success: true } }),
    '/my/profile': () => ({ json: { uid: 42, name: 'Kevin', avatar: 'a.png' } }),
  })
  const mw = new MakerWorld(path, f.impl)
  const r1 = await mw.loginPassword('me@x.com', 'secret')
  assert.deepEqual(r1, { ok: false, next: 'verifyCode' })
  assert.ok(f.calls.some((c) => c.url.includes('/sendemail/code')), '要自动发码')
  const acc = await mw.loginCode('me@x.com', '123456')
  assert.equal(acc.uid, 42)
  assert.equal(acc.name, 'Kevin')
  const saved = await readFile(path, 'utf8')
  assert.ok(saved.includes('tok'))
  assert.ok(!saved.includes('secret'), '密码绝不落盘')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  // 重启后读得回来
  assert.equal((await new MakerWorld(path, f.impl).account())?.name, 'Kevin')
})

test('验证码错与过期区分开', async () => {
  const f = fakeFetch({ '/user/login': (c) => ({ status: 400, json: { code: (c.body as { code: string }).code === '1' ? 1 : 2 } }) })
  const mw = new MakerWorld(await store(), f.impl)
  await assert.rejects(mw.loginCode('a', '1'), (e: MwError) => e.code === 'codeExpired')
  await assert.rejects(mw.loginCode('a', '2'), (e: MwError) => e.code === 'wrongCode')
})

test('密码不对给出明确的错', async () => {
  const f = fakeFetch({ '/user/login': () => ({ status: 400, json: { code: 1, error: 'Incorrect account or password.' } }) })
  await assert.rejects(new MakerWorld(await store(), f.impl).loginPassword('a', 'b'), (e: MwError) => e.code === 'badPassword')
})

test('下载：带 token 换签名链接；401 会登出；次数用完、验证码分别报', async () => {
  let mode = 'ok'
  const f = fakeFetch({
    '/user/login': () => ({ json: { accessToken: 'tok' } }),
    '/my/profile': () => ({ json: { uid: 1 } }),
    '/f3mf': () =>
      mode === 'ok'
        ? { json: { name: 'x.3mf', url: 'https://cdn/x.3mf?sig=1' } }
        : mode === 'limit'
          ? { status: 400, json: { code: -1, error: "You've reached your daily download limit." } }
          : mode === 'captcha'
            ? { status: 418, json: { captchaId: 'abc' } }
            : { status: 401, json: {} },
  })
  const mw = new MakerWorld(await store(), f.impl)
  await assert.rejects(mw.downloadUrl(1), (e: MwError) => e.code === 'auth', '没登录就不去请求')
  await mw.loginPassword('a', 'b')
  assert.deepEqual(await mw.downloadUrl(7), { name: 'x.3mf', url: 'https://cdn/x.3mf?sig=1' })
  assert.equal(f.calls.at(-1)!.auth, 'Bearer tok')
  mode = 'limit'
  await assert.rejects(mw.downloadUrl(7), (e: MwError) => e.code === 'limit')
  mode = 'captcha'
  await assert.rejects(mw.downloadUrl(7), (e: MwError) => e.code === 'captcha')
  mode = '401'
  await assert.rejects(mw.downloadUrl(7), (e: MwError) => e.code === 'auth')
  assert.equal(await mw.account(), null, 'token 失效后视为未登录')
})

test('收藏列表按登录时存下的用户编号取', async () => {
  const f = fakeFetch({
    '/user/login': () => ({ json: { accessToken: 'tok' } }),
    '/my/profile': () => ({ json: { uid: 77 } }),
    '/favorites/designs/77': () => ({ json: { total: 1, hits: [{ id: 5, title: 'T', cover: 'c', designCreator: { name: 'n' } }] } }),
  })
  const mw = new MakerWorld(await store(), f.impl)
  await mw.loginPassword('a', 'b')
  const r = await mw.favorites()
  assert.equal(r.total, 1)
  assert.equal(r.items[0].title, 'T')
  assert.equal(r.items[0].creator, 'n')
})

test('浏览和搜索是公开的：不带 token；搜索走 design2；排序参数照传', async () => {
  const f = fakeFetch({
    '/select/design/nav': () => ({ json: { total: 3, hits: [{ id: 1, title: 'A', cover: 'c', designCreator: { name: 'x' } }] } }),
    '/select/design2': () => ({ json: { total: 9, hits: [{ id: 2, title: 'B', cover: 'c' }] } }),
  })
  const mw = new MakerWorld(await store(), f.impl)
  const b = await mw.browse('category_700', 20)
  assert.equal(b.items[0].title, 'A')
  assert.ok(f.calls[0].url.includes('navKey=category_700&offset=20'))
  assert.equal(f.calls[0].auth, null)
  const s = await mw.search('龙 dragon', 'downloadCount')
  assert.equal(s.total, 9)
  assert.ok(f.calls[1].url.includes('keyword=%E9%BE%99%20dragon'))
  assert.ok(f.calls[1].url.includes('orderBy=downloadCount'))
  assert.deepEqual(await mw.search('   '), { items: [], total: 0 }, '空关键词不发请求')
  assert.equal(f.calls.length, 2)
  await assert.rejects(mw.browse('Following'), (e: MwError) => e.code === 'badLink')
})
