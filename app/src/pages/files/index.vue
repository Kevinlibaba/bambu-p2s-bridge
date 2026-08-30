<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app'
import { api, isConfigured, type RemoteFile, type ThreeMfInfo } from '../../api/client'
import { themeClass, applyChrome } from '../../store/prefs'
import Sheet from '../../components/Sheet.vue'

const { t } = useI18n()
const path = ref('/')
const files = ref<RemoteFile[]>([])
const loading = ref(false)
const error = ref('')

const TIMELAPSE = '/timelapse'
const THUMB_DIR = TIMELAPSE + '/thumbnail'

const QUICK = computed(() => [
  { label: t('files.models'), path: '/' },
  { label: t('files.timelapse'), path: TIMELAPSE },
  { label: t('files.recordings'), path: '/ipcam' },
])

type Kind = 'video' | 'model' | 'image' | 'other'

function kindOf(name: string): Kind {
  const n = name.toLowerCase()
  if (/\.(mp4|m4v|mov)$/.test(n)) return 'video'
  if (n.endsWith('.3mf')) return 'model'
  if (/\.(jpg|jpeg|png|webp|gif)$/.test(n)) return 'image'
  return 'other'
}

/** 去掉扩展名，用来把 video_x.mp4 对上 thumbnail/video_x.jpg */
function stem(name: string) {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

function join(dir: string, name: string) {
  return (dir === '/' ? '' : dir) + '/' + name
}

function fmtSize(n: number) {
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

function fmtTime(iso: string | null) {
  return iso?.slice(0, 19).replace('T', ' ') ?? t('files.unknownTime')
}

function fmtDuration(sec: number) {
  const m = Math.max(1, Math.round(sec / 60))
  return m >= 60
    ? t('monitor.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
    : t('monitor.minutes', { m })
}

// ---- 列表 ----

/** 延时摄影的封面：/timelapse/thumbnail 里同名图片。进目录时取一次。 */
const thumbs = ref<Record<string, string>>({})

async function loadThumbs(dir: string) {
  thumbs.value = {}
  if (dir !== TIMELAPSE) return
  try {
    const r = await api.files(THUMB_DIR)
    const found: Record<string, string> = {}
    for (const f of r.files) {
      if (!f.isDirectory && kindOf(f.name) === 'image') found[stem(f.name)] = join(THUMB_DIR, f.name)
    }
    thumbs.value = found
  } catch {
    // 没有 thumbnail 目录就不显示封面，不算错误
  }
}

/**
 * SD 卡被电脑挂载过之后会留下一堆系统垃圾（macOS 的 ._* 与 .fseventsd、
 * Windows 的 System Volume Information），把真正的模型埋掉。这些在打印机上
 * 永远没有意义，直接不显示。
 */
const JUNK_DIRS = new Set([
  'System Volume Information',
  '$RECYCLE.BIN',
  'found.000',
])
function isUserFile(f: RemoteFile): boolean {
  return !f.name.startsWith('.') && !JUNK_DIRS.has(f.name)
}

async function load(p = path.value) {
  if (!isConfigured()) return
  loading.value = true; error.value = ''
  try {
    const r = await api.files(p)
    path.value = r.path
    files.value = r.files.filter(isUserFile).sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name))
    void loadThumbs(r.path)
  } catch (e) {
    error.value = (e as Error).message; files.value = []
  } finally { loading.value = false }
}

function up() {
  if (path.value === '/') return
  const parts = path.value.split('/').filter(Boolean); parts.pop()
  load('/' + parts.join('/'))
}

// ---- 详情 / 预览 ----
const sel = ref<RemoteFile | null>(null)
const model = ref<ThreeMfInfo | null>(null)
const modelLoading = ref(false)
const modelError = ref('')
const plateIdx = ref(0)

const selPath = computed(() => (sel.value ? join(path.value, sel.value.name) : ''))
const selKind = computed<Kind>(() => (sel.value ? kindOf(sel.value.name) : 'other'))
const mediaUrl = computed(() => (selPath.value ? api.mediaUrl(selPath.value) : ''))

const posterUrl = computed(() => {
  if (!sel.value) return ''
  const p = thumbs.value[stem(sel.value.name)]
  return p ? api.mediaUrl(p) : ''
})

const plate = computed(() => model.value?.plates[plateIdx.value] ?? null)
const plateUrl = computed(() =>
  plate.value?.hasThumbnail ? api.plateUrl(selPath.value, plate.value.index) : '')

function open(f: RemoteFile) {
  if (f.isDirectory) { load(join(path.value, f.name)); return }
  sel.value = f
  model.value = null; modelError.value = ''; plateIdx.value = 0
  if (kindOf(f.name) === 'model') void loadModel()
}

function close() {
  sel.value = null
  model.value = null
}

async function loadModel() {
  modelLoading.value = true; modelError.value = ''
  try {
    model.value = await api.model(selPath.value)
  } catch (e) {
    modelError.value = (e as Error).message
  } finally { modelLoading.value = false }
}

function save() {
  const url = api.downloadUrl(selPath.value)
  // #ifdef H5
  window.open(url, '_blank')
  // #endif
  // #ifndef H5
  uni.downloadFile({
    url,
    success: (r) => uni.openDocument({ filePath: r.tempFilePath, fail: () => {} }),
    fail: () => uni.showToast({ title: t('files.previewFailed'), icon: 'none' }),
  })
  // #endif
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
            <text v-if="!f.isDirectory && kindOf(f.name) !== 'other'" class="tag">
              {{ t('files.preview') }}
            </text>
          </view>
        </view>
      </view>

      <text class="note">{{ t('files.note') }}</text>
    </view>

    <!-- 详情与预览 -->
    <Sheet :visible="!!sel" :title="sel?.name" @close="close">
      <!-- 视频：Range 由桥接侧实现，进度条可拖 -->
      <video v-if="selKind === 'video'" class="player" :src="mediaUrl" :poster="posterUrl"
        controls object-fit="contain" />

      <image v-else-if="selKind === 'image'" class="shot" :src="mediaUrl" mode="widthFix" />

      <!-- 3MF：包内渲染图 + slice_info.config -->
      <template v-else-if="selKind === 'model'">
        <view v-if="modelLoading" class="ph"><text class="ph-t">{{ t('common.loading') }}</text></view>
        <view v-else-if="modelError" class="ph"><text class="ph-t err">{{ modelError }}</text></view>
        <template v-else-if="model">
          <view v-if="model.plates.length > 1" class="segs plates">
            <view v-for="(p, i) in model.plates" :key="p.index" class="seg"
              :class="{ on: i === plateIdx }" @click="plateIdx = i">
              <text class="seg-t">{{ t('files.plate', { n: p.index }) }}</text>
            </view>
          </view>

          <image v-if="plateUrl" class="plate" :src="plateUrl" mode="aspectFit" />
          <view v-else class="ph"><text class="ph-t">{{ t('files.noPreview') }}</text></view>

          <view v-if="plate" class="card sheet-card">
            <view v-if="plate.prediction" class="line">
              <text class="k">{{ t('files.printTime') }}</text>
              <text class="v">{{ fmtDuration(plate.prediction) }}</text>
            </view>
            <view v-if="plate.weight" class="hsep" />
            <view v-if="plate.weight" class="line">
              <text class="k">{{ t('files.filamentUsed') }}</text>
              <text class="v">{{ t('files.grams', { v: plate.weight.toFixed(1) }) }}</text>
            </view>
            <view v-if="plate.nozzleDiameters" class="hsep" />
            <view v-if="plate.nozzleDiameters" class="line">
              <text class="k">{{ t('files.nozzleDiameter') }}</text>
              <text class="v">{{ t('files.millimetres', { v: plate.nozzleDiameters }) }}</text>
            </view>
            <view v-if="plate.printerModel" class="hsep" />
            <view v-if="plate.printerModel" class="line">
              <text class="k">{{ t('files.printerModel') }}</text>
              <text class="v">{{ plate.printerModel }}</text>
            </view>
            <view v-if="plate.supportUsed !== null" class="hsep" />
            <view v-if="plate.supportUsed !== null" class="line">
              <text class="k">{{ t('files.support') }}</text>
              <text class="v">{{ plate.supportUsed ? t('common.yes') : t('common.no') }}</text>
            </view>
            <view v-if="plate.objects.length" class="hsep" />
            <view v-if="plate.objects.length" class="line">
              <text class="k">{{ t('files.objects') }}</text>
              <text class="v ell">{{ plate.objects.join(' · ') }}</text>
            </view>
          </view>

          <template v-if="plate && plate.filaments.length">
            <text class="grouphead">{{ t('files.filamentUsed') }}</text>
            <view class="card sheet-card">
              <view v-for="(f, i) in plate.filaments" :key="i">
                <view v-if="i > 0" class="hsep" />
                <view class="line">
                  <view class="fil">
                    <view class="swatch" :style="{ background: f.color || 'transparent' }" />
                    <text class="k">{{ f.type || t('common.none') }}</text>
                  </view>
                  <text class="v">
                    {{ f.usedG != null ? t('files.grams', { v: f.usedG.toFixed(1) }) : t('common.none') }}
                    <text v-if="f.usedM != null"> · {{ t('files.meters', { v: f.usedM.toFixed(1) }) }}</text>
                  </text>
                </view>
              </view>
            </view>
          </template>

          <text class="hint">{{ t('files.modelNote') }}</text>
        </template>
      </template>

      <!-- 通用信息 -->
      <view class="card sheet-card">
        <view class="line">
          <text class="k">{{ t('files.size') }}</text>
          <text class="v">{{ fmtSize(sel?.size ?? 0) }}</text>
        </view>
        <view class="hsep" />
        <view class="line">
          <text class="k">{{ t('files.modified') }}</text>
          <text class="v">{{ fmtTime(sel?.modifiedAt ?? null) }}</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="save">
          <text class="k accent">{{ t('files.download') }}</text>
          <text class="v">›</text>
        </view>
      </view>

      <template #footer>
        <button class="cta" @click="close">{{ t('files.close') }}</button>
      </template>
    </Sheet>
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
.plates { background: var(--surface); margin-bottom: 24rpx; }
.plates .seg.on { background: var(--surface-2); }

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
.tag { font-size: 21rpx; color: var(--accent); margin-left: 20rpx; flex-shrink: 0;
  padding: 4rpx 16rpx; border-radius: 999rpx; background: var(--accent-dim); letter-spacing: -0.01em; }
.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin-top: 32rpx; text-align: center; letter-spacing: -0.01em; }

/* ---- 详情卡片 ---- */
.player { width: 100%; height: 420rpx; border-radius: 24rpx; background: #000000; }
.shot { width: 100%; border-radius: 24rpx; background: var(--surface); }
.plate { width: 100%; height: 460rpx; border-radius: 24rpx; background: var(--surface); }
.ph { padding: 90rpx 0; text-align: center; background: var(--surface); border-radius: 24rpx; }
.ph-t { font-size: 26rpx; color: var(--ink-2); letter-spacing: -0.01em; }

.sheet-card { margin-top: 24rpx; }
.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 36rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.line { display: flex; align-items: center; justify-content: space-between; min-height: 96rpx; }
.tappable:active { opacity: 0.55; }
.k { font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.accent { color: var(--accent); }
.v { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.02em;
  text-align: right; margin-left: 32rpx; min-width: 0; }
.v.ell { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.fil { display: flex; align-items: center; }
.swatch { width: 30rpx; height: 30rpx; border-radius: 10rpx; margin-right: 18rpx; flex-shrink: 0;
  /* 深色耗材在深色底上需要一圈微光才有边界 */
  box-shadow: inset 0 0 0 1rpx rgba(255, 255, 255, 0.18); }

.hint { display: block; font-size: 22rpx; color: var(--ink-3);
  margin: 20rpx 8rpx 0; line-height: 1.6; letter-spacing: -0.01em; }

.cta { width: 100%; font-size: 31rpx; font-weight: 500;
  height: 96rpx; line-height: 96rpx; background: var(--surface); color: var(--accent);
  border: none; border-radius: 999rpx; letter-spacing: -0.02em; padding: 0; }
.cta::after { border: none; }
</style>
