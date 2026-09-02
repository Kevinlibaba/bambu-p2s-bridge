<script setup lang="ts">
/*
 * 温度曲线。
 *
 * 三条线共用一个 y 轴 —— 喷嘴、热床、腔温都是摄氏度，同量纲，
 * 拆成双轴反而会让人误读斜率。轴从 0 起，不做「放大差异」的截断。
 * 只画线，不画点：一小时三百多个采样，画点就成了一片糊。
 *
 * 用 canvas 而不是 SVG，是为了后面接原生端与小程序时不用重写。
 */
import { computed, onMounted, ref, watch, getCurrentInstance, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TempSample } from '../api/client'

/*
 * canvasId 必须每个实例唯一。uni-app 的 tab 页是保活的 —— 监控页的图表
 * 和历史页里的图表会同时存在于 DOM，共用一个 id 会让 createCanvasContext
 * 和 getElementById 拿到对方那块画布。
 */
const props = withDefaults(
  defineProps<{ samples: TempSample[]; id?: string }>(),
  { id: 'tempchart' },
)
const { t } = useI18n()
const inst = getCurrentInstance()
const canvasId = props.id
const W = ref(0)
const H = 180

/*
 * 主题 token 定义在 `page`（H5 下是 uni-page-body），手动切换主题时
 * .theme-dark/.theme-light 还会加在各页面的根节点上。所以必须从
 * 图表自己的节点往上解析，读 documentElement 什么都拿不到 ——
 * 那会让浅色模式下的图表底色仍然是深色。
 */
function cssVar(name: string, fallback: string): string {
  // #ifdef H5
  const el = document.getElementById(canvasId) ?? document.body
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
  // #endif
  // #ifndef H5
  return fallback
  // #endif
}

/** 取一次色板。绘制与图例共用，避免两处各读一遍读出不同结果。 */
function readTone() {
  return {
    nozzle: cssVar('--critical', '#FF453A'),
    bed: cssVar('--accent', '#0A84FF'),
    chamber: cssVar('--good', '#30D158'),
    surface: cssVar('--surface', '#1c1c1e'),
    grid: cssVar('--separator', 'rgba(255,255,255,0.08)'),
    ink3: cssVar('--ink-3', '#6e6e73'),
  }
}
const tone = ref(readTone())

const SERIES = [
  { key: 'n' as const, tone: 'nozzle' as const, label: () => t('chart.nozzle') },
  { key: 'b' as const, tone: 'bed' as const, label: () => t('chart.bed') },
  { key: 'c' as const, tone: 'chamber' as const, label: () => t('chart.chamber') },
]

const hasData = computed(() => props.samples.length >= 2)

/** 最新一帧的读数，直接标在图例上 —— 比让人去猜曲线末端的高度快得多 */
const latest = computed(() => props.samples[props.samples.length - 1] ?? null)

function draw() {
  if (!W.value || !hasData.value) return
  tone.value = readTone()          // 主题可能在两次绘制之间被切换
  const c = tone.value
  const ctx = uni.createCanvasContext(canvasId, inst?.proxy ?? undefined)
  const s = props.samples
  const pad = { l: 34, r: 8, t: 10, b: 18 }
  const w = W.value - pad.l - pad.r
  const h = H - pad.t - pad.b

  // y 轴从 0 起，上界取整到 20 的倍数，刻度线才落在整数上
  let max = 0
  for (const x of s) max = Math.max(max, x.n, x.b, x.c ?? 0)
  max = Math.max(60, Math.ceil(max / 20) * 20)

  const px = (i: number) => pad.l + (i / (s.length - 1)) * w
  const py = (v: number) => pad.t + h - (v / max) * h

  ctx.setFillStyle(c.surface)
  ctx.fillRect(0, 0, W.value, H)

  // 网格与刻度：四条线足够定位，再多就成了背景噪声
  const grid = c.grid
  const ink3 = c.ink3
  ctx.setFontSize(9)
  for (let i = 0; i <= 4; i += 1) {
    const v = (max / 4) * i
    const y = py(v)
    ctx.beginPath()
    ctx.setStrokeStyle(grid)
    ctx.setLineWidth(1)
    ctx.moveTo(pad.l, y)
    ctx.lineTo(pad.l + w, y)
    ctx.stroke()
    ctx.setFillStyle(ink3)
    ctx.fillText(`${Math.round(v)}`, 6, y + 3)
  }

  for (const ser of SERIES) {
    const vals = s.map((x) => x[ser.key])
    if (vals.every((v) => v === null)) continue // 腔温取不到时不画那条线
    ctx.beginPath()
    ctx.setStrokeStyle(c[ser.tone])
    ctx.setLineWidth(2)
    let started = false
    vals.forEach((v, i) => {
      if (v === null) return
      const x = px(i)
      const y = py(v)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // 时间跨度标在右下角，免得以为这是全部历史
  const mins = Math.round((s[s.length - 1].t - s[0].t) / 60000)
  ctx.setFillStyle(ink3)
  ctx.setFontSize(9)
  ctx.fillText(t('chart.span', { n: mins }), pad.l, H - 5)

  ctx.draw()
}

onMounted(() => {
  uni.createSelectorQuery()
    .in(inst?.proxy ?? undefined)
    .select('.wrap')
    .boundingClientRect((r) => {
      W.value = Math.round((r as UniApp.NodeInfo)?.width ?? 0)
      void nextTick(draw)
    })
    .exec()
})

watch(() => props.samples, () => void nextTick(draw), { deep: false })
</script>

<template>
  <view class="wrap">
    <canvas v-if="hasData" :canvas-id="canvasId" :id="canvasId" class="cv" :style="{ height: H + 'px' }" />
    <view v-else class="ph" :style="{ height: H + 'px' }">
      <text class="ph-t">{{ t('chart.empty') }}</text>
    </view>
    <view class="legend">
      <view v-for="ser in SERIES" :key="ser.key" class="leg">
        <view class="swatch" :style="{ background: tone[ser.tone] }" />
        <text class="leg-t">{{ ser.label() }}</text>
        <text class="leg-v">{{ latest && latest[ser.key] !== null ? latest[ser.key] + '℃' : '—' }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.wrap { width: 100%; }
.cv { width: 100%; display: block; border-radius: 18rpx; }
.ph { display: flex; align-items: center; justify-content: center;
  background: var(--surface); border-radius: 18rpx; }
.ph-t { font-size: 23rpx; color: var(--ink-3); }
.legend { display: flex; margin-top: 18rpx; }
.leg { display: flex; align-items: center; margin-right: 32rpx; }
.swatch { width: 14rpx; height: 14rpx; border-radius: 4rpx; margin-right: 10rpx; }
.leg-t { font-size: 22rpx; color: var(--ink-3); margin-right: 10rpx; }
.leg-v { font-size: 22rpx; color: var(--ink); font-variant-numeric: tabular-nums; }
</style>
