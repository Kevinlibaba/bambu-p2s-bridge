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
  /*
   * 不带 job 是实时曲线（内存里的环形缓冲）；带 job 是回看某一单，
   * 从落盘的按天文件里按该单的起止时间切出来。
   *
   * 曲线是从这个功能上线之后才开始记的，更早的任务没有数据 ——
   * 这种情况返回空数组并把 available 置为 false，让前端说清楚
   * 是「没记录」而不是「加载失败」。
   */
  app.get('/api/history/temps', async (req, reply) => {
    const q = req.query as { minutes?: string; job?: string } | undefined
    if (q?.job) {
      const job = history.find(q.job)
      if (!job) return reply.code(404).send({ error: '没有这个任务' })
      const samples = await temps.range(job.startedAt, job.endedAt)
      return { samples, available: samples.length > 0, job: { id: job.id, name: job.name } }
    }
    const raw = Number(q?.minutes ?? 60)
    const minutes = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 360) : 60
    return { samples: temps.list(minutes), available: true }
  })
}
