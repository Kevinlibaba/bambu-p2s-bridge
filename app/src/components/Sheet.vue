<script setup lang="ts">
import { onUnmounted, watch } from 'vue'
import { onHide, onUnload } from '@dcloudio/uni-app'

const props = defineProps<{ visible: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/*
 * 防止滑动穿透到背后的页面。两道防线，缺一不可：
 *
 * 1) 事件层（下方模板上的 .stop.prevent）——遮罩与卡片的非滚动区域吞掉 touchmove。
 *    在 Chrome 上这一道就够了，但 **iOS Safari 靠不住**：一旦手势被判定为页面
 *    滚动，后续 touchmove 的 preventDefault 会被忽略。
 *
 * 2) 布局层（这里）——把 body 固定住。这是各家弹窗库通用的做法，正是为了绕开
 *    上面那个 WebKit 行为。用 position:fixed 而不是 overflow:hidden，因为本页的
 *    滚动发生在 viewport 上，overflow:hidden 加在 body 上不起作用（实测确认）。
 *    固定时用负 top 保住原位置，关闭后再滚回去，所以不会跳。
 */
let savedY = 0
let locked = false

function lockPage(on: boolean) {
  // #ifdef H5
  if (typeof document === 'undefined' || on === locked) return
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
  locked = on
  // #endif
}

watch(() => props.visible, (v) => lockPage(v), { immediate: true })

/*
 * 页面被切走时必须解锁。uni-app 会缓存页面而不是卸载它，所以 onUnmounted
 * 不会触发 —— 卡片开着时后退或切标签页，body 的 position:fixed 会留在那里，
 * 整个应用从此都滚不动。
 */
onHide(() => lockPage(false))
onUnload(() => lockPage(false))
onUnmounted(() => lockPage(false))

function swallow() { /* 生效的是模板上的 .stop.prevent 修饰符 */ }

/*
 * 遮罩上「点一下关闭」要区分点击与拖拽：手指在背景上划动时不该关掉卡片。
 * 记下按下位置，位移超过阈值就当成拖拽，忽略随后的 click。
 */
const TAP_SLOP = 10
let downX = 0
let downY = 0
let dragged = false

/*
 * 取第一个触点。
 *
 * 原来写的是 touches.item(0) —— 那假定拿到的一定是原生 TouchList。
 * 但 uni-app 会规范化事件，某些路径下 touches 是普通数组，没有 item()，
 * 于是这里每次触摸都抛 TypeError，dragged 永远设不上：这段代码本是为了
 * 「在遮罩上划动时别关掉卡片」，结果防护完全失效。
 * 下标取值对 TouchList 和数组都成立。
 */
function pointOf(e: TouchEvent | MouseEvent): { x: number; y: number } | null {
  if ('touches' in e) {
    const t = e.touches[0] ?? e.changedTouches[0]
    return t ? { x: t.clientX, y: t.clientY } : null
  }
  return { x: e.clientX, y: e.clientY }
}

function onMaskDown(e: TouchEvent | MouseEvent) {
  const pt = pointOf(e)
  if (!pt) return
  downX = pt.x
  downY = pt.y
  dragged = false
}

function onMaskMove(e: TouchEvent) {
  const pt = pointOf(e)
  if (!pt) return
  if (Math.abs(pt.x - downX) > TAP_SLOP || Math.abs(pt.y - downY) > TAP_SLOP) {
    dragged = true
  }
}

function onMaskTap() {
  if (!dragged) emit('close')
  dragged = false
}
</script>

<template>
  <!-- iOS 式底部卡片：抓手 + 点遮罩关闭，不做多余装饰 -->
  <view
    v-if="visible"
    class="mask"
    @click="onMaskTap"
    @touchstart="onMaskDown"
    @mousedown="onMaskDown"
    @touchmove.stop.prevent="onMaskMove"
  >
    <!-- 卡片内的滑动到此为止，不再冒泡到遮罩，否则内部滚动区也会被 prevent 掉 -->
    <view class="sheet" @click.stop @touchmove.stop.prevent="swallow">
      <view class="grabber" />
      <text v-if="title" class="title">{{ title }}</text>
      <!-- 只阻止冒泡：默认行为要留着，否则内部滚不动 -->
      <scroll-view class="scroll" scroll-y @touchmove.stop>
        <view class="inner" :class="{ 'no-footer': !$slots.footer }"><slot /></view>
      </scroll-view>
      <!-- 主操作固定在底部，永远不随内容长度滚走 -->
      <view v-if="$slots.footer" class="footer"><slot name="footer" /></view>
    </view>
  </view>
</template>

<style scoped>
.mask {
  position: fixed;
  left: 0; right: 0; top: 0; bottom: 0;
  /* 层级见 App.vue：uni 内置浮层 999 > 本卡片 900 > tabBar 899 */
  z-index: 900;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  animation: fade 0.2s ease;
}

/*
 * 高度不写死：卡片是一个上限受约束的弹性列，
 *   抓手 / 标题 / 底部操作 —— 固定高度，按内容撑开
 *   滚动区                —— flex:1 吃掉剩余空间
 * 这样标题换几行、内容多长、设备多高都不会把底部操作挤出屏幕。
 * dvh 让移动端浏览器地址栏收缩时也能跟着变，vh 作为老浏览器兜底。
 */
.sheet {
  width: 100%;
  max-height: 88vh;
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-radius: 36rpx 36rpx 0 0;
  box-shadow: 0 -1rpx 0 var(--separator);
  overflow: hidden;
  /* 沉稳上滑，不弹跳 —— 与 Meter 的过渡曲线一致 */
  animation: rise 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  /* 提前给合成层，别让第一帧才去提升图层 */
  will-change: transform;
}

.grabber {
  flex: none;
  width: 72rpx; height: 8rpx; border-radius: 4rpx;
  background: var(--ink-3); opacity: 0.5;
  margin: 16rpx auto 20rpx;
}

.title {
  flex: none;
  font-size: 32rpx; font-weight: 600; color: var(--ink);
  letter-spacing: -0.03em; line-height: 1.35;
  word-break: break-all;
  margin: 0 40rpx 24rpx;
}

/*
 * 卡片高度由内容决定，超过 max-height 才收缩 —— 所以滚动区是
 * flex:0 1 auto（可缩不可涨），不是 flex:1。min-height:0 让它真的能缩。
 */
.scroll {
  flex: 0 1 auto;
  min-height: 0;
}

/* #ifdef H5 */
/*
 * uni-app 的 scroll-view 内层用 height:100%；父级高度是 flex 算出来的，
 * 浏览器不认作确定高度，内层就塌回内容高度 —— 结果超出部分被裁掉而不是可滚。
 * H5 下直接让外层元素承担滚动，把内层放平。
 * 其他端保留 scroll-view 的原生行为，不受影响。
 */
.scroll {
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.scroll :deep(.uni-scroll-view) {
  height: auto;
  overflow: visible;
}
/* #endif */

/*
 * 内容的左右内边距在这里，不在 .sheet 上 —— 标题和底栏各自留白，
 * 滚动区必须整块滚动，不能被父级 padding 夹住。
 */
.inner {
  padding: 0 36rpx 8rpx;
}
/* 没有底栏时，安全区留白由内容自己负责 */
.inner.no-footer {
  padding-bottom: calc(24rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
}

.footer {
  flex: none;
  padding: 20rpx 36rpx calc(24rpx + constant(safe-area-inset-bottom));
  padding: 20rpx 36rpx calc(24rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid var(--separator);
}

@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rise {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
</style>
