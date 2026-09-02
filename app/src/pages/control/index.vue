<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow } from '@dcloudio/uni-app'
import {
  api, configured, planHarvest, runHarvest, coolForHarvest,
  type Command, type HarvestPlan,
} from '../../api/client'
import Sheet from '../../components/Sheet.vue'
import Spinner from '../../components/Spinner.vue'
import { printer } from '../../store/printer'
import { themeClass, applyChrome } from '../../store/prefs'
import { confirm, toast } from '../../util/dialog'

const { t } = useI18n()
const s = computed(() => printer.summary)
const nozzle = ref(0)
const bed = ref(0)
let touched = false

watch(s, (v) => {
  if (!touched && v) { nozzle.value = Math.round(v.nozzle.target); bed.value = Math.round(v.bed.target) }
}, { immediate: true })

const SPEEDS = [
  { level: 1 as const, key: 'silent', pct: '50%' },
  { level: 2 as const, key: 'standard', pct: '100%' },
  { level: 3 as const, key: 'sport', pct: '124%' },
  { level: 4 as const, key: 'ludicrous', pct: '166%' },
]
const lightOn = computed(() => s.value?.lights?.find((l) => l.node === 'chamber_light')?.mode === 'on')

/*
 * 收菜：打完之后用打印头把件推下热床。
 *
 * 轮廓、最高点、有没有 brim 全由桥接从「刚打完的那一单」自己解出来 ——
 * 界面只负责把风险讲清楚再让人按。热床没冷透是推不动的（实测），
 * 所以温度单独拎出来显示，并给一个吹风降温的入口。
 */
