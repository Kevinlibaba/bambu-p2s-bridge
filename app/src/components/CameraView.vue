<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, configured, tokenizedUrl } from '../api/client'

/**
 * 摄像头画面。
 *
 * live  —— WebRTC。go2rtc 把打印机的 H.264 原样转发，不转码，
 *          全帧率、亚秒延迟，带宽和以前抽帧差不多（约 1 Mbps）。
 * saver —— 定时抓单帧。带宽可控，留给有流量限制的场景。
 *
 * 信令走桥接的鉴权代理；媒体由 go2rtc 直接发给客户端，不经过 Node。
 * WebRTC 起不来（比如 UDP 被挡）时自动退回抽帧，不让画面整个消失。
 */
const props = withDefaults(
  defineProps<{ active: boolean; mode: 'live' | 'saver'; saverIntervalMs?: number }>(),
  { saverIntervalMs: 5000 },
)
const emit = defineEmits<{ (e: 'fallback'): void }>()

const host = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const fsHost = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const fullscreen = ref(false)
const snapshotUrl = ref('')
const usingSnapshot = ref(false)

let video: HTMLVideoElement | null = null
let pc: RTCPeerConnection | null = null
let ws: WebSocket | null = null
let snapTimer: ReturnType<typeof setInterval> | null = null
let watchdog: ReturnType<typeof setTimeout> | null = null

// ---------- 抽帧 ----------
function refreshSnapshot() {
  if (!configured.value) return
  snapshotUrl.value = api.snapshotUrl() + '&t=' + Date.now()
}
function startSnapshots(intervalMs: number) {
  usingSnapshot.value = true
  if (snapTimer) clearInterval(snapTimer)
  refreshSnapshot()
  snapTimer = setInterval(refreshSnapshot, intervalMs)
}
function stopSnapshots() {
  if (snapTimer) { clearInterval(snapTimer); snapTimer = null }
  usingSnapshot.value = false
}

// ---------- WebRTC ----------
function teardownRtc() {
  if (fullscreen.value) { fullscreen.value = false; lockPage(false) }
  if (watchdog) { clearTimeout(watchdog); watchdog = null }
  try { ws?.close() } catch { /* noop */ }
  ws = null
  try { pc?.close() } catch { /* noop */ }
  pc = null
  if (video) {
    video.srcObject = null
    video.remove()
    video = null
  }
}

function fallback() {
  teardownRtc()
  emit('fallback')
  startSnapshots(props.saverIntervalMs)
}

// #ifdef H5
function elOf(r: typeof host): HTMLElement | null {
  const v = r.value as { $el?: HTMLElement } | HTMLElement | null
  return (v as { $el?: HTMLElement })?.$el ?? (v as HTMLElement | null)
}

function mountVideo(): HTMLVideoElement | null {
  const el = elOf(host)
  if (!el) return null
  const v = document.createElement('video')
  v.autoplay = true
  v.muted = true
  v.controls = false
  // iOS 不加这两个属性会强制全屏播放
  v.playsInline = true
  v.setAttribute('playsinline', '')
  v.setAttribute('webkit-playsinline', '')
  v.style.cssText = 'width:100%;height:100%;display:block;background:#000;object-fit:contain'
  v.addEventListener('click', toggleFullscreen)
  /* iOS 退出原生全屏后会暂停播放，MediaStream 源有时还会被断开。
     这些监听负责把它拉回来；真断了则由下面的卡顿看门狗重建连接。 */
  v.addEventListener('pause', resumeIfLive)
  v.addEventListener('webkitendfullscreen', resumeIfLive)
  el.appendChild(v)
  return v
}

/*
 * 全屏。原生 API 能用就用原生（Android/桌面能顺带处理旋转和系统 UI），
 * iOS Safari 只在 <video> 上提供 webkitEnterFullscreen，且对 MediaStream
 * 源的支持不稳定 —— 两条都不成就退回应用内覆盖层，行为在各端一致。
 */
type IOSVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void
  webkitDisplayingFullscreen?: boolean
}

function resumeIfLive() {
  if (!props.active || props.mode !== 'live' || !video) return
  void video.play().catch(() => { /* 自动播放被拦时交给看门狗 */ })
}

