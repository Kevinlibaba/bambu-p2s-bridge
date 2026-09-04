<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { onHide, onUnload } from '@dcloudio/uni-app'

const props = defineProps<{ visible: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/*
 * 防止滑动穿透到背后的页面。三道防线：
 *
 * 1) 事件层 —— 遮罩的 touchmove 直接 prevent；卡片在真的被拖动时才 prevent
 *    （不能无条件拦，否则内部滚动被掐死，这个坑踩过）。
 * 2) 滚动链 —— 滚动区上的 overscroll-behavior: contain，滚到边界就停，
 *    不把滚动传给背后的页面。
 * 3) 布局层 —— 这里，锁住 html 的滚动。
 *
 * 第 3 道曾经存在过，现在去掉了 —— 两种写法都有比它要解决的问题更糟的副作用：
 *
 *   body { position: fixed }   body 被拿出文档流、页面高度塌陷。iOS 上
 *                              bottom:0 的固定元素（uni-app 的底部标签栏）
 *                              会跟着上移，关闭时归位 —— 就是「标签闪一下」。
 *   html { overflow: hidden }  不塌陷布局，但**滚动位置被清零**（实测
 *                              scrollY 300 → 0）。这比闪一下更糟。
 *
 * 现在靠 touch-action 兜底：直接告诉浏览器这片区域的触摸不产生滚动。
 * 这正是 touch-action 的用途，而且是在手势分类**之前**生效的 ——
 * 不像 preventDefault，一旦手势已被判定为页面滚动就会被忽略
 * （那恰恰是当初引入 body-fixed 的理由）。
 * 好处是全程不动任何布局，固定元素没有理由移动。
 */


/*
 * 下滑关闭。
 *
 * 行为对着 iOS 原生 sheet 抄，常量取自 vaul（那个库明确以 iOS sheet 为蓝本，
 * 而且它的缓动曲线 cubic-bezier(0.32, 0.72, 0, 1) 和本组件原本用的正好一致）：
 *
 *   往下拖   跟手 1:1
 *   往上拖   橡皮筋阻尼，永远回不到打开位置之上
 *   松手     速度 ≥ 0.4 px/ms，或拖过卡片高度的 25% → 关闭；否则弹回
 *
 * 最要紧的一条是和内部滚动的协同：内容没滚到顶时，下滑应该是滚内容，
 * 不是关卡片。少了这一条，手势就会在「想往回滚」时把卡片关掉 ——
 * 那是最恼人的一种错。
 */
const VELOCITY_DISMISS = 0.4
const CLOSE_RATIO = 0.25
/*
 * 橡皮筋系数，用 UIScrollView 那条 f(x) = x·d·c / (d + c·x)，越拉越迟钝。
 *
 * 滚动回弹惯用 0.55，但那对固定高度的卡片太软 —— 实测拖 200px 会上移 96px，
 * 卡片下方直接露出一截遮罩，看着像坏了。这里的卡片不能变高，往上拖只需要
 * 一点「收到了」的反馈，所以取 0.1：拖 200px 约 19px，且封顶在 74px。
 */
const RUBBER_C = 0.1

/* 滑出关闭的时长。必须和 .sheet.dismissing 的过渡时长一致 */
const DISMISS_MS = 220
const dragY = ref(0)
const dragging = ref(false)
const dismissing = ref(false)
/* uni-app 里 <view> 上的 ref 拿到的可能是组件代理而不是 DOM 元素 */
const cardRef = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const scrollRef = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
let startY = 0
let startAt = 0
let sheetH = 0
let armed = false

/**
 * 卡片高度。它是关闭阈值的分母 —— 量不到就退回半屏，绝不能留 0：
 * 那会让阈值变成「往下拖一点点就关」，实测踩过。
 */
function measureCard(): number {
  // #ifdef H5
  const h = unwrap(cardRef.value)?.getBoundingClientRect?.().height ?? 0
  if (h > 0) return h
  // #endif
  return typeof window === 'undefined' ? 600 : window.innerHeight * 0.5
}

/**
 * 这一次触摸该不该拖卡片。
 *
 * 两条规则，都照 iOS：
 *  · 手指落在抓手、标题、底部操作这些非滚动区 → 永远可拖
 *  · 落在滚动区里 → 只有内容已经在顶部才拖，否则先滚内容
 *
 * 第二条是手势好不好用的分水岭。少了它，用户想把内容往回滚的时候
 * 卡片会直接被关掉 —— 那是最恼人的一种错。
 *
 * 不从 e.target 往上找滚动容器：uni-app 把事件包装过，target 不是
 * DOM 元素，遍历从第一步就失效（实测踩过，表现是任何下拉都能关闭）。
 * 直接持有滚动区的 ref 更可靠。
 */
function unwrap(r: unknown): HTMLElement | null {
  const v = r as { $el?: HTMLElement } | HTMLElement | null
  return ((v as { $el?: HTMLElement })?.$el ?? (v as HTMLElement | null)) ?? null
}

/*
 * 找出真正在滚的那个元素。
 *
 * 不按类名找：uni-app 的 scroll-view 渲染成 <uni-scroll-view> 外加一层内部 div，
 * 而**外层才是滚动容器**（实测 688/400），内层是 688/688 根本不滚。
 * 按类名去取内层就永远读到 scrollTop = 0，于是任何下拉都被当成「已在顶部」。
 * 按「谁的 scrollHeight 超出 clientHeight」来判，对版本差异也更稳。
 */
function scroller(): HTMLElement | null {
  // #ifdef H5
  const host = unwrap(scrollRef.value)
  if (!host) return null
  if (host.scrollHeight > host.clientHeight + 1) return host
  const nested = host.querySelectorAll?.('*') ?? []
  for (const el of Array.from(nested) as HTMLElement[]) {
    if (el.scrollHeight > el.clientHeight + 1) return el
  }
  return host
  // #endif
  // eslint-disable-next-line no-unreachable
  return null
}

function shouldDrag(touchY: number): boolean {
  const el = scroller()
  if (!el) return true
  const r = el.getBoundingClientRect?.()
  // 落在滚动区之外（抓手 / 标题 / 底部操作）—— 永远可拖
  if (r && (touchY < r.top || touchY > r.bottom)) return true
  return (el.scrollTop ?? 0) <= 0
}

function onSheetDown(e: TouchEvent) {
  const p = pointOf(e)
  if (!p) return
  startY = p.y
  startAt = Date.now()
  dragY.value = 0
  armed = shouldDrag(p.y)
  dragging.value = false
  sheetH = measureCard()
}

function onSheetMove(e: TouchEvent) {
  const p = pointOf(e)
  if (!p) return
  const dy = p.y - startY

  /*
   * 只有真的在拖卡片时才 preventDefault。
   *
   * 原来在模板上写死 .prevent，等于对每一次 touchmove 都拦 —— 内部滚动
   * 被彻底掐死。而防「滑动穿透到背后页面」只需要在拖卡片的时候拦；
   * 手指在滚动区里往回滚时不拦，scroll-view 才滚得动。
   */
  if (!armed) return
  if (e.cancelable) e.preventDefault()

  // 往上拖：橡皮筋，且永远不越过打开位置
  dragY.value = dy >= 0 ? dy : -((-dy) * sheetH * RUBBER_C) / (sheetH + RUBBER_C * -dy)
  if (Math.abs(dy) > 4) dragging.value = true
}

function onSheetUp() {
  if (!armed) return
  armed = false
  const dy = dragY.value
  const dt = Math.max(1, Date.now() - startAt)
  const velocity = dy / dt
  dragging.value = false
  if (dy > 0 && (velocity >= VELOCITY_DISMISS || dy >= sheetH * CLOSE_RATIO)) {
    beginClose()
    return
  }
  dragY.value = 0
}

const sheetStyle = computed(() =>
  dragY.value === 0 ? '' : `transform: translateY(${dragY.value.toFixed(1)}px);`,
)
/* 遮罩跟着一起淡出，手指还没松就能看出「再拖一点就关了」 */
/* 遮罩最暗时的不透明度。改这里要一起改 CSS 里 .mask 的底色和 dim 关键帧 */
const DIM_MAX = 0.5

/*
 * 变暗只动背景色的 alpha，绝不动 opacity。
 *
 * 卡片是遮罩的子元素，而 opacity 会作用于整棵子树 —— 用 opacity 淡出的话，
 * 卡片自己也跟着变半透明，下滑过程中能透出背后的页面，看起来就是「闪」。
 * 这是实测反馈出来的：关闭动画里页面呈半透明。
 */
const maskStyle = computed(() => {
  if (dragY.value <= 0 || sheetH === 0) return ''
  const k = Math.max(0, 1 - dragY.value / sheetH)
  return `background-color: rgba(0, 0, 0, ${(DIM_MAX * k).toFixed(3)});`
})

/*
 * 页面被切走时把拖动状态复位。uni-app 会缓存页面而不是卸载它，所以
 * onUnmounted 不一定触发 —— 卡片开着时后退或切标签页，残留的 dragY
 * 会让下次打开时卡片从半路开始。
 *
 * 这里原来还要「解锁页面」：那时是把 body 设成 position:fixed，忘了解锁
 * 整个应用就再也滚不动。现在不锁布局了，所以只剩状态需要清。
 */
function resetDrag() {
  dragY.value = 0
  dragging.value = false
  dismissing.value = false
  armed = false
}
onHide(resetDrag)
onUnload(resetDrag)
onUnmounted(resetDrag)

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
  if (!dragged) beginClose()
  dragged = false
}

