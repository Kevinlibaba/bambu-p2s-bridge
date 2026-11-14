<script setup lang="ts">
/*
 * 打印队列。原来是文件页里的一张弹出卡片，拆成独立页面后从「我的」进来。
 *
 * 队列的执行在桥接侧：打完一件 → 收菜 → 起下一件。这里只负责排队、调顺序、
 * 看状态和停下来之后的人工确认。状态没有推送，页面在前台时 3 秒轮询一次。
 * 往队列里加东西仍在文件详情里做（那里有自检和配料）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onHide, onUnload, onPullDownRefresh } from '@dcloudio/uni-app'
import {
  configured, fetchQueue, dequeue, reorderQueue, startQueue, pauseQueue, resumeQueue, clearQueue,
  queuePhotoUrl, type QueueStatus, type QueueItem,
} from '../../api/client'
import { themeClass, applyChrome } from '../../store/prefs'
import { confirm, toast } from '../../util/dialog'
import Spinner from '../../components/Spinner.vue'

const { t } = useI18n()

const queue = ref<QueueStatus | null>(null)
const err = ref('')
const busy = ref(false)

const items = computed(() => queue.value?.items ?? [])
const waiting = computed(() => items.value.filter((i) => i.status === 'waiting'))
const hasFinished = computed(() =>
  items.value.some((i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped'))
const current = computed<QueueItem | null>(() => items.value.find((i) => i.id === queue.value?.current) ?? null)

/** 顶部状态卡的第二行：在跑就说到哪一步，停着就说还剩几项 */
const statusSub = computed(() => {
  const q = queue.value
  if (!q) return ''
  if (current.value) return `${current.value.name} · ${t('queue.phase.' + q.phase)}`
  return t('queue.waitingCount', { n: waiting.value.length })
})

async function load() {
  try {
    queue.value = await fetchQueue()
    err.value = ''
  } catch (e) {
    err.value = (e as Error).message
  }
}

let timer: ReturnType<typeof setInterval> | null = null
function startPoll() {
  stopPoll()
  timer = setInterval(() => void load(), 3000)
}
function stopPoll() {
  if (timer) { clearInterval(timer); timer = null }
}

/** 每个操作都是「发请求 → 用返回的整份状态替换」。服务端的错误已经是给人看的话 */
async function act(work: () => Promise<QueueStatus>, okMsg?: string) {
  if (busy.value) return
  busy.value = true
  try {
    queue.value = await work()
    err.value = ''
    if (okMsg) toast(okMsg)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    busy.value = false
  }
}

/** 上移/下移：只动 waiting 项之间的相对顺序，把整份新顺序发过去 */
function move(id: string, delta: -1 | 1) {
  const ids = waiting.value.map((i) => i.id)
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  void act(() => reorderQueue(ids))
}

async function remove(it: QueueItem) {
  if (!(await confirm(t('queue.removeTitle'), t('queue.removeDesc', { name: it.name }), true))) return
  void act(() => dequeue(it.id), t('queue.removed'))
}

const isFirst = (id: string) => waiting.value[0]?.id === id
const isLast = (id: string) => waiting.value[waiting.value.length - 1]?.id === id

function openFiles() {
  uni.navigateTo({ url: '/pages/files/index' })
}

onShow(() => {
  applyChrome('queue.title')
  if (!configured.value) return
  void load()
  startPoll()
})
onHide(stopPoll)
onUnload(stopPoll)
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh() })
</script>

