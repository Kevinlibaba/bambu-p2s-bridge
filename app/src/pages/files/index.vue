<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onHide, onPullDownRefresh } from '@dcloudio/uni-app'
import {
  api, configured, uploadFile, importUrl, deleteFile, startPrint, fetchPrintPlan,
  startSlice, fetchSliceJob, fetchSliceOptions,
  fetchSchedule, setSchedule, cancelSchedule, type ScheduleStatus,
  fetchQueue, enqueue, dequeue, reorderQueue, startQueue, pauseQueue, resumeQueue, clearQueue,
  queuePhotoUrl, type QueueStatus, type QueueItem,
  planHarvestFile, makeHarvestFile,
  type RemoteFile, type ThreeMfInfo, type PrintPlan, type PlanTray, type PreflightCheck,
  type SliceJob, type SliceOptions, type SliceParams,
} from '../../api/client'
import { themeClass, applyChrome } from '../../store/prefs'
import { takePendingOpen, type PendingOpen } from '../../store/reprint'
import { confirm, toast } from '../../util/dialog'
import Sheet from '../../components/Sheet.vue'
import ZoomOverlay from '../../components/ZoomOverlay.vue'
import Meter from '../../components/Meter.vue'
import Spinner from '../../components/Spinner.vue'
import FileIcon from '../../components/FileIcon.vue'

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
const JUNK_DIRS = new Set(['system volume information', '$recycle.bin', 'recycler'])
/** chkdsk 生成的碎片目录是 FOUND.000、FOUND.001…… 编号递增 */
const JUNK_PATTERN = /^found\.\d{3}$/
function isUserFile(f: RemoteFile): boolean {
  const name = f.name.toLowerCase()
  return !f.name.startsWith('.') && !JUNK_DIRS.has(name) && !JUNK_PATTERN.test(name)
}

/** 上次打印时间。今天/昨天说人话，再往前给日期 —— 精确到分钟没有意义 */
function fmtDay(ts: number): string {
  const d = new Date(ts)
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const days = Math.floor((midnight.getTime() - d.getTime()) / 86400000) + 1
  if (days <= 0) return t('files.today')
  if (days === 1) return t('files.yesterday')
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 添加时间。这台机器的 FTP 对不少文件不返回时间（modifiedAt 为 null，界面上是「时间未知」），
 * 给它们 -Infinity 排到有时间的之后，再由调用方按名字兜底，保证两次刷新顺序一样。
 */
function addedAt(f: RemoteFile): number {
  if (!f.modifiedAt) return Number.NEGATIVE_INFINITY
  const ts = Date.parse(f.modifiedAt)
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts
}

/** 置顶项：打印时间最大的那一个文件。一个都没打过就没有置顶项；打印时间打平了按名字取定 */
function mostRecentlyPrinted(list: RemoteFile[]): RemoteFile | null {
  let top: RemoteFile | null = null
  let topAt = -Infinity
  for (const f of list) {
    const at = f.lastPrintedAt
    if (f.isDirectory || typeof at !== 'number') continue
    if (at > topAt || (at === topAt && top !== null && f.name.localeCompare(top.name) < 0)) {
      top = f; topAt = at
    }
  }
  return top
}

async function load(p = path.value) {
  if (!configured.value) return
  loading.value = true; error.value = ''
  try {
    const r = await api.files(p)
    path.value = r.path
    /*
     * 排序：目录在前；文件里只把「最近打印的那一个」置顶 —— 想再打一遍的基本就是刚打完那个，
     * 而把所有打印过的都排在前面，会让几个老文件长期霸占列表顶部，新传上来的反而找不到。
     * 剩下的按添加时间（modifiedAt）倒序，新的在前。
     */
    const list = r.files.filter(isUserFile)
    const top = mostRecentlyPrinted(list)
    files.value = list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      if (a === top) return -1
      if (b === top) return 1
      const ma = addedAt(a)
      const mb = addedAt(b)
      if (ma !== mb) return mb - ma
      return a.name.localeCompare(b.name)
    })
    void loadThumbs(r.path)
  } catch (e) {
    error.value = (e as Error).message; files.value = []
  } finally { loading.value = false }
}

// ---- 搜索 ----
/*
 * 只按名字过滤当前目录。卡上几十个文件、名字又长又像，翻着找不如打两个字。
 * 不跨目录搜 —— 列表是按目录一次次取的，跨目录得把整张卡扫一遍。
 */
const query = ref('')
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? files.value.filter((f) => f.name.toLowerCase().includes(q)) : files.value
})
// 换了目录，上一个目录的关键词多半不再适用；同目录刷新时 path 不变，不会清
watch(path, () => { query.value = '' })

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

/*
 * 放大看录像。
 *
 * 不用系统全屏 —— 那是原生播放器，捏合只在「适应↔填充」两档之间切换，
 * 既放不大也不能平移。这里另起一个覆盖层，把播放进度接力过去，
 * 免得放大后又要从头找。
 */
const zoomOpen = ref(false)
function currentOf(id: string): number {
  const el = document.getElementById(id) as HTMLVideoElement | null
  // uni-app 的 video 在 H5 下是包一层的，真正的媒体元素在里面
  const v = el?.tagName === 'VIDEO' ? el : (el?.querySelector('video') ?? null)
  return v?.currentTime ?? 0
}
function seek(id: string, to: number) {
  const el = document.getElementById(id) as HTMLElement | null
  const v = el?.tagName === 'VIDEO' ? (el as HTMLVideoElement) : (el?.querySelector('video') ?? null)
  if (v && to > 0) v.currentTime = to
}
async function openZoom() {
  const at = currentOf('fileplayer')
  zoomOpen.value = true
  await nextTick()
  setTimeout(() => seek('zoomplayer', at), 120)
}
function closeZoom() {
  const at = currentOf('zoomplayer')
  zoomOpen.value = false
  setTimeout(() => seek('fileplayer', at), 120)
}

const posterUrl = computed(() => {
  if (!sel.value) return ''
  const p = thumbs.value[stem(sel.value.name)]
  return p ? api.mediaUrl(p) : ''
})

const plate = computed(() => model.value?.plates[plateIdx.value] ?? null)

/*
 * 元数据回来之前就先按当前盘号把图要过去。
 *
 * 之前要等 /api/files/3mf 回来、看到 hasThumbnail 才发图片请求，图片的加载被
 * 整个串在元数据后面 —— 实测白等 260-400ms，而图片本身几十毫秒就到。
 * 猜错（这个盘没有图）就是一次 404，@error 把它藏起来退回占位。
 */
const imgFailed = ref(false)
/*
 * 猜的那一次失败（比如打印机正忙回了 503），元数据随后说这盘确实有图 ——
 * 那就再要一次。URL 要变一下，否则浏览器不会重新去取同一个失败过的地址。
 */
const imgRetry = ref(0)
const plateUrl = computed(() => {
  if (selKind.value !== 'model' || !selPath.value) return ''
  if (!model.value) return imgFailed.value ? '' : api.plateUrl(selPath.value, plateIdx.value + 1)
  if (!plate.value?.hasThumbnail) return ''
  const u = api.plateUrl(selPath.value, plate.value.index)
  return imgRetry.value ? `${u}&r=${imgRetry.value}` : u
})
watch(model, (m) => {
  // 「再打一次」预选的盘号来自旧记录，文件被重切成更少的盘时会越界，退回第 1 盘
  if (m && plateIdx.value >= m.plates.length) plateIdx.value = 0
  if (m && imgFailed.value && plate.value?.hasThumbnail) {
    imgFailed.value = false
    imgRetry.value += 1
  }
})

// ---- 盘的切换 ----
const plateCount = computed(() => model.value?.plates.length ?? 0)
const canPrev = computed(() => plateIdx.value > 0)
const canNext = computed(() => plateIdx.value < plateCount.value - 1)
function goPlate(delta: number) {
  const next = plateIdx.value + delta
  if (next >= 0 && next < plateCount.value) { plateIdx.value = next; imgFailed.value = false }
}

/*
 * 预览图上左右滑动切盘。
 * 弹窗内容本身是竖向滚动的，所以只有当横向位移明显压过竖向时才认作翻页 ——
 * 否则想上下滚的时候会误触发。手指抬起时才判定，滑动过程中不抢滚动。
 */
const SWIPE_MIN = 40
let swipeX = 0
let swipeY = 0
let swiping = false

function onPlateTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  if (!t) return
  swipeX = t.clientX
  swipeY = t.clientY
  swiping = true
}

function onPlateTouchEnd(e: TouchEvent) {
  if (!swiping) return
  swiping = false
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - swipeX
  const dy = t.clientY - swipeY
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return
  goPlate(dx < 0 ? 1 : -1)
}

// ---- 配料 ----
/*
 * ams_mapping 的下标是「切片项目里的耗材序号 - 1」，长度必须等于项目耗材数。
 * 这套匹配逻辑放在桥接里，前端只负责展示预演结果和记录用户的覆盖，
 * 避免同一份规则在两端各写一遍。
 */
