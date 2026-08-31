/**
 * 推送出口。
 *
 * Web Push 是首选：不依赖任何第三方服务，PWA 装到主屏后 iOS 也收得到，
 * 消息经由浏览器厂商的推送通道，桥接只需要能出网。
 * 其余几个是给不想装 PWA、或者想收到 Telegram / 企业微信里的场景准备的。
 *
 * 每个出口都自己吞掉异常 —— 推送失败不该影响桥接的正常运转。
 */
import webpush from 'web-push'
import { config } from '../config.js'
import type { NotifyEvent } from './events.js'
import type { PushStore } from './store.js'

export interface SinkResult {
  name: string
  ok: boolean
  detail?: string
}

const TIMEOUT_MS = 10_000

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Bark（iOS）。URL 形如 https://api.day.app/<设备key> */
async function bark(e: NotifyEvent): Promise<SinkResult> {
  const base = config.notify.bark
  if (!base) return { name: 'bark', ok: false, detail: 'skipped' }
  try {
    await postJson(base.replace(/\/+$/, '') + '/', {
      title: e.title,
      body: e.body,
      group: 'bambu',
      level: e.kind === 'printFailed' || e.kind === 'error' ? 'timeSensitive' : 'active',
    })
    return { name: 'bark', ok: true }
  } catch (err) {
    return { name: 'bark', ok: false, detail: (err as Error).message }
  }
}

/** ntfy。URL 形如 https://ntfy.sh/<topic>，也可指向自建实例 */
async function ntfy(e: NotifyEvent): Promise<SinkResult> {
  const url = config.notify.ntfy
  if (!url) return { name: 'ntfy', ok: false, detail: 'skipped' }
  try {
    await postJson(url, {
      topic: url.split('/').pop(),
      title: e.title,
      message: e.body,
      priority: e.kind === 'printFailed' || e.kind === 'error' ? 4 : 3,
      tags: ['printer'],
    })
    return { name: 'ntfy', ok: true }
  } catch (err) {
    return { name: 'ntfy', ok: false, detail: (err as Error).message }
  }
}

async function telegram(e: NotifyEvent): Promise<SinkResult> {
  const { token, chatId } = config.notify.telegram
  if (!token || !chatId) return { name: 'telegram', ok: false, detail: 'skipped' }
  try {
    await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: `*${e.title}*\n${e.body}`,
      parse_mode: 'Markdown',
    })
    return { name: 'telegram', ok: true }
  } catch (err) {
    return { name: 'telegram', ok: false, detail: (err as Error).message }
  }
}

/** 通用 webhook：原样投递事件，接企业微信/钉钉/自建服务都行 */
async function webhook(e: NotifyEvent): Promise<SinkResult> {
  const url = config.notify.webhook
  if (!url) return { name: 'webhook', ok: false, detail: 'skipped' }
  try {
    await postJson(url, e)
    return { name: 'webhook', ok: true }
  } catch (err) {
    return { name: 'webhook', ok: false, detail: (err as Error).message }
  }
}

export function vapidReady(): boolean {
  return !!(config.notify.vapid.publicKey && config.notify.vapid.privateKey)
}

/**
 * RFC 8292 要求 VAPID 的 sub 是 mailto: 或 https: URL，
 * Apple 还会额外拒绝不可路由的域名（.local / localhost 之类），
 * 回 403 BadJwtToken。这类问题只在真机推送时才暴露，
 * 所以启动时就先检出来。返回问题描述，无问题时为 null。
 */
export function vapidSubjectProblem(): string | null {
  const sub = config.notify.vapid.subject.trim()
  if (!sub) return 'VAPID_SUBJECT 为空'
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/i.test(sub)) {
    return `VAPID_SUBJECT 必须是 mailto: 或 https:// 开头的地址，当前是 "${sub}"`
  }
  if (/\.local$|localhost|\.internal$|\.test$|\.invalid$/i.test(sub)) {
    return `VAPID_SUBJECT 的域名不可路由（${sub}），Apple 会以 403 BadJwtToken 拒绝推送`
  }
  return null
}

let vapidSet = false
function ensureVapid() {
  if (vapidSet || !vapidReady()) return
  webpush.setVapidDetails(
    config.notify.vapid.subject,
    config.notify.vapid.publicKey,
    config.notify.vapid.privateKey,
  )
  vapidSet = true
}

/**
 * Web Push。订阅失效（410/404）时把它从库里摘掉，
 * 否则每次推送都要为死订阅等一次超时。
 */
async function push(e: NotifyEvent, store: PushStore): Promise<SinkResult> {
  if (!vapidReady()) return { name: 'webpush', ok: false, detail: 'skipped' }
  const subs = store.all()
  if (!subs.length) return { name: 'webpush', ok: false, detail: 'no-subscribers' }
  ensureVapid()

  const payload = JSON.stringify({
    title: e.title,
    body: e.body,
    kind: e.kind,
    code: e.code ?? null,
  })

  let sent = 0
  const dead: string[] = []
  const failures: string[] = []
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, payload, { TTL: 3600 })
        sent += 1
      } catch (err) {
        const fail = err as { statusCode?: number; body?: string; message?: string }
        // 订阅已失效，摘掉；否则每次推送都要为死订阅等一次超时
        if (fail.statusCode === 404 || fail.statusCode === 410) {
          dead.push(s.endpoint)
          return
        }
        /*
         * 其余错误必须原样带出来。推送服务的拒绝原因是排查的唯一线索 ——
         * 例如 Apple 对 VAPID subject 很严格，用 .local 这类不可路由的域名
         * 会回 403 BadJwtToken；早先这里把异常整个吞掉，界面上只看得到
         * 「没有出口送达成功」，查不出所以然。
         */
        const why = (fail.body ?? fail.message ?? '').trim().slice(0, 200)
        failures.push(fail.statusCode ? `${fail.statusCode} ${why}` : why || 'unknown')
      }
    }),
  )
  if (dead.length) await store.removeMany(dead)
  const detail = [`sent=${sent}`, dead.length ? `dead=${dead.length}` : '', ...failures]
    .filter(Boolean).join(' ')
  return { name: 'webpush', ok: sent > 0, detail }
}

/** 把一条事件投给所有已配置的出口。任一成功即算送达。 */
export async function deliver(e: NotifyEvent, store: PushStore): Promise<SinkResult[]> {
  return Promise.all([push(e, store), bark(e), ntfy(e), telegram(e), webhook(e)])
}

/** 已配置了哪些出口 —— 只报有无，不回显任何密钥 */
export function configuredSinks(store: PushStore): Record<string, boolean | number> {
  return {
    webpush: vapidReady(),
    webpushSubscribers: store.all().length,
    bark: !!config.notify.bark,
    ntfy: !!config.notify.ntfy,
    telegram: !!(config.notify.telegram.token && config.notify.telegram.chatId),
    webhook: !!config.notify.webhook,
  }
}
