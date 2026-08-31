/**
 * Web Push 订阅。
 *
 * 只在 H5 下有意义：小程序与原生 App 各有自己的推送通道，
 * 那两端要接的话是另一套东西，这里用条件编译隔开，不污染跨端逻辑。
 *
 * iOS 的限制值得单独说：Safari 只在「已添加到主屏」的 PWA 里给 Notification
 * 权限，普通标签页里 Notification.requestPermission 会直接被拒。
 * 所以界面上要先引导用户装到主屏，再谈订阅。
 */
import { fetchNotifyStatus, subscribePush, unsubscribePush } from './client'

export type PushSupport = 'ok' | 'no-sw' | 'no-push' | 'insecure' | 'not-h5'

/** base64url → Uint8Array。VAPID 公钥是这个编码，applicationServerKey 要二进制 */
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupport(): PushSupport {
  // #ifndef H5
  return 'not-h5'
  // #endif
  // #ifdef H5
  // Service Worker 与推送都要求安全上下文；localhost 例外
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator)) return 'no-sw'
  if (!('PushManager' in window) || !('Notification' in window)) return 'no-push'
  return 'ok'
  // #endif
}

/** 是否运行在已装到主屏的独立窗口里 —— iOS 下这是能否推送的硬前提 */
export function isStandalone(): boolean {
  // #ifdef H5
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
  // #endif
  // #ifndef H5
  return false
  // #endif
}

export function isIOS(): boolean {
  // #ifdef H5
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  // #endif
  // #ifndef H5
  return false
  // #endif
}

/**
 * 拿到 Service Worker 注册。应用启动时已经注册过（见 util/sw.ts），
 * 这里只等它就绪，不重复注册 —— 重复注册会多触发一次 controllerchange。
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  // #ifdef H5
  if (pushSupport() !== 'ok') return null
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.ready
  // #endif
  // #ifndef H5
  return null
  // #endif
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  // #ifdef H5
  if (pushSupport() !== 'ok') return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
  // #endif
  // #ifndef H5
  return null
  // #endif
}

/** 订阅。返回失败原因而不是抛异常，界面据此给出可操作的提示。 */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  // #ifdef H5
  const support = pushSupport()
  if (support !== 'ok') return { ok: false, reason: support }

  const status = await fetchNotifyStatus()
  if (!status.vapidPublicKey) return { ok: false, reason: 'no-vapid' }

  const reg = (await ensureServiceWorker()) ?? (await navigator.serviceWorker.ready)
  await navigator.serviceWorker.ready

  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, reason: 'denied' }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
  })
  await subscribePush(JSON.parse(JSON.stringify(sub)))
  return { ok: true }
  // #endif
  // #ifndef H5
  return { ok: false, reason: 'not-h5' }
  // #endif
}

export async function disablePush(): Promise<void> {
  // #ifdef H5
  const sub = await currentSubscription()
  if (!sub) return
  await unsubscribePush(sub.endpoint).catch(() => {})
  await sub.unsubscribe().catch(() => {})
  // #endif
}
