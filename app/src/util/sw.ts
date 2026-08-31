/**
 * Service Worker 的注册，以及发版后的自动更新。
 *
 * 装到主屏的 PWA 常驻内存，切回前台不算一次导航，页面不会自己重新加载 ——
 * 表现就是每次发版都得把 app 杀掉重开。
 *
 * 判断「有没有新版本」不能只盯 Service Worker：一次普通发版只会改
 * index.html 和带哈希的资源，sw.js 本身字节没变，registration.update()
 * 查不到新 worker，controllerchange 也就永远不会触发。所以这里直接比对
 * index.html 里引用的入口文件名 —— 它带内容哈希，改了就是真的换了版本。
 * SW 的 controllerchange 仍然监听着，那条路覆盖 sw.js 自身也变了的情况。
 */

/** 首次安装时 controllerchange 也会触发，那一次不该刷新 —— 页面本来就是新的 */
let hadController = false
let reloading = false
/** 页面启动时加载的入口文件名，用来和服务端的最新版本比对 */
let bootBundle = ''

function busyTyping(): boolean {
  const el = document.activeElement
  return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName)
}

/**
 * 刷新。正在输入时不打断 —— 用户可能正粘着 token，刷掉就白填了，
 * 改为等下次切回前台再刷。
 */
function reloadWhenIdle(): void {
  if (reloading) return
  reloading = true
  if (!busyTyping()) {
    location.reload()
    return
  }
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || busyTyping()) return
    document.removeEventListener('visibilitychange', onVisible)
    location.reload()
  }
  document.addEventListener('visibilitychange', onVisible)
}

/** 从一段 HTML 里挑出入口脚本的文件名 */
function entryOf(html: string): string {
  return /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] ?? ''
}

function currentEntry(): string {
  // NodeList 在当前 tsconfig 的 lib 下不可展开，用 Array.from
  const el = Array.from(document.querySelectorAll('script[src]'))
    .map((s) => (s as HTMLScriptElement).src)
    .find((src) => /assets\/index-[A-Za-z0-9_-]+\.js/.test(src))
  return el ? entryOf(el) : ''
}

async function checkForUpdate(base: string): Promise<void> {
  if (reloading || !navigator.onLine) return
  try {
    // no-store 绕过 HTTP 缓存；SW 那边是网络优先，在线时同样拿得到最新的
    const res = await fetch(`${base}index.html`, { cache: 'no-store' })
    if (!res.ok) return
    const latest = entryOf(await res.text())
    if (latest && bootBundle && latest !== bootBundle) reloadWhenIdle()
  } catch {
    /* 离线或桥接不可达，下次再说 */
  }
}

export function registerServiceWorker(): void {
  // #ifdef H5
  if (typeof window === 'undefined') return
  const base = import.meta.env.BASE_URL || '/'
  bootBundle = currentEntry()

  // 切回前台时查一次。PWA 从后台恢复走的就是这条路。
  const onVisible = () => {
    if (document.visibilityState === 'visible') void checkForUpdate(base)
  }
  document.addEventListener('visibilitychange', onVisible)

  if (!('serviceWorker' in navigator) || !window.isSecureContext) return

  hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadWhenIdle()
  })

  void navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base })
    .then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update()
      })
    })
    .catch(() => {
      /* 注册失败只影响离线可用与推送，不该拖垮应用 */
    })
  // #endif
}
