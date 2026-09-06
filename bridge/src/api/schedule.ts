/** 定时打印的接口：看、定、取消 */
import type { FastifyInstance } from 'fastify'
import { PrintSchedule, ScheduleError } from '../schedule/index.js'

export function registerScheduleRoutes(app: FastifyInstance, schedule: PrintSchedule): void {
  app.get('/api/print/schedule', async () => schedule.status())

  app.post('/api/print/schedule', async (req, reply) => {
    const body = (req.body ?? {}) as { at?: unknown; print?: Record<string, unknown>; name?: unknown }
    try {
      if (!body.print || typeof body.print !== 'object') throw new ScheduleError('缺少打印参数')
      const path = String(body.print.path ?? '')
      if (!path) throw new ScheduleError('缺少文件路径')
      const name = String(body.name ?? path.slice(path.lastIndexOf('/') + 1))
      return await schedule.set(Number(body.at), body.print, name)
    } catch (e) {
      if (e instanceof ScheduleError) return reply.code(e.status).send({ error: e.message })
      throw e
    }
  })

  app.delete('/api/print/schedule', async () => schedule.cancel())
}