const plan = ref<PrintPlan | null>(null)
const planLoading = ref(false)
/** 用户手动指定的「耗材序号 → 料盘全局序号」，没指定的交给桥接自动配 */
const slotOverride = ref<Record<string, number>>({})
/** 当前展开选择器的那一号耗材 */
const openFil = ref<number | null>(null)

async function loadPlan() {
  plan.value = null
  slotOverride.value = {}
  openFil.value = null
  if (!selPath.value) return
  /*
   * 没有盘也要问一次 —— 未切片的原始模型正是这种情况，
   * 自检里的 notSliced 得让它有机会回来，否则界面上什么都不说，
   * 用户只会看到一个空荡荡的预览。
   */
  planLoading.value = true
  try {
    plan.value = await fetchPrintPlan(selPath.value, plateNo.value)
  } catch {
    plan.value = null // 预演失败不该挡住看文件，开打时桥接还会再校验一次
  } finally {
    planLoading.value = false
  }
}

/*
 * 实际会用的盘号。model 还没加载出来时 plate 是空的，而请求里本来就按第 1 盘发 ——
 * 直接 watch `plate.value?.index` 的话，它从 undefined 变成 1 会再触发一次，
 * 两次请求的参数其实一模一样。实测因此白花 600ms，而这 600ms 正好压在
 * 弹层刚打开、用户在看的时候。
 */
const plateNo = computed(() => plate.value?.index ?? 1)

watch([selPath, plateNo], () => void loadPlan())

const usableTrays = computed(() => (plan.value?.trays ?? []).filter((t) => !t.empty))

/** 某一号耗材最终会用的料盘序号：用户指定优先，否则用预演结果 */
function slotOf(id: number | null): number {
  if (id === null) return -1
  const ov = slotOverride.value[String(id)]
  if (ov !== undefined) return ov
  return plan.value?.filaments.find((f) => f.id === id)?.slot ?? -1
}

function trayOf(id: number | null): PlanTray | null {
  const s = slotOf(id)
  return usableTrays.value.find((t) => t.slot === s) ?? null
}

function trayLabel(tr: PlanTray): string {
  // 外置料盘不属于任何 AMS，没有槽位号
  if (tr.unit < 0) return t('files.externalSlot', { name: tr.subBrand || tr.type })
  return t('files.slotName', { n: tr.index + 1, name: tr.subBrand || tr.type })
}

function slotText(id: number | null): string {
  const tr = trayOf(id)
  return tr ? trayLabel(tr) : t('files.noSlot')
}

function assign(id: number | null, tr: PlanTray) {
  if (id === null) return
  slotOverride.value = { ...slotOverride.value, [String(id)]: tr.slot }
  openFil.value = null
}

/** 每一号耗材都得有料盘，缺一个就不让开打 */
const planReady = computed(() => {
  const f = plan.value?.filaments ?? []
  return f.length > 0 && f.every((x) => slotOf(x.id) >= 0)
})

// ---- 打印前自检 ----
/*
 * 桥接只回结论码与参数，文案在这里本地化 —— 服务端不该假定用户用哪种语言。
 * slotMissing 由上面的料盘选择器实时反映，这里过滤掉免得重复说一遍。
 */
const checks = computed<PreflightCheck[]>(
  () => (plan.value?.checks ?? []).filter((c) => c.code !== 'slotMissing'),
)
const blockingChecks = computed(() => checks.value.filter((c) => c.level === 'error'))

function checkText(c: PreflightCheck): string {
  const p = c.params ?? {}
  // 切片器的告警标识来自 BambuStudio，能认出来的给中文，认不出的原样显示
  if (c.code === 'sliceWarning') {
    const known = `files.slice.${p.msg}`
    const s = t(known)
    return s === known ? String(p.msg) : s
  }
  const slotName = p.slot === 0 ? t('files.externalShort') : t('files.slotShort', { n: p.slot })
  return t(`files.check.${c.code}`, { ...p, slot: slotName } as Record<string, unknown>)
}

/**
 * 光看名字像不像未切片的原始模型。
 *
 * 权威判断是桥接给的自检结果（notSliced），但那要等一次往返。而「要不要提前
 * 去取切片参数」这个决定等不起 —— 等自检回来再去取，参数卡会在弹层打开约
 * 一秒后才蹦出来，内容往下跳一大截。名字这个判据在实际文件上是准的，
 * 猜错的代价也只是多一次（或少一次提前的）请求，卡片显不显示仍由自检说了算。
 */
function looksUnsliced(name: string): boolean {
  const n = name.toLowerCase()
  return n.endsWith('.3mf') && !n.endsWith('.gcode.3mf')
}

function open(f: RemoteFile) {
  if (f.isDirectory) { load(join(path.value, f.name)); return }
  sel.value = f
  model.value = null; modelError.value = ''; plateIdx.value = 0
  imgFailed.value = false; imgRetry.value = 0
  sliceOpts.value = null; optsState.value = 'idle'; optsFor = ''
  if (kindOf(f.name) !== 'model') return
  void loadModel()
  // 跟模型信息、自检并行去取，别排在它们后面
  if (looksUnsliced(f.name)) void loadSliceOpts()
}

function close() {
  sel.value = null
  model.value = null
  sliceOpts.value = null
  sliceParams.value = {}
  optsState.value = 'idle'
  optsFor = ''
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
    fail: () => toast(t('files.previewFailed')),
  })
  // #endif
}

const busy = ref('')


// ---- 导入 ----
/**
 * 全部走应用自己的卡片，不用 uni.showActionSheet / showModal ——
 * 系统控件是浅灰居中样式，和这里的纯黑分组列表完全不是一套语言。
 */
type ImportStep = '' | 'choose' | 'link' | 'progress'
const importStep = ref<ImportStep>('')
const canImport = computed(() => path.value === '/')
const linkText = ref('')
const progressName = ref('')
const progressPct = ref(0)
const progressLabel = ref('')

const importTitle = computed(() =>
  importStep.value === 'link'
    ? t('import.linkTitle')
    : importStep.value === 'progress'
      ? t('import.progressTitle')
      : t('import.sheetTitle'),
)

function closeImport() {
  importStep.value = ''
  linkText.value = ''
}

/** 上传/下载期间把卡片切到进度态，完成后自动收起 */
async function runImport(name: string, work: () => Promise<{ name: string }>) {
  progressName.value = name
  progressPct.value = 0
  progressLabel.value = t('import.fetching')
  importStep.value = 'progress'
  try {
    const res = await work()
    toast(t('import.done', { name: res.name }))
    closeImport()
    await load('/')
  } catch (e) {
    toast((e as Error).message)
    closeImport()
  }
}

function pickFile() {
  uni.chooseFile({
    count: 1,
    extension: ['.3mf'],
    success: (r) => {
      const path = (r.tempFilePaths as string[])[0]
      const raw = (r.tempFiles as { name?: string }[])[0]
      const name = raw?.name ?? path.split('/').pop() ?? 'model.gcode.3mf'
      if (!name.toLowerCase().endsWith('.3mf')) return toast(t('import.onlyThreeMf'))
      void runImport(name, () =>
        uploadFile({ path, name, raw }, (pct: number) => {
          progressPct.value = pct
          // 传完之后服务端还要把文件当 3MF 重新解析一遍，别让标签停在"上传中 100%"
          progressLabel.value =
            pct >= 100 ? t('import.verifying') : t('import.uploading', { pct })
        }),
      )
    },
    fail: () => {},
  })
}

function doImportLink() {
  const link = linkText.value.trim()
  if (!link) return
  let guess = ''
  try {
    guess = decodeURIComponent(new URL(link).pathname.split('/').pop() ?? '')
  } catch {
    guess = ''
  }
  if (!guess.toLowerCase().endsWith('.3mf')) guess = 'imported.gcode.3mf'
  void runImport(guess, () => importUrl(link, guess))
}

// ---- 删除 ----
async function removeSelected() {
  const f = sel.value
  if (!f) return
  if (!(await confirm(t('del.title'), t('del.desc', { name: f.name }), true))) return
  try {
    await deleteFile(selPath.value)
    toast(t('del.done'))
    close()
    await load()
  } catch (e) {
    toast((e as Error).message)
  }
}

// ---- 开始打印 ----
/** 二次确认里必须写清后果：远程开打意味着首层无人看管 */
/** 把最终的选择整理成 { 耗材序号: 料盘序号 }，全部显式发出去，不留给默认值 */
function chosenSlots(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of plan.value?.filaments ?? []) {
    const s = slotOf(x.id)
    if (x.id !== null && s >= 0) out[String(x.id)] = s
  }
  return out
}