<template>
  <view class="root" :class="themeClass">
    <view v-if="!configured" class="empty"><text class="empty-t">{{ t('common.notConfigured') }}</text></view>
    <view v-else-if="!queue && !err" class="busy"><Spinner :size="40" /></view>
    <view v-else-if="!queue" class="card first"><view class="line"><text class="k dim">{{ err }}</text></view></view>

    <template v-else>
      <!-- 状态 -->
      <view class="card first">
        <view class="line">
          <view class="stack">
            <view class="row">
              <view class="dot" :class="queue.state" />
              <text class="k strong">{{ t('queue.state.' + queue.state) }}</text>
            </view>
            <text class="sub">{{ statusSub }}</text>
          </view>
          <text class="v">{{ t('queue.count', { n: items.length }) }}</text>
        </view>
      </view>

      <!--
        停下等人的那张卡。safety 是安全门：收菜之后桥接不敢自己认定床已经空了，
        把照片给人看，人点了「床已清空」才起下一件。
      -->
      <view v-if="queue.pause" class="qpause">
        <text class="qpause-t">{{ t('queue.reason.' + queue.pause.reason) }}</text>
        <text class="qpause-d">{{ t('queue.reasonHint.' + queue.pause.reason) }}</text>
        <text v-if="queue.pause.message" class="qpause-m">{{ queue.pause.message }}</text>
        <image v-if="queue.pause.photo" class="qphoto" :src="queuePhotoUrl(queue.pause.photo)" mode="aspectFill" />
        <button class="cta fill qresume" :disabled="busy" @click="act(resumeQueue)">
          {{ queue.pause.reason === 'safety' ? t('queue.resumeSafety') : t('queue.resume') }}
        </button>
      </view>

      <view class="grouprow">
        <text class="grouphead">{{ t('queue.items') }}</text>
        <text v-if="hasFinished" class="link" @click="act(clearQueue)">{{ t('queue.clear') }}</text>
      </view>
      <view v-if="!items.length" class="card">
        <view class="line stack">
          <text class="k dim">{{ t('queue.empty') }}</text>
          <text class="sub">{{ t('queue.howToAdd') }}</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="openFiles">
          <text class="k accent">{{ t('queue.goFiles') }}</text>
          <text class="v">›</text>
        </view>
      </view>
      <view v-else class="card">
        <view v-for="(it, i) in items" :key="it.id">
          <view v-if="i > 0" class="hsep" />
          <view class="qrow">
            <text class="qno">{{ i + 1 }}</text>
            <view class="qmain">
              <text class="qname">{{ it.name }}</text>
              <view class="qmeta">
                <text class="qpill" :class="it.status">{{ t('queue.status.' + it.status) }}</text>
                <text class="qsub">
                  {{ t('queue.plateN', { n: it.plate }) }}<text v-if="!it.harvestAuto"> · {{ t('queue.manualAfter') }}</text>
                </text>
              </view>
              <text v-if="it.error" class="qsub err">{{ it.error }}</text>
            </view>
            <view v-if="it.status === 'waiting'" class="qacts">
              <text class="qbtn" :class="{ off: isFirst(it.id) }" :aria-label="t('queue.up')" @click="move(it.id, -1)">↑</text>
              <text class="qbtn" :class="{ off: isLast(it.id) }" :aria-label="t('queue.down')" @click="move(it.id, 1)">↓</text>
              <text class="qbtn danger" :aria-label="t('queue.remove')" @click="remove(it)">×</text>
            </view>
          </view>
        </view>
      </view>
      <text class="hint">{{ t('queue.note') }}</text>

      <view class="hwarn"><text class="hwarn-t">{{ t('queue.expTitle') }}</text></view>

      <view class="actions">
        <button v-if="queue.state === 'running'" class="cta" :disabled="busy" @click="act(pauseQueue)">
          {{ t('queue.pauseAction') }}
        </button>
        <button v-else-if="queue.state === 'paused'" class="cta fill" :disabled="busy" @click="act(resumeQueue)">
          {{ t('queue.resume') }}
        </button>
        <button v-else-if="waiting.length" class="cta fill" :disabled="busy" @click="act(startQueue)">
          {{ t('queue.start') }}
        </button>
      </view>
    </template>
  </view>
</template>

<style scoped>
.root { min-height: 100vh; background: var(--bg); padding: 0 32rpx 64rpx; box-sizing: border-box; }
.empty { padding: 200rpx 0; text-align: center; }
.empty-t { font-size: 30rpx; color: var(--ink-2); }
.busy { display: flex; justify-content: center; padding: 80rpx 0; }

