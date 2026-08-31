<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onHide, onPullDownRefresh } from '@dcloudio/uni-app'
import { api, configured, type Command } from '../../api/client'
import { printer, restart } from '../../store/printer'
import { themeClass, applyChrome } from '../../store/prefs'
import StatTile from '../../components/StatTile.vue'
import Meter from '../../components/Meter.vue'
import AmsSlot from '../../components/AmsSlot.vue'
import CameraView from '../../components/CameraView.vue'
import Sheet from '../../components/Sheet.vue'
import Spinner from '../../components/Spinner.vue'
import SunIcon from '../../components/SunIcon.vue'
import TempChart from '../../components/TempChart.vue'
import {
  startDrying, stopDrying, unloadFilament, DryBlockedError,
  fetchErrors, clearErrors, fetchTemps,
  type AmsUnit, type DryBlocker, type PrinterErrorItem, type TempSample,
} from '../../api/client'

const { t, locale } = useI18n()

const KNOWN_STATES = ['IDLE', 'RUNNING', 'PAUSE', 'FINISH', 'FAILED', 'PREPARE', 'SLICING']

const s = computed(() => printer.summary)
const stateText = computed(() => {
  const v = s.value?.state
  return t(`state.${v && KNOWN_STATES.includes(v) ? v : 'UNKNOWN'}`)
})
/*
 * 过渡阶段。打印机在 stg_cur 里报当前处于哪个阶段（调平、换料、擦嘴……），
 * -1 表示不在任何阶段。0 是「正在打印」，与上面的状态行重复，不再单列。
 * 对照表 0–77 取自 BambuStudio 的 get_stage_string。
 */
const stage = computed(() => s.value?.stage ?? -1)
const inStage = computed(() => stage.value > 0)
const stageText = computed(() => {
  const n = stage.value
  const key = `stage.${n}`
  const txt = t(key)
  // 固件报了对照表里没有的编号时，给出编号而不是空白
  return txt === key ? t('stage.unknown', { n }) : txt
})
/** 这一单的阶段序列里，当前走到第几个 —— 让等待有个尽头 */
const stageStep = computed(() => {
  const list = s.value?.stageList ?? []
  const i = list.indexOf(stage.value)
  return i >= 0 && list.length > 1 ? { cur: i + 1, total: list.length } : null
})

const running = computed(() => s.value?.state === 'RUNNING')
const paused = computed(() => s.value?.state === 'PAUSE')
// 错误码为 0 时不显示「错误码 0」这种废话
const alertDesc = computed(() => {
  const n = s.value?.errors?.length ?? 0
  const code = s.value?.printError ?? 0
  const parts: string[] = []
  if (n) parts.push(t('monitor.errorHms', { count: n }))
  if (code) parts.push(t('monitor.errorCode', { code: code.toString(16).toUpperCase().padStart(8, '0') }))
  return parts.join(' · ')
})
const hasError = computed(
  () => (s.value?.errors?.length ?? 0) > 0 || (s.value?.printError ?? 0) !== 0,
)

const stateTone = computed<'neutral' | 'good' | 'warning' | 'critical'>(() => {
  if (hasError.value || s.value?.state === 'FAILED') return 'critical'
  if (paused.value) return 'warning'
  if (s.value?.state === 'FINISH') return 'good'
  if (running.value) return 'good'
  return 'neutral'
})

/* 进度条只在需要注意时着色。正常与完成都用蓝色 ——
   状态已由圆点和文字说清楚，颜色不必重复表达，也不该和主数字抢注意力。 */
const meterTone = computed<'accent' | 'warning' | 'critical'>(() =>
  stateTone.value === 'critical' ? 'critical' : stateTone.value === 'warning' ? 'warning' : 'accent',
)

