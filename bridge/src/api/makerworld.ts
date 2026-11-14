/**
 * MakerWorld 登录与导入。客户端逻辑和踩过的坑见 makerworld/client.ts。
 *
 * 导入 = 换签名链接 → 交给文件模块的 importFromUrl（边下边传到打印机、再校验），
 * 跟「从链接导入」是同一条路，之后在文件页里照常切片、打印。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { MakerWorld, MwError } from '../makerworld/client.js'
import type { ImportResult } from './files.js'

const MAX_NAME = 120

/**
 * MakerWorld 给的文件名常带标点和表情。打印机屏幕、FTP 路径都不太认这些，
 * 只留字母数字（含中日文）、空格和少量安全标点。
 */
export function mwFileName(raw: string, fallback: string): string {
  let base = (raw || fallback || 'makerworld').replace(/\.3mf$/i, '')
  base = base
    .replace(/[^\p{L}\p{N} ._()\-+]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) base = 'makerworld'
  const max = MAX_NAME - 4
  if (base.length > max) base = base.slice(0, max).trim()
  return `${base}.3mf`
}

export function registerMakerWorldRoutes(
  app: FastifyInstance,
  mw: MakerWorld,
  files: {
    importFromUrl: (url: URL, name: unknown) => Promise<ImportResult>
    fail: (reply: FastifyReply, e: unknown) => FastifyReply
  },
): void {
  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof MwError) return reply.code(e.status).send({ error: e.message, code: e.code })
    return files.fail(reply, e)
  }

  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

  app.get('/api/mw/account', async () => ({ account: await mw.account() }))

  app.post('/api/mw/logout', async () => {
    await mw.logout()
    return { ok: true }
  })

  app.post('/api/mw/login', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>
      const account = text(b.account)
      if (!account) throw new MwError('badLink', '请输入账号')
      // 三种提交：密码 / 邮箱验证码 / 两步验证码。前两种在第一步失败时会告诉客户端下一步要什么
      if (text(b.tfaKey) && text(b.code)) return { ok: true, account: await mw.loginTfa(account, text(b.tfaKey), text(b.code)) }
      if (text(b.code)) return { ok: true, account: await mw.loginCode(account, text(b.code)) }
      if (typeof b.password === 'string' && b.password) return await mw.loginPassword(account, b.password)
      throw new MwError('badPassword', '请输入密码或验证码')
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post('/api/mw/code', async (req, reply) => {
    try {
      const account = text(((req.body ?? {}) as Record<string, unknown>).account)
      if (!account) throw new MwError('badLink', '请输入邮箱')
      await mw.sendCode(account)
      return { ok: true }
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get('/api/mw/design', async (req, reply) => {
    try {
      const link = text((req.query as Record<string, unknown>).link)
      return await mw.design(link)
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get('/api/mw/list', async (req, reply) => {
    try {
      const q = req.query as Record<string, unknown>
      const offset = Math.max(0, Number(q.offset) || 0)
      const limit = Math.min(50, Math.max(1, Number(q.limit) || 20))
      return q.kind === 'likes' ? await mw.likes(offset, limit) : await mw.favorites(offset, limit)
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post('/api/mw/import', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>
      const instanceId = Number(b.instanceId)
      if (!Number.isInteger(instanceId) || instanceId <= 0) throw new MwError('badLink', '缺少打印配置编号')
      const { url, name } = await mw.downloadUrl(instanceId)
      const file = mwFileName(text(b.name) || name, `makerworld-${instanceId}`)
      return await files.importFromUrl(new URL(url), file)
    } catch (e) {
      return fail(reply, e)
    }
  })
}