/**
 * 统一的关闭流程：卡片滑出 → 到底之后才卸载。
 *
 * 页面解锁刻意提前到滑出**开始**的那一刻，而不是等卸载。
 *
 * body 的 position 从 fixed 切回 static 会引发一次重排，iOS Safari 上
 * fixed 元素（底部标签栏就是）会因此重新定位、闪一下。放在开头做，
 * 那一下就藏在还暗着的遮罩底下；等遮罩透明时布局早已稳定。
 * 此时手指已经松开，不必再担心滑动穿透。
 *
 * 这条路径 headless 上复现不出来（tab 栏全程不动、遮罩平滑淡出），
 * 所以是针对 iOS 已知行为下的手，没有实测佐证。
 */
function beginClose() {
  if (dismissing.value) return
  if (sheetH <= 0) sheetH = measureCard()
  dismissing.value = true
  dragY.value = sheetH
  setTimeout(() => {
    dragY.value = 0
    dismissing.value = false
    emit('close')
  }, DISMISS_MS)
}
</script>

<template>
  <!-- iOS 式底部卡片：抓手 + 点遮罩关闭，不做多余装饰 -->
  <view
    v-if="visible"
    class="mask"
    :class="{ dismissing }"
    :style="maskStyle"
    @click="onMaskTap"
    @touchstart="onMaskDown"
    @mousedown="onMaskDown"
    @touchmove.stop.prevent="onMaskMove"
  >
    <!-- 卡片内的滑动到此为止，不再冒泡到遮罩，否则内部滚动区也会被 prevent 掉 -->
    <view
      ref="cardRef"
      class="sheet"
      :class="{ dragging, dismissing }"
      :style="sheetStyle"
      @click.stop
      @touchstart="onSheetDown"
      @touchmove.stop="onSheetMove"
      @touchend="onSheetUp"
      @touchcancel="onSheetUp"
    >
      <view class="grabber" />
      <text v-if="title" class="title">{{ title }}</text>
      <!-- 只阻止冒泡：默认行为要留着，否则内部滚不动 -->
      <!--
        不 stop：手势要冒泡到卡片上判断该滚还是该拖。
        也不 prevent：默认行为留着，否则内部滚不动。
      -->
      <scroll-view ref="scrollRef" class="scroll" scroll-y>
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
  /* 淡入同理：只让底色变暗，卡片始终不透明地滑上来 */
  animation: dim 0.2s ease;
  /* 遮罩上的手势不产生滚动，也不把滚动链传给背后 */
  touch-action: none;
  overscroll-behavior: none;
}
/*
 * 滑出关闭时遮罩要跟着一起淡出。
 *
 * 遮罩透明度是从 dragY 算的：拖动中逐帧变化，跟手，不需要过渡；
 * 但松手那一下 dragY 一次性跳到卡片高度，没有过渡的话透明度会在一帧里
 * 从 0.7 直接掉到 0 —— 变暗瞬间消失、背后的页面和底部标签栏「闪」一下，
 * 而卡片还在慢慢往下滑。时长与 DISMISS_MS 对齐。
 */
.mask.dismissing {
  transition: background-color 0.22s cubic-bezier(0.32, 0.72, 0, 1);
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
  /* 卡片上的触摸不产生页面滚动；滚动区自己再放行竖向 */
  touch-action: none;
  /* 松手后弹回/滑出用同一条曲线；拖动中要跟手，所以那时不能有过渡 */
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}
.sheet.dragging {
  transition: none;
}
/* 滑出用略快的时长，和 DISMISS_MS 对齐；改这里要一起改那个常量 */
.sheet.dismissing {
  transition: transform 0.22s cubic-bezier(0.32, 0.72, 0, 1);
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
  /* 滚到边界就停，不把滚动链传给背后的页面 */
  overscroll-behavior: contain;
  /* 卡片整体禁掉了触摸滚动，这里单独放行竖向，否则内部滚不动 */
  touch-action: pan-y;
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

@keyframes dim {
  from { background-color: rgba(0, 0, 0, 0); }
  to { background-color: rgba(0, 0, 0, 0.5); }
}
@keyframes rise {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
</style>
