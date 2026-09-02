<script setup lang="ts">
/*
 * 打印历史。
 *
 * 局域网模式下打印机不给任何历史，这一页的数据全部来自桥接自己记的账。
 * 统计只呈现能确证的部分：耗材克重取自切片文件，查不到的单不计入，
 * 并在下面注明「N 单未计入」—— 宁可说不全，也不给一个凑出来的数。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app'
import {
  fetchHistory, fetchJobTemps, fetchJobEvents, configured, api,
  type HistoryPayload, type JobRecord, type TempSample, type LoggedEvent,
} from '../../api/client'
import { themeClass, applyChrome } from '../../store/prefs'
import Spinner from '../../components/Spinner.vue'
import Sheet from '../../components/Sheet.vue'
import TempChart from '../../components/TempChart.vue'

const { t } = useI18n()
const data = ref<HistoryPayload | null>(null)
const loading = ref(false)
const err = ref('')

/*
 * 回看某一单的温度曲线。
 *
 * 曲线是按天落盘的，只有这个功能上线之后跑的单才有 —— 更早的单会拿到
 * available: false。那是「没记录」，不是「加载失败」，两者要分开说，
 * 否则用户会以为是坏了。
 */
const sel = ref<JobRecord | null>(null)
const temps = ref<TempSample[]>([])
const tempsState = ref<'loading' | 'ok' | 'none' | 'error'>('loading')

const events = ref<LoggedEvent[]>([])

/** 源 3mf 还在打印机上时才有缩略图；文件被删了就没有，这很常见 */
function thumb(j: JobRecord): string {
  return j.file3mf && j.plate !== null ? api.plateUrl(j.file3mf, j.plate) : ''
}
const selThumb = computed(() => (sel.value ? thumb(sel.value) : ''))
const videoUrl = computed(() =>
  sel.value?.video ? api.mediaUrl(`/timelapse/${sel.value.video}`) : '')

const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 桥接只给事件类型，文案在这里出 —— 界面语言不该由桥接决定 */
const eventLabel = (e: LoggedEvent) =>
  t(`event.${e.kind}`, e.kind) + (e.code ? ` · ${e.code}` : '')

async function openJob(j: JobRecord) {
  sel.value = j
  temps.value = []
  events.value = []
  tempsState.value = 'loading'
  // 曲线和事件各自加载，一个失败不该拖累另一个
  void fetchJobEvents(j.id).then((r) => { events.value = r.events }).catch(() => {})
  try {
    const r = await fetchJobTemps(j.id)
    temps.value = r.samples
    tempsState.value = r.available ? 'ok' : 'none'
  } catch {
    tempsState.value = 'error'
  }
}

async function load() {
  if (!configured.value) return
  loading.value = true
  err.value = ''
  try {
    data.value = await fetchHistory(200)
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onShow(() => { applyChrome('history.title'); void load() })
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh() })

const month = computed(() => data.value?.stats.month ?? null)
const jobs = computed(() => data.value?.jobs ?? [])

