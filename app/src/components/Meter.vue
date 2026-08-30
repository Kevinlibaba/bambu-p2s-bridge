<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(
  defineProps<{ pct: number; tone?: 'accent' | 'good' | 'warning' | 'critical' }>(),
  { tone: 'accent' },
)
const clamped = computed(() => Math.max(0, Math.min(100, props.pct || 0)))
</script>

<template>
  <view class="track">
    <view class="fill" :class="'t-' + tone" :style="{ width: clamped + '%' }" />
  </view>
</template>

<style scoped>
.track {
  width: 100%;
  height: 8rpx;
  border-radius: 4rpx;
  background: var(--surface-2);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 4rpx;
  background: var(--accent);
  /* 沉稳、有重量感的过渡，不弹跳 */
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}
.t-good { background: var(--good); }
.t-warning { background: var(--warning); }
.t-critical { background: var(--critical); }
</style>