const eta = computed(() => {
  const m = s.value?.remainingMin ?? 0
  if (!m) return running.value ? t('monitor.calculating') : t('common.none')
  return m >= 60
    ? t('monitor.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
    : t('monitor.minutes', { m })
})

const heating = (cur: number, target: number) => target > 0 && Math.abs(cur - target) > 3
const tempSub = (cur: number, target: number) =>
  heating(cur, target)
    ? t('monitor.heatingTo', { t: Math.round(target) })
    : t('monitor.target', { t: Math.round(target) })

const lightOn = computed(
  () => s.value?.lights?.find((l) => l.node === 'chamber_light')?.mode === 'on',
)

// ---- 摄像头 ----
const camOn = ref(true)
const camMode = ref<'live' | 'saver'>('live')
/* uni-app 会缓存页面，切走标签页时组件不会卸载 —— 不显式停掉的话
   WebRTC 会在后台一直跑，白耗流量和电。 */
const pageActive = ref(true)
const cam = ref<{ enterFullscreen: () => void } | null>(null)
const camActive = computed(() => camOn.value && pageActive.value)

function toggleCam() {
  camOn.value = !camOn.value
}
function cycleRate() {
  camMode.value = camMode.value === 'live' ? 'saver' : 'live'
}
const rateLabel = computed(() =>
  camMode.value === 'live' ? t('monitor.quality.live') : t('monitor.quality.saver'),
)

/** WebRTC 起不来时组件会自己退回抽帧，这里只负责把档位显示改对 */
function onCamFallback() {
  if (camMode.value === 'live') {
    camMode.value = 'saver'
    uni.showToast({ title: t('monitor.liveFallback'), icon: 'none', duration: 2600 })
  }
}

function goSettings() {
  uni.switchTab({ url: '/pages/settings/index' })
}

onShow(() => { pageActive.value = true; applyChrome('tab.monitor'); startTemps() })
onHide(() => { pageActive.value = false; stopTemps() })
onPullDownRefresh(() => {
  restart()
  setTimeout(() => uni.stopPullDownRefresh(), 600)
})

// ---- AMS 烘干 ----
const drySheet = ref(false)

// —— 错误详情 ——
const errSheet = ref(false)
const errItems = ref<PrinterErrorItem[]>([])
const errClearable = ref(false)
const errLoading = ref(false)
const errBusy = ref(false)

async function openErrors() {
  errSheet.value = true
  errLoading.value = true
  try {
    const r = await fetchErrors(locale.value)
    errItems.value = r.items
    errClearable.value = r.clearable
  } catch (e) {
    errItems.value = []
    toast((e as Error).message)
  } finally {
    errLoading.value = false
  }
}

async function doClearErrors() {
  errBusy.value = true
  try {
    await clearErrors()
    // 打印机要一两拍才把新状态推上来
    await new Promise((r) => setTimeout(r, 1500))
    const r = await fetchErrors(locale.value)
    errItems.value = r.items
    errClearable.value = r.clearable
    toast(t('err.cleared'))
  } catch (e) {
    toast((e as Error).message)
  } finally {
    errBusy.value = false
  }
}

/** HMS 条目清不掉，得等条件消失，界面上要说清楚 */
const errHasHms = computed(() => errItems.value.some((i) => i.kind === 'hms'))

function openErrorPage(url: string) {
  // #ifdef H5
  window.open(url, '_blank')
  // #endif
}
const dryBusy = ref('')
const unit = computed<AmsUnit | null>(() => s.value?.amsUnits?.[0] ?? null)
const blockers = computed<readonly DryBlocker[]>(() => s.value?.dryBlockers ?? [])
const isDrying = computed(
  () => unit.value?.dryStatus === 'drying' || unit.value?.dryStatus === 'checking',
)

/*
 * 预设来源优先取该槽耗材 RFID 里的推荐值 —— 比硬编码材料表准，也正是
 * Bambu 自己的做法（CtrlAmsStartDryingHour 传的是选中槽位的 filament_type）。
 * RFID 里没有时才落到这张表，并统一夹到 AMS 2 Pro 的 45–65℃ 区间内。
 */
/*
 * 烘干预设。数值取自 BambuStudio 耗材配置里的
 * filament_dev_ams_drying_temperature / _time（resources/profiles/BBL/filament/
 * fdm_filament_*.json），数组首值就是内置 AMS / AMS 2 Pro 这一档 ——
 * 与打印机屏幕上的预设一致（PLA 45℃/12h、PETG 65℃/12h）。
 * 官方对照表见 wiki.bambulab.com/en/filament-acc/filament/dry-filament。
 */
const DRY_PRESETS: { id: string; temp: number; hours: number }[] = [
  { id: 'PLA', temp: 45, hours: 12 },
  { id: 'PETG', temp: 65, hours: 12 },
  { id: 'PET', temp: 65, hours: 12 },
  { id: 'PCTG', temp: 65, hours: 12 },
  { id: 'TPU', temp: 65, hours: 12 },
  { id: 'ABS', temp: 65, hours: 12 },
  { id: 'ASA', temp: 65, hours: 12 },
  { id: 'PC', temp: 65, hours: 12 },
  { id: 'PA', temp: 65, hours: 12 },
  { id: 'PVA', temp: 65, hours: 12 },
  { id: 'PP', temp: 60, hours: 12 },
  { id: 'PE', temp: 45, hours: 12 },
]

const clampT = (n: number) => Math.max(45, Math.min(65, Math.round(n)))
const clampH = (n: number) => Math.max(1, Math.min(24, Math.round(n)))

const dryMat = ref('PLA')
const dryTemp = ref(45)
const dryHours = ref(12)
/** 下拉展开状态 */
const matOpen = ref(false)

function pickMat(id: string) {
  const p = DRY_PRESETS.find((x) => x.id === id)
  if (!p) return
  dryMat.value = id
  dryTemp.value = clampT(p.temp)
  dryHours.value = clampH(p.hours)
  matOpen.value = false
}

// humidity_raw 就是 BambuStudio 显示的那个百分比，0 也是合法读数。
// ---- 温度曲线 ----
/*
 * 采样在桥接里做（10 秒一个点），这里只按可见性拉取：
 * 页面在前台且没有弹窗时每 30 秒续一次，切走就停 —— 曲线不值得为它烧电。
 */
const temps = ref<TempSample[]>([])
let tempTimer: ReturnType<typeof setInterval> | null = null

async function loadTemps() {
  try {
    temps.value = (await fetchTemps(60)).samples
  } catch {
    /* 曲线拉不到不该影响主界面 */
  }
}

function startTemps() {
  void loadTemps()
  if (tempTimer) return
  tempTimer = setInterval(() => void loadTemps(), 30_000)
}

function stopTemps() {
  if (tempTimer) clearInterval(tempTimer)
  tempTimer = null
}

// 外置料盘（unit 为 -1）不属于 AMS，不该混进料槽列表里
const amsTrays = computed(() => (s.value?.ams ?? []).filter((t) => t.unit >= 0))
const extTray = computed(() => (s.value?.ams ?? []).find((t) => t.unit < 0 && !t.empty) ?? null)

const humidityText = computed(() => {
  const pct = unit.value?.humidityPct
  return pct === undefined || pct === null ? '—' : t('dry.humidityPct', { p: pct })
})

function confirmAsk(title: string, content: string, danger = false): Promise<boolean> {
  return new Promise((r) =>
    uni.showModal({
      title, content, confirmColor: danger ? '#ff453a' : '#2997ff',
      success: (m) => r(!!m.confirm), fail: () => r(false),
    }),
  )
}
const toast = (msg: string) => uni.showToast({ title: msg, icon: 'none', duration: 2600 })

async function doStartDry() {
  if (!unit.value) return
  const ok = await confirmAsk(
    t('dry.title'),
    t('dry.confirmStart', { t: dryTemp.value, h: dryHours.value }),
    true,
  )
  if (!ok) return
  try {
    await startDrying({
      amsId: unit.value.id, temp: dryTemp.value, duration: dryHours.value,
      filament: dryMat.value,
    })
    toast(t('dry.started'))
  } catch (e) {
    // 服务端拦下时会带回具体原因，这里不做二次判断，直接照它说的展示
    if (e instanceof DryBlockedError) toast(t('dry.blocked'))
    else toast((e as Error).message)
  }
}

async function doStopDry() {
  if (!unit.value) return
  if (!(await confirmAsk(t('dry.title'), t('dry.confirmStop')))) return
  try { await stopDrying(unit.value.id); toast(t('dry.stopped')) }
  catch (e) { toast((e as Error).message) }
}

/** 逐条解除阻塞：停任务 / 退料。每步都要用户确认，且写明后果 */
async function resolveBlocker(b: DryBlocker) {
  if (b === 'printing') {
    if (!(await confirmAsk(t('dry.doStopPrint'), t('dry.confirmStopPrint'), true))) return
    try { await api.command({ type: 'stop' }); toast(t('common.sent')) }
    catch (e) { toast((e as Error).message) }
    return
  }
  if (b === 'filamentLoaded') {
    if (!(await confirmAsk(t('dry.doUnload'), t('dry.confirmUnload'), true))) return
    if (!unit.value) return
    dryBusy.value = t('dry.unloading')
    try { await unloadFilament(unit.value.id) }
    catch (e) { toast((e as Error).message) }
    finally {
      // 退料要一分钟左右，状态由 WebSocket 推送更新，这里只是收掉忙碌态
      setTimeout(() => { dryBusy.value = '' }, 3000)
    }
  }
}

const stepTemp = (d: number) => { dryTemp.value = clampT(dryTemp.value + d) }
const stepHours = (d: number) => { dryHours.value = clampH(dryHours.value + d) }

async function send(c: Command, confirmText?: string) {
  if (confirmText) {
    const ok = await new Promise<boolean>((resolve) =>
      uni.showModal({
        title: t('common.confirmTitle'), content: confirmText, confirmColor: '#2997ff',
        success: (r) => resolve(!!r.confirm), fail: () => resolve(false),
      }),
    )
    if (!ok) return
  }
  try {
    await api.command(c)
    uni.showToast({ title: t('common.sent'), icon: 'none' })
  } catch (e) {
    uni.showToast({ title: (e as Error).message, icon: 'none', duration: 2500 })
  }
}
</script>

<template>
  <view class="root" :class="themeClass">
    <!-- 未配置 -->
    <view v-if="!configured" class="empty">
      <text class="empty-t">{{ t('monitor.emptyTitle') }}</text>
      <text class="empty-s">{{ t('monitor.emptyDesc') }}</text>
      <button class="cta" @click="goSettings">{{ t('monitor.emptyCta') }}</button>
    </view>

    <template v-else>
      <!-- 摄像头：全出血，控件浮在画面上 -->
      <view class="cam">
        <CameraView v-if="camOn" ref="cam" :active="camActive" :mode="camMode" @fallback="onCamFallback" />
        <view v-else class="cam-off"><text class="cam-off-t">{{ t('monitor.camPaused') }}</text></view>

        <!-- 全屏：右上角图标按钮，形状同播放器里的那个 -->
        <view
          v-if="camOn"
          class="fs-btn"
          :aria-label="t('monitor.fullscreen')"
          @click="cam?.enterFullscreen()"
        >
          <view class="fs-ico" />
        </view>
        <view class="scrim" />
        <view class="cam-ctl">
          <view class="glass" @click="toggleCam">
            <text class="glass-t">{{ camOn ? t('monitor.camPause') : t('monitor.camPlay') }}</text>
          </view>
          <view class="glass" @click="cycleRate">
            <text class="glass-t">{{ rateLabel }}</text>
          </view>
        </view>
      </view>

      <view class="body">
        <!-- 报错：图标 + 文案，颜色只是佐证 -->
        <view v-if="hasError" class="alert tappable" @click="openErrors">
          <view class="alert-i"><text class="alert-g">!</text></view>
          <view class="alert-b">
            <text class="alert-t">{{ t('monitor.errorTitle') }}</text>
            <text class="alert-s">{{ alertDesc }}</text>
          </view>
          <text class="alert-x">›</text>
        </view>

        <!-- 主体：整屏唯一的 hero -->
        <view class="hero">
          <view class="statusline">
            <view class="dot" :class="'d-' + stateTone" />
            <text class="status-t">{{ stateText }}</text>
            <text class="status-s">{{ t('link.' + printer.link) }}</text>
          </view>

          <view class="figure">
            <text class="num">{{ s?.progress ?? 0 }}</text>
            <text class="pct">%</text>
          </view>

          <Meter :pct="s?.progress ?? 0" :tone="meterTone" />

          <text class="task">{{ s?.taskName || t('monitor.noTask') }}</text>

          <!-- 过渡阶段：调平、换料这些，比干等着看进度条有用得多 -->
          <view v-if="inStage" class="stage">
            <Spinner :size="26" />
            <text class="stage-t">{{ stageText }}</text>
            <text v-if="stageStep" class="stage-n">{{ stageStep.cur }}/{{ stageStep.total }}</text>
          </view>

          <view class="facts">
            <text class="fact">{{ t('monitor.layers', { cur: s?.layer ?? 0, total: s?.totalLayers ?? 0 }) }}</text>
            <text class="sep">·</text>
            <text class="fact">{{ t('monitor.remaining', { value: eta }) }}</text>
          </view>
        </view>

        <!-- 温度 -->
        <view class="card temps">
          <StatTile
            :label="t('monitor.nozzle')" :value="String(Math.round(s?.nozzle.cur ?? 0))" unit="℃"
            :sub="tempSub(s?.nozzle.cur ?? 0, s?.nozzle.target ?? 0)"
            :tone="heating(s?.nozzle.cur ?? 0, s?.nozzle.target ?? 0) ? 'warning' : 'neutral'" />
          <view class="vsep" />
          <StatTile
            :label="t('monitor.bed')" :value="String(Math.round(s?.bed.cur ?? 0))" unit="℃"
            :sub="tempSub(s?.bed.cur ?? 0, s?.bed.target ?? 0)"
            :tone="heating(s?.bed.cur ?? 0, s?.bed.target ?? 0) ? 'warning' : 'neutral'" />
          <view class="vsep" />
          <StatTile
            :label="t('monitor.chamber')" :value="s?.chamber != null ? String(Math.round(s.chamber)) : t('common.none')" unit="℃"
            :sub="t('monitor.speedPct', { p: s?.speedPct ?? 100 })" />
        </view>

        <!-- 温度走势：翘边、层间粘接出问题时用来倒查 -->
        <view class="chart"><TempChart :samples="temps" /></view>

        <!-- 操作 -->
        <view class="acts">
          <button v-if="!paused" class="pill" :disabled="!running"
            @click="send({ type: 'pause' }, t('monitor.confirmPause'))">{{ t('action.pause') }}</button>
          <button v-else class="pill fill" @click="send({ type: 'resume' })">{{ t('action.resume') }}</button>
          <button class="pill warn" :disabled="!running && !paused"
            @click="send({ type: 'stop' }, t('monitor.confirmStop'))">{{ t('action.stop') }}</button>
          <button class="pill" @click="send({ type: 'light', on: !lightOn })">
            {{ lightOn ? t('action.lightOff') : t('action.lightOn') }}
          </button>
        </view>

        <!-- 耗材 -->
        <!-- 分组标题右侧一个按钮，不再占掉列表一整行 -->
        <view class="grouprow">
          <text class="grouphead">{{ t('monitor.amsGroup') }}</text>
          <view v-if="unit" class="dry-btn" :aria-label="t('dry.entry')" @click="drySheet = true">
            <SunIcon :active="isDrying" :size="38" />
          </view>
        </view>
        <view class="card list">
          <view v-for="(t, i) in amsTrays" :key="`${t.unit}-${t.slot}`">
            <view v-if="i > 0" class="hsep" />
            <AmsSlot :tray="t" />
          </view>
        </view>

        <!-- 烘干控制 -->
      <!-- 错误详情：文案来自 Bambu 官方错误库，桥接侧代查 -->
      <Sheet :visible="errSheet" :title="t('err.title')" @close="errSheet = false">
        <view v-if="errLoading" class="busy"><Spinner :size="36" /></view>

        <template v-else-if="errItems.length">
          <view class="card sheet-card">
            <view v-for="(it, i) in errItems" :key="it.code">
              <view v-if="i > 0" class="hsep" />
              <view class="line stack tappable" @click="openErrorPage(it.url)">
                <text class="err-t">{{ it.text || t('err.noText') }}</text>
                <view class="err-foot">
                  <text class="err-code">{{ it.code }}</text>
                  <text class="err-more">{{ t('err.detail') }} ›</text>
                </view>
              </view>
            </view>
          </view>
          <text v-if="errHasHms" class="hint">{{ t('err.hmsNote') }}</text>
        </template>

        <view v-else class="card sheet-card">
          <view class="line"><text class="k">{{ t('err.none') }}</text></view>
        </view>

        <template #footer>
          <button class="cta fill" :disabled="!errClearable || errBusy" @click="doClearErrors">
            {{ errBusy ? t('err.clearing') : t('err.clear') }}
          </button>
        </template>
      </Sheet>

      <Sheet :visible="drySheet" :title="t('dry.title')" @close="drySheet = false">
        <view class="card sheet-card">
          <template v-if="isDrying">
            <view class="line">
              <text class="k">{{ t('dry.statusLabel') }}</text>
              <text class="v accent">
                {{ t('dry.status.' + (unit?.dryStatus ?? 'unknown'))
                }}{{ unit && unit.dryRemainMin > 0 ? ' · ' + t('dry.remain', { min: unit.dryRemainMin }) : '' }}
              </text>
            </view>
            <view class="hsep" />
          </template>
          <view class="line">
            <text class="k">{{ t('dry.chamber') }}</text>
            <text class="v">{{ unit ? Math.round(unit.temp) : '—' }}℃</text>
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="k">{{ t('dry.humidity') }}</text>
            <text class="v">{{ humidityText }}</text>
          </view>
        </view>

        <!-- 阻塞原因与补救 -->
        <template v-if="!isDrying && blockers.length">
          <text class="grouphead">{{ t('dry.blocked') }}</text>
          <view class="card sheet-card">
            <view v-for="(b, i) in blockers" :key="b">
              <view v-if="i > 0" class="hsep" />
              <view class="line" :class="{ tappable: b !== 'alreadyDrying' }"
                @click="b !== 'alreadyDrying' && resolveBlocker(b)">
                <text class="k">{{ t('dry.blocker.' + b) }}</text>
                <text v-if="b === 'printing'" class="v accent">{{ t('dry.doStopPrint') }} ›</text>
                <text v-else-if="b === 'filamentLoaded'" class="v accent">{{ t('dry.doUnload') }} ›</text>
              </view>
            </view>
          </view>
          <view v-if="dryBusy" class="busy"><Spinner :size="36" /><text class="busy-t">{{ dryBusy }}</text></view>
          <text class="hint">{{ t('dry.note') }}</text>
        </template>

        <!-- 选耗材：参数随之带出，也可再手动调 -->
        <template v-else-if="!isDrying">
          <text class="grouphead">{{ t('dry.paramsGroup') }}</text>
          <view class="card sheet-card">
            <!-- 耗材类型下拉：选中即带出官方预设，之后仍可手调 -->
            <view class="line tappable" @click="matOpen = !matOpen">
              <text class="k">{{ t('dry.matLabel') }}</text>
              <view class="trail">
                <text class="v">{{ dryMat }}</text>
                <text class="caret" :class="{ open: matOpen }">⌄</text>
              </view>
            </view>
            <template v-if="matOpen">
              <view v-for="m in DRY_PRESETS" :key="m.id" class="mat">
                <view class="hsep" />
                <view class="line tappable" @click="pickMat(m.id)">
                  <view class="pick-meta">
                    <text class="k">{{ m.id }}</text>
                    <text class="pick-sub">{{ t('dry.recommended', { t: m.temp, h: m.hours }) }}</text>
                  </view>
                  <text v-if="dryMat === m.id" class="tick">✓</text>
                </view>
              </view>
            </template>
            <view class="hsep" />
            <view class="line">
              <text class="k">{{ t('dry.tempLabel') }}</text>
              <view class="trail">
                <text class="v num">{{ dryTemp }}℃</text>
                <view class="stepper">
                  <text class="sbtn" :class="{ off: dryTemp <= 45 }" @click="stepTemp(-5)">−</text>
                  <view class="svsep" />
                  <text class="sbtn" :class="{ off: dryTemp >= 65 }" @click="stepTemp(5)">＋</text>
                </view>
              </view>
            </view>
            <view class="hsep" />
            <view class="line">
              <text class="k">{{ t('dry.durationLabel') }}</text>
              <view class="trail">
                <text class="v num">{{ dryHours }} {{ t('dry.hours') }}</text>
                <view class="stepper">
                  <text class="sbtn" :class="{ off: dryHours <= 1 }" @click="stepHours(-1)">−</text>
                  <view class="svsep" />
                  <text class="sbtn" :class="{ off: dryHours >= 24 }" @click="stepHours(1)">＋</text>
                </view>
              </view>
            </view>
          </view>
          <text class="hint">{{ t('dry.note') }}</text>
        </template>

        <template #footer>
          <button v-if="isDrying" class="cta danger" @click="doStopDry">{{ t('dry.stop') }}</button>
          <button v-else class="cta fill" :disabled="blockers.length > 0" @click="doStartDry">
            {{ t('dry.start') }}
          </button>
        </template>
      </Sheet>

      <text class="foot">{{ s?.wifi }} · {{ t('monitor.updatedAt', { time: printer.lastAt ? new Date(printer.lastAt).toLocaleTimeString() : t('common.none') }) }}</text>
      </view>
    </template>
  </view>
</template>

<style scoped>
.root { background: var(--bg); min-height: 100vh; }

/* 空状态：一句话，居中，大留白 */
.empty { padding: 200rpx 60rpx; display: flex; flex-direction: column; align-items: center; }
.empty-t { font-size: 52rpx; font-weight: 600; letter-spacing: -0.03em; color: var(--ink); }
.empty-s { font-size: 28rpx; color: var(--ink-2); margin: 20rpx 0 60rpx;
  text-align: center; line-height: 1.5; letter-spacing: -0.01em; }
.cta { font-size: 30rpx; height: 96rpx; line-height: 96rpx; padding: 0 64rpx;
  background: var(--accent); color: #fff; border: none; border-radius: 999rpx;
  letter-spacing: -0.01em; }

.cam { position: relative; background: #000; line-height: 0; }
.cam-img { width: 100%; display: block; }
/* 和 CameraView 一样锁 16:9，暂停/恢复才不会差那一两像素。
   写死 rpx 高度会随屏宽和真实画面比例对不上。 */
.cam-off { aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; }
@supports not (aspect-ratio: 1 / 1) {
  .cam-off { height: 0; padding-top: 56.25%; position: relative; }
}
.cam-off-t { color: var(--ink-3); font-size: 26rpx; letter-spacing: -0.01em; }
/* 底部压一层渐变，控件不再受画面明暗影响（Apple 在相机/照片里的做法） */
.scrim { position: absolute; left: 0; right: 0; bottom: 0; height: 180rpx;
  background: linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0)); pointer-events: none; }
