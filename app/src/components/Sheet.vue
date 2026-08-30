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
    </view>
  </view>
</template>

<style scoped>
.mask {
  position: fixed;
  left: 0; right: 0; top: 0; bottom: 0;
  z-index: 900;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  animation: fade 0.2s ease;
}
.sheet {
  width: 100%;
  max-height: 86vh;
  background: var(--bg);
  border-radius: 36rpx 36rpx 0 0;
  padding: 16rpx 36rpx calc(40rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(40rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -1rpx 0 var(--separator);
  /* 沉稳上滑，不弹跳 —— 与 Meter 的过渡曲线一致 */
  animation: rise 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}
.grabber {
  width: 72rpx; height: 8rpx; border-radius: 4rpx;
  background: var(--ink-3); opacity: 0.5;
  margin: 0 auto 20rpx;
}
.title {
  display: block;
  font-size: 32rpx; font-weight: 600; color: var(--ink);
  letter-spacing: -0.03em; line-height: 1.35;
  word-break: break-all;
  margin: 0 4rpx 24rpx;
}
.scroll { max-height: 66vh; }
.inner { padding-bottom: 8rpx; }

@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes rise {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
</style>
