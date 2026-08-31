<script setup lang="ts">
/*
 * 文件类型图标。
 *
 * 图形用 SVG 数据 URI 做 mask，颜色由 background-color 提供 —— 这样形状是
 * 精确的矢量，颜色又能跟随主题（--accent 在深浅两套里不是同一个值）。
 * 不用 Unicode 字符：这个项目在全屏按钮上踩过一次，⛶ / ⤢ 这类字形在不同
 * 系统上缺字或粗细不一。也不用内联 <svg>：那在小程序端渲染不了，
 * 而 mask 是纯 CSS，各端都认。
 *
 * 文件夹 / 播放 / 图片 / 文稿取自 Bootstrap Icons（MIT），
 * 模型那个等轴测立方体是照 3D 模型文件的通用画法自己描的 ——
 * 外六边形加三条交于中心的内棱，一眼是立体。
 */
defineProps<{ kind: 'dir' | 'model' | 'video' | 'image' | 'other' }>()
</script>

<template>
  <view class="ic" :class="kind"><view class="gl" /></view>
</template>

<style scoped>
.ic {
  width: 56rpx; height: 56rpx; border-radius: 16rpx; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
/* 图形本体。mask 决定形状，background 决定颜色 */
.gl {
  width: 32rpx; height: 32rpx;
  background-color: currentColor;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
}

/* 淡底 + 同色图形，读起来是分类而不是警示 */
.ic.dir { background: var(--accent-dim); color: var(--accent); }
.ic.model { background: rgba(48, 209, 88, 0.16); color: var(--good); }
.ic.video { background: rgba(255, 159, 10, 0.18); color: var(--warning); }
.ic.image { background: var(--surface-2); color: var(--ink-2); }
.ic.other { background: var(--surface-2); color: var(--ink-3); }

.dir .gl { -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M9.828%203h3.982a2%202%200%200%201%201.992%202.181l-.637%207A2%202%200%200%201%2013.174%2014H2.825a2%202%200%200%201-1.991-1.819l-.637-7a2%202%200%200%201%20.342-1.31L.5%203a2%202%200%200%201%202-2h3.672a2%202%200%200%201%201.414.586l.828.828A2%202%200%200%200%209.828%203m-8.322.12q.322-.119.684-.12h5.396l-.707-.707A1%201%200%200%200%206.172%202H2.5a1%201%200%200%200-1%20.981z%22%2F%3E%3C%2Fsvg%3E"); mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M9.828%203h3.982a2%202%200%200%201%201.992%202.181l-.637%207A2%202%200%200%201%2013.174%2014H2.825a2%202%200%200%201-1.991-1.819l-.637-7a2%202%200%200%201%20.342-1.31L.5%203a2%202%200%200%201%202-2h3.672a2%202%200%200%201%201.414.586l.828.828A2%202%200%200%200%209.828%203m-8.322.12q.322-.119.684-.12h5.396l-.707-.707A1%201%200%200%200%206.172%202H2.5a1%201%200%200%200-1%20.981z%22%2F%3E%3C%2Fsvg%3E"); }
/* 立方体是线框，比实心图形显小，稍放大一点视觉重量才匹配 */
.model .gl { width: 36rpx; height: 36rpx;
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linejoin%3D%22round%22%20stroke-linecap%3D%22round%22%3E%3Cpath%20d%3D%22M12%202.4%2020.6%207.2v9.6L12%2021.6%203.4%2016.8V7.2Z%22%2F%3E%3Cpath%20d%3D%22M12%2012%2020.6%207.2M12%2012%203.4%207.2M12%2012v9.6%22%2F%3E%3C%2Fsvg%3E"); mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.9%22%20stroke-linejoin%3D%22round%22%20stroke-linecap%3D%22round%22%3E%3Cpath%20d%3D%22M12%202.4%2020.6%207.2v9.6L12%2021.6%203.4%2016.8V7.2Z%22%2F%3E%3Cpath%20d%3D%22M12%2012%2020.6%207.2M12%2012%203.4%207.2M12%2012v9.6%22%2F%3E%3C%2Fsvg%3E"); }
.video .gl { -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22m11.596%208.697-6.363%203.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01%201.233-.696l6.363%203.692a.802.802%200%200%201%200%201.393%22%2F%3E%3C%2Fsvg%3E"); mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22m11.596%208.697-6.363%203.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01%201.233-.696l6.363%203.692a.802.802%200%200%201%200%201.393%22%2F%3E%3C%2Fsvg%3E"); }
.image .gl { -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M.002%203a2%202%200%200%201%202-2h12a2%202%200%200%201%202%202v10a2%202%200%200%201-2%202h-12a2%202%200%200%201-2-2zm1%209v1a1%201%200%200%200%201%201h12a1%201%200%200%200%201-1V9.5l-3.777-1.947a.5.5%200%200%200-.577.093l-3.71%203.71-2.66-1.772a.5.5%200%200%200-.63.062zm5-6.5a1.5%201.5%200%201%200-3%200%201.5%201.5%200%200%200%203%200%22%2F%3E%3C%2Fsvg%3E"); mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M.002%203a2%202%200%200%201%202-2h12a2%202%200%200%201%202%202v10a2%202%200%200%201-2%202h-12a2%202%200%200%201-2-2zm1%209v1a1%201%200%200%200%201%201h12a1%201%200%200%200%201-1V9.5l-3.777-1.947a.5.5%200%200%200-.577.093l-3.71%203.71-2.66-1.772a.5.5%200%200%200-.63.062zm5-6.5a1.5%201.5%200%201%200-3%200%201.5%201.5%200%200%200%203%200%22%2F%3E%3C%2Fsvg%3E"); }
.other .gl { width: 28rpx; height: 28rpx;
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M4%200h5.293A1%201%200%200%201%2010%20.293L13.707%204a1%201%200%200%201%20.293.707V14a2%202%200%200%201-2%202H4a2%202%200%200%201-2-2V2a2%202%200%200%201%202-2m5.5%201.5v2a1%201%200%200%200%201%201h2z%22%2F%3E%3C%2Fsvg%3E"); mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22%23000%22%3E%3Cpath%20d%3D%22M4%200h5.293A1%201%200%200%201%2010%20.293L13.707%204a1%201%200%200%201%20.293.707V14a2%202%200%200%201-2%202H4a2%202%200%200%201-2-2V2a2%202%200%200%201%202-2m5.5%201.5v2a1%201%200%200%200%201%201h2z%22%2F%3E%3C%2Fsvg%3E"); }
</style>
