/**
 * 切片器状态与一键安装。安装逻辑见 slice/installer.ts。
 *
 *   GET    /api/slicer          用的是哪一份、能不能装、安装进度
 *   POST   /api/slicer/install  开始下载安装（后台跑，前端轮询 GET）
 *   DELETE /api/slicer          删掉一键安装的那份（手动挂载的不碰）
 */
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { InstallError, looksInstalled, SlicerInstaller } from '../slice/installer.js'

export function registerSlicerRoutes(app: FastifyInstance, installer: SlicerInstaller): void {
  app.get('/api/slicer', async () => {
    const mounted = looksInstalled(config.slicer.root)
    const downloaded = looksInstalled(installer.root)
    const src = installer.source
    return {
      available: mounted || downloaded,
      /** mounted = 宿主机手动挂进来的；downloaded = 一键安装的 */
      source: mounted ? 'mounted' : downloaded ? 'downloaded' : null,
      version: downloaded && !mounted ? await installer.installedVersion() : null,
      supported: installer.supported,
      /** 一键安装会装的版本与下载大小 */
      offer: { version: src.version, downloadMB: src.size ? Math.round(src.size / 1048576) : null, diskMB: 540 },
      install: installer.current(),
    }
  })

  app.post('/api/slicer/install', async (_req, reply) => {
    try {
      return installer.start()
    } catch (e) {
      if (e instanceof InstallError) return reply.code(400).send({ error: e.message, code: e.code })
      throw e
    }
  })

  app.delete('/api/slicer', async (_req, reply) => {
    try {
      await installer.remove()
      return { ok: true }
    } catch (e) {
      if (e instanceof InstallError) return reply.code(409).send({ error: e.message, code: e.code })
      throw e
    }
  })
}
