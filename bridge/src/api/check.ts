/** 存储卡体检的接口：起一轮、看进度和结果 */
import type { FastifyInstance } from 'fastify'
import type { FileChecker } from '../check/index.js'

export function registerCheckRoutes(app: FastifyInstance, checker: FileChecker): void {
  app.get('/api/files/check', async () => checker.status())

  app.post('/api/files/check', async (_req, reply) => {
    if (checker.status().running) {
      return reply.code(409).send({ ...checker.status(), error: '体检已经在跑了' })
    }
    // 立刻返回，进度靠轮询 —— 卡上几百 MB 要下一分钟
    void checker.run()
    return reply.code(202).send(checker.status())
  })
}