async function printSelected() {
  const f = sel.value
  if (!f) return
  const notSliced = checks.value.find((c) => c.code === 'notSliced')
  if (notSliced) { toast(checkText(notSliced)); return }
  if (!planReady.value) { toast(t('files.pickSlotFirst')); return }
  // 自检有阻断项时，把问题原样摆出来再问一次，答应了才带 force 下发
  const stop = blockingChecks.value
  const unsliced = stop.find((c) => c.code === 'notSliced')
  if (unsliced) {
    // 这条没有「仍然打印」可言，机器认不了未切片的文件
    toast(checkText(unsliced))
    return
  }
  if (stop.length) {
    const list = stop.map((c) => `· ${checkText(c)}`).join('\n')
    if (!(await confirm(t('files.checkTitle'), `${list}\n\n${t('files.checkForce')}`, true))) return
  } else if (!(await confirm(t('print.title'), t('print.desc', { name: f.name, plate: plateNo.value }), true))) {
    return
  }

  try {
    await startPrint({
      path: selPath.value, plate: plateNo.value, slots: chosenSlots(),
      force: stop.length > 0,
    })
    toast(t('print.started'))
    close()
  } catch (e) {
    toast((e as Error).message)
  }
}

// ---- 云切片 ----
/*
 * 未切片的 3mf 打不了，但可以就地切。这里的入口只在「确实是未切片的模型」时出现 ——
 * 自检里的 notSliced 是最可靠的判据，它由桥接给出。
 */
const sliceJob = ref<SliceJob | null>(null)
const slicing = computed(
  () => !!sliceJob.value && !['done', 'failed'].includes(sliceJob.value.phase),
)
/*
 * 能不能切，优先信 /api/slice/options —— 它读中央目录时顺手就知道了，而且跟
 * 模型信息并行发出。退到自检结果是为了兜住文件名骗人的情况（比如叫
 * `x.gcode.3mf` 其实没切过），那条路要等 /api/print/plan，实测慢 550ms。
 */
const canSlice = computed(() => {
  if (selKind.value !== 'model') return false
  switch (optsState.value) {
    case 'ok': return sliceOpts.value?.sliceable ?? false
    case 'loading': return false
    case 'unavailable': return false
    default: return checks.value.some((c) => c.code === 'notSliced')
  }
})
/** 是未切片的模型、但这台桥接没装切片器 —— 提示回到电脑上切 */
const sliceUnavailable = computed(
  () => optsState.value === 'unavailable' && checks.value.some((c) => c.code === 'notSliced'),
)
/*
 * 进度只在「正看着的就是这个文件」时显示。任务是按文件路径记的，
 * 换选一个文件还看到上一个的进度会很误导。
 */
const sliceHere = computed(() => !!sliceJob.value && sliceJob.value.source === selPath.value)

/*
 * 切片参数：默认全部沿用模型作者的设置，用户想改哪项改哪项。
 *
 * 不做成「选一套预设」是有原因的 —— 预设是整套的，换过去会连支撑一起换掉
 * （标准工艺里 enable_support=0）。想要「层薄一点」的人不该因此丢掉作者
 * 开的支撑。逐项覆盖没有这个副作用：没动的项，桥接一个字都不会写。
 */
const sliceOpts = ref<SliceOptions | null>(null)
const sliceParams = ref<SliceParams>({})

/** 作者原本的设置。用来标出「这项被改过」，以及一键恢复 */
const authorParams = computed<SliceParams>(() => sliceOpts.value?.current ?? {})

const paramsDirty = computed(() => {
  const a = authorParams.value
  const p = sliceParams.value
  return (Object.keys(p) as (keyof SliceParams)[]).some((k) => p[k] !== a[k])
})

/** 某一项是否被改过 —— 界面上给它一个标记，免得改完自己都忘了动过什么 */
function changed(k: keyof SliceParams): boolean {
  return sliceParams.value[k] !== authorParams.value[k]
}

function resetParams() {
  sliceParams.value = { ...authorParams.value }
}

/** 只留跟作者默认值不同的项 */
function changedParams(): SliceParams {
  const out: SliceParams = {}
  for (const k of Object.keys(sliceParams.value) as (keyof SliceParams)[]) {
    if (changed(k)) (out[k] as unknown) = sliceParams.value[k]
  }
  return out
}

/*
 * 直接取反，不读事件对象 —— uni-app 包装过的事件在类型上拿不到 detail，
 * 而且 checked 已经绑在这个值上了，事件里那个值跟取反的结果一样。
 */
function toggleParam(k: 'supports' | 'brim') {
  sliceParams.value = { ...sliceParams.value, [k]: !sliceParams.value[k] }
}

/*
 * 切片参数请求的状态。
 *   loading     在途，此时不信自检的判断 —— 两边对「切没切过」的定义不同，
 *               谁先回来就先按谁显示会让按钮在「切片」「打印」之间跳
 *   ok          拿到了，sliceOpts 里的 sliceable 是权威
 *   unavailable 桥接机上没装切片器（503），入口一律不出现
 *   error       别的失败（网络等），退回自检的判断
 */
const optsState = ref<'idle' | 'loading' | 'ok' | 'unavailable' | 'error'>('idle')
/** 在途请求属于哪个文件。响应回来时不是当前文件就整个丢掉 */
let optsFor = ''

async function loadSliceOpts() {
  const path = selPath.value
  if (!path || optsFor === path) return
  optsFor = path
  sliceOpts.value = null
  optsState.value = 'loading'
  try {
    const opts = await fetchSliceOptions(path)
    /*
     * 用户可能已经关掉、点开了别的文件。晚到的响应套到新文件上，
     * 会把 A 的作者参数当成 B 的默认值 —— 一次调参就把 A 的壁数/填充写进 B。
     */
    if (selPath.value !== path) return
    sliceOpts.value = opts
    optsState.value = 'ok'
    resetParams()
  } catch (e) {
    if (selPath.value !== path) return
    optsState.value = (e as { status?: number }).status === 503 ? 'unavailable' : 'error'
  } finally {
    if (optsFor === path) optsFor = ''
  }
}

const LAYER_STEP = 0.02
function stepLayer(d: number) {
  const r = sliceOpts.value?.layerRange
  const cur = sliceParams.value.layerHeight ?? authorParams.value.layerHeight ?? 0.2
  // 浮点加减会攒出 0.13999999999，两位小数够用也够准
  let v = Math.round((cur + d * LAYER_STEP) * 100) / 100
  if (r) v = Math.min(r.max, Math.max(r.min, v))
  sliceParams.value = { ...sliceParams.value, layerHeight: v }
}

function stepInfill(d: number) {
  const cur = sliceParams.value.infillDensity ?? authorParams.value.infillDensity ?? 15
  sliceParams.value = {
    ...sliceParams.value,
    infillDensity: Math.min(100, Math.max(0, cur + d * 5)),
  }
}

function stepWalls(d: number) {
  const cur = sliceParams.value.wallLoops ?? authorParams.value.wallLoops ?? 2
  sliceParams.value = { ...sliceParams.value, wallLoops: Math.min(10, Math.max(1, cur + d)) }
}

const layerAtMin = computed(() => {
  const r = sliceOpts.value?.layerRange
  return !!r && (sliceParams.value.layerHeight ?? 0) <= r.min
})
const layerAtMax = computed(() => {
  const r = sliceOpts.value?.layerRange
  return !!r && (sliceParams.value.layerHeight ?? 0) >= r.max
})

/** 各阶段的说法。切片那一段最久，其余几秒就过去了 */
const slicePhaseText = computed(() => {
  const p = sliceJob.value?.phase
  if (!p) return ''
  return t(`slice.phase.${p}`)
})

/*
 * 兜底：文件名叫 `x.gcode.3mf` 但其实没切过，open() 里就不会提前去拉参数。
 * 等自检说了实话再补一次 —— 这条路慢，但它本来就是罕见情况。
 */
watch(canSlice, (on) => {
  if (on && optsState.value === 'idle') void loadSliceOpts()
})

let slicePoll = 0
function stopSlicePoll() {
  if (slicePoll) { clearTimeout(slicePoll); slicePoll = 0 }
}

/*
 * 轮询而不是等一个长请求：切片几十秒到几分钟，手机锁屏或切网就断了，
 * 而那边其实还在跑。2 秒一次足够，切片本身以十几秒计。
 */
function pollSlice(id: string) {
  stopSlicePoll()
  slicePoll = setTimeout(async () => {
    try {
      const j = await fetchSliceJob(id)
      sliceJob.value = j
      if (j.phase === 'done') {
        toast(t('slice.done'))
        await load()
        // 切完直接打开产物 —— 接下来要做的就是打它，不该让人回列表里找
        const outName = j.output ? j.output.slice(j.output.lastIndexOf('/') + 1) : ''
        const out = files.value.find((f) => f.name === outName)
        if (out) open(out)
        else close()
        return
      }
      if (j.phase === 'failed') { toast(j.error || t('slice.failed')); return }
      pollSlice(id)
    } catch {
      // 单次查询失败不该让整件事断掉 —— 网络抖一下很常见，继续问
      pollSlice(id)
    }
  }, 2000) as unknown as number
}

