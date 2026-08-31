/**
 * 打印历史接口。只读 —— 记录由 History 自己在状态跃迁时写。
 */
import type { FastifyInstance } from 'fastify'
import type { History } from '../history/index.js'

export function registerHistoryRoutes(app: FastifyInstance, history: History): void {
  app.get('/api/history', async (req) => {
    const raw = Number((req.query as { limit?: string } | undefined)?.limit ?? 50)
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 50
    return {
      jobs: history.list(limit),
      running: history.running(),
      stats: history.stats(),
    }
  })
}
