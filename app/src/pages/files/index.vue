<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app'
import { api, isConfigured, type RemoteFile } from '../../api/client'
import { themeClass, applyChrome } from '../../store/prefs'

const { t } = useI18n()
const path = ref('/')
const files = ref<RemoteFile[]>([])
const loading = ref(false)
const error = ref('')

const QUICK = computed(() => [
  { label: t('files.models'), path: '/' },
  { label: t('files.timelapse'), path: '/timelapse' },
  { label: t('files.recordings'), path: '/ipcam' },
])

function fmtSize(n: number) {
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

async function load(p = path.value) {
  if (!isConfigured()) return
  loading.value = true; error.value = ''
  try {
    const r = await api.files(p)
    path.value = r.path
    files.value = r.files.sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name))
  } catch (e) {
    error.value = (e as Error).message; files.value = []
  } finally { loading.value = false }
}

function open(f: RemoteFile) {
  if (f.isDirectory) load((path.value === '/' ? '' : path.value) + '/' + f.name)
  else uni.showModal({
    title: f.name, showCancel: false, confirmColor: '#2997ff',
    content: `${fmtSize(f.size)}\n${f.modifiedAt?.slice(0, 19).replace('T', ' ') ?? t('files.unknownTime')}`,
  })
}

function up() {
  if (path.value === '/') return
  const parts = path.value.split('/').filter(Boolean); parts.pop()
  load('/' + parts.join('/'))
}

onShow(() => { applyChrome('tab.files'); load() })
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh() })
</script>

<template>
  <view class="root" :class="themeClass">
    <view v-if="!isConfigured()" class="empty"><text class="empty-s">{{ t('common.notConfigured') }}</text></view>

    <view v-else class="body">
      <view class="segs">
        <view v-for="q in QUICK" :key="q.path" class="seg" :class="{ on: path === q.path }"
          @click="load(q.path)"><text class="seg-t">{{ q.label }}</text></view>
      </view>

      <view class="crumb">
        <text v-if="path !== '/'" class="up" @click="up">‹ {{ t('files.up') }}</text>
        <text class="path">{{ path }}</text>
      </view>

      <view v-if="loading" class="empty"><text class="empty-s">{{ t('common.loading') }}</text></view>
      <view v-else-if="error" class="empty"><text class="empty-s err">{{ error }}</text></view>
      <view v-else-if="!files.length" class="empty"><text class="empty-s">{{ t('files.emptyDir') }}</text></view>

      <view v-else class="card">
        <view v-for="(f, i) in files" :key="f.name">
          <view v-if="i > 0" class="hsep" />
          <view class="row" @click="open(f)">
            <view class="ic" :class="{ dir: f.isDirectory }">
              <text class="ic-t">{{ f.isDirectory ? '›' : '·' }}</text>
            </view>
            <view class="meta">
              <text class="name">{{ f.name }}</text>
              <text class="sub">
                {{ f.isDirectory ? t('files.dir') : fmtSize(f.size) }}
                <text v-if="f.modifiedAt"> · {{ f.modifiedAt.slice(0, 10) }}</text>
              </text>
            </view>
          </view>
        </view>
      </view>

      <text class="note">{{ t('files.note') }}</text>
    </view>
  </view>
</template>

<style scoped>
.root { background: var(--bg); min-height: 100vh; }
.body { padding: 36rpx 36rpx 140rpx; }
.empty { padding: 140rpx 60rpx; text-align: center; }
.empty-s { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.01em; }
.err { color: var(--critical); }

.segs { display: flex; background: var(--surface); border-radius: 24rpx; padding: 8rpx; }
.seg { flex: 1; padding: 20rpx 0; text-align: center; border-radius: 18rpx;
  transition: background 0.25s ease; }
.seg.on { background: var(--surface-2); }
.seg-t { font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em; }
.seg.on .seg-t { font-weight: 600; }

.crumb { display: flex; align-items: center; margin: 32rpx 8rpx 16rpx; }
.up { font-size: 26rpx; color: var(--accent); margin-right: 20rpx; letter-spacing: -0.01em; }
.path { font-size: 24rpx; color: var(--ink-3); flex: 1; letter-spacing: -0.01em; }

.card { background: var(--surface); border-radius: 28rpx; padding: 0 34rpx; }
.hsep { height: 1rpx; background: var(--separator); }
.row { display: flex; align-items: center; padding: 26rpx 0; }
.row:active { opacity: 0.55; }
.ic { width: 40rpx; height: 40rpx; border-radius: 12rpx; background: var(--surface-2);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.ic.dir { background: var(--accent-dim); }
.ic-t { font-size: 26rpx; color: var(--ink-2); line-height: 1; }
.ic.dir .ic-t { color: var(--accent); }
.meta { margin-left: 24rpx; flex: 1; min-width: 0; }
.name { display: block; font-size: 29rpx; color: var(--ink);
  letter-spacing: -0.02em; word-break: break-all; line-height: 1.35; }
.sub { display: block; font-size: 23rpx; color: var(--ink-2); margin-top: 6rpx; letter-spacing: -0.01em; }
.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin-top: 32rpx; text-align: center; letter-spacing: -0.01em; }
</style>
