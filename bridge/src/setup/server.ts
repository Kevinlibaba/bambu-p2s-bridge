/**
 * 设置模式下的精简服务器：只有网页 App 和向导接口，不连打印机。
 *
 * 一行命令装好、还没填打印机的时候就是这个状态。用户在浏览器里打开地址，
 * App 发现 /api/setup/status 说要设置，就进向导；向导应用后进程退出，
 * Docker（restart: unless-stopped）把它按新配置拉起来。
 */
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { join } from 'node:path'
import { registerSetupRoutes } from './routes.js'

export async function buildSetupServer(onApplied: () => void) {
  const app = Fastify({ logger: { level: 'warn' } })

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
    if (!body || !body.trim()) return done(null, {})
    try {
      done(null, JSON.parse(body))
    } catch (e) {
      done(e as Error, undefined)
    }
  })

  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'public'),
    prefix: '/app/',
    index: ['index.html'],
    decorateReply: false,
  })

  app.get('/', async (_req, reply) => reply.redirect('/app/'))
  app.get('/api/health', async () => ({ ok: true, setup: true, printerConnected: false, lastReportAt: 0 }))

  registerSetupRoutes(app, { needed: true, onApplied })

  // 其余接口：说清楚为什么不能用，App 据此跳去向导
  app.all('/api/*', async (_req, reply) =>
    reply.code(503).send({ error: '还没有配置打印机，先完成设置', code: 'setup' }))

  return app
}