async function sliceSelected() {
  const f = sel.value
  if (!f || slicing.value) return
  const desc = paramsDirty.value
    ? t('slice.descChanged', { name: f.name })
    : t('slice.desc', { name: f.name })
  if (!(await confirm(t('slice.title'), desc, true))) return
  try {
    const j = await startSlice({
      path: selPath.value,
      plate: plate.value?.index ?? 1,
      // 只发用户真正动过的项。全量发的话，万一文件在这期间被同名重传，
      // 桥接会把「旧默认值 vs 新文件」的所有差异都当成用户改动写进去
      params: paramsDirty.value ? changedParams() : undefined,
    })
    sliceJob.value = j
    pollSlice(j.id)
  } catch (e) {
    toast((e as Error).message)
  }
}

// ---- 定时打印 ----
/*
 * 只有一个预约，不做队列。到点时桥接走的是和手动开打完全相同的路径
 * （同样的自检、同样的配料、不带 force），自检拦下了就推一条并作废。
 */
const schedule = ref<ScheduleStatus | null>(null)
const schedOpen = ref(false)
const schedDay = ref<0 | 1>(0)
const schedTime = ref('07:00')

const schedAt = computed(() => {
  const [h, m] = schedTime.value.split(':').map(Number)
  const d = new Date()
  d.setDate(d.getDate() + schedDay.value)
  d.setHours(h || 0, m || 0, 0, 0)
  return d.getTime()
})
const schedTooSoon = computed(() => schedAt.value - Date.now() < 60_000)

async function loadSchedule() {
  try { schedule.value = await fetchSchedule() } catch { /* 旧桥接没有这个接口 */ }
}

