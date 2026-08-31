/**
 * 打印历史接口。只读 —— 记录由 History 自己在状态跃迁时写。
 */
import type { FastifyInstance } from 'fastify'
import type { History } from '../history/index.js'
import type { Temps } from '../history/temps.js'

export function registerHistoryRoutes(
  app: FastifyInstance,
  history: History,
  temps: Temps,
): void {
  app.get('/api/history', async (req) => {
    const raw = Number((req.query as { limit?: string } | undefined)?.limit ?? 50)
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 50
    return {
      jobs: history.list(limit),
      running: history.running(),
      stats: history.stats(),
    }
  })

  /** 温度曲线。默认给最近一小时，够看当下这一单的走势 */
  app.get('/api/history/temps', async (req) => {
    const raw = Number((req.query as { minutes?: string } | undefined)?.minutes ?? 60)
    const minutes = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 360) : 60
    return { samples: temps.list(minutes) }
  })
}
