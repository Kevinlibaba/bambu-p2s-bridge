/**
 * 推送订阅与自检。
 *
 * VAPID 公钥是公开信息（浏览器订阅时必须拿到），可以直接下发；
 * 私钥只留在服务端，任何接口都不回显。
 */
import type { FastifyInstance } from 'fastify'
import type { NotifyEvent } from '../notify/events.js'
import type { Notifier } from '../notify/index.js'

export function registerNotifyRoutes(app: FastifyInstance, notifier: Notifier): void {
  app.get('/api/notify', async () => notifier.status())

  app.post('/api/notify/subscribe', async (req, reply) => {
    const ok = await notifier.store.add(req.body)
    if (!ok) return reply.code(400).send({ error: '订阅格式无效' })
    return { ok: true, subscribers: notifier.store.all().length }
  })

  app.post('/api/notify/unsubscribe', async (req) => {
    const endpoint = String((req.body as { endpoint?: string } | undefined)?.endpoint ?? '')
    const removed = await notifier.store.remove(endpoint)
    return { ok: true, removed, subscribers: notifier.store.all().length }
  })

  /** 自检：走完整投递链路，把每个出口的结果原样返回，方便定位是哪一环没配好 */
  app.post('/api/notify/test', async (req) => {
    const body = (req.body ?? {}) as { snapshot?: boolean }
    let e: NotifyEvent = {
      kind: 'online',
      key: `test:${Date.now()}`,
      title: '测试通知',
      body: '如果你看到这条，推送链路是通的。',
    }
    // 带快照的测试：验证「首层完成」那条链路（抓帧、落盘、各出口带图）
    if (body.snapshot) {
      e = await notifier.withSnapshot({ ...e, kind: 'firstLayer', title: '测试快照', body: '摄像头此刻的画面' })
    }
    const rec = await notifier.send(e)
    return { ok: rec.results.some((r) => r.ok), results: rec.results, image: rec.image ?? null }
  })
}