/*
 * 卡顿看门狗。
 * 退出全屏后画面冻住的成因在 iOS 上不止一种（暂停、轨道被结束、解码器被回收），
 * 与其逐个猜，不如直接盯住 currentTime：连续几个周期不前进就整条重建。
 */
let lastTime = -1
let stalls = 0
let stallTimer: ReturnType<typeof setInterval> | null = null

function startStallWatch() {
  stopStallWatch()
  lastTime = -1
  stalls = 0
  stallTimer = setInterval(() => {
    if (!props.active || props.mode !== 'live' || fullscreen.value || !video) return
    const t = video.currentTime
    if (t === lastTime) {
      stalls++
      if (stalls === 1) resumeIfLive()      // 先试着直接恢复播放
      // 必须走 start()：它先 stopAll() 拆掉旧的 pc/ws/video，
      // 直接调 startRtc() 会再挂一个 video 元素，旧连接也不释放
      if (stalls >= 3) { stalls = 0; start() }
    } else {
      stalls = 0
    }
    lastTime = t
  }, 2000)
}
function stopStallWatch() {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null }
}

function toggleFullscreen() {
  if (fullscreen.value) return void closeOverlay()
  enterFullscreen()
}

function enterFullscreen() {
  const v = video
  if (!v) return
  const ios = v as IOSVideo

  /*
   * iOS Safari 在 iPhone 上不支持元素级的标准全屏 API，只在 <video> 上提供
   * webkitEnterFullscreen —— 那是系统播放器，自带退出按钮，体验比自制覆盖层好，
   * 所以优先。但它对 MediaStream 源的支持不稳定，可能既不抛错也不生效，
   * 因此调用后要回头确认真的进去了，没有就退回覆盖层。
   */
  if (typeof ios.webkitEnterFullscreen === 'function') {
    try {
      ios.webkitEnterFullscreen()
      setTimeout(() => {
        if (!ios.webkitDisplayingFullscreen) void openOverlay()
      }, 500)
      return
    } catch { /* 落到下一档 */ }
  }

  if (typeof v.requestFullscreen === 'function') {
    v.requestFullscreen().catch(() => void openOverlay())
    return
  }

  void openOverlay()
}

/** 覆盖层期间锁住背后的页面，理由同弹出卡片：iOS 上 preventDefault 挡不住滚动 */
let savedY = 0
function lockPage(on: boolean) {
  if (typeof document === 'undefined') return
  const b = document.body
  if (on) {
    savedY = window.scrollY || document.documentElement.scrollTop || 0
    b.style.position = 'fixed'
    b.style.top = `-${savedY}px`
    b.style.left = '0'
    b.style.right = '0'
    b.style.width = '100%'
  } else {
    b.style.position = ''
    b.style.top = ''
    b.style.left = ''
    b.style.right = ''
    b.style.width = ''
    window.scrollTo(0, savedY)
  }
}

async function openOverlay() {
  fullscreen.value = true
  lockPage(true)
  await nextTick()
  const target = elOf(fsHost)
  if (target && video) target.appendChild(video)   // 移动节点，MediaStream 不中断
}

async function closeOverlay() {
  const back = elOf(host)
  if (back && video) back.appendChild(video)
  fullscreen.value = false
  lockPage(false)
}

