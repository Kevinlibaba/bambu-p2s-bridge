<script setup lang="ts">
defineProps<{
  label: string
  value: string
  unit?: string
  sub?: string
  tone?: 'neutral' | 'good' | 'warning' | 'critical'
}>()
</script>

<template>
  <view class="tile">
    <text class="label">{{ label }}</text>
    <view class="row">
      <text class="value">{{ value }}</text>
      <text v-if="unit" class="unit">{{ unit }}</text>
    </view>
    <view class="subrow">
      <view v-if="tone && tone !== 'neutral'" class="dot" :class="'d-' + tone" />
      <text v-if="sub" class="sub">{{ sub }}</text>
    </view>
  </view>
</template>

<style scoped>
.tile { flex: 1; padding: 4rpx 0; }
.label {
  font-size: 24rpx;
  color: var(--ink-2);
  letter-spacing: 0.01em;
}
.row { display: flex; align-items: baseline; margin-top: 12rpx; }
/* 数值是这块的主角：重字重 + 收紧字距 */
.value {
  font-size: 54rpx;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--ink);
}
.unit { font-size: 24rpx; color: var(--ink-2); margin-left: 6rpx; letter-spacing: -0.01em; }
.subrow { display: flex; align-items: center; margin-top: 12rpx; min-height: 30rpx; }
.dot { width: 10rpx; height: 10rpx; border-radius: 50%; margin-right: 10rpx; flex-shrink: 0; }
.d-good { background: var(--good); }
.d-warning { background: var(--warning); }
.d-critical { background: var(--critical); }
.sub { font-size: 22rpx; color: var(--ink-2); letter-spacing: -0.01em; }
</style>
