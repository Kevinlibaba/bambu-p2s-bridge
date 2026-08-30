<script setup lang="ts">
defineProps<{ visible: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <!-- iOS 式底部卡片：抓手 + 点遮罩关闭，不做多余装饰 -->
  <view v-if="visible" class="mask" @click="emit('close')">
    <view class="sheet" @click.stop>
      <view class="grabber" />
      <text v-if="title" class="title">{{ title }}</text>
      <scroll-view class="scroll" scroll-y>
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

/* min-height:0 是关键：不加的话 flex 子项不会收缩，内容长了就会顶破容器 */
.scroll {
  flex: 1 1 auto;
  min-height: 0;
}
.inner { padding: 0 36rpx 8rpx; }

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
