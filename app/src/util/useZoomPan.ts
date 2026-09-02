/**
 * 把 zoompan 的数学接到真实的触摸事件上。
 *
 * 数学部分（锚点、边界）在 zoompan.ts 里，有单测；这里只管手势状态机，
 * 刻意写薄一点。
 *
 * 手势约定：
 *  - 双指捏合缩放，锚在两指中点
 *  - 放大后单指拖动平移；未放大时单指不拦截，留给外层做「点背景关闭」
 *  - 双击在 1 倍与 2.5 倍之间切换，锚在点击处
 */
import { ref, computed } from 'vue'
import {
  IDENTITY, clampScale, containBox, pinchOf, scaleAround, toCss, toggleScale, translateBy,
  type Box, type Transform,
} from './zoompan'

/*
 * uni-app 会把事件规范化，touches 有时是普通数组、有时是 TouchList，
 * 两者的取值方式不一样（一个能下标、一个还带 item()）。统一成数组，
 * 免得在某一端上抛 `touches.item is not a function`。
 */
interface Pt { clientX: number; clientY: number }
function pts(list: unknown): Pt[] {
  if (!list) return []
  const arr = list as ArrayLike<Pt>
  const out: Pt[] = []
  for (let i = 0; i < (arr.length ?? 0); i++) {
    const p = arr[i]
    if (p && typeof p.clientX === 'number') out.push(p)
  }
  return out
}

const DOUBLE_TAP_MS = 300
/** 超过这个位移就不算「点一下」，避免拖动结束时误触发关闭 */
const TAP_SLOP = 10

export function useZoomPan() {
  const t = ref<Transform>({ ...IDENTITY })
  const zoomed = computed(() => t.value.s > 1)
  const style = computed(() => {
    const css = toCss(t.value)
    return css ? `transform: ${css};` : ''
  })

  let rect = { left: 0, top: 0, width: 0, height: 0 }
  /** 容器尺寸与画面实际尺寸。16:9 的画面放进竖屏容器时两者相差很大 */
  let container: Box = { w: 0, h: 0 }
  let content: Box = { w: 0, h: 0 }
  let startDist = 0
  let startScale = 1
  let lastX = 0
  let lastY = 0
  let panning = false
  let lastTapAt = 0
  let downX = 0
  let downY = 0
  let moved = 0

  function measure(el: HTMLElement | null) {
    if (!el) return
    const r = el.getBoundingClientRect()
    rect = { left: r.left, top: r.top, width: r.width, height: r.height }
    container = { w: r.width, h: r.height }

    /*
     * 画面的实际尺寸要单独量。16:9 的视频放进竖屏容器，上下是黑边 ——
     * 按容器高度给拖动余量的话，竖直方向能一路拖到只剩黑边。
     * 画面在已缩放的容器里，所以量到的尺寸要除回当前倍数才是原始尺寸。
     */
    const media = el.querySelector('video, img') as
      (HTMLVideoElement & HTMLImageElement) | null
    if (media) {
      const m = media.getBoundingClientRect()
      const s = t.value.s || 1
      // 元素框永远满容器，画面只占其中一块，要按 contain 规则还原
      const natW = media.videoWidth || media.naturalWidth || 0
      const natH = media.videoHeight || media.naturalHeight || 0
      if (m.width > 0 && m.height > 0) {
        content = containBox(m.width / s, m.height / s, natW, natH)
        return
      }
    }
    content = container
  }

  function reset() {
    t.value = { ...IDENTITY }
    panning = false
    startDist = 0
  }

  function onTouchStart(e: TouchEvent, el: HTMLElement | null) {
    measure(el)
    const ts = pts(e.touches)
    if (ts.length === 2) {
      const p = pinchOf(
        { x: ts[0].clientX, y: ts[0].clientY },
        { x: ts[1].clientX, y: ts[1].clientY },
        rect,
      )
      startDist = p.dist
      startScale = t.value.s
      panning = false
      return
    }
    if (ts.length === 1) {
      const touch = ts[0]
      downX = lastX = touch.clientX
      downY = lastY = touch.clientY
      moved = 0
      panning = t.value.s > 1
    }
  }

  function onTouchMove(e: TouchEvent) {
    const ts = pts(e.touches)
    if (ts.length === 2 && startDist > 0) {
      // 双指时必须拦截，否则 iOS 会把它当成页面手势
      e.preventDefault()
      const p = pinchOf(
        { x: ts[0].clientX, y: ts[0].clientY },
        { x: ts[1].clientX, y: ts[1].clientY },
        rect,
      )
      const next = clampScale((startScale * p.dist) / startDist)
      t.value = scaleAround(t.value, next, p.midX, p.midY, container, content)
      return
    }
    if (ts.length === 1) {
      const touch = ts[0]
      moved = Math.max(moved, Math.hypot(touch.clientX - downX, touch.clientY - downY))
      if (!panning) return
      e.preventDefault()
      t.value = translateBy(
        t.value,
        touch.clientX - lastX,
        touch.clientY - lastY,
        container,
        content,
      )
      lastX = touch.clientX
      lastY = touch.clientY
    }
  }

  /**
   * @returns 这次触摸是否应被视作「点了一下」——
   *   外层据此决定关不关闭，拖动和捏合都不该触发关闭
   */
  function onTouchEnd(e: TouchEvent, el: HTMLElement | null): boolean {
    if (pts(e.touches).length > 0) return false // 还有手指在屏幕上
    const wasPinching = startDist > 0
    startDist = 0
    const wasPanning = panning
    panning = false
    if (wasPinching || wasPanning || moved > TAP_SLOP) return false

    const now = Date.now()
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0
      measure(el)
      const touch = pts(e.changedTouches)[0]
      if (touch) {
        t.value = toggleScale(
          t.value,
          touch.clientX - rect.left - rect.width / 2,
          touch.clientY - rect.top - rect.height / 2,
          container,
          content,
        )
      }
      return false
    }
    lastTapAt = now
    return true
  }

  return { transform: t, zoomed, style, reset, onTouchStart, onTouchMove, onTouchEnd }
}