/** 分钟 → 「2 小时 59 分」，不足一小时只给分钟 */
function fmtMin(m: number): string {
  if (m < 60) return t('history.minutes', { n: m })
  return t('history.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 成功率。没有任何一单时不显示，避免出现 0% 这种误导 */
const rate = computed(() => {
  const m = month.value
  if (!m || m.count === 0) return null
  return Math.round((m.finished / m.count) * 100)
})

function sub(j: JobRecord): string {
  // partial 的单没观测到开始，耗时是不可知的 —— 不能显示成「0 分钟」
  const bits = [fmtDate(j.endedAt), j.partial ? t('history.unknownTime') : fmtMin(j.minutes)]
  if (j.plate !== null) bits.push(t('history.plate', { n: j.plate }))
  if (j.weightG !== null) bits.push(t('history.grams', { v: j.weightG.toFixed(1) }))
  if (j.result === 'failed' && j.progress > 0) bits.push(t('history.stoppedAt', { p: j.progress }))
  return bits.join(' · ')
}
</script>

<template>
  <view class="root" :class="themeClass">
    <view v-if="!configured" class="empty">
      <text class="empty-t">{{ t('monitor.emptyTitle') }}</text>
    </view>

    <template v-else>
      <!-- 本月概览：三个数字撑起整页，细节留给下面的列表 -->
      <view v-if="month" class="tiles">
        <view class="tile">
          <text class="tile-n">{{ month.count }}</text>
          <text class="tile-l">{{ t('history.jobs') }}</text>
        </view>
        <view class="tile">
          <text class="tile-n">{{ Math.round(month.minutes / 60) }}</text>
          <text class="tile-l">{{ t('history.hours') }}</text>
        </view>
        <view class="tile">
          <text class="tile-n">{{ month.grams }}</text>
          <text class="tile-l">{{ t('history.gramsUnit') }}</text>
        </view>
      </view>
      <text v-if="month" class="cap">
        {{ t('history.monthCap', { ok: month.finished, bad: month.failed }) }}
        <text v-if="rate !== null"> · {{ t('history.rate', { p: rate }) }}</text>
      </text>
      <text v-if="month && month.count > month.weighed" class="cap dim">
        {{ t('history.unweighed', { n: month.count - month.weighed }) }}
      </text>

      <view v-if="data?.running" class="card run">
        <view class="line">
          <text class="k">{{ t('history.running') }}</text>
          <text class="v accent">{{ data.running.name || '—' }}</text>
        </view>
      </view>

      <text class="grouphead">{{ t('history.recent') }}</text>
      <view v-if="loading && !jobs.length" class="busy"><Spinner :size="40" /></view>
      <view v-else-if="err" class="card"><view class="line"><text class="k">{{ err }}</text></view></view>
      <view v-else-if="!jobs.length" class="card">
        <view class="line"><text class="k dim">{{ t('history.none') }}</text></view>
      </view>
      <view v-else class="card">
        <view v-for="(j, i) in jobs" :key="j.id + i">
          <view v-if="i > 0" class="hsep" />
          <view class="line tappable jrow" @click="openJob(j)">
            <image v-if="thumb(j)" class="jthumb" :src="thumb(j)" mode="aspectFit" />
            <view v-else class="jthumb ph" />
            <view class="jmeta">
              <view class="row">
                <text class="dot" :class="j.result" />
                <text class="name">{{ j.name || t('history.unnamed') }}</text>
              </view>
              <text class="sub">{{ sub(j) }}</text>
            </view>
          </view>
        </view>
      </view>
    </template>

    <Sheet :visible="!!sel" :title="sel?.name || t('history.unnamed')" @close="sel = null">
      <text class="cap">{{ sel ? sub(sel) : '' }}</text>

      <image v-if="selThumb" class="shot" :src="selThumb" mode="aspectFit" />

      <view v-if="tempsState === 'loading'" class="busy"><Spinner :size="40" /></view>
      <view v-else-if="tempsState === 'ok'" class="chart">
        <TempChart id="histchart" :samples="temps" />
      </view>
      <view v-else class="card sheet-card">
        <view class="line">
          <text class="k dim">
            {{ tempsState === 'none' ? t('history.noCurve') : t('history.curveFailed') }}
          </text>
        </view>
      </view>

      <!-- 事件时间轴。和上面的曲线共用一段时间，对着看才能定位问题 -->
      <text class="grouphead">{{ t('history.timeline') }}</text>
      <view class="card sheet-card">
        <view v-if="!events.length" class="line">
          <text class="k dim">{{ t('history.noEvents') }}</text>
        </view>
        <view v-for="(e, i) in events" :key="e.t + e.kind">
          <view v-if="i > 0" class="hsep" />
          <view class="line">
            <text class="k">{{ eventLabel(e) }}</text>
            <text class="v">{{ hhmm(e.t) }}</text>
          </view>
        </view>
      </view>

      <!-- 延时录像。打印机不给关联信息，是按结束时间撞出来的 -->
      <template v-if="videoUrl">
        <text class="grouphead">{{ t('history.timelapse') }}</text>
        <video class="player" :src="videoUrl" controls object-fit="contain" />
      </template>
    </Sheet>
  </view>
</template>

<style scoped>
.root { min-height: 100vh; background: var(--bg); padding: 0 32rpx 48rpx; box-sizing: border-box; }
.empty { padding: 200rpx 0; text-align: center; }
.empty-t { font-size: 30rpx; color: var(--ink-2); }

.tiles { display: flex; gap: 20rpx; margin-top: 24rpx; }
.tile { flex: 1; background: var(--surface); border-radius: 22rpx; padding: 32rpx 20rpx;
  text-align: center; }
.tile-n { display: block; font-size: 56rpx; font-weight: 600; color: var(--ink);
  letter-spacing: -0.04em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.tile-l { display: block; font-size: 22rpx; color: var(--ink-3); margin-top: 8rpx;
  letter-spacing: -0.01em; }

.cap { display: block; font-size: 23rpx; color: var(--ink-2); margin: 18rpx 8rpx 0;
  line-height: 1.5; letter-spacing: -0.01em; }
.cap.dim { color: var(--ink-3); margin-top: 8rpx; }

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 40rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.card { background: var(--surface); border-radius: 22rpx; padding: 0 28rpx; }
.card.run { margin-top: 24rpx; }
.hsep { height: 1rpx; background: var(--separator); }
.line { display: flex; align-items: center; justify-content: space-between; min-height: 96rpx; }
.line.stack { display: block; padding: 24rpx 0; }
.k { font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.dim { color: var(--ink-3); }
.tappable:active { opacity: 0.55; }
.sheet-card { margin-top: 24rpx; }
.chart { margin-top: 24rpx; }
.jrow { align-items: center; }
.jthumb { width: 88rpx; height: 88rpx; margin-right: 24rpx; border-radius: 12rpx;
  background: var(--fill); flex-shrink: 0; }
.jthumb.ph { opacity: 0.45; }
.jmeta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.shot { width: 100%; height: 320rpx; margin-top: 24rpx; border-radius: 16rpx;
  background: var(--fill); }
.player { width: 100%; height: 420rpx; margin-top: 24rpx; border-radius: 16rpx;
  background: #000; }
.v { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.02em; }
.v.accent { color: var(--accent); }

.row { display: flex; align-items: center; }
.dot { width: 14rpx; height: 14rpx; border-radius: 50%; margin-right: 16rpx; flex-shrink: 0; }
.dot.finished { background: var(--good); }
.dot.failed { background: var(--critical); }
.name { flex: 1; font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.sub { display: block; font-size: 22rpx; color: var(--ink-3); margin: 8rpx 0 0 30rpx;
  letter-spacing: -0.01em; }

.busy { display: flex; justify-content: center; padding: 80rpx 0; }
</style>
