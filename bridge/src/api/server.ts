import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import multipart from '@fastify/multipart'
import { WebSocket as UpstreamSocket } from 'ws'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import type { PrinterState } from '../printer/state.js'
import type { PrinterMqtt } from '../printer/mqtt.js'
import { execute, CommandError, type CommandInput } from '../printer/commands.js'
import { registerFileRoutes } from './files.js'
import { registerPrintRoutes } from './print.js'
import { registerAmsRoutes } from './ams.js'
import { registerErrorRoutes } from './errors.js'

function tokenOf(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) return h.slice(7)
  const q = (req.query as any)?.token
  return typeof q === 'string' ? q : undefined
}

export async function buildServer(state: PrinterState, mqtt: PrinterMqtt) {
  const app = Fastify({ logger: { level: 'warn' } })
  await app.register(websocket)

  // 切片文件几十 MB 起步；只允许单文件，且必须流式读取，不能落进内存
  await app.register(multipart, {
    limits: { files: 1, fileSize: 512 * 1024 * 1024 },
  })

  // 前端静态资源（uni-app H5 产物）。挂在 /app/ 下，hash 路由无需 history 回退。
  await app.register(fastifyStatic, {
    root: join(process.cwd(), 'public'),
    prefix: '/app/',
    index: ['index.html'],
    decorateReply: false,
  })

  // ---- 鉴权：除 /api/health 外全部需要 token ----
  app.addHook('onRequest', async (req, reply) => {
    if (!config.api.token) return          // 未配置 token = 调试模式
    if (req.url.startsWith('/api/health')) return
    // 应用外壳必须能在用户填入 token 之前加载
    if (req.url === '/' || req.url.startsWith('/app')) return
    if (tokenOf(req) !== config.api.token) {
      return reply.code(401).send({ error: '未授权' })
    }
  })

  app.get('/', async (_req, reply) => reply.redirect('/app/'))

  app.get('/api/health', async () => ({
    ok: true,
    printerConnected: mqtt.connected,
    lastReportAt: state.lastReportAt,
  }))

  app.get('/api/state', async () => state.summary())

  app.get('/api/state/raw', async () => state.raw)

  app.post('/api/command', async (req, reply) => {
    try {
      return execute(mqtt, req.body as CommandInput)
    } catch (e) {
      const err = e as CommandError
      return reply.code(err.status ?? 400).send({ error: err.message })
    }
  })

  // ---- 文件（FTPS）：列目录、Range 流式读取、3MF 预览 ----
  registerFileRoutes(app)
  registerPrintRoutes(app, mqtt, state)
  registerAmsRoutes(app, mqtt, state)
  registerErrorRoutes(app, mqtt, state)

  // ---- 摄像头：在 go2rtc 前面做鉴权代理 ----
  // go2rtc 本身无认证，因此它只监听 127.0.0.1，外部一律经这里
  async function proxyCamera(path: string, reply: FastifyReply) {
    const url = `${config.camera.go2rtc}${path}`
    const upstream = await fetch(url)
    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ error: `go2rtc 返回 ${upstream.status}` })
    }
    reply.header('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
    reply.header('cache-control', 'no-store')
    return reply.send(Readable.fromWeb(upstream.body as any))
  }

  app.get('/api/camera/snapshot.jpg', async (_req, reply) =>
    proxyCamera(`/api/frame.jpeg?src=${config.camera.stream}`, reply))

  /**
   * WebRTC / MSE 的信令通道。
   *
   * go2rtc 没有任何鉴权，所以它只监听 127.0.0.1，这里做带 token 的中继。
   * 走的是信令，不是媒体 —— 媒体由 go2rtc 的 WebRTC 直接发给客户端，
   * 不经过这条连接，也就不会把视频流塞进 Node 的事件循环。
   */
  app.get('/api/camera/ws', { websocket: true }, (socket, req) => {
    if (config.api.token && tokenOf(req as FastifyRequest) !== config.api.token) {
      socket.close(4401, '未授权')
      return
    }

    const url = `${config.camera.go2rtc.replace(/^http/, 'ws')}/api/ws?src=${encodeURIComponent(config.camera.stream)}`
    const upstream = new UpstreamSocket(url)
    const pending: (string | Buffer)[] = []

    upstream.on('open', () => {
      for (const m of pending) upstream.send(m)
      pending.length = 0
    })
    upstream.on('message', (data, isBinary) => {
      if (socket.readyState === socket.OPEN) socket.send(data as Buffer, { binary: isBinary })
    })
    upstream.on('close', () => socket.close())
    upstream.on('error', (e) => {
      console.error('[camera] go2rtc 信令错误:', (e as Error).message)
      socket.close(1011, 'upstream error')
    })

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // 客户端往往在上游握手完成前就发出 offer，先缓存
      if (upstream.readyState === UpstreamSocket.OPEN) upstream.send(data, { binary: isBinary })
      else if (upstream.readyState === UpstreamSocket.CONNECTING) pending.push(data)
    })
    socket.on('close', () => upstream.close())
  })

  // ---- WebSocket：状态实时推送 ----
  app.get('/api/events', { websocket: true }, (socket, req) => {
    if (config.api.token && tokenOf(req as FastifyRequest) !== config.api.token) {
      socket.close(4401, '未授权')
      return
    }
    socket.send(JSON.stringify({ type: 'snapshot', data: state.summary() }))

    const onUpdate = (summary: unknown, patch: unknown) => {
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify({ type: 'update', data: summary, patch }))
    }
    state.on('update', onUpdate)

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping()
    }, 30_000)

    socket.on('close', () => {
      state.off('update', onUpdate)
      clearInterval(ping)
    })
  })

  return app
}