.cam-ctl { position: absolute; right: 24rpx; bottom: 24rpx; display: flex; line-height: 1; }
/* 玻璃拟态：浮在画面之上而不遮挡内容 */
.glass {
  margin-left: 14rpx; padding: 14rpx 30rpx; border-radius: 999rpx;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(30rpx) saturate(180%);
  -webkit-backdrop-filter: blur(24rpx) saturate(180%);
  border: 1rpx solid rgba(255, 255, 255, 0.14);
}
.glass-t { font-size: 24rpx; color: #fff; letter-spacing: -0.01em; }

/* 全屏按钮。图标用 CSS 画的对角折角，比 Unicode 的 ⛶/⤢ 可靠 ——
   那些字形在不同系统上缺字或粗细不一。 */
.fs-btn {
  position: absolute;
  top: 24rpx;
  right: 24rpx;
  width: 68rpx;
  height: 68rpx;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(30rpx) saturate(180%);
  -webkit-backdrop-filter: blur(24rpx) saturate(180%);
  border: 1rpx solid rgba(255, 255, 255, 0.14);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.25s ease;
}
.fs-btn:active { opacity: 0.6; }

.fs-ico {
  position: relative;
  width: 28rpx;
  height: 28rpx;
}
/* 左上折角 */
.fs-ico::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 11rpx; height: 11rpx;
  border-top: 3rpx solid #fff;
  border-left: 3rpx solid #fff;
  border-top-left-radius: 2rpx;
}
/* 右下折角 */
.fs-ico::after {
  content: '';
  position: absolute;
  right: 0; bottom: 0;
  width: 11rpx; height: 11rpx;
  border-bottom: 3rpx solid #fff;
  border-right: 3rpx solid #fff;
  border-bottom-right-radius: 2rpx;
}

