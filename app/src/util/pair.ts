/*
 * 扫码配对与首次设置的几件小事。
 *
 * 配对链接形如 https://<桥接地址>/app/#pair=<token>：token 放在 # 后面，
 * 浏览器不会把它发给服务器，也就不会出现在任何访问日志里。App 一启动就把它取出来
 * 存好、从地址栏抹掉 —— 必须赶在 uni 的 hash 路由读地址之前，见 main.ts。
 */
import qrcode from 'qrcode-generator'
import { loadSettings, saveSettings } from '../api/client'

const PAIR = '#pair='

/** 在本机打开就能直接用的链接 */
export function pairUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/app/${PAIR}${encodeURIComponent(token)}`
}

/** App 是不是由桥接自己托管的（地址形如 http://host:8080/app/） */
function servedByBridge(): boolean {
  return typeof location !== 'undefined' && /^\/app(\/|$)/.test(location.pathname)
}

/**
 * 启动时调用，两件事：
 *  · 地址栏里带配对 token 就存下来并抹掉；
 *  · 还没填过服务器地址、而 App 正是桥接托管的，就默认用当前地址 ——
 *    新手在浏览器里打开桥接，不用再回头填一遍「服务器地址」。
 */
export function bootstrapFromLocation(): void {
  if (typeof location === 'undefined') return
  if (location.hash.startsWith(PAIR)) {
    const token = decodeURIComponent(location.hash.slice(PAIR.length))
    if (token) saveSettings({ baseUrl: location.origin, token })
    history.replaceState(null, '', location.pathname + location.search)
    return
  }
  if (!loadSettings().baseUrl && servedByBridge()) {
    saveSettings({ baseUrl: location.origin, token: loadSettings().token })
  }
}

/** 二维码，SVG 数据 URI，可以直接给 <image> */
export function qrDataUri(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
