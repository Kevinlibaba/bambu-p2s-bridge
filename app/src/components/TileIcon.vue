<script setup lang="ts">
/*
 * iOS「设置」式的彩色圆角小图标：彩色底 + 白色图形。
 *
 * 图形和 FileIcon 一样用 SVG 做 mask、颜色由 background 给 —— 小程序端也认，
 * 形状是矢量。这里的几个图形都是照 SF Symbols 的意思自己描的线稿（24×24），
 * 不引图标库。
 */
import { computed } from 'vue'

type Name = 'queue' | 'history' | 'folder' | 'cube' | 'sliders' | 'printer'

const props = withDefaults(defineProps<{ name: Name; color: string; size?: number }>(), { size: 58 })

const S = 'fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const GLYPHS: Record<Name, string> = {
  queue:
    `<g fill="#000"><circle cx="5" cy="6.5" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="5" cy="17.5" r="1.5"/></g>` +
    `<path ${S} d="M9.5 6.5H19.5M9.5 12H19.5M9.5 17.5H19.5"/>`,
  history: `<circle ${S} cx="12" cy="12" r="8.3"/><path ${S} d="M12 7.6V12l3.1 2"/>`,
  folder: `<path fill="#000" d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.9c.6 0 1.1.2 1.5.6L12 7h6.8A2.2 2.2 0 0 1 21 9.2v8.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8z"/>`,
  cube: `<path ${S} d="M12 2.6 20.4 7.3v9.4L12 21.4 3.6 16.7V7.3Z"/><path ${S} d="M12 12 20.4 7.3M12 12 3.6 7.3M12 12v9.4"/>`,
  sliders:
    `<path ${S} d="M4 7.5h9M17.5 7.5H20M4 16.5h2.5M11 16.5h9"/>` +
    `<circle ${S} cx="15.3" cy="7.5" r="2.2"/><circle ${S} cx="8.7" cy="16.5" r="2.2"/>`,
  printer:
    `<rect ${S} x="4" y="3.5" width="16" height="17" rx="2.5"/><path ${S} d="M4 9h16"/>` +
    `<path fill="#000" d="M10.6 9h2.8v2.6L12 13l-1.4-1.4z"/><path ${S} d="M8 16.8h8"/>`,
}

const mask = computed(() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${GLYPHS[props.name]}</svg>`
  const u = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  return { WebkitMaskImage: u, maskImage: u }
})
const box = computed(() => ({
  width: `${props.size}rpx`, height: `${props.size}rpx`,
  borderRadius: `${Math.round(props.size * 0.23)}rpx`, background: props.color,
}))
const glyph = computed(() => ({ width: `${Math.round(props.size * 0.62)}rpx`, height: `${Math.round(props.size * 0.62)}rpx` }))
</script>

<template>
  <view class="tile" :style="box"><view class="gl" :style="[glyph, mask]" /></view>
</template>

<style scoped>
.tile { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.gl {
  background-color: #fff;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
}
</style>
