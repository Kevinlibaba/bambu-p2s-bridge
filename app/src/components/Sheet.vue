<script setup lang="ts">
defineProps<{ visible: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/*
 * 防止滑动穿透到背后的页面。
 *
 * 试过在 body 上加 overflow:hidden —— 这个页面的滚动发生在 viewport
 * (documentElement) 上，那条规则没生效，反而让页面在打开卡片时跳回顶部。
 * 改为在事件层拦截，分三层：
 *   遮罩   —— 阻止默认行为，背景不滚
 *   卡片   —— 抓手/标题/底栏这些不滚动的区域同样阻止
 *   滚动区 —— 只阻止冒泡，不阻止默认，让它自己正常滚
 * 配合 CSS 的 overscroll-behavior:contain，滚到尽头也不会接力给页面。
 */
function swallow() { /* 生效的是模板上的 .stop.prevent 修饰符 */ }
</script>

<template>
  <!-- iOS 式底部卡片：抓手 + 点遮罩关闭，不做多余装饰 -->
  <view
    v-if="visible"
    class="mask"
    @click="emit('close')"
    @touchmove.stop.prevent="swallow"
  >
    <!-- 卡片内的滑动到此为止，不再冒泡到遮罩，否则内部滚动区也会被 prevent 掉 -->
    <view class="sheet" @click.stop @touchmove.stop.prevent="swallow">
      <view class="grabber" />
      <text v-if="title" class="title">{{ title }}</text>
      <!-- 只阻止冒泡：默认行为要留着，否则内部滚不动 -->
      <scroll-view class="scroll" scroll-y @touchmove.stop>
        <view class="inner"><slot /></view>
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