function fmtAt(ms: number): string {
  const d = new Date(ms)
  const day = d.toDateString() === new Date().toDateString() ? t('schedule.today') : t('schedule.tomorrow')
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function openSchedule() {
  if (!planReady.value) { toast(t('files.pickSlotFirst')); return }
  const stop = blockingChecks.value
  // 定时不允许带 force：半夜没人守着，自检不过就不该开
  if (stop.length) { toast(checkText(stop[0])); return }
  // 默认「下一个早上 7 点」：现在还没到 7 点就是今天，否则明天
  const now = new Date()
  schedDay.value = now.getHours() < 7 ? 0 : 1
  schedTime.value = '07:00'
  schedOpen.value = true
}

function onSchedTime(e: { detail: { value: string } }) {
  schedTime.value = e.detail.value
}

async function confirmSchedule() {
  const f = sel.value
  if (!f || schedTooSoon.value) return
  try {
    schedule.value = await setSchedule(
      schedAt.value,
      { path: selPath.value, plate: plateNo.value, slots: chosenSlots() },
      f.name,
    )
    schedOpen.value = false
    toast(t('schedule.set', { time: fmtAt(schedAt.value) }))
    close()
  } catch (e) {
    toast((e as Error).message)
  }
}

async function cancelSched() {
  const p = schedule.value?.pending
  if (!p) return
  if (!(await confirm(t('schedule.cancelTitle'), t('schedule.cancelDesc', { name: p.name }), true))) return
  try {
    schedule.value = await cancelSchedule()
    toast(t('schedule.cancelled'))
  } catch (e) {
    toast((e as Error).message)
  }
}

// ---- 打印队列 ----
/*
 * 队列的执行在桥接侧：打完一件 → 收菜 → 起下一件。界面只负责排队和看状态。
 * 状态没有推送，Sheet 开着时 3 秒轮询一次；关掉就停，别让后台白跑。
 */
const queue = ref<QueueStatus | null>(null)
const queueErr = ref('')
const queueOpen = ref(false)
const queueBusy = ref(false)

const queueItems = computed(() => queue.value?.items ?? [])
const queueWaiting = computed(() => queueItems.value.filter((i) => i.status === 'waiting'))
const queueHasFinished = computed(() =>
  queueItems.value.some((i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped'))
const queueCurrent = computed<QueueItem | null>(() =>
  queueItems.value.find((i) => i.id === queue.value?.current) ?? null)

async function loadQueue() {
  try {
    queue.value = await fetchQueue()
    queueErr.value = ''
  } catch (e) {
    // 旧桥接没有这个接口：横幅不出现，Sheet 里给一句原因
    queueErr.value = (e as Error).message
  }
}

let queueTimer: ReturnType<typeof setInterval> | null = null
function startQueuePoll() {
  stopQueuePoll()
  queueTimer = setInterval(() => void loadQueue(), 3000)
}
function stopQueuePoll() {
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null }
}
watch(queueOpen, (on) => {
  if (on) { void loadQueue(); startQueuePoll() } else stopQueuePoll()
})

/** 横幅第二行：暂停就说为什么停，在跑就说到哪一步了 */
const queueBannerSub = computed(() => {
  const q = queue.value
  if (!q) return ''
  if (q.pause) return t('queue.reason.' + q.pause.reason)
  const cur = queueCurrent.value
  if (cur) return `${cur.name} · ${t('queue.phase.' + q.phase)}`
  return t('queue.waitingCount', { n: queueWaiting.value.length })
})

/**
 * 队列的每个操作都是「发请求 → 用返回的状态整个替换」。
 * 服务端 4xx 时 error 已经是给人看的话（打印机忙、没有待打项……），原样 toast。
 */
async function queueAction(work: () => Promise<QueueStatus>, okMsg?: string) {
  if (queueBusy.value) return
  queueBusy.value = true
  try {
    queue.value = await work()
    queueErr.value = ''
    if (okMsg) toast(okMsg)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    queueBusy.value = false
  }
}

async function enqueueSelected() {
  const f = sel.value
  if (!f) return
  if (!planReady.value) { toast(t('files.pickSlotFirst')); return }
  const stop = blockingChecks.value
  // 队列项开打时没人在旁边，和定时打印一样不允许带 force 硬闯
  if (stop.length) { toast(checkText(stop[0])); return }
  try {
    queue.value = await enqueue(selPath.value, plateNo.value, chosenSlots())
    queueErr.value = ''
    toast(t('queue.added', { name: f.name }))
    close()
  } catch (e) {
    toast((e as Error).message)
  }
}

/** 上移/下移：只动 waiting 项之间的相对顺序，把整份新顺序发过去 */
function moveQueueItem(id: string, delta: -1 | 1) {
  const ids = queueWaiting.value.map((i) => i.id)
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  void queueAction(() => reorderQueue(ids))
}

async function removeQueueItem(it: QueueItem) {
  if (!(await confirm(t('queue.removeTitle'), t('queue.removeDesc', { name: it.name }), true))) return
  void queueAction(() => dequeue(it.id), t('queue.removed'))
}

function isFirstWaiting(id: string) { return queueWaiting.value[0]?.id === id }
function isLastWaiting(id: string) { return queueWaiting.value[queueWaiting.value.length - 1]?.id === id }

/*
 * 历史页的「再打一次」。只负责带路：进到那个目录、打开详情、预选上次那一盘。
 * 开打仍走 printSelected 的自检和确认 —— 上次能打不等于现在还能打，料可能早换了。
 */
async function openPending(want: PendingOpen) {
  const cut = want.path.lastIndexOf('/')
  const dir = cut > 0 ? want.path.slice(0, cut) : '/'
  const name = want.path.slice(cut + 1)
  await load(dir)
  if (error.value) return // 目录都没拿到，页面上已经在说原因了
  const f = files.value.find((x) => !x.isDirectory && x.name === name)
  if (!f) { toast(t('files.reprintMissing')); return }
  open(f)
  if (want.plate && want.plate > 0) plateIdx.value = want.plate - 1
}

// ---- 生成带收菜的版本 ----
/*
 * 把推件序列写进这一盘的结束 G-code（M18 之前），另存一个文件。打这个文件，
 * 打完自动推 —— 不用像「打完这一件后收菜」那样先 G28，也就没有带着件回零
 * 撞探测点的风险。原文件不动，想不推的时候还打原文件。
 */
const harvestBusy = ref(false)
const canHarvestFile = computed(() =>
  selKind.value === 'model' && !!model.value && !modelError.value && !canSlice.value
  && !!plate.value && !/\.harvest\.gcode\.3mf$/i.test(sel.value?.name ?? ''))

async function makeHarvest() {
  const f = sel.value
  if (!f || harvestBusy.value) return
  harvestBusy.value = true
  try {
    // 先只规划：这一盘能不能推、有什么风险，要在生成之前就看清楚
    const p = await planHarvestFile(selPath.value, plateNo.value)
    if (!p.order.length) { toast(t('harvest.fileNone')); return }
    const outName = p.output.slice(p.output.lastIndexOf('/') + 1)
    let desc = t('harvest.fileDesc', { name: outName })
    if (p.warnings.length) {
      const list = p.warnings.map((w) => `· ${t('harvestWarn.' + w.code, w.params || {})}`).join('\n')
      desc += '\n\n' + t('harvest.fileWarnDesc', { list })
    }
    if (!(await confirm(t('harvest.fileTitle'), desc, p.warnings.some((w) => w.level === 'warn')))) return
    const r = await makeHarvestFile(selPath.value, plateNo.value)
    toast(t('harvest.fileDone'))
    await load()
    const out = files.value.find((x) => x.name === r.output.slice(r.output.lastIndexOf('/') + 1))
    if (out) open(out)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    harvestBusy.value = false
  }
}

onShow(() => {
  applyChrome('tab.files')
  const want = takePendingOpen()
  if (want) void openPending(want)
  else load()
  void loadSchedule()
  void loadQueue()
  // 切走时轮询停了；Sheet 还开着就接着轮
  if (queueOpen.value) startQueuePoll()
})
onHide(stopQueuePoll)
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh() })
</script>

<template>
  <view class="root" :class="themeClass">
    <view v-if="!configured" class="empty"><text class="empty-s">{{ t('common.notConfigured') }}</text></view>

    <view v-else class="body">
      <!-- 有预约就一直挂在最上面：让机器半夜动起来的事，不能藏在设置里 -->
      <view v-if="schedule?.pending" class="card banner">
        <view class="line">
          <view class="stack">
            <text class="k">{{ t('schedule.pending', { time: fmtAt(schedule.pending.at) }) }}</text>
            <text class="sub">{{ schedule.pending.name }}</text>
          </view>
          <text class="v accent tappable" @click="cancelSched">{{ t('schedule.cancel') }}</text>
        </view>
      </view>
      <!-- 队列里有东西就一直挂着：停下等人确认的时候（paused）换成警告色，别让人错过 -->
      <view v-if="queueItems.length" class="card banner" :class="{ warn: queue?.state === 'paused' }">
        <view class="line">
          <view class="stack">
            <text class="k">{{ t('queue.banner', { n: queueItems.length, state: t('queue.state.' + (queue?.state ?? 'idle')) }) }}</text>
            <text class="sub">{{ queueBannerSub }}</text>
          </view>
          <text class="v accent tappable" @click="queueOpen = true">{{ t('queue.view') }} ›</text>
        </view>
      </view>
      <view class="segs">
        <view v-for="q in QUICK" :key="q.path" class="seg" :class="{ on: path === q.path }"
          @click="load(q.path)"><text class="seg-t">{{ q.label }}</text></view>
      </view>

      <view class="search">
        <input class="sinput" v-model="query" type="text" confirm-type="search"
          :placeholder="t('files.search')" placeholder-class="ph" />
        <view v-if="query" class="clear" @click="query = ''"><text class="clear-t">×</text></view>
      </view>

      <view class="crumb">
        <text v-if="path !== '/'" class="up" @click="up">‹ {{ t('files.up') }}</text>
        <text class="path">{{ path }}</text>
        <!-- 导入只能落在模型根目录，所以入口跟着面包屑走，且只在那里出现。
             面包屑行有固定最小高度，按钮出现与否不会让下方列表跳动。 -->
        <view v-if="canImport" class="add-btn" @click="importStep = 'choose'">
          <text class="add-t">+</text>
        </view>
      </view>

      <view v-if="loading" class="empty"><Spinner /></view>
      <view v-else-if="error" class="empty"><text class="empty-s err">{{ error }}</text></view>
      <view v-else-if="!files.length" class="empty"><text class="empty-s">{{ t('files.emptyDir') }}</text></view>
      <view v-else-if="!shown.length" class="empty">
        <text class="empty-s">{{ t('files.noMatch', { q: query.trim() }) }}</text>
      </view>

      <view v-else class="card">
        <view v-for="(f, i) in shown" :key="f.name">
          <view v-if="i > 0" class="hsep" />
          <view class="row" @click="open(f)">
            <FileIcon :kind="f.isDirectory ? 'dir' : kindOf(f.name)" />
            <view class="meta">
              <text class="name">{{ f.name }}</text>
              <text class="sub">
                {{ f.isDirectory ? t('files.dir') : fmtSize(f.size) }}
                <text v-if="f.modifiedAt"> · {{ f.modifiedAt.slice(0, 10) }}</text>
                <!-- 标出上次打印时间，排序才看得懂为什么是这个顺序 -->
                <text v-if="f.lastPrintedAt" class="printed">
                  · {{ t('files.lastPrinted', { d: fmtDay(f.lastPrintedAt) }) }}
                </text>
              </text>
            </view>
            <text v-if="!f.isDirectory && kindOf(f.name) !== 'other'" class="tag">
              {{ t('files.preview') }}
            </text>
          </view>
        </view>
      </view>

      <!-- 加载时只留转圈，说明文字一并收起，免得那一瞬满屏都是字 -->
      <template v-if="!loading">
        <text class="note">{{ t('files.note') }}</text>
        <text v-if="path === '/'" class="note">{{ t('import.note') }}</text>
      </template>
    </view>

    <!-- 详情与预览 -->
    <ZoomOverlay :visible="zoomOpen" @close="closeZoom">
      <video v-if="zoomOpen" id="zoomplayer" class="zplayer" :src="mediaUrl"
        controls autoplay object-fit="contain" />
    </ZoomOverlay>

    <Sheet :visible="!!sel" :title="sel?.name" @close="close">
      <!-- 视频：Range 由桥接侧实现，进度条可拖 -->
      <video v-if="selKind === 'video'" id="fileplayer" class="player" :src="mediaUrl"
        :poster="posterUrl" controls object-fit="contain" />
      <view v-if="selKind === 'video'" class="line tappable" @click="openZoom">
        <text class="k">{{ t('files.zoomView') }}</text>
        <text class="v accent">›</text>
      </view>

      <image v-else-if="selKind === 'image'" class="shot" :src="mediaUrl" mode="widthFix" />

      <!-- 3MF：包内渲染图 + slice_info.config -->
      <template v-else-if="selKind === 'model'">
        <!-- 预览图先挂上，不等元数据；.plate 有固定高度，本身就是占位框 -->
        <view v-if="modelError" class="ph-box"><text class="ph-t err">{{ modelError }}</text></view>
        <view v-else-if="plateUrl" class="plate-wrap"
          @touchstart="onPlateTouchStart" @touchend="onPlateTouchEnd">
          <image class="plate" :src="plateUrl" mode="aspectFit" @error="imgFailed = true" />
          <template v-if="plateCount > 1">
              <view class="nav prev" :class="{ off: !canPrev }"
                :aria-label="t('files.prevPlate')" @click.stop="goPlate(-1)">
                <text class="nav-t">‹</text>
              </view>
              <view class="nav next" :class="{ off: !canNext }"
                :aria-label="t('files.nextPlate')" @click.stop="goPlate(1)">
                <text class="nav-t">›</text>
              </view>
              <view class="pager"><text class="pager-t">{{ plateIdx + 1 }} / {{ plateCount }}</text></view>
          </template>
        </view>
        <view v-else-if="modelLoading" class="ph-box"><Spinner :size="40" /></view>
        <view v-else class="ph-box"><text class="ph-t">{{ t('files.noPreview') }}</text></view>
        <template v-if="model">

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

          <!-- 耗材与料盘：每一号耗材都要落到一个具体料盘，否则打印机拼不出 AMS 映射表 -->
          <template v-if="plate && plate.filaments.length">
            <text class="grouphead">{{ t('files.filamentUsed') }}</text>
            <view class="card sheet-card">
              <view v-for="(f, i) in plate.filaments" :key="i">
                <view v-if="i > 0" class="hsep" />
                <view class="line tappable" @click="openFil = openFil === f.id ? null : f.id">
                  <view class="fil">
                    <view class="swatch" :style="{ background: f.color || 'transparent' }" />
                    <view class="pick-meta">
                      <text class="k">{{ f.type || t('common.none') }}</text>
                      <text class="pick-sub">
                        {{ f.usedG != null ? t('files.grams', { v: f.usedG.toFixed(1) }) : t('common.none') }}
                        <text v-if="f.usedM != null"> · {{ t('files.meters', { v: f.usedM.toFixed(1) }) }}</text>
                      </text>
                    </view>
                  </view>
                  <view class="trail">
                    <text class="v" :class="{ warn: slotOf(f.id) < 0 }">{{ slotText(f.id) }}</text>
                    <text class="caret" :class="{ open: openFil === f.id }">⌄</text>
                  </view>
                </view>
                <template v-if="openFil === f.id">
                  <view v-for="tr in usableTrays" :key="tr.slot" class="mat">
                    <view class="hsep" />
                    <view class="line tappable" @click="assign(f.id, tr)">
                      <view class="fil">
                        <view class="swatch" :style="{ background: '#' + tr.color.slice(0, 6) }" />
                        <text class="k">{{ trayLabel(tr) }}</text>
                      </view>
                      <text v-if="slotOf(f.id) === tr.slot" class="tick">✓</text>
                    </view>
                  </view>
                </template>
              </view>
            </view>
            <text v-if="planLoading" class="note">{{ t('files.planning') }}</text>
            <text v-else-if="!planReady" class="note warn">{{ plan?.error || t('files.pickSlotFirst') }}</text>

          </template>

          <!--
            打印前自检。放在耗材分组之外 —— 未切片的模型没有耗材可列，
            但恰恰是最需要看到「为什么打不了」的情况。
          -->
          <template v-if="checks.length">
            <text class="grouphead">{{ t('files.checkGroup') }}</text>
            <view class="card sheet-card">
              <view v-for="(c, i) in checks" :key="i">
                <view v-if="i > 0" class="hsep" />
                <view class="line stack">
                  <view class="chk">
                    <text class="chk-dot" :class="c.level" />
                    <text class="chk-t">{{ checkText(c) }}</text>
                  </view>
                </view>
              </view>
            </view>
          </template>

          <text class="hint">{{ t('files.modelNote') }}</text>
        </template>
      </template>

      <!--
        切片参数。默认全是模型作者定的值，改哪项覆盖哪项 —— 没动的项桥接
        一个字都不会写，所以支撑、填充这些不会被顺带改掉。
      -->
      <template v-if="canSlice && sliceOpts">
        <view class="grouphead-row">
          <text class="grouphead">{{ t('slice.paramsGroup') }}</text>
          <text v-if="paramsDirty" class="reset" @click="resetParams">{{ t('slice.reset') }}</text>
        </view>
        <view class="card sheet-card">
          <view class="line">
            <text class="k">
              {{ t('slice.layerHeight') }}<text v-if="changed('layerHeight')" class="dot">·</text>
            </text>
            <view class="trail">
              <text class="v num">{{ sliceParams.layerHeight?.toFixed(2) }} mm</text>
              <view class="stepper">
                <text class="sbtn" :class="{ off: layerAtMin }" @click="stepLayer(-1)">−</text>
                <view class="svsep" />
                <text class="sbtn" :class="{ off: layerAtMax }" @click="stepLayer(1)">＋</text>
              </view>
            </view>
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="k">
              {{ t('slice.infill') }}<text v-if="changed('infillDensity')" class="dot">·</text>
            </text>
            <view class="trail">
              <text class="v num">{{ sliceParams.infillDensity }}%</text>
              <view class="stepper">
                <text class="sbtn" :class="{ off: (sliceParams.infillDensity ?? 0) <= 0 }"
                  @click="stepInfill(-1)">−</text>
                <view class="svsep" />
                <text class="sbtn" :class="{ off: (sliceParams.infillDensity ?? 0) >= 100 }"
                  @click="stepInfill(1)">＋</text>
              </view>
            </view>
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="k">
              {{ t('slice.walls') }}<text v-if="changed('wallLoops')" class="dot">·</text>
            </text>
            <view class="trail">
              <text class="v num">{{ sliceParams.wallLoops }}</text>
              <view class="stepper">
                <text class="sbtn" :class="{ off: (sliceParams.wallLoops ?? 0) <= 1 }"
                  @click="stepWalls(-1)">−</text>
                <view class="svsep" />
                <text class="sbtn" :class="{ off: (sliceParams.wallLoops ?? 0) >= 10 }"
                  @click="stepWalls(1)">＋</text>
              </view>
            </view>
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="k">
              {{ t('slice.supports') }}<text v-if="changed('supports')" class="dot">·</text>
            </text>
            <switch class="sw" :checked="!!sliceParams.supports" color="#2997ff"
              @change="toggleParam('supports')" />
          </view>
          <view class="hsep" />
          <view class="line">
            <text class="k">
              {{ t('slice.brim') }}<text v-if="changed('brim')" class="dot">·</text>
            </text>
            <switch class="sw" :checked="!!sliceParams.brim" color="#2997ff"
              @change="toggleParam('brim')" />
          </view>
        </view>
        <text class="hint">{{ paramsDirty ? t('slice.paramsChanged') : t('slice.paramsNote') }}</text>
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
        <template v-if="canSlice">
          <view class="hsep" />
          <view class="line tappable" @click="sliceSelected">
            <text class="k accent">{{ t('slice.action') }}</text>
            <text class="v">{{ sliceHere && slicing ? slicePhaseText : '›' }}</text>
          </view>
        </template>
        <template v-else-if="selKind === 'model' && model && !modelError">
          <view class="hsep" />
          <view class="line tappable" @click="printSelected">
            <text class="k accent">{{ t('print.action') }}</text>
            <text class="v">›</text>
          </view>
          <view class="hsep" />
          <view class="line tappable" @click="openSchedule">
            <text class="k accent">{{ t('schedule.action') }}</text>
            <text class="v">›</text>
          </view>
          <view class="hsep" />
          <view class="line tappable" @click="enqueueSelected">
            <text class="k accent">{{ t('queue.action') }}<text class="beta">β</text></text>
            <text class="v">›</text>
          </view>
          <template v-if="canHarvestFile">
            <view class="hsep" />
            <view class="line tappable" @click="makeHarvest">
              <text class="k accent">{{ t('harvest.fileAction') }}<text class="beta">β</text></text>
              <text class="v">{{ harvestBusy ? '…' : '›' }}</text>
            </view>
          </template>
        </template>
        <view class="hsep" />
        <view class="line tappable" @click="removeSelected">
          <text class="k danger">{{ t('del.action') }}</text>
          <text class="v">›</text>
        </view>
      </view>

      <text v-if="canSlice" class="hint">{{ t('slice.hint') }}</text>
      <text v-else-if="sliceUnavailable" class="hint">{{ t('slice.unavailable') }}</text>
      <text v-else-if="selKind === 'model'" class="hint">{{ t('print.risk') }}</text>

      <template #footer>
        <button class="cta" @click="close">{{ t('files.close') }}</button>
      </template>
    </Sheet>

    <!-- 定时打印：选今天/明天 + 时刻 -->
    <Sheet :visible="schedOpen" :title="t('schedule.title')" @close="schedOpen = false">
      <view class="card sheet-card">
        <view class="line">
          <text class="k">{{ t('schedule.day') }}</text>
          <view class="segs mini">
            <view class="seg" :class="{ on: schedDay === 0 }" @click="schedDay = 0">
              <text class="seg-t">{{ t('schedule.today') }}</text>
            </view>
            <view class="seg" :class="{ on: schedDay === 1 }" @click="schedDay = 1">
              <text class="seg-t">{{ t('schedule.tomorrow') }}</text>
            </view>
          </view>
        </view>
        <view class="hsep" />
        <picker mode="time" :value="schedTime" @change="onSchedTime">
          <view class="line tappable">
            <text class="k">{{ t('schedule.time') }}</text>
            <text class="v num">{{ schedTime }} ›</text>
          </view>
        </picker>
      </view>
      <text class="hint">{{ schedTooSoon ? t('schedule.tooSoon') : t('schedule.note', { time: fmtAt(schedAt), name: sel?.name ?? '' }) }}</text>
      <template #footer>
        <button class="cta fill" :disabled="schedTooSoon" @click="confirmSchedule">{{ t('schedule.confirm') }}</button>
      </template>
    </Sheet>

    <!-- 打印队列：排队、看进度、暂停后的安全确认 -->
    <Sheet :visible="queueOpen" :title="t('queue.title')" @close="queueOpen = false">
      <!-- 警告放最前面：队列会在无人值守时自动开打下一件，先知道风险再看内容 -->
      <view class="hwarn">
        <text class="hwarn-t">{{ t('queue.expTitle') }}</text>
      </view>

      <view v-if="!queue && !queueErr" class="ph-box"><Spinner :size="40" /></view>
      <view v-else-if="!queue && queueErr" class="card sheet-card">
        <view class="line"><text class="k dim">{{ queueErr }}</text></view>
      </view>

      <template v-else-if="queue">
        <!--
          停下等人的那张卡。safety 是安全门：收菜之后桥接不敢自己认定床已经空了，
          把照片给人看，人点了「床已清空」才起下一件。别的原因也走同一张卡，只换文案。
        -->
        <view v-if="queue.pause" class="qpause">
          <text class="qpause-t">{{ t('queue.reason.' + queue.pause.reason) }}</text>
          <text class="qpause-d">{{ t('queue.reasonHint.' + queue.pause.reason) }}</text>
          <text v-if="queue.pause.message" class="qpause-m">{{ queue.pause.message }}</text>
          <image v-if="queue.pause.photo" class="qphoto" :src="queuePhotoUrl(queue.pause.photo)"
            mode="aspectFill" />
          <button class="cta fill qresume" :disabled="queueBusy" @click="queueAction(resumeQueue)">
            {{ queue.pause.reason === 'safety' ? t('queue.resumeSafety') : t('queue.resume') }}
          </button>
        </view>

        <view v-if="!queueItems.length" class="ph-box"><text class="ph-t">{{ t('queue.empty') }}</text></view>
        <view v-else class="card sheet-card">
          <view v-for="(it, i) in queueItems" :key="it.id">
            <view v-if="i > 0" class="hsep" />
            <view class="qrow">
              <view class="qmain">
                <view class="qhead">
                  <text class="qpill" :class="it.status">{{ t('queue.status.' + it.status) }}</text>
                  <text class="qname">{{ it.name }}</text>
                </view>
                <text class="qsub">
                  {{ t('queue.plateN', { n: it.plate }) }}
                  <!-- 收菜规划有告警的项打完不会自动衔接，先说清楚，免得半夜发现队列停了 -->
                  <text v-if="!it.harvestAuto"> · {{ t('queue.manualAfter') }}</text>
                </text>
                <text v-if="it.error" class="qsub err">{{ it.error }}</text>
              </view>
              <view v-if="it.status === 'waiting'" class="qacts">
                <text class="qbtn" :class="{ off: isFirstWaiting(it.id) }"
                  :aria-label="t('queue.up')" @click="moveQueueItem(it.id, -1)">↑</text>
                <text class="qbtn" :class="{ off: isLastWaiting(it.id) }"
                  :aria-label="t('queue.down')" @click="moveQueueItem(it.id, 1)">↓</text>
                <text class="qbtn danger" :aria-label="t('queue.remove')"
                  @click="removeQueueItem(it)">×</text>
              </view>
            </view>
          </view>
        </view>
        <text class="hint">{{ t('queue.note') }}</text>
      </template>

      <template #footer>
        <text v-if="queue && queueHasFinished" class="qclear" @click="queueAction(clearQueue)">
          {{ t('queue.clear') }}
        </text>
        <button v-if="queue?.state === 'running'" class="cta" :disabled="queueBusy"
          @click="queueAction(pauseQueue)">{{ t('queue.pauseAction') }}</button>
        <button v-else-if="queue?.state === 'paused'" class="cta fill" :disabled="queueBusy"
          @click="queueAction(resumeQueue)">{{ t('queue.resume') }}</button>
        <button v-else-if="queue && queueWaiting.length" class="cta fill" :disabled="queueBusy"
          @click="queueAction(startQueue)">{{ t('queue.start') }}</button>
        <button v-else class="cta" @click="queueOpen = false">{{ t('files.close') }}</button>
      </template>
    </Sheet>

    <!-- 导入：三个步骤共用一张卡片 -->
    <Sheet :visible="importStep !== ''" :title="importTitle" @close="closeImport">
      <template v-if="importStep === 'choose'">
        <view class="card sheet-card">
          <view class="line stack tappable" @click="pickFile">
            <text class="k accent">{{ t('import.fromFile') }}</text>
            <text class="opt-sub">{{ t('import.fromFileHint') }}</text>
          </view>
          <view class="hsep" />
          <view class="line stack tappable" @click="importStep = 'link'">
            <text class="k accent">{{ t('import.fromLink') }}</text>
            <text class="opt-sub">{{ t('import.fromLinkHint') }}</text>
          </view>
        </view>
        <text class="hint">{{ t('import.note') }}</text>
      </template>

      <template v-else-if="importStep === 'link'">
        <view class="card sheet-card">
          <view class="field">
            <input class="finput" v-model="linkText" type="text" confirm-type="done"
              :placeholder="t('import.linkPlaceholder')" placeholder-class="ph"
              @confirm="doImportLink" />
          </view>
        </view>
        <text class="hint">{{ t('import.fromLinkHint') }}</text>
      </template>

      <template v-else-if="importStep === 'progress'">
        <view class="prog">
          <text class="prog-name">{{ progressName }}</text>
          <Meter :pct="progressPct" />
          <text class="prog-sub">{{ progressLabel }}</text>
        </view>
      </template>

      <template #footer>
        <button v-if="importStep === 'link'" class="cta fill"
          :disabled="!linkText.trim()" @click="doImportLink">
          {{ t('import.confirm') }}
        </button>
        <button v-else-if="importStep === 'choose'" class="cta" @click="closeImport">
          {{ t('files.close') }}
        </button>
      </template>
    </Sheet>
  </view>
</template>

<style scoped>
.root { background: var(--bg); min-height: 100vh; }
.body { padding: 36rpx 36rpx 140rpx; }
.empty { padding: 140rpx 60rpx; display: flex; align-items: center;
  justify-content: center; flex-direction: column; }
.empty-s { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.01em; }
.err { color: var(--critical); }

.segs { display: flex; background: var(--surface); border-radius: 24rpx; padding: 8rpx; }
.seg { flex: 1; padding: 20rpx 0; text-align: center; border-radius: 18rpx;
  transition: background 0.25s ease; }
.seg.on { background: var(--surface-2); }
.seg-t { font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em; }
.seg.on .seg-t { font-weight: 600; }

/* 搜索框：和分段控件同一块底色，只在有输入时露出清除钮 */
.search { display: flex; align-items: center; margin-top: 16rpx; padding: 0 28rpx;
  min-height: 76rpx; background: var(--surface); border-radius: 20rpx; }
.sinput { flex: 1; height: 76rpx; font-size: 27rpx; color: var(--ink); letter-spacing: -0.01em; }
.clear { width: 40rpx; height: 40rpx; border-radius: 50%; background: var(--surface-2);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-left: 16rpx; }
.clear:active { opacity: 0.55; }
.clear-t { font-size: 28rpx; color: var(--ink-2); line-height: 1; margin-top: -2rpx; }

.crumb { display: flex; align-items: center; margin: 28rpx 8rpx 16rpx; min-height: 56rpx; }
.up { font-size: 26rpx; color: var(--accent); margin-right: 20rpx; letter-spacing: -0.01em; }
.path { font-size: 24rpx; color: var(--ink-3); flex: 1; letter-spacing: -0.01em; }

.card { background: var(--surface); border-radius: 28rpx; padding: 0 34rpx; }
.hsep { height: 1rpx; background: var(--separator); }
.row { display: flex; align-items: center; padding: 26rpx 0; }
.row:active { opacity: 0.55; }
.meta { margin-left: 24rpx; flex: 1; min-width: 0; }
.name { display: block; font-size: 29rpx; color: var(--ink);
  letter-spacing: -0.02em; word-break: break-all; line-height: 1.35; }
.sub { display: block; font-size: 23rpx; color: var(--ink-2); margin-top: 6rpx; letter-spacing: -0.01em; }
.tag { font-size: 21rpx; color: var(--accent); margin-left: 20rpx; flex-shrink: 0;
  padding: 4rpx 16rpx; border-radius: 999rpx; background: var(--accent-dim); letter-spacing: -0.01em; }
/* 面包屑右侧的导入按钮：着色圆形，和列表里的方形图标块区分开 */
.add-btn {
  width: 56rpx; height: 56rpx; border-radius: 50%;
  background: var(--accent-dim);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-left: 16rpx;
  transition: opacity 0.25s ease;
}
.add-btn:active { opacity: 0.55; }
.add-t { font-size: 34rpx; font-weight: 500; color: var(--accent); line-height: 1; }

/* 选项行：标题 + 说明纵向排列，比系统 actionSheet 能承载更多信息 */
.line.stack { display: block; padding: 26rpx 0; min-height: 0; }
.opt-sub { display: block; font-size: 23rpx; color: var(--ink-2);
  margin-top: 8rpx; line-height: 1.45; letter-spacing: -0.01em; }

.field { padding: 26rpx 0; }
.finput { width: 100%; font-size: 29rpx; color: var(--ink); letter-spacing: -0.01em; }
.ph { color: var(--ink-3); }

/* 进度：文件名 + 进度条 + 状态，替代把标签文字换成"上传中 45%" */
.prog { padding: 20rpx 0 8rpx; }
.prog-name { display: block; font-size: 28rpx; color: var(--ink);
  letter-spacing: -0.02em; line-height: 1.4; word-break: break-all; margin-bottom: 28rpx; }
.prog-sub { display: block; font-size: 24rpx; color: var(--ink-2);
  margin-top: 20rpx; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }

.cta.fill { background: var(--accent); color: #fff; }
.cta.fill[disabled] { opacity: 0.4; }
.k.danger { color: var(--critical); }

.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin-top: 32rpx; text-align: center; letter-spacing: -0.01em; }

/* ---- 详情卡片 ---- */
.player { width: 100%; height: 420rpx; border-radius: 24rpx; background: #000000; }
.zplayer { width: 100%; height: 100%; background: #000000; }
.shot { width: 100%; border-radius: 24rpx; background: var(--surface); }
.plate { width: 100%; height: 460rpx; border-radius: 24rpx; background: var(--surface); }
/* 预览占位框。注意别叫 .ph —— 那个名字被输入框的 placeholder-class 占着 */
.ph-box { padding: 90rpx 0; background: var(--surface); border-radius: 24rpx;
  display: flex; align-items: center; justify-content: center; }
.ph-t { font-size: 26rpx; color: var(--ink-2); letter-spacing: -0.01em; }

.sheet-card { margin-top: 24rpx; }
.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 36rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }

/* 分组标题跟「恢复」放同一行，标题的外边距要让给这一行 */
.grouphead-row { display: flex; align-items: baseline; justify-content: space-between;
  margin: 36rpx 0 16rpx; }
.grouphead-row .grouphead { margin: 0 0 0 8rpx; }
.reset { font-size: 24rpx; color: var(--accent); padding: 6rpx 8rpx; margin-right: 0; }
.reset:active { opacity: 0.55; }

/* 改过的项给一个小圆点 —— 一屏参数里，光看数字认不出自己动过哪些 */
.dot { color: var(--accent); font-weight: 700; margin-left: 8rpx; font-size: 34rpx;
  line-height: 1; vertical-align: middle; }

.num { font-variant-numeric: tabular-nums; }
.banner { margin-bottom: 20rpx; }
/* 队列停下等人时横幅整块换成警告色：这是要人动手的事，不能长得和普通信息一样 */
.banner.warn { background: var(--warning-bg); }
.banner.warn .k { color: var(--warning); }
.k.dim { color: var(--ink-3); }

/* ---- 打印队列 ---- */
/* 实验功能警示块，和监控页收菜 Sheet 的同一套写法：浅色底而不是描边，深色模式下不刺眼 */
.hwarn { margin-top: 24rpx; padding: 26rpx 28rpx; border-radius: 20rpx;
  background: var(--warning-bg); }
.hwarn-t { display: block; font-size: 27rpx; color: var(--warning); letter-spacing: -0.02em; }

.qpause { margin-top: 24rpx; padding: 30rpx 34rpx; border-radius: 28rpx;
  background: var(--warning-bg); }
.qpause-t { display: block; font-size: 30rpx; font-weight: 600; color: var(--warning);
  letter-spacing: -0.02em; line-height: 1.35; }
.qpause-d { display: block; font-size: 25rpx; color: var(--ink); margin-top: 10rpx;
  line-height: 1.5; letter-spacing: -0.01em; }
.qpause-m { display: block; font-size: 23rpx; color: var(--ink-2); margin-top: 8rpx;
  line-height: 1.5; letter-spacing: -0.01em; word-break: break-all; }
.qphoto { display: block; width: 100%; height: 360rpx; border-radius: 20rpx; margin-top: 20rpx;
  background: var(--surface); }
.qresume { margin-top: 24rpx; }

.qrow { display: flex; align-items: center; padding: 22rpx 0; }
.qmain { flex: 1; min-width: 0; }
.qhead { display: flex; align-items: center; min-width: 0; }
.qname { flex: 1; min-width: 0; font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.qsub { display: block; font-size: 22rpx; color: var(--ink-3); margin-top: 6rpx;
  letter-spacing: -0.01em; }
.qsub.err { color: var(--critical); word-break: break-all; }
/* 状态胶囊。按状态上色，语义和别处一致：accent 在进行、warning 要注意、critical 出错、good 完成 */
.qpill { flex-shrink: 0; font-size: 20rpx; padding: 4rpx 14rpx; border-radius: 999rpx;
  margin-right: 14rpx; letter-spacing: -0.01em; color: var(--ink-2); background: var(--surface-2); }
.qpill.printing { color: var(--accent); background: var(--accent-dim); }
.qpill.harvesting { color: var(--warning); background: var(--warning-bg); }
.qpill.done { color: var(--good); background: var(--surface-2); }
.qpill.failed { color: var(--critical); background: var(--surface-2); }
.qpill.skipped { color: var(--ink-3); background: var(--surface-2); }
/* 上移/下移/移除：三个小方块，不引图标库，字符够用 */
.qacts { display: flex; align-items: center; margin-left: 16rpx; flex-shrink: 0; }
.qbtn { width: 60rpx; height: 60rpx; line-height: 60rpx; text-align: center; border-radius: 14rpx;
  background: var(--surface-2); color: var(--ink); font-size: 30rpx; margin-left: 10rpx; }
.qbtn:active { opacity: 0.55; }
.qbtn.off { color: var(--ink-3); opacity: 0.45; pointer-events: none; }
.qbtn.danger { color: var(--critical); }
.qclear { display: block; text-align: center; font-size: 26rpx; color: var(--accent);
  padding: 8rpx 0 20rpx; letter-spacing: -0.01em; }
.qclear:active { opacity: 0.55; }
.beta { font-size: 18rpx; color: var(--ink-3); margin-left: 6rpx; vertical-align: super; }
.segs.mini { margin: 0; flex: 0 0 auto; }
.segs.mini .seg { padding: 12rpx 22rpx; }
.cta.fill { width: 100%; }
.stepper { display: flex; align-items: center; margin-left: 20rpx;
  background: var(--surface-2); border-radius: 15rpx; overflow: hidden; }
.sbtn { width: 82rpx; height: 62rpx; line-height: 62rpx; text-align: center;
  font-size: 32rpx; color: var(--ink); }
.sbtn:active { background: var(--separator); }
.sbtn.off { color: var(--ink-3); }
.svsep { width: 1rpx; height: 34rpx; background: var(--separator); }
.sw { transform: scale(0.82); transform-origin: right center; }
.line { display: flex; align-items: center; justify-content: space-between; min-height: 96rpx; }
.tappable:active { opacity: 0.55; }
.k { font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.accent { color: var(--accent); }
.v { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.02em;
  text-align: right; margin-left: 32rpx; min-width: 0; }
.v.ell { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.fil { display: flex; align-items: center; }
.swatch { width: 30rpx; height: 30rpx; border-radius: 10rpx; margin-right: 18rpx; flex-shrink: 0;
  /* 纯黑/纯白耗材在同色底上需要一圈描边才有边界，明暗两套主题各取一个方向 */
  box-shadow: inset 0 0 0 1rpx var(--swatch-ring); }

.hint { display: block; font-size: 22rpx; color: var(--ink-3);
  margin: 20rpx 8rpx 0; line-height: 1.6; letter-spacing: -0.01em; }

.cta { width: 100%; font-size: 31rpx; font-weight: 500;
  height: 96rpx; line-height: 96rpx; background: var(--surface); color: var(--accent);
  border: none; border-radius: 999rpx; letter-spacing: -0.02em; padding: 0; }
.cta::after { border: none; }
.pick-meta { margin-left: 18rpx; min-width: 0; }
.pick-meta .k { display: block; }
.pick-sub { display: block; font-size: 22rpx; color: var(--ink-3); margin-top: 6rpx;
  letter-spacing: -0.01em; }
.trail { display: flex; align-items: center; margin-left: 24rpx; flex-shrink: 0; }
.trail .v { margin-left: 0; }
.caret { font-size: 26rpx; color: var(--ink-3); margin-left: 10rpx; line-height: 1;
  transition: transform 0.2s ease; }
.caret.open { transform: rotate(180deg); }
.mat .line { padding-left: 24rpx; }
.tick { font-size: 30rpx; color: var(--accent); margin-left: 20rpx; flex-shrink: 0; }
.v.warn, .note.warn { color: var(--critical); }
.chk { display: flex; align-items: flex-start; }
.chk-dot { width: 14rpx; height: 14rpx; border-radius: 50%; margin: 12rpx 18rpx 0 0;
  flex-shrink: 0; }
.chk-dot.error { background: var(--critical); }
.chk-dot.warn { background: var(--warning); }
.chk-t { flex: 1; font-size: 27rpx; color: var(--ink); line-height: 1.5;
  letter-spacing: -0.01em; }
.printed { color: var(--accent); }
.plate-wrap { position: relative; }
/*
 * 按钮浮在图上，到头时压暗但不移除 —— 位置才稳定。
 * 底色用固定的深色而不是主题色：预览图在浅色主题下是白底，
 * 白字压半透明浅灰完全看不见。与监控页摄像头上的浮层按钮同一套做法。
 */
.nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 64rpx; height: 64rpx; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(30rpx) saturate(180%);
  -webkit-backdrop-filter: blur(24rpx) saturate(180%);
  border: 1rpx solid rgba(255, 255, 255, 0.14);
}
.nav.prev { left: 16rpx; }
.nav.next { right: 16rpx; }
.nav.off { opacity: 0.3; }
.nav:active { opacity: 0.55; }
.nav-t { font-size: 36rpx; color: #fff; line-height: 1; margin-top: -4rpx; }
.pager {
  position: absolute; right: 16rpx; bottom: 16rpx;
  padding: 6rpx 18rpx; border-radius: 999rpx;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(30rpx) saturate(180%);
  -webkit-backdrop-filter: blur(24rpx) saturate(180%);
  border: 1rpx solid rgba(255, 255, 255, 0.14);
}
.pager-t { font-size: 21rpx; color: #fff; font-variant-numeric: tabular-nums; }
</style>