async function startRtc() {
  if (!configured.value) return
  video = mountVideo()
  if (!video) return fallback()

  pc = new RTCPeerConnection({ iceServers: [] })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.ontrack = (e) => {
    if (video && e.streams[0]) {
      video.srcObject = e.streams[0]
      stopSnapshots()
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
    }
  }

  const url = tokenizedUrl('/api/camera/ws').replace(/^http/, 'ws')
  ws = new WebSocket(url)

  ws.onopen = async () => {
    try {
      const offer = await pc!.createOffer()
      await pc!.setLocalDescription(offer)
      // go2rtc 要的是完整的 SessionDescription 对象，不是裸 SDP 字符串
      ws!.send(JSON.stringify({
        type: 'webrtc',
        value: { type: 'offer', sdp: pc!.localDescription!.sdp, ice_servers: [] },
      }))
    } catch {
      fallback()
    }
  }
  ws.onmessage = async (ev) => {
    let msg: { type?: string; value?: unknown }
    try { msg = JSON.parse(ev.data as string) } catch { return }

    if (msg.type === 'error') {
      console.error('[camera] go2rtc:', msg.value)
      return fallback()
    }
    try {
      if (msg.type === 'webrtc' && msg.value) {
        // 应答可能是对象，也可能是裸 SDP，两种都接住
        const v = msg.value as { sdp?: string } | string
        const sdp = typeof v === 'string' ? v : v.sdp
        if (sdp) await pc!.setRemoteDescription({ type: 'answer', sdp })
      } else if (msg.type === 'webrtc/candidate' && msg.value) {
        const v = msg.value as { candidate?: string } | string
        const candidate = typeof v === 'string' ? v : v.candidate
        if (candidate) await pc!.addIceCandidate({ candidate, sdpMid: '0' })
      }
    } catch { /* 个别候选失败不致命 */ }
  }
  ws.onerror = () => fallback()

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc/candidate', value: e.candidate.candidate }))
    }
  }

  // 起不来就别干等着，先用抽帧顶上，出画后自动切回
  startSnapshots(props.saverIntervalMs)
  startStallWatch()
  watchdog = setTimeout(() => { if (!video?.srcObject) fallback() }, 8000)
}
// #endif

// ---------- 调度 ----------
function stopAll() {
  stopStallWatch()
  teardownRtc()
  stopSnapshots()
}
function start() {
  stopAll()
  if (!props.active) return
  if (props.mode === 'saver') return startSnapshots(props.saverIntervalMs)
  // #ifdef H5
  void startRtc()
  return
  // #endif
  // 非 H5 端暂无 WebRTC，直接抽帧
  startSnapshots(props.saverIntervalMs)
}

/* 必须等挂载完成 —— immediate 的 watch 会在模板渲染前就跑，
   那时容器 ref 还是 null，会被误判成"起不来"直接降级 */
onMounted(() => {
  void nextTick(start)
  // #ifdef H5
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      fullscreen.value = false
      resumeIfLive()
    }
  })
  // #endif
})
watch(() => [props.active, props.mode], () => void nextTick(start))
onBeforeUnmount(() => { lockPage(false); stopAll() })

defineExpose({ start, stopAll, enterFullscreen })
</script>

<template>
  <view class="wrap">
    <!-- WebRTC 的 <video> 由脚本挂进这里；抽帧时用 image -->
    <view ref="host" class="host" />
    <image
      v-if="usingSnapshot && snapshotUrl"
      class="shot"
      :src="snapshotUrl"
      mode="aspectFit"
      @click="openOverlay"
    />

    <!-- 应用内全屏覆盖层：原生全屏不可用时的统一行为 -->
    <view v-if="fullscreen" class="fs" @click="closeOverlay">
      <view ref="fsHost" class="fs-host" />
      <image v-if="usingSnapshot && snapshotUrl" class="fs-shot" :src="snapshotUrl" mode="aspectFit" />
      <view class="fs-close"><text class="fs-close-t">✕</text></view>
    </view>
  </view>
</template>

<style scoped>
/*
 * 高度由 16:9 写死，不随内容变化。
 * 切换档位的瞬间容器里既没有图片也还没有视频，若让内容决定高度就会先塌陷
 * 再撑开，下方整页跟着跳一下。源流固定 1920x1080，锁比例即可根治。
 */
.wrap {
  position: relative;
  background: #000;
  line-height: 0;
  overflow: hidden;
  aspect-ratio: 16 / 9;
}
@supports not (aspect-ratio: 1 / 1) {
  .wrap::before { content: ''; display: block; padding-top: 56.25%; }
}
.fs {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  /* 盖住 tabBar(899) 与弹出卡片(900)，但让给 uni 自己的 toast/modal(999) */
  z-index: 950;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fs-host { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.fs-shot { width: 100%; height: 100%; }
.fs-close {
  position: absolute;
  top: calc(24rpx + constant(safe-area-inset-top));
  top: calc(24rpx + env(safe-area-inset-top));
  right: 28rpx;
  width: 72rpx; height: 72rpx; border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(20rpx);
  -webkit-backdrop-filter: blur(20rpx);
  display: flex; align-items: center; justify-content: center;
}
.fs-close-t { color: #fff; font-size: 30rpx; line-height: 1; }

.host, .shot {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  width: 100%; height: 100%;
}
</style>