const HARVEST_BED_MAX = 30
const sheet = ref(false)
const plan = ref<HarvestPlan | null>(null)
const planErr = ref('')
const busy = ref(false)
const bedHot = computed(() => (plan.value?.bedTemp ?? 0) > HARVEST_BED_MAX)
/** 桥接只给 path/plate，「第 N 盘」这句话在这里按当前语言拼 */
const sourceText = computed(() => {
  const p = plan.value
  if (!p?.path) return '—'
  const name = p.path.replace(/^\//, '')
  return p.plate === null ? name : `${name} · ${t('harvest.plateN', { n: p.plate })}`
})

async function openHarvest() {
  sheet.value = true
  plan.value = null
  planErr.value = ''
  try {
    plan.value = await planHarvest()
  } catch (e) {
    planErr.value = (e as Error).message
  }
}

async function doCool() {
  busy.value = true
  try {
    await coolForHarvest()
    toast(t('harvest.cooling'))
    // 风扇开了，温度要一会儿才降下来；重新取一次计划把新温度带回来
    setTimeout(() => { void openHarvest() }, 8000)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = false
  }
}

async function doHarvest() {
  if (!(await confirm(t('harvest.title'), t('harvest.confirm')))) return
  busy.value = true
  try {
    await runHarvest()
    sheet.value = false
    toast(t('harvest.started'))
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = false
  }
}

onShow(() => applyChrome('tab.control'))

async function send(c: Command, confirmText?: string) {
  if (confirmText) {
    const ok = await confirm(t('common.confirmTitle'), confirmText)
    if (!ok) return
  }
  try { await api.command(c); toast(t('common.sent')) }
  catch (e) { toast((e as Error).message) }
}

const step = (which: 'n' | 'b', d: number) => {
  touched = true
  if (which === 'n') nozzle.value = Math.max(0, Math.min(300, nozzle.value + d))
  else bed.value = Math.max(0, Math.min(110, bed.value + d))
}
</script>

<template>
  <view class="root" :class="themeClass">
    <view v-if="!configured" class="empty">
      <text class="empty-s">{{ t('common.notConfigured') }}</text>
    </view>

    <view v-else class="body">
      <text class="grouphead">{{ t('control.tempGroup') }}</text>
      <view class="card">
        <view class="line">
          <view class="line-l">
            <text class="line-t">{{ t('control.nozzle') }}</text>
            <text class="line-s">{{ t('control.current', { c: Math.round(s?.nozzle.cur ?? 0), max: 300 }) }}</text>
          </view>
          <view class="stepper">
            <text class="sbtn" @click="step('n', -5)">−</text>
            <text class="sval">{{ nozzle }}℃</text>
            <text class="sbtn" @click="step('n', 5)">＋</text>
          </view>
        </view>
        <view class="hsep" />
        <view class="line">
          <text class="link" @click="send({ type: 'nozzleTemp', celsius: 0 }, t('control.confirmNozzleOff'))">
            {{ t('control.turnOff') }}
          </text>
          <text class="link strong" @click="send({ type: 'nozzleTemp', celsius: nozzle }, t('control.confirmNozzle', { t: nozzle }))">
            {{ t('control.apply') }}
          </text>
        </view>
      </view>

      <view class="card mt">
        <view class="line">
          <view class="line-l">
            <text class="line-t">{{ t('control.bed') }}</text>
            <text class="line-s">{{ t('control.current', { c: Math.round(s?.bed.cur ?? 0), max: 110 }) }}</text>
          </view>
          <view class="stepper">
            <text class="sbtn" @click="step('b', -5)">−</text>
            <text class="sval">{{ bed }}℃</text>
            <text class="sbtn" @click="step('b', 5)">＋</text>
          </view>
        </view>
        <view class="hsep" />
        <view class="line">
          <text class="link" @click="send({ type: 'bedTemp', celsius: 0 }, t('control.confirmBedOff'))">
            {{ t('control.turnOff') }}
          </text>
          <text class="link strong" @click="send({ type: 'bedTemp', celsius: bed }, t('control.confirmBed', { t: bed }))">
            {{ t('control.apply') }}
          </text>
        </view>
      </view>

      <text class="grouphead">{{ t('control.speedGroup', { p: s?.speedPct ?? 100 }) }}</text>
      <view class="segs">
        <view v-for="sp in SPEEDS" :key="sp.level" class="seg" :class="{ on: s?.speedLevel === sp.level }"
          @click="send({ type: 'speed', level: sp.level }, t('control.confirmSpeed', { name: t('control.speed.' + sp.key) }))">
          <text class="seg-n">{{ t('control.speed.' + sp.key) }}</text>
          <text class="seg-p">{{ sp.pct }}</text>
        </view>
      </view>

      <text class="grouphead">{{ t('control.otherGroup') }}</text>
      <view class="card">
        <view class="line tappable" @click="send({ type: 'light', on: !lightOn })">
          <text class="line-t">{{ t('control.chamberLight') }}</text>
          <text class="line-v">{{ lightOn ? t('common.on') : t('common.off') }}</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="send({ type: 'pushall' })">
          <text class="line-t">{{ t('control.refresh') }}</text>
          <text class="line-v">›</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="openHarvest">
          <text class="line-t">{{ t('harvest.title') }}</text>
          <text class="line-v">›</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="send({ type: 'home' }, t('control.confirmHome'))">
          <text class="line-t danger">{{ t('control.home') }}</text>
          <text class="line-v">›</text>
        </view>
      </view>

      <text class="note">{{ t('control.gcodeNote') }}</text>
    </view>

    <Sheet :visible="sheet" :title="t('harvest.title')" @close="sheet = false">
      <view v-if="!plan && !planErr" class="busy"><Spinner :size="40" /></view>

      <view v-else-if="planErr" class="card sheet-card">
        <view class="line"><text class="line-t dim">{{ planErr }}</text></view>
      </view>

      <template v-else-if="plan">
        <text class="cap">{{ t('harvest.intro') }}</text>

        <view class="card sheet-card">
          <view class="line">
            <text class="line-t">{{ t('harvest.source') }}</text>
            <text class="line-v ell">{{ sourceText }}</text>
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="line-t">{{ t('harvest.parts') }}</text>
            <text class="line-v">{{ plan.objectCount }}</text>
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="line-t">{{ t('harvest.bedTemp') }}</text>
            <text class="line-v" :class="bedHot ? 'warn' : ''">{{ plan.bedTemp }}℃</text>
          </view>
        </view>

        <!-- 热床没冷透就推不动，这是实测结论，所以挡在前面 -->
        <view v-if="bedHot" class="card sheet-card">
          <view class="line stack">
            <text class="line-t warn">{{ t('harvest.tooHot', { max: HARVEST_BED_MAX }) }}</text>
            <text class="line-s">{{ t('harvest.tooHotHint') }}</text>
          </view>
          <view class="hsep" />
          <view class="line tappable" @click="doCool">
            <text class="line-t accent">{{ t('harvest.cool') }}</text>
            <text class="line-v">›</text>
          </view>
        </view>

        <template v-if="plan.warnings.length">
          <text class="grouphead">{{ t('harvest.warnings') }}</text>
          <view class="card sheet-card">
            <view v-for="(w, i) in plan.warnings" :key="w.code + i">
              <view v-if="i > 0" class="hsep" />
              <view class="line stack">
                <text class="line-t">{{ t('harvestWarn.' + w.code, w.params || {}) }}</text>
              </view>
            </view>
          </view>
        </template>

        <button class="pill go" :disabled="busy || bedHot || !plan.order.length" @click="doHarvest">
          {{ busy ? t('harvest.working') : t('harvest.go') }}
        </button>
        <text class="note">{{ t('harvest.note') }}</text>
      </template>
    </Sheet>
  </view>
</template>

<style scoped>
.root { background: var(--bg); min-height: 100vh; }
.body { padding: 36rpx 36rpx 140rpx; }
.empty { padding: 200rpx 60rpx; text-align: center; }
.empty-s { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.01em; }

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 44rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.grouphead:first-child { margin-top: 8rpx; }

/* ---- 收菜详情卡。取值与其他页保持一致，别在这里另起一套 ---- */
.busy { display: flex; justify-content: center; padding: 80rpx 0; }
.cap { display: block; font-size: 23rpx; color: var(--ink-2); margin: 18rpx 8rpx 0;
  line-height: 1.5; letter-spacing: -0.01em; }
.sheet-card { margin-top: 24rpx; }
/* 覆盖 .line 的固定行高，否则单行文字下方会留一大块空白 */
.line.stack { display: block; padding: 26rpx 0; min-height: 0; height: auto; }
.line.stack .line-t { display: block; line-height: 1.45; }
.line.stack .line-s { display: block; margin-top: 8rpx; }
.line-t.dim { color: var(--ink-3); }
.line-t.accent { color: var(--accent); }
.line-t.warn, .line-v.warn { color: var(--warning); }
/* 文件名可能很长，省略号截断，别把整行撑开 */
.line-v.ell { max-width: 62%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pill {
  width: 100%; margin-top: 32rpx; font-size: 30rpx; height: 96rpx; line-height: 96rpx;
  background: var(--surface); color: var(--ink); border: none; border-radius: 999rpx;
  letter-spacing: -0.02em; padding: 0;
}
.pill::after { border: none; }
.pill.go { background: var(--accent); color: #fff; }
.pill[disabled], .pill[disabled]:not([type]) {
  background: var(--surface); color: var(--ink-3); opacity: 0.5;
}

.card { background: var(--surface); border-radius: 28rpx; padding: 0 34rpx; }
.mt { margin-top: 20rpx; }
.hsep { height: 1rpx; background: var(--separator); }

.line { display: flex; align-items: center; justify-content: space-between; min-height: 108rpx; }
.line-l { flex: 1; }
.line-t { font-size: 30rpx; color: var(--ink); letter-spacing: -0.02em; }
.line-t.danger { color: var(--critical); }
.line-s { display: block; font-size: 24rpx; color: var(--ink-2); margin-top: 6rpx; letter-spacing: -0.01em; }
.line-v { font-size: 30rpx; color: var(--ink-2); letter-spacing: -0.02em; }
.tappable:active { opacity: 0.55; }

.stepper { display: flex; align-items: center; background: var(--surface-2); border-radius: 999rpx; }
.sbtn { width: 74rpx; height: 66rpx; line-height: 66rpx; text-align: center;
  font-size: 32rpx; color: var(--accent); }
.sval { min-width: 118rpx; text-align: center; font-size: 30rpx; color: var(--ink);
  font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

.link { font-size: 30rpx; color: var(--accent); letter-spacing: -0.02em; }
.link.strong { font-weight: 600; }
.link:active { opacity: 0.55; }

.segs { display: flex; background: var(--surface); border-radius: 24rpx; padding: 8rpx; }
.seg { flex: 1; padding: 20rpx 0; text-align: center; border-radius: 18rpx;
  transition: background 0.25s ease; }
.seg.on { background: var(--surface-2); }
.seg-n { display: block; font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em; }
.seg.on .seg-n { font-weight: 600; }
.seg-p { display: block; font-size: 22rpx; color: var(--ink-2); margin-top: 4rpx; }

.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin-top: 32rpx; padding: 0 8rpx; line-height: 1.6; letter-spacing: -0.01em; }
</style>
