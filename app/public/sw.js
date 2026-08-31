/*
 * Service Worker。只做两件事：
 *   1. 缓存应用外壳，断网时至少能打开界面，而不是一片空白
 *   2. 接收推送并唤起系统通知
 *
 * 刻意不缓存 /api/**：状态、摄像头、文件列表都必须是实时的，
 * 缓存它们只会让人看到过期的打印进度 —— 那比看不到更糟。
 */
const CACHE = 'bambu-shell-v1'

self.addEventListener('install', (e) => {
  // 新版本立刻接管，免得用户要关掉所有标签页才生效
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html']).catch(() => {})))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // 换名的旧缓存整份删掉
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      /*
       * 带哈希的资源每次发版都是新文件名，旧的再也不会被请求，
       * 却会一直躺在同一个缓存里越堆越多。激活时清掉，
       * 页面随后会把新版重新缓存进来。
       */
      const cache = await caches.open(CACHE)
      const stale = (await cache.keys()).filter((r) => new URL(r.url).pathname.includes('/assets/'))
      await Promise.all(stale.map((r) => cache.delete(r)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api/')) return // 实时数据一律直连

  // 静态资源：网络优先，失败回缓存。开发时不会拿到旧包，断网时仍打得开。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  )
})

self.addEventListener('push', (e) => {
  let d = { title: '打印机', body: '' }
  try {
    d = e.data ? e.data.json() : d
  } catch {
    d = { title: '打印机', body: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || '打印机', {
      body: d.body || '',
      icon: './static/icons/icon-192.png',
      badge: './static/icons/icon-192.png',
      // 同一类事件只留最新一条，别在通知中心堆一摞
      tag: d.kind || 'bambu',
      renotify: true,
      data: d,
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const target = new URL('./index.html#/pages/monitor/index', self.location.href).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})
