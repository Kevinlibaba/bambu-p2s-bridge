<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ size?: number }>(), { size: 44 })

/** iOS 系统那个转圈：8 根辐条依次渐隐，靠 animation-delay 错开 */
const SPOKES = 8
const bars = computed(() =>
  Array.from({ length: SPOKES }, (_, i) => ({
    transform: `rotate(${(360 / SPOKES) * i}deg)`,
    animationDelay: `${-(0.8 / SPOKES) * (SPOKES - i)}s`,
  })),
)
const box = computed(() => ({ '--sz': `${props.size}rpx` }))
</script>

<template>
  <view class="spin" :style="box">
    <view v-for="(b, i) in bars" :key="i" class="bar" :style="b" />
  </view>
</template>

<style scoped>
.spin {
  position: relative;
  width: var(--sz);
  height: var(--sz);
  /* 用 currentColor，放到哪里就跟哪里的文字同色 */
  color: var(--ink-3);
}
.bar {
  position: absolute;
  left: 44%;
  top: 0;
  width: 12%;
  height: 27%;
  border-radius: 999rpx;
  background: currentColor;
  /* 绕整个盒子的中心转，而不是自身中心 */
  transform-origin: 50% calc(var(--sz) / 2);
  animation: spoke 0.8s linear infinite;
}
@keyframes spoke {
  0% { opacity: 1; }
  100% { opacity: 0.15; }
}
</style>
