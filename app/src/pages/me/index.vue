<script setup lang="ts">
/*
 * 「我的」：照 iOS「设置」的样子 —— 顶上一张身份卡（这里是打印机），下面是
 * 分组的圆角列表，每行一个彩色小图标。真正的设置项（连接、外观、通知、体检）
 * 都收进最下面的「设置」二级页，这一页只做入口和一眼可见的状态。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow } from '@dcloudio/uni-app'
import { configured, fetchQueue, mwAccount, type QueueStatus, type MwAccount } from '../../api/client'
import { printer } from '../../store/printer'
import { themeClass, applyChrome } from '../../store/prefs'
import TileIcon from '../../components/TileIcon.vue'

const { t } = useI18n()

const KNOWN_STATES = ['IDLE', 'RUNNING', 'PAUSE', 'FINISH', 'FAILED', 'PREPARE', 'SLICING']
const s = computed(() => printer.summary)

const online = computed(() => !!s.value?.online)
const busyPrinting = computed(() => ['RUNNING', 'PAUSE', 'PREPARE'].includes(s.value?.state ?? ''))
/** 身份卡第二行：在打就给进度和文件名，否则给状态 */
const printerLine = computed(() => {
  if (!configured.value) return t('me.notConfigured')
  if (!s.value) return t('common.none')
  if (!online.value) return t('common.offline')
  const st = s.value.state
  const label = t(`state.${KNOWN_STATES.includes(st) ? st : 'UNKNOWN'}`)
  if (busyPrinting.value) return `${label} · ${s.value.progress}%${s.value.taskName ? ' · ' + s.value.taskName : ''}`
  return label
})

// 队列和 MW 账号只在这一页出现时拉一次，拿不到就不显示右侧状态
const queue = ref<QueueStatus | null>(null)
const mw = ref<MwAccount | null>(null)
const mwKnown = ref(false)

const queueValue = computed(() => {
  const q = queue.value
  if (!q || !q.items.length) return ''
  return q.state === 'idle' ? t('queue.count', { n: q.items.length }) : t('queue.state.' + q.state)
})
const queueAttention = computed(() => queue.value?.state === 'paused')

onShow(async () => {
  applyChrome('tab.me')
  if (!configured.value) return
  const [q, a] = await Promise.allSettled([fetchQueue(), mwAccount()])
  queue.value = q.status === 'fulfilled' ? q.value : null
  mw.value = a.status === 'fulfilled' ? a.value.account : null
  mwKnown.value = a.status === 'fulfilled'
})

const go = (url: string) => uni.navigateTo({ url })
const tab = (url: string) => uni.switchTab({ url })
</script>

<template>
  <view class="root" :class="themeClass">
    <!-- 身份卡：这台打印机 -->
    <view class="card hero tappable" @click="configured ? tab('/pages/monitor/index') : go('/pages/settings/index')">
      <TileIcon name="printer" color="linear-gradient(160deg, #3a3a3c, #1c1c1e)" :size="108" />
      <view class="hero-m">
        <text class="hero-t">Bambu Lab P2S</text>
        <view class="hero-s">
          <view class="dot" :class="{ on: online, busy: busyPrinting }" />
          <text class="hero-st">{{ printerLine }}</text>
        </view>
      </view>
      <text class="chev">›</text>
    </view>

    <!-- 打印 -->
    <view class="card group">
      <view class="row tappable" @click="go('/pages/queue/index')">
        <TileIcon name="queue" color="#FF9500" />
        <view class="row-m">
          <text class="row-t">{{ t('queue.title') }}</text>
          <view class="row-r">
            <text v-if="queueValue" class="row-v" :class="{ warn: queueAttention }">{{ queueValue }}</text>
            <text class="chev">›</text>
          </view>
        </view>
      </view>
      <view class="row tappable" @click="go('/pages/history/index')">
        <TileIcon name="history" color="#5856D6" />
        <view class="row-m">
          <text class="row-t">{{ t('history.title') }}</text>
          <view class="row-r"><text class="chev">›</text></view>
        </view>
      </view>
      <view class="row tappable" @click="go('/pages/files/index')">
        <TileIcon name="folder" color="#0A84FF" />
        <view class="row-m last">
          <text class="row-t">{{ t('me.files') }}</text>
          <view class="row-r"><text class="chev">›</text></view>
        </view>
      </view>
    </view>

    <!-- 账号 -->
    <view class="card group">
      <view class="row tappable" @click="tab('/pages/makerworld/index')">
        <TileIcon name="cube" color="#34C759" />
        <view class="row-m last">
          <text class="row-t">MakerWorld</text>
          <view class="row-r">
            <text v-if="mwKnown" class="row-v">{{ mw ? (mw.name || mw.account) : t('me.mwSignedOut') }}</text>
            <text class="chev">›</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 设置 -->
    <view class="card group">
      <view class="row tappable" @click="go('/pages/settings/index')">
        <TileIcon name="sliders" color="#8E8E93" />
        <view class="row-m last">
          <text class="row-t">{{ t('me.settings') }}</text>
          <view class="row-r">
            <text v-if="!configured" class="row-v warn">{{ t('me.notConfigured') }}</text>
            <text class="chev">›</text>
          </view>
        </view>
      </view>
    </view>

    <text class="foot">{{ t('settings.footer') }}</text>
  </view>
</template>

<style scoped>
.root { min-height: 100vh; background: var(--bg); padding: 28rpx 32rpx 140rpx; box-sizing: border-box; }
.card { background: var(--surface); border-radius: 24rpx; overflow: hidden; }
.tappable:active { background: var(--surface-2); }

/* 身份卡 */
.hero { display: flex; align-items: center; padding: 28rpx; }
.hero-m { flex: 1; min-width: 0; margin-left: 26rpx; }
.hero-t { display: block; font-size: 36rpx; font-weight: 600; color: var(--ink); letter-spacing: -0.03em; }
.hero-s { display: flex; align-items: center; margin-top: 8rpx; min-width: 0; }
.hero-st { font-size: 25rpx; color: var(--ink-2); letter-spacing: -0.01em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dot { width: 14rpx; height: 14rpx; border-radius: 50%; margin-right: 12rpx; flex-shrink: 0; background: var(--ink-3); }
.dot.on { background: var(--good); }
.dot.on.busy { background: var(--accent); }

/* 分组列表：分隔线从文字处起，不穿过图标 —— iOS 的 inset 分隔 */
.group { margin-top: 40rpx; }
.row { display: flex; align-items: center; padding-left: 28rpx; }
.row-m { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between;
  min-height: 100rpx; margin-left: 24rpx; padding-right: 28rpx; border-bottom: 1rpx solid var(--separator); }
.row-m.last { border-bottom: none; }
.row-t { font-size: 30rpx; color: var(--ink); letter-spacing: -0.02em; }
.row-r { display: flex; align-items: center; flex-shrink: 0; margin-left: 20rpx; max-width: 60%; }
.row-v { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.02em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row-v.warn { color: var(--warning); }
.chev { font-size: 34rpx; color: var(--ink-3); margin-left: 12rpx; line-height: 1; }
.hero .chev { margin-left: 16rpx; }

.foot { display: block; text-align: center; font-size: 22rpx; color: var(--ink-3);
  margin-top: 56rpx; line-height: 1.6; white-space: pre-line; letter-spacing: -0.01em; }
</style>
