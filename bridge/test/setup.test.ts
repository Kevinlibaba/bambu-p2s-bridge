import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSsdp } from '../src/setup/discover.js'
import { validateInput } from '../src/setup/verify.js'
import { registerSetupRoutes } from '../src/setup/routes.js'
import { readStoredConfig, writeStoredConfig, pick, type StoredConfig } from '../src/setup/store.js'
import { streamSource } from '../src/printer/camera.js'

// 假凭据，只在测试里用
const CODE = 'test1234'
const WRONG = 'zzzzzzzz'

test('SSDP：从打印机广播里取出 IP、序列号、型号', () => {
  const msg = [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1990',
    'Location: 192.168.1.42',
    'NT: urn:bambulab-com:device:3dprinter:1',
    'USN: 22E00A000000001',
    'DevModel.bambu.com: N7',
    'DevName.bambu.com: 3DP-22E-001',
    'DevVersion.bambu.com: 01.00.00.00',
    '',
  ].join('\r\n')
  assert.deepEqual(parseSsdp(msg, '10.0.0.9'), {
    ip: '192.168.1.42', serial: '22E00A000000001', model: 'N7', modelName: 'P2S',
    name: '3DP-22E-001', version: '01.00.00.00',
  })
  assert.equal(parseSsdp('NOTIFY * HTTP/1.1\r\nDevModel.bambu.com: N7\r\n', '1.1.1.1'), null, '没有序列号的不算')
  assert.equal(parseSsdp('NOTIFY * HTTP/1.1\r\nUSN: ABCDEFGH1\r\n', '10.0.0.9')!.ip, '10.0.0.9', '没 Location 用来源地址')
})

test('输入校验：IP、序列号、8 位访问码', () => {
  assert.equal(validateInput('192.168.1.42', '22E00A000000001', CODE), null)
  assert.equal(validateInput('192.168.1.42', '22E00A000000001', '1234567'), 'invalid')
  assert.equal(validateInput('192.168.1.42', 'bad serial!', CODE), 'invalid')
  assert.equal(validateInput('1.2.3.4;reboot', '22E00A000000001', CODE), 'invalid')
})

test('配置：环境变量优先，缺的从文件补；文件 0600', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'cfg-')), 'config.json')
  assert.deepEqual(readStoredConfig(path), {}, '没有文件就是空配置')
  writeStoredConfig({ printer: { host: '1.2.3.4' }, apiToken: 'file-token' }, path)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const s = readStoredConfig(path)
  assert.equal(s.apiToken, 'file-token')
  process.env.__T_PICK = 'env-token'
  assert.equal(pick('__T_PICK', s.apiToken), 'env-token')
  process.env.__T_PICK = '  '
  assert.equal(pick('__T_PICK', s.apiToken), 'file-token', '空白的环境变量不算')
  delete process.env.__T_PICK
})

test('视频流地址：访问码里的特殊字符要转义', () => {
  assert.equal(streamSource('192.168.1.42', 'ab@cd:12'), 'rtsps://bblp:ab%40cd%3A12@192.168.1.42:322/streaming/live/1')
})

async function setupApp(over: Partial<Parameters<typeof registerSetupRoutes>[1]> = {}) {
  const app = Fastify()
  const written: StoredConfig[] = []
  let restarted = 0
  registerSetupRoutes(app, {
    needed: true,
    onApplied: () => { restarted += 1 },
    verify: async (_h, _s, code) => (code === CODE ? { ok: true, state: 'IDLE' } : { ok: false, error: 'auth' }),
    discover: async () => [],
    write: (c) => { written.push(c) },
    currentToken: () => '',
    ...over,
  })
  await app.ready()
  return { app, written, restarted: () => restarted }
}

const good = { host: '192.168.1.42', serial: '22e00a000000001', code: CODE }

test('向导：访问码不对就不写配置；对了才生成 token 和推送密钥并重启', async () => {
  const { app, written, restarted } = await setupApp()
  assert.deepEqual((await app.inject('/api/setup/status')).json(), { needed: true })

  const bad = await app.inject({ method: 'POST', url: '/api/setup/apply', payload: { ...good, code: WRONG } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, 'auth')
  assert.equal(written.length, 0, '验证不过绝不写盘')

  const ok = await app.inject({ method: 'POST', url: '/api/setup/apply', payload: good })
  assert.equal(ok.statusCode, 200)
  const token = ok.json().token as string
  assert.match(token, /^[0-9a-f]{48}$/)
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].printer, { host: '192.168.1.42', serial: '22E00A000000001', accessCode: CODE }, '序列号统一大写')
  assert.equal(written[0].apiToken, token)
  assert.ok(written[0].vapid?.publicKey && written[0].vapid?.privateKey, '顺手生成推送密钥')

  await new Promise((r) => setTimeout(r, 900))
  assert.equal(restarted(), 1, '写完配置重启')

  // 应用之后向导就关了：别人不能再来改
  assert.deepEqual((await app.inject('/api/setup/status')).json(), { needed: false })
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/apply', payload: good })).statusCode, 409)
  assert.equal((await app.inject('/api/setup/discover')).statusCode, 409)
})

test('向导：环境变量里已有 token 就沿用，手机上已填的不失效', async () => {
  const { app, written } = await setupApp({ currentToken: () => 'existing-token' })
  const ok = await app.inject({ method: 'POST', url: '/api/setup/apply', payload: good })
  assert.equal(ok.json().token, 'existing-token')
  assert.equal(written[0].apiToken, 'existing-token')
})

test('向导：已配置的桥接上只有 status，其余 409', async () => {
  const { app } = await setupApp({ needed: false })
  assert.deepEqual((await app.inject('/api/setup/status')).json(), { needed: false })
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/test', payload: good })).statusCode, 409)
})

test('向导：撞访问码会被限流', async () => {
  const { app } = await setupApp()
  let last = 0
  for (let i = 0; i < 16; i++) {
    last = (await app.inject({ method: 'POST', url: '/api/setup/test', payload: { ...good, code: WRONG } })).statusCode
  }
  assert.equal(last, 429)
})