.body { padding: 44rpx 36rpx 140rpx; }

.alert { display: flex; align-items: center; background: rgba(255, 69, 58, 0.12);
  border-radius: 24rpx; padding: 26rpx 28rpx; margin-bottom: 40rpx; }
.alert-i { width: 40rpx; height: 40rpx; border-radius: 50%; background: var(--critical);
  display: flex; align-items: center; justify-content: center; margin-right: 22rpx; flex-shrink: 0; }
.alert-g { font-size: 26rpx; font-weight: 700; color: #fff; line-height: 1; }
.alert-b { flex: 1; }
.alert-t { display: block; font-size: 28rpx; font-weight: 600; color: var(--ink); letter-spacing: -0.02em; }
.alert-s { display: block; font-size: 24rpx; color: var(--ink-2); margin-top: 6rpx; }

.statusline { display: flex; align-items: center; }
.dot { width: 14rpx; height: 14rpx; border-radius: 50%; background: var(--ink-3); margin-right: 14rpx; }
.d-good { background: var(--good); }
.d-warning { background: var(--warning); }
.d-critical { background: var(--critical); }
.status-t { font-size: 28rpx; color: var(--ink); font-weight: 500; letter-spacing: -0.02em; }
.status-s { font-size: 24rpx; color: var(--ink-3); margin-left: auto; letter-spacing: -0.01em; }

/* Hero：巨大、重、字距收紧 —— 整页的绝对主角 */
.figure { display: flex; align-items: baseline; margin: 24rpx 0 32rpx; }
.num { font-size: 150rpx; font-weight: 700; letter-spacing: -0.055em;
  line-height: 0.9; color: var(--ink); }
.pct { font-size: 48rpx; font-weight: 500; color: var(--ink-2);
  margin-left: 10rpx; letter-spacing: -0.03em; }

.task { display: block; font-size: 32rpx; color: var(--ink); margin-top: 32rpx;
  letter-spacing: -0.02em; line-height: 1.35; }
.facts { display: flex; align-items: center; margin-top: 12rpx; }
.fact { font-size: 26rpx; color: var(--ink-2); letter-spacing: -0.01em; }
.sep { font-size: 26rpx; color: var(--ink-3); margin: 0 14rpx; }

.card { background: var(--surface); border-radius: 28rpx; padding: 30rpx 34rpx; }
.temps { display: flex; align-items: stretch; margin-top: 52rpx; }
.vsep { width: 1rpx; background: var(--separator); margin: 4rpx 26rpx; }

.acts { display: flex; margin-top: 28rpx; }
.pill {
  flex: 1; margin-right: 18rpx; font-size: 30rpx; height: 96rpx; line-height: 96rpx;
  background: var(--surface); color: var(--ink); border: none; border-radius: 999rpx;
  letter-spacing: -0.02em; padding: 0;
  transition: opacity 0.25s ease, background 0.25s ease;
}
.pill::after { border: none; }
.pill:last-child { margin-right: 0; }
.pill[disabled], .pill[disabled]:not([type]) {
  background: var(--surface); color: var(--ink-3); opacity: 0.5;
}
.pill.fill { background: var(--accent); color: #fff; }
.pill.warn { color: var(--critical); }
.pill.warn[disabled] { color: var(--ink-3); }

/* 耗材选择行：色块 + 名称 + 推荐参数，选中用 iOS 的对勾而不是单选圈 */
.pick-meta { margin-left: 22rpx; min-width: 0; }
.pick-meta .k { display: block; }
.pick-sub {
  display: block; font-size: 22rpx; color: var(--ink-2);
  margin-top: 6rpx; letter-spacing: -0.01em;
}
.tick { font-size: 30rpx; color: var(--accent); margin-left: 20rpx; flex-shrink: 0; }

/* 烘干入口：与「耗材」同一行、贴最右。小太阳灰色静止=未烘干，红色旋转=烘干中 */
.grouprow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 52rpx 0 16rpx;
  padding: 0 8rpx;
}
.grouprow .grouphead { margin: 0; }
.dry-btn {
  flex: none;
  width: 68rpx;
  height: 68rpx;
  border-radius: 50%;
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.25s ease;
}
.dry-btn:active { opacity: 0.55; }

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 52rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.list { padding: 0 34rpx; }
.hsep { height: 1rpx; background: var(--separator); }

.foot { display: block; text-align: center; font-size: 22rpx;
  color: var(--ink-3); margin-top: 52rpx; letter-spacing: -0.01em; }

/* —— 烘干弹窗 —— */
.sheet-card { margin-top: 24rpx; }
.line { display: flex; align-items: center; justify-content: space-between;
  min-height: 96rpx; padding: 16rpx 0; box-sizing: border-box; }
.tappable:active { opacity: 0.55; }
.k { font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; }
.v { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.02em;
  text-align: right; margin-left: 32rpx; flex-shrink: 0; }
.v.accent { color: var(--accent); }
.trail { display: flex; align-items: center; margin-left: 32rpx; flex-shrink: 0; }
.trail .v { margin-left: 0; }
.v.num { font-variant-numeric: tabular-nums; color: var(--ink); min-width: 132rpx; }
.stepper { display: flex; align-items: center; margin-left: 20rpx;
  background: var(--surface-2); border-radius: 15rpx; overflow: hidden; }
.sbtn { width: 82rpx; height: 62rpx; line-height: 62rpx; text-align: center;
  font-size: 32rpx; color: var(--ink); }
.sbtn:active { background: var(--separator); }
.sbtn.off { color: var(--ink-3); }
.svsep { width: 1rpx; height: 34rpx; background: var(--separator); }
.busy { display: flex; align-items: center; justify-content: center; margin-top: 28rpx; }
.busy-t { font-size: 25rpx; color: var(--ink-2); margin-left: 16rpx; letter-spacing: -0.01em; }
.hint { display: block; font-size: 22rpx; color: var(--ink-3);
  margin: 20rpx 8rpx 0; line-height: 1.6; letter-spacing: -0.01em; }
.cta.fill { width: 100%; padding: 0; }
.cta.fill[disabled] { opacity: 0.4; }
.cta.danger { width: 100%; padding: 0; background: var(--surface); color: var(--critical); }
.alert-x { font-size: 30rpx; color: var(--critical); opacity: 0.55; margin-left: 16rpx; }
.line.stack { display: block; padding: 26rpx 0; }
.err-t { display: block; font-size: 28rpx; color: var(--ink); line-height: 1.5;
  letter-spacing: -0.01em; }
.err-foot { display: flex; align-items: center; justify-content: space-between;
  margin-top: 12rpx; }
.err-code { font-size: 22rpx; color: var(--ink-3); font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em; }
.err-more { font-size: 23rpx; color: var(--accent); }
.caret { font-size: 26rpx; color: var(--ink-3); margin-left: 12rpx; line-height: 1;
  transition: transform 0.2s ease; }
.caret.open { transform: rotate(180deg); }
.mat .line { padding-left: 24rpx; }
.chart { margin-top: 24rpx; }
.stage { display: flex; align-items: center; margin-top: 16rpx; }
.stage-t { font-size: 25rpx; color: var(--accent); margin-left: 14rpx;
  letter-spacing: -0.01em; }
.stage-n { font-size: 22rpx; color: var(--ink-3); margin-left: auto;
  font-variant-numeric: tabular-nums; }
</style>
