<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, isConfigured, tokenizedUrl } from '../api/client'

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
const snapshotUrl = ref('')
const usingSnapshot = ref(false)

let video: HTMLVideoElement | null = null
let pc: RTCPeerConnection | null = null
let ws: WebSocket | null = null
let snapTimer: ReturnType<typeof setInterval> | null = null
let watchdog: ReturnType<typeof setTimeout> | null = null

// ---------- 抽帧 ----------
function refreshSnapshot() {
  if (!isConfigured()) return
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
function mountVideo(): HTMLVideoElement | null {
  const el = (host.value as { $el?: HTMLElement })?.$el ?? (host.value as HTMLElement | null)
  if (!el) return null
  const v = document.createElement('video')
  v.autoplay = true
  v.muted = true
  v.controls = false
  // iOS 不加这两个属性会强制全屏播放
  v.playsInline = true
  v.setAttribute('playsinline', '')
  v.setAttribute('webkit-playsinline', '')
  v.style.cssText = 'width:100%;display:block;background:#000'
  el.appendChild(v)
  return v
}

async function startRtc() {
  if (!isConfigured()) return
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
  watchdog = setTimeout(() => { if (!video?.srcObject) fallback() }, 8000)
}
// #endif

// ---------- 调度 ----------
function stopAll() {
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
onMounted(() => { void nextTick(start) })
watch(() => [props.active, props.mode], () => void nextTick(start))
onBeforeUnmount(stopAll)

defineExpose({ start, stopAll })
</script>

<template>
  <view class="wrap">
    <!-- WebRTC 的 <video> 由脚本挂进这里；抽帧时用 image -->
    <view ref="host" class="host" />
    <image v-if="usingSnapshot && snapshotUrl" class="shot" :src="snapshotUrl" mode="widthFix" />
  </view>
</template>

<style scoped>
.wrap { position: relative; background: #000; line-height: 0; }
.host { line-height: 0; }
.shot { width: 100%; display: block; }
</style>
