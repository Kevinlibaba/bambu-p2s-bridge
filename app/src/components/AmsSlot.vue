<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AmsTray } from '../api/client'

const { t } = useI18n()

const props = defineProps<{ tray: AmsTray }>()
const swatch = computed(() => {
  const c = props.tray.color
  return c && c.length >= 6 ? '#' + c.slice(0, 6) : 'transparent'
})
const low = computed(() => props.tray.remainPct >= 0 && props.tray.remainPct <= 20)
</script>

<template>
  <view class="row">
    <view class="swatch" :style="{ background: swatch }" />
    <text class="name">{{ tray.empty ? t('ams.empty') : tray.subBrand || tray.type }}</text>
    <view class="right">
      <text class="pct" :class="{ low }">
        {{ tray.empty || tray.remainPct < 0 ? '—' : tray.remainPct + '%' }}
      </text>
      <text v-if="low" class="tag">{{ t('ams.low') }}</text>
    </view>
  </view>
</template>

<style scoped>
.row { display: flex; align-items: center; height: 100rpx; }
.swatch {
  width: 36rpx; height: 36rpx; border-radius: 12rpx; flex-shrink: 0;
  /* 深色耗材在深色底上需要一圈微光才有边界 */
  box-shadow: inset 0 0 0 1rpx rgba(255, 255, 255, 0.18);
}
.name {
  margin-left: 24rpx; font-size: 30rpx; color: var(--ink);
  letter-spacing: -0.02em; flex: 1; min-width: 0;
}
.right { display: flex; align-items: center; }
.pct {
  font-size: 30rpx; color: var(--ink-2);
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
}
.pct.low { color: var(--warning); }
.tag {
  font-size: 20rpx; color: var(--warning); margin-left: 14rpx;
  padding: 4rpx 14rpx; border-radius: 999rpx;
  background: rgba(255, 159, 10, 0.14);
}
</style>
