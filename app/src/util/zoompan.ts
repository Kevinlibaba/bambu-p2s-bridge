/**
 * 双指缩放与拖动。
 *
 * 起因：全屏看画面时想放大某个角落检查打印质量，但 iPhone 上走的是
 * webkitEnterFullscreen，那是系统播放器 —— 它的捏合只是「适应↔填充」
 * 两档切换，不是缩放，所以看起来就是「只能放大一倍且不能移动」。
 * 我们自己的覆盖层则完全没做缩放。
 *
 * 页面的 viewport 写了 user-scalable=no，浏览器不会自己缩放，
 * 手势完全归我们管，这反而省去了和系统缩放打架的麻烦。
 *
 * 变换模型固定为 `translate(tx, ty) scale(s)`，transform-origin 取默认的
 * 中心点。下面所有坐标都是「相对容器中心」的像素。
 */

export interface Transform {
  s: number
  tx: number
  ty: number
}

export const IDENTITY: Transform = { s: 1, tx: 0, ty: 0 }

export const MIN_SCALE = 1
export const MAX_SCALE = 6

export function clampScale(s: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(s)) return min
  return Math.min(max, Math.max(min, s))
}

export interface Box {
  w: number
  h: number
}

/**
 * 按 contain 规则算出画面在元素框里真正占据的尺寸。
 *
 * aspectFit / object-fit: contain 的元素框永远是满容器的，但画面只占其中
 * 一块 —— 16:9 的源放进竖屏，上下都是黑边。直接量元素框会把黑边也算成画面，
 * 于是竖直方向给出根本不存在的拖动余量，一拖就只剩黑。
 */
export function containBox(elW: number, elH: number, natW: number, natH: number): Box {
  if (!(elW > 0 && elH > 0 && natW > 0 && natH > 0)) return { w: elW, h: elH }
  const k = Math.min(elW / natW, elH / natH)
  return { w: natW * k, h: natH * k }
}

/**
 * 把位移限制在「画面边缘不越过容器边缘」之内。
 *
 * 关键是要按**实际画面**算，而不是按容器算。16:9 的视频放进竖屏容器，
 * 上下本来就有黑边；若按容器高度给余量，竖直方向能一路拖到只剩黑边，
 * 用户还得盲猜怎么划回来 —— 实测就是这样。
 *
 * 画面缩放后是 s·cw × s·ch，居中放在 W × H 的容器里，于是单边余量是
 * (s·cw − W)/2；画面还没铺满容器时余量为 0，不允许拖动。
 */
export function clampTranslate(t: Transform, container: Box, content: Box = container): Transform {
  if (t.s <= 1) return { s: t.s, tx: 0, ty: 0 }
  const maxX = Math.max(0, (t.s * content.w - container.w) / 2)
  const maxY = Math.max(0, (t.s * content.h - container.h) / 2)
  return {
    s: t.s,
    tx: Math.min(maxX, Math.max(-maxX, t.tx)),
    ty: Math.min(maxY, Math.max(-maxY, t.ty)),
  }
}

/**
 * 以某个锚点为中心改变缩放倍数。
 *
 * 手指按住的那一点在缩放前后必须停在原地，否则画面会从指尖底下溜走。
 * 推导：锚点 m 对应的内容坐标 c 满足 m = c·s₀ + t₀，缩放后要求
 * m = c·s₁ + t₁，代入即得 t₁ = m − (m − t₀)·s₁/s₀。
 */
export function scaleAround(
  cur: Transform,
  nextScale: number,
  anchorX: number,
  anchorY: number,
  container: Box,
  content: Box = container,
): Transform {
  const s = clampScale(nextScale)
  const k = s / cur.s
  return clampTranslate(
    {
      s,
      tx: anchorX - (anchorX - cur.tx) * k,
      ty: anchorY - (anchorY - cur.ty) * k,
    },
    container,
    content,
  )
}

export function translateBy(
  cur: Transform, dx: number, dy: number, container: Box, content: Box = container,
): Transform {
  return clampTranslate({ s: cur.s, tx: cur.tx + dx, ty: cur.ty + dy }, container, content)
}

export function toCss(t: Transform): string {
  // 缩放为 1 时不留 transform，免得给合成层平添一次无谓的重绘
  if (t.s === 1 && t.tx === 0 && t.ty === 0) return ''
  return `translate(${t.tx.toFixed(2)}px, ${t.ty.toFixed(2)}px) scale(${t.s.toFixed(4)})`
}

export interface Point {
  x: number
  y: number
}

/** 两指之间的距离与中点，中点已换算成「相对容器中心」 */
export function pinchOf(a: Point, b: Point, rect: { left: number; top: number; width: number; height: number }) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return {
    dist: Math.hypot(dx, dy),
    midX: (a.x + b.x) / 2 - rect.left - rect.width / 2,
    midY: (a.y + b.y) / 2 - rect.top - rect.height / 2,
  }
}

/** 双击在 1 倍与这个倍数之间切换 —— 比反复捏合快得多 */
export const DOUBLE_TAP_SCALE = 2.5

export function toggleScale(
  cur: Transform, anchorX: number, anchorY: number, container: Box, content: Box = container,
): Transform {
  const target = cur.s > 1 ? 1 : DOUBLE_TAP_SCALE
  if (target === 1) return { ...IDENTITY }
  return scaleAround(cur, target, anchorX, anchorY, container, content)
}
