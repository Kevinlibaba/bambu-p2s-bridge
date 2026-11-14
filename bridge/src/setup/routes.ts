/**
 * 首次设置向导的接口。只在设置模式下可用；配置好之后一律 409，只剩 status。
 *
 *   GET  /api/setup/status    还要不要设置（免鉴权，App 启动时用它决定进不进向导）
 *   GET  /api/setup/discover  在局域网里找打印机
 *   POST /api/setup/test      {host, serial, code} 真连一次打印机
 *   POST /api/setup/apply     {host, serial, code} 再验一次 → 生成 token / 推送密钥 → 写盘 → 重启
 *
 * 安全：设置模式下这些接口不需要 token（这时还没有 token）。能防住「局域网里别人抢先配置」
 * 的只有访问码 —— apply 前一定在服务端重新验证一遍，不信任前面 test 的结果；尝试次数也限流，
 * 免得被拿来撞访问码。
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import webpush from 'web-push'
import { config } from '../config.js'
import { discoverPrinters } from './discover.js'
import { verifyPrinter, type VerifyResult } from './verify.js'
import { readStoredConfig, writeStoredConfig } from './store.js'

const WINDOW_MS = 10 * 60_000
const MAX_TRIES = 15

export interface SetupDeps {
  needed: boolean
  /** 写完配置后调用：设置模式下是退出进程，交给 Docker 重新拉起 */
  onApplied: () => void
  verify?: typeof verifyPrinter
  discover?: typeof discoverPrinters
  write?: typeof writeStoredConfig
  /** 已有的接口 token（环境变量或文件里的），有就沿用 */
  currentToken?: () => string
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): void {
  const verify = deps.verify ?? verifyPrinter
  const discover = deps.discover ?? discoverPrinters
  const write = deps.write ?? writeStoredConfig
  const currentToken = deps.currentToken ?? (() => config.api.token)
  let applied = false
  let tries: number[] = []

  const limited = () => {
    const now = Date.now()
    tries = tries.filter((t) => now - t < WINDOW_MS)
    if (tries.length >= MAX_TRIES) return true
    tries.push(now)
    return false
  }
  const body = (b: unknown) => {
    const o = (b ?? {}) as Record<string, unknown>
    const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return { host: s(o.host), serial: s(o.serial).toUpperCase(), code: s(o.code) }
  }

  app.get('/api/setup/status', async () => ({ needed: deps.needed && !applied }))

  // 设置完成后剩下的接口全部关掉
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/setup/') || req.url.startsWith('/api/setup/status')) return
    if (!deps.needed || applied) return reply.code(409).send({ error: '已经设置过了', code: 'done' })
  })

  app.get('/api/setup/discover', async () => ({ printers: await discover(6000) }))

  app.post('/api/setup/test', async (req, reply) => {
    if (limited()) return reply.code(429).send({ error: '尝试太频繁，稍后再试', code: 'limited' })
    const { host, serial, code } = body(req.body)
    const r = await verify(host, serial, code)
    return r.ok ? r : reply.code(400).send({ ...r, code: r.error })
  })

  app.post('/api/setup/apply', async (req, reply) => {
    if (limited()) return reply.code(429).send({ error: '尝试太频繁，稍后再试', code: 'limited' })
    const { host, serial, code } = body(req.body)
    // 不信任前面 test 的结果：这里是唯一真正改配置的地方
    const r: VerifyResult = await verify(host, serial, code)
    if (!r.ok) return reply.code(400).send({ ...r, code: r.error })

    const prev = readStoredConfig(config.configPath)
    // 环境变量里已有的 token / 密钥沿用（老安装改走向导时，手机上已填的 token 不失效）
    const apiToken = currentToken() || randomBytes(24).toString('hex')
    let vapid = prev.vapid
    if (!config.notify.vapid.publicKey || !config.notify.vapid.privateKey) {
      const k = webpush.generateVAPIDKeys()
      vapid = { publicKey: k.publicKey, privateKey: k.privateKey, subject: config.notify.vapid.subject }
    }
    write({ ...prev, printer: { host, serial, accessCode: code }, apiToken, vapid }, config.configPath)
    applied = true
    // 先把响应发出去，再重启
    setTimeout(() => deps.onApplied(), 800)
    return { ok: true, token: apiToken, state: r.state }
  })
}
