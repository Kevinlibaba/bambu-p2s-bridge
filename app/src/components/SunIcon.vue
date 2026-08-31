<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ size?: number; active?: boolean }>(), {
  size: 40,
  active: false,
})

/** 8 根光芒，绕中心均匀排布 */
const RAYS = 8
const rays = computed(() =>
  Array.from({ length: RAYS }, (_, i) => ({ transform: `rotate(${(360 / RAYS) * i}deg)` })),
)
const box = computed(() => ({ '--sz': `${props.size}rpx` }))
</script>

<template>
  <view class="sun" :class="{ on: active }" :style="box">
    <view class="core" />
    <view v-for="(r, i) in rays" :key="i" class="ray" :style="r" />
  </view>
</template>

<style scoped>
/* 用 CSS 画而不是字形：☀ 这类符号在各系统上粗细和留白差别很大 */
.sun {
  position: relative;
  width: var(--sz);
  height: var(--sz);
  color: var(--ink-3);
  transition: color 0.3s ease;
}
/* 烘干中：变红并缓慢旋转 */
.sun.on {
  color: var(--critical);
  animation: spin 4s linear infinite;
}
.core {
  position: absolute;
  top: 30%; left: 30%;
  width: 40%; height: 40%;
  border-radius: 50%;
  background: currentColor;
}
.ray {
  position: absolute;
  left: 46%;
  top: 0;
  width: 8%;
  height: 20%;
  border-radius: 999rpx;
  background: currentColor;
  /* 绕整个盒子的中心排布，而不是自身中心 */
  transform-origin: 50% calc(var(--sz) / 2);
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