.card { background: var(--surface); border-radius: 22rpx; padding: 0 28rpx; }
.first { margin-top: 24rpx; }
.hsep { height: 1rpx; background: var(--separator); }
.line { display: flex; align-items: center; justify-content: space-between; min-height: 96rpx; }
.line.stack { display: block; padding: 26rpx 0; }
.stack { min-width: 0; padding: 22rpx 0; }
.row { display: flex; align-items: center; }
.k { font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.strong { font-weight: 600; }
.k.dim { color: var(--ink-3); }
.k.accent { color: var(--accent); }
.v { font-size: 27rpx; color: var(--ink-2); letter-spacing: -0.02em; flex-shrink: 0; margin-left: 24rpx; }
.sub { display: block; font-size: 23rpx; color: var(--ink-2); margin-top: 6rpx; letter-spacing: -0.01em; }
.tappable:active { opacity: 0.55; }
.link { font-size: 25rpx; color: var(--accent); letter-spacing: -0.01em; }
.link:active { opacity: 0.55; }

.dot { width: 16rpx; height: 16rpx; border-radius: 50%; margin-right: 14rpx; background: var(--ink-3); }
.dot.running { background: var(--good); }
.dot.paused { background: var(--warning); }

.grouprow { display: flex; align-items: baseline; justify-content: space-between; margin: 40rpx 8rpx 16rpx; }
.grouphead { font-size: 24rpx; color: var(--ink-2); letter-spacing: 0.01em; }

.qrow { display: flex; align-items: center; padding: 22rpx 0; }
.qno { width: 40rpx; flex-shrink: 0; font-size: 24rpx; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.qmain { flex: 1; min-width: 0; }
.qname { display: block; font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.qmeta { display: flex; align-items: center; margin-top: 8rpx; min-width: 0; }
.qsub { font-size: 22rpx; color: var(--ink-3); letter-spacing: -0.01em; }
.qsub.err { display: block; margin-top: 6rpx; color: var(--critical); word-break: break-all; }
/* 状态胶囊：accent 在进行、warning 要注意、critical 出错、good 完成 */
.qpill { flex-shrink: 0; font-size: 20rpx; padding: 4rpx 14rpx; border-radius: 999rpx;
  margin-right: 12rpx; letter-spacing: -0.01em; color: var(--ink-2); background: var(--surface-2); }
.qpill.printing { color: var(--accent); background: var(--accent-dim); }
.qpill.harvesting { color: var(--warning); background: var(--warning-bg); }
.qpill.done { color: var(--good); }
.qpill.failed { color: var(--critical); }
.qpill.skipped { color: var(--ink-3); }
.qacts { display: flex; align-items: center; margin-left: 12rpx; flex-shrink: 0; }
.qbtn { width: 60rpx; height: 60rpx; line-height: 60rpx; text-align: center; border-radius: 14rpx;
  background: var(--surface-2); color: var(--ink); font-size: 30rpx; margin-left: 10rpx; }
.qbtn:active { opacity: 0.55; }
.qbtn.off { color: var(--ink-3); opacity: 0.45; pointer-events: none; }
.qbtn.danger { color: var(--critical); }

.qpause { margin-top: 24rpx; padding: 30rpx 34rpx; border-radius: 22rpx; background: var(--warning-bg); }
.qpause-t { display: block; font-size: 30rpx; font-weight: 600; color: var(--warning); letter-spacing: -0.02em; line-height: 1.35; }
.qpause-d { display: block; font-size: 25rpx; color: var(--ink); margin-top: 10rpx; line-height: 1.5; letter-spacing: -0.01em; }
.qpause-m { display: block; font-size: 23rpx; color: var(--ink-2); margin-top: 8rpx; line-height: 1.5; word-break: break-all; }
.qphoto { display: block; width: 100%; height: 360rpx; border-radius: 18rpx; margin-top: 20rpx; background: var(--surface); }
.qresume { margin-top: 24rpx; }

.hint { display: block; font-size: 22rpx; color: var(--ink-3); margin: 20rpx 8rpx 0; line-height: 1.6; letter-spacing: -0.01em; }
.hwarn { margin-top: 28rpx; padding: 24rpx 28rpx; border-radius: 20rpx; background: var(--warning-bg); }
.hwarn-t { display: block; font-size: 24rpx; color: var(--warning); line-height: 1.5; letter-spacing: -0.01em; }

.actions { margin-top: 32rpx; }
.cta { width: 100%; font-size: 31rpx; font-weight: 500; height: 96rpx; line-height: 96rpx;
  background: var(--surface); color: var(--accent); border: none; border-radius: 999rpx; letter-spacing: -0.02em; padding: 0; }
.cta::after { border: none; }
.cta.fill { background: var(--accent); color: #fff; }
.cta[disabled] { opacity: 0.4; }
</style>
