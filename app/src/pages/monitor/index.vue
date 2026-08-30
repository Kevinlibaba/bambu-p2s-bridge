<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { onShow, onHide, onPullDownRefresh } from '@dcloudio/uni-app'
import { api, isConfigured, type Command } from '../../api/client'
import { printer, restart } from '../../store/printer'
import StatTile from '../../components/StatTile.vue'
import Meter from '../../components/Meter.vue'
import AmsSlot from '../../components/AmsSlot.vue'

const STATE_LABEL: Record<string, string> = {
  IDLE: '空闲', RUNNING: '打印中', PAUSE: '已暂停',
  FINISH: '已完成', FAILED: '失败', PREPARE: '准备中', SLICING: '切片中',
}

const s = computed(() => printer.summary)
const stateText = computed(() => STATE_LABEL[s.value?.state ?? ''] ?? s.value?.state ?? '未知')
const running = computed(() => s.value?.state === 'RUNNING')
const paused = computed(() => s.value?.state === 'PAUSE')
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
  if (!m) return running.value ? '计算中' : '—'
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`
})

const heating = (cur: number, target: number) => target > 0 && Math.abs(cur - target) > 3
const lightOn = computed(
  () => s.value?.lights?.find((l) => l.node === 'chamber_light')?.mode === 'on',
)

// ---- 摄像头 ----
const camOn = ref(true)
const camUrl = ref('')
const camIntervalMs = ref(3000)
let camTimer: ReturnType<typeof setInterval> | null = null

function refreshCam() {
  if (!isConfigured()) return
  camUrl.value = api.snapshotUrl() + '&t=' + Date.now()
}
function startCam() {
  if (camTimer || !camOn.value) return
  refreshCam()
  camTimer = setInterval(refreshCam, camIntervalMs.value)
}
function stopCam() {
  if (camTimer) { clearInterval(camTimer); camTimer = null }
}
function toggleCam() {
  camOn.value = !camOn.value
  camOn.value ? startCam() : stopCam()
}
function cycleRate() {
  camIntervalMs.value =
    camIntervalMs.value === 3000 ? 1000 : camIntervalMs.value === 1000 ? 10000 : 3000
  stopCam(); startCam()
}
const rateLabel = computed(() =>
  camIntervalMs.value === 1000 ? '流畅' : camIntervalMs.value === 3000 ? '标准' : '省流',
)

onShow(() => startCam())
onHide(() => stopCam())
onUnmounted(() => stopCam())
onPullDownRefresh(() => {
  restart(); refreshCam()
  setTimeout(() => uni.stopPullDownRefresh(), 600)
})

async function send(c: Command, confirmText?: string) {
  if (confirmText) {
    const ok = await new Promise<boolean>((resolve) =>
      uni.showModal({
        title: '确认操作', content: confirmText, confirmColor: '#2997ff',
        success: (r) => resolve(!!r.confirm), fail: () => resolve(false),
      }),
    )
    if (!ok) return
  }
  try {
    await api.command(c)
    uni.showToast({ title: '已发送', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: (e as Error).message, icon: 'none', duration: 2500 })
  }
}
</script>

<template>
  <view class="root">
    <!-- 未配置 -->
    <view v-if="!isConfigured()" class="empty">
      <text class="empty-t">还没连上。</text>
      <text class="empty-s">在设置里填入服务器地址与 Token，即可开始。</text>
      <button class="cta" @click="uni.switchTab({ url: '/pages/settings/index' })">前往设置</button>
    </view>

    <template v-else>
      <!-- 摄像头：全出血，控件浮在画面上 -->
      <view class="cam">
        <image v-if="camOn && camUrl" class="cam-img" :src="camUrl" mode="widthFix" />
        <view v-else class="cam-off"><text class="cam-off-t">画面已暂停</text></view>
        <view class="scrim" />
        <view class="cam-ctl">
          <view class="glass" @click="toggleCam">
            <text class="glass-t">{{ camOn ? '暂停' : '播放' }}</text>
          </view>
          <view class="glass" @click="cycleRate">
            <text class="glass-t">{{ rateLabel }}</text>
          </view>
        </view>
      </view>

      <view class="body">
        <!-- 报错：图标 + 文案，颜色只是佐证 -->
        <view v-if="hasError" class="alert">
          <view class="alert-i"><text class="alert-g">!</text></view>
          <view class="alert-b">
            <text class="alert-t">打印机报错</text>
            <text class="alert-s">HMS {{ s?.errors?.length || 0 }} 项 · 错误码 {{ s?.printError }}</text>
          </view>
        </view>

        <!-- 主体：整屏唯一的 hero -->
        <view class="hero">
          <view class="statusline">
            <view class="dot" :class="'d-' + stateTone" />
            <text class="status-t">{{ stateText }}</text>
            <text class="status-s">{{ printer.link === 'live' ? '实时' : printer.link === 'polling' ? '轮询' : '连接中' }}</text>
          </view>

          <view class="figure">
            <text class="num">{{ s?.progress ?? 0 }}</text>
            <text class="pct">%</text>
          </view>

          <Meter :pct="s?.progress ?? 0" :tone="meterTone" />

          <text class="task">{{ s?.taskName || '暂无任务' }}</text>
          <view class="facts">
            <text class="fact">第 {{ s?.layer ?? 0 }} / {{ s?.totalLayers ?? 0 }} 层</text>
            <text class="sep">·</text>
            <text class="fact">剩余 {{ eta }}</text>
          </view>
        </view>

        <!-- 温度 -->
        <view class="card temps">
          <StatTile
            label="喷嘴" :value="String(Math.round(s?.nozzle.cur ?? 0))" unit="℃"
            :sub="heating(s?.nozzle.cur ?? 0, s?.nozzle.target ?? 0) ? `升温至 ${Math.round(s?.nozzle.target ?? 0)}℃` : `目标 ${Math.round(s?.nozzle.target ?? 0)}℃`"
            :tone="heating(s?.nozzle.cur ?? 0, s?.nozzle.target ?? 0) ? 'warning' : 'neutral'" />
          <view class="vsep" />
          <StatTile
            label="热床" :value="String(Math.round(s?.bed.cur ?? 0))" unit="℃"
            :sub="heating(s?.bed.cur ?? 0, s?.bed.target ?? 0) ? `升温至 ${Math.round(s?.bed.target ?? 0)}℃` : `目标 ${Math.round(s?.bed.target ?? 0)}℃`"
            :tone="heating(s?.bed.cur ?? 0, s?.bed.target ?? 0) ? 'warning' : 'neutral'" />
          <view class="vsep" />
          <StatTile
            label="腔温" :value="s?.chamber != null ? String(Math.round(s.chamber)) : '—'" unit="℃"
            :sub="`速度 ${s?.speedPct ?? 100}%`" />
        </view>

        <!-- 操作 -->
        <view class="acts">
          <button v-if="!paused" class="pill" :disabled="!running"
            @click="send({ type: 'pause' }, '确定暂停当前打印？')">暂停</button>
          <button v-else class="pill fill" @click="send({ type: 'resume' })">继续</button>
          <button class="pill warn" :disabled="!running && !paused"
            @click="send({ type: 'stop' }, '停止后无法恢复。确定停止打印？')">停止</button>
          <button class="pill" @click="send({ type: 'light', on: !lightOn })">
            {{ lightOn ? '关灯' : '开灯' }}
          </button>
        </view>

        <!-- 耗材 -->
        <text class="grouphead">耗材</text>
        <view class="card list">
          <view v-for="(t, i) in s?.ams ?? []" :key="`${t.unit}-${t.slot}`">
            <view v-if="i > 0" class="hsep" />
            <AmsSlot :tray="t" />
          </view>
        </view>

        <text class="foot">{{ s?.wifi }} · 更新于 {{ printer.lastAt ? new Date(printer.lastAt).toLocaleTimeString() : '—' }}</text>
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
.cam-off { height: 420rpx; display: flex; align-items: center; justify-content: center; }
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

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 52rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.list { padding: 0 34rpx; }
.hsep { height: 1rpx; background: var(--separator); }

.foot { display: block; text-align: center; font-size: 22rpx;
  color: var(--ink-3); margin-top: 52rpx; letter-spacing: -0.01em; }
</style>
