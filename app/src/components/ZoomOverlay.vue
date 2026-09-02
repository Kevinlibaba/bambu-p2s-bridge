<script setup lang="ts">
/*
 * 可缩放的全屏覆盖层。
 *
 * 存在的理由：交给系统播放器就没法做手势。iOS 原生全屏的捏合只是
 * 「适应↔填充」两档切换，不是缩放，也不能平移 —— 想放大看清打印件的
 * 某个角落根本做不到。这里把画面接管过来，捏合、拖动、双击都自己实现。
 *
 * 内容由调用方通过插槽给，组件只负责手势、变换和关闭。
 */
import { ref, watch } from 'vue'
import { useZoomPan } from '../util/useZoomPan'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/*
 * uni-app 里 <view> 上的 ref 拿到的可能是组件代理而不是真实 DOM 元素，
 * 直接 getBoundingClientRect 会抛错 —— 和 CameraView 里 elOf 的道理一样。
 */
const root = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const rootEl = () => {
  const v = root.value as { $el?: HTMLElement } | HTMLElement | null
  return ((v as { $el?: HTMLElement })?.$el ?? (v as HTMLElement | null)) ?? null
}
const zoom = useZoomPan()

watch(() => props.visible, (v) => {
  if (!v) zoom.reset()
  lockPage(v)
})

/* 覆盖层期间锁住背后的页面：iOS 上光靠 preventDefault 挡不住整页滚动 */
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

function onStart(e: TouchEvent) {
  zoom.onTouchStart(e, rootEl())
}
function onMove(e: TouchEvent) {
  zoom.onTouchMove(e)
}
function onEnd(e: TouchEvent) {
  const tapped = zoom.onTouchEnd(e, rootEl())
  // 放大状态下正在看细节，一次误触不该把全屏关掉
  if (tapped && !zoom.zoomed.value) emit('close')
}
</script>

<template>
  <view
    v-if="visible"
    ref="root"
    class="zo"
    @touchstart="onStart"
    @touchmove="onMove"
    @touchend="onEnd"
  >
    <view class="zo-inner" :style="zoom.style.value">
      <slot />
    </view>
    <view class="zo-close" @click.stop="emit('close')"><text class="zo-close-t">✕</text></view>
  </view>
</template>

<style scoped>
.zo {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  /* 盖住 tabBar(899) 与弹出卡片(900)，让给 uni 自己的 toast/modal(999) */
  z-index: 950;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 手势全归我们管，否则 iOS 会把双指当页面手势、单指当滚动 */
  touch-action: none;
}
.zo-inner {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  transform-origin: center center;
  will-change: transform;
}
.zo-close {
  position: absolute;
  top: calc(24rpx + constant(safe-area-inset-top));
  top: calc(24rpx + env(safe-area-inset-top));
  right: 28rpx;
  width: 72rpx; height: 72rpx; border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(20rpx);
  display: flex; align-items: center; justify-content: center;
}
.zo-close-t { color: #fff; font-size: 32rpx; line-height: 1; }
</style>
