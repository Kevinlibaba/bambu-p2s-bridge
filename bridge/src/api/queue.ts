/** 打印队列的接口。规则都在 queue/index.ts 里，这里只做编解码和错误映射 */
import type { FastifyInstance } from 'fastify'
import * as ftp from '../printer/ftp.js'
import { PrintQueue, QueueError } from '../queue/index.js'
import { EjectSourceError } from '../eject/source.js'

export function registerQueueRoutes(app: FastifyInstance, queue: PrintQueue): void {
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (e instanceof QueueError) return reply.code(e.status).send({ error: e.message })
    if (e instanceof EjectSourceError) return reply.code(e.status).send({ error: e.message })
    if (e instanceof ftp.BadPathError) return reply.code(400).send({ error: e.message })
    if (e instanceof ftp.NotAFileError) return reply.code(e.status).send({ error: e.message })
    if (e instanceof ftp.TooManyReadsError) return reply.code(503).send({ error: e.message })
    return reply.code(502).send({ error: `FTPS 失败: ${(e as Error).message}` })
  }

  app.get('/api/queue', async () => queue.status())

  app.post('/api/queue', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: string; plate?: number; slots?: Record<string, number> }
    try {
      if (!body.path) throw new QueueError('要排哪个文件')
      const path = ftp.normalizePath(body.path)
      if (!/\.gcode\.3mf$/i.test(path)) throw new QueueError('只能排已切片的 .gcode.3mf')
      const st = await queue.add({ path, plate: body.plate, slots: body.slots })
      return reply.code(201).send(st)
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete<{ Params: { id: string } }>('/api/queue/:id', async (req, reply) => {
    try { return await queue.remove(req.params.id) } catch (e) { return fail(reply, e) }
  })

  app.post('/api/queue/reorder', async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown }
    try {
      if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) throw new QueueError('ids 必须是字符串数组')
      return await queue.reorder(body.ids as string[])
    } catch (e) { return fail(reply, e) }
  })

  for (const [name, fn] of [
    ['start', () => queue.start()], ['pause', () => queue.pause()],
    ['resume', () => queue.resume()], ['clear', () => queue.clear()],
  ] as const) {
    app.post(`/api/queue/${name}`, async (_req, reply) => {
      try { return await fn() } catch (e) { return fail(reply, e) }
    })
  }
}
