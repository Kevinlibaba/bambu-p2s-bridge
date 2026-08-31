import { reactive, readonly } from 'vue'
import { api, eventsUrl, configured, type Summary } from '../api/client'

export type Link = 'idle' | 'connecting' | 'live' | 'polling' | 'error'

interface Store {
  summary: Summary | null
  link: Link
  error: string
  lastAt: number
}

const store = reactive<Store>({ summary: null, link: 'idle', error: '', lastAt: 0 })

let socket: UniApp.SocketTask | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let retry = 0
let stopped = true

function apply(s: Summary) {
  store.summary = s
  store.lastAt = Date.now()
  store.error = ''
}

/**
 * WebSocket 优先；失败则退化为轮询。
 * 微信小程序在正式版要求 wss + 已备案域名，轮询兜底能保证那种场景下仍可用。
 */
function openSocket() {
  if (stopped) return
  store.link = 'connecting'
  let opened = false

  try {
    socket = uni.connectSocket({ url: eventsUrl(), complete: () => {} })
  } catch (e) {
    return fallbackToPolling((e as Error).message)
  }
  if (!socket) return fallbackToPolling('无法建立 WebSocket')

  socket.onOpen(() => {
    opened = true
    retry = 0
    store.link = 'live'
    stopPolling()
  })

  socket.onMessage((res) => {
    try {
      const msg = JSON.parse(res.data as string)
      if (msg?.data) apply(msg.data as Summary)
    } catch {
      /* 忽略非 JSON 帧 */
    }
  })

  socket.onError(() => {
    if (!opened) fallbackToPolling('WebSocket 连接失败')
  })

  socket.onClose(() => {
    socket = null
    if (stopped) return
    if (opened) {
      // 曾经连上过 —— 退避重连
      retry = Math.min(retry + 1, 6)
      store.link = 'connecting'
      setTimeout(openSocket, Math.min(1000 * 2 ** retry, 30000))
    } else {
      fallbackToPolling('WebSocket 已关闭')
    }
  })
}

function fallbackToPolling(reason: string) {
  if (stopped) return
  console.warn('[store] 退化为轮询:', reason)
  store.link = 'polling'
  startPolling()
}

function startPolling() {
  if (pollTimer) return
  const tick = async () => {
    try {
      apply(await api.state())
      if (store.link !== 'live') store.link = 'polling'
    } catch (e) {
      store.error = (e as Error).message
      store.link = 'error'
    }
  }
  void tick()
  pollTimer = setInterval(tick, 3000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function start() {
  if (!configured.value) {
    store.link = 'idle'
    store.error = '尚未配置服务器地址与 Token'
    return
  }
  // onLaunch 与 onShow 会连续触发，这里保证幂等，否则会开出两条连接
  if (!stopped && (socket || store.link === 'live' || store.link === 'connecting')) return
  stopped = false
  retry = 0
  // 先抓一次快照，界面立刻有内容，不必等 WS 握手
  api.state().then(apply).catch((e) => {
    store.error = (e as Error).message
  })
  openSocket()
}

export function stop() {
  stopped = true
  stopPolling()
  try {
    socket?.close({})
  } catch {
    /* noop */
  }
  socket = null
  store.link = 'idle'
}

export function restart() {
  stop()
  start()
}

export const printer = readonly(store)
