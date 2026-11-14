/**
 * 跨端网络层。
 * uni.request / uni.connectSocket 已抹平 H5 / App / 小程序 的差异，
 * 这里只负责拼地址、带 token、统一错误。
 */

import { computed, ref } from 'vue'

const KEY_BASE = 'bambu.baseUrl'
const KEY_TOKEN = 'bambu.token'

export interface Settings {
  baseUrl: string
  token: string
}

export function loadSettings(): Settings {
  return {
    baseUrl: (uni.getStorageSync(KEY_BASE) as string) || '',
    token: (uni.getStorageSync(KEY_TOKEN) as string) || '',
  }
}

/*
 * 「是否已配置」必须是响应式的。
 * tabBar 页面一旦创建就一直活着，如果这里只是个普通函数，
 * 在设置页保存之后切到别的标签页，模板不会重新求值 ——
 * 表现就是连接明明已经好了，功能页却还在提示「请先设置连接」，
 * 得把 app 杀掉重开才正常。
 */
const settingsRev = ref(0)

export function saveSettings(s: Settings) {
  uni.setStorageSync(KEY_BASE, s.baseUrl.replace(/\/+$/, ''))
  uni.setStorageSync(KEY_TOKEN, s.token)
  settingsRev.value += 1
}

export const configured = computed(() => {
  settingsRev.value // 依赖，保存后重新求值
  const s = loadSettings()
  return !!s.baseUrl && !!s.token
})

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
  }
}

function url(path: string): string {
  const { baseUrl } = loadSettings()
  if (!baseUrl) throw new ApiError('尚未配置服务器地址')
  return baseUrl + path
}

/** 图片/视频等无法带 header 的场景，用查询参数携带 token */
export function tokenizedUrl(path: string): string {
  const { token } = loadSettings()
  const sep = path.includes('?') ? '&' : '?'
  return url(path) + sep + 'token=' + encodeURIComponent(token)
}

export function request<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; data?: unknown; timeout?: number } = {},
): Promise<T> {
  const { token } = loadSettings()
  return new Promise((resolve, reject) => {
    uni.request({
      url: url(path),
      method: opts.method ?? 'GET',
      data: opts.data as any,
      timeout: opts.timeout ?? 20000,
      // 无 body 的 POST 不能声明 application/json —— Fastify 会以
      // FST_ERR_CTP_EMPTY_JSON_BODY 回 400，界面上只看到一句 Bad Request
      header: opts.data === undefined
        ? { Authorization: 'Bearer ' + token }
        : { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      success: (res) => {
        const code = res.statusCode
        if (code >= 200 && code < 300) return resolve(res.data as T)
        const payload = res.data as { error?: string; blockers?: unknown; code?: string } | undefined
        const msg = payload?.error ?? `HTTP ${code}`
        // MakerWorld 的 401 是「MW 没登录」，不是桥接 token 不对 —— 它带着 code，按它自己的说法报
        const err = new ApiError(code === 401 && !payload?.code ? 'Token 无效或未授权' : msg, code) as ApiError & {
          blockers?: unknown
          code?: string
        }
        // 409 时服务端会附带 blockers，调用方要靠它决定给出哪种补救操作
        if (payload?.blockers) err.blockers = payload.blockers
        if (payload?.code) err.code = payload.code
        reject(err)
      },
      fail: (e) => reject(new ApiError(e.errMsg || '网络请求失败')),
    })
  })
}

// ---------- 具体接口 ----------

export interface Summary {
  online: boolean
  state: string
  progress: number
  remainingMin: number
  layer: number
  totalLayers: number
  taskName: string
  file: string
  nozzle: { cur: number; target: number; type: string; diameter: string }
  bed: { cur: number; target: number }
  chamber: number | null
  fans: { cooling: number; aux: number; chamber: number; heatbreak: number }
  speedLevel: number
  speedPct: number
  lights: { node: string; mode: string }[]
  errors: unknown[]
  printError: number
  /** 当前过渡阶段（调平、换料、擦嘴…），-1 表示不在任何阶段。文案见 locale 的 stage.* */
  stage: number
  /** 这一单计划要经过的阶段序列 */
  stageList: number[]
  wifi: string
  sdcard: boolean
  ams: AmsTray[]
  amsUnits: AmsUnit[]
  dryBlockers: DryBlocker[]
  /** 这一单里已跳过的零件（slice_info.config 的 identify_id），来自 print.s_obj */
  skippedObjects: number[]
  /** 固件支持不支持中途跳过零件（print.fun 第 49 位） */
  skipSupported: boolean
  updatedAt: number
}

export type DryStatus = 'off' | 'checking' | 'drying' | 'cooling' | 'unknown'
export type DryBlocker = 'printing' | 'filamentLoaded' | 'alreadyDrying'

export interface AmsUnit {
  id: number
  temp: number
  humidity: number
  humidityPct: number | null
  dryStatus: DryStatus
  dryRemainMin: number
  loadedSlot: number | null
}

export interface AmsTray {
  unit: number
  slot: number
  type: string
  subBrand: string
  color: string
  remainPct: number
  nozzleTempMin: number
  nozzleTempMax: number
  dryTemp: number
  dryHours: number
  empty: boolean
}

export interface RemoteFile {
  name: string
  size: number
  isDirectory: boolean
  modifiedAt: string | null
  /** 上次打印的时间戳；没打过或不是切片文件时为 null/缺省 */
  lastPrintedAt?: number | null
}

/** .gcode.3mf 预览：桥接侧从包里抽出来的信息，整包永远不下发到手机 */
export interface ThreeMfFilament {
  id: number | null
  type: string
  /** #RRGGBB */
  color: string
  usedM: number | null
  usedG: number | null
}

export interface ThreeMfPlate {
  index: number
  /** 预计打印时长，秒 */
  prediction: number | null
  /** 预计耗材重量，克 */
  weight: number | null
  nozzleDiameters: string | null
  printerModel: string | null
  supportUsed: boolean | null
  objects: string[]
  filaments: ThreeMfFilament[]
  hasThumbnail: boolean
}

export interface ThreeMfInfo {
  path: string
  name: string
  size: number
  plates: ThreeMfPlate[]
  entryCount: number
  hasModel: boolean
  metadataMissing: boolean
}

export type Command =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'light'; on: boolean; node?: string }
  | { type: 'speed'; level: 1 | 2 | 3 | 4 }
  | { type: 'nozzleTemp'; celsius: number }
  | { type: 'bedTemp'; celsius: number }
  | { type: 'home' }
  | { type: 'pushall' }

export const api = {
  health: () => request<{ ok: boolean; printerConnected: boolean }>('/api/health'),
  state: () => request<Summary>('/api/state'),
  command: (c: Command) => request<{ ok: boolean }>('/api/command', { method: 'POST', data: c }),
  files: (path = '/') =>
    request<{ path: string; files: RemoteFile[] }>('/api/files?path=' + encodeURIComponent(path)),
  model: (path: string) =>
    request<ThreeMfInfo>('/api/files/3mf?path=' + encodeURIComponent(path)),
  snapshotUrl: () => tokenizedUrl('/api/camera/snapshot.jpg'),
  /** 供 <video> / <image> 直接消费：支持 Range，token 走查询参数 */
  mediaUrl: (path: string) =>
    tokenizedUrl('/api/files/stream?path=' + encodeURIComponent(path)),
  downloadUrl: (path: string) =>
    tokenizedUrl('/api/files/download?path=' + encodeURIComponent(path)),
  plateUrl: (path: string, plate: number) =>
    tokenizedUrl(`/api/files/3mf/plate.png?path=${encodeURIComponent(path)}&plate=${plate}`),
}

/** WebSocket 地址：把 http(s) 换成 ws(s)，token 走查询参数 */
export function eventsUrl(): string {
  return tokenizedUrl('/api/events').replace(/^http/, 'ws')
}

// ---------- 导入 / 删除 / 打印 ----------

/**
 * 上传走 uni.uploadFile 而不是 request —— 它在各端都是流式的，
 * 并且提供进度回调。几十 MB 的切片文件没有进度条会让人以为卡死了。
 */
export function uploadFile(
  file: { path: string; name: string; raw?: unknown },
  onProgress?: (pct: number) => void,
): Promise<ThreeMfInfo> {
  const { token } = loadSettings()
  return new Promise((resolve, reject) => {
    const task = uni.uploadFile({
      url: url('/api/files/upload'),
      filePath: file.path,
      name: 'file',
      // H5 下传 File 对象才能带上正确的文件名
      file: file.raw as never,
      header: { Authorization: 'Bearer ' + token },
      timeout: 30 * 60 * 1000,
      success: (res) => {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(res.data as string)
        } catch {
          return reject(new ApiError('服务器返回了无法解析的内容'))
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body as unknown as ThreeMfInfo)
        reject(new ApiError(String(body.error ?? `HTTP ${res.statusCode}`), res.statusCode))
      },
      fail: (e) => reject(new ApiError(e.errMsg || '上传失败')),
    })
    task?.onProgressUpdate?.((p) => onProgress?.(p.progress))
  })
}

export const importUrl = (link: string, name: string) =>
  request<ThreeMfInfo>('/api/files/import', { method: 'POST', data: { url: link, name }, timeout: 10 * 60 * 1000 })

// ---------- 切片器一键安装 ----------
export interface SlicerStatus {
  available: boolean
  /** mounted = 宿主机手动挂载；downloaded = 一键安装 */
  source: 'mounted' | 'downloaded' | null
  version: string | null
  /** 这台机器能不能装（BambuStudio 只有 x86_64 版） */
  supported: boolean
  offer: { version: string; downloadMB: number | null; diskMB: number }
  install: {
    state: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
    pct: number
    error: string | null
    code: string | null
  }
}

export const fetchSlicer = () => request<SlicerStatus>('/api/slicer')
export const installSlicer = () => request<SlicerStatus['install']>('/api/slicer/install', { method: 'POST' })
export const removeSlicer = () => request<{ ok: boolean }>('/api/slicer', { method: 'DELETE' })

// ---------- 首次设置向导 ----------
// 设置模式下桥接还没有 token，这几个接口免鉴权（带个空的 Authorization 也无妨）

export interface FoundPrinter {
  ip: string
  serial: string
  model: string
  modelName: string
  name: string
  version: string
}

export const setupStatus = () => request<{ needed: boolean }>('/api/setup/status', { timeout: 5000 })
export const setupDiscover = () =>
  request<{ printers: FoundPrinter[] }>('/api/setup/discover', { timeout: 15000 })
export const setupApply = (data: { host: string; serial: string; code: string }) =>
  request<{ ok: true; token: string; state?: string }>('/api/setup/apply', { method: 'POST', data, timeout: 30000 })

// ---------- MakerWorld（国际版） ----------

export interface MwAccount {
  account: string
  uid?: number
  name?: string
  avatar?: string
  loginAt: number
  expiresAt?: number
}

export type MwLoginReply =
  | { ok: true; account: MwAccount }
  | { ok: false; next: 'verifyCode' }
  | { ok: false; next: 'tfa'; tfaKey: string }

export interface MwCard {
  id: number
  title: string
  cover: string
  creator: string
  likeCount: number
  downloadCount: number
}

export interface MwInstance {
  id: number
  profileId: number
  title: string
  cover: string
  isDefault: boolean
  printTime: number
  weight: number
  plates: number
  needAms: boolean
  filaments: { type: string; color: string }[]
  printer: string
  native: boolean
  layerHeight?: string
  downloadCount: number
  printCount: number
}

export interface MwDesign extends MwCard {
  instances: MwInstance[]
  selected: number | null
}

export const mwAccount = () => request<{ account: MwAccount | null }>('/api/mw/account')
export const mwLogout = () => request<{ ok: boolean }>('/api/mw/logout', { method: 'POST' })
export const mwLogin = (data: { account: string; password?: string; code?: string; tfaKey?: string }) =>
  request<MwLoginReply>('/api/mw/login', { method: 'POST', data })
export const mwSendCode = (account: string) =>
  request<{ ok: boolean }>('/api/mw/code', { method: 'POST', data: { account } })
export const mwDesign = (link: string) =>
  request<MwDesign>('/api/mw/design?link=' + encodeURIComponent(link))
export type MwListQuery =
  | { kind: 'favorites' | 'likes'; offset?: number }
  | { kind: 'nav'; key: string; offset?: number }
  | { kind: 'search'; q: string; sort?: '' | 'downloadCount' | 'likeCount'; offset?: number }

export const mwList = (q: MwListQuery) => {
  const qs = Object.entries({ ...q, limit: 20 })
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return request<{ items: MwCard[]; total: number }>(`/api/mw/list?${qs}`)
}
export const mwImport = (instanceId: number) =>
  request<ThreeMfInfo>('/api/mw/import', { method: 'POST', data: { instanceId }, timeout: 10 * 60 * 1000 })

export const deleteFile = (path: string) =>
  request<{ ok: boolean }>('/api/files?path=' + encodeURIComponent(path), { method: 'DELETE' })

export interface PrintRequest {
  path: string
  plate?: number
  useAms?: boolean
  amsMapping?: number[]
  /** 只点名「哪号耗材用哪个料盘」，其余由桥接自动配 */
  slots?: Record<string, number>
  /** 跳过自检里的阻断项。只有用户明确确认过才该带上 */
  force?: boolean
  timelapse?: boolean
}

export interface PlanFilament {
  id: number | null
  type: string
  color: string
  trayInfoIdx: string
  usedG: number | null
  usedM: number | null
  /** 自动配到的料盘全局序号，-1 表示没配上 */
  slot: number
  trayType: string
}

export interface PlanTray {
  /** 全局序号 = unit * 4 + index，就是 ams_mapping 里填的值 */
  slot: number
  unit: number
  index: number
  type: string
  subBrand: string
  color: string
  empty: boolean
}

export interface PreflightCheck {
  code: string
  /** error 会拦住打印，warn 只提示 */
  level: 'error' | 'warn'
  params?: Record<string, string | number>
}

export interface PrintPlan {
  path: string
  plate: number
  plateCount: number
  filamentCount: number
  filaments: PlanFilament[]
  mapping: number[] | null
  /** 配不出来时的原因，界面据此拦住「开始打印」 */
  error: string | null
  /** 打印前自检结果 */
  checks: PreflightCheck[]
  trays: PlanTray[]
}

export interface JobRecord {
  id: string
  name: string
  file: string
  plate: number | null
  startedAt: number
  endedAt: number
  minutes: number
  result: 'finished' | 'failed'
  progress: number
  layer: number
  totalLayers: number
  printError: number
  /** 切片文件里的预估克重，查不到为 null */
  weightG: number | null
  estimateMin: number | null
  /** 桥接是在打印中途起来的，耗时无从得知 */
  partial: boolean  /** 源 3mf 在打印机上的路径。桥接按归一化后的名字在目录里找出来的 */
  file3mf?: string
  /** 这一单的延时录像文件名，位于 /timelapse 下 */
  video?: string
}

export interface HistoryStatsRow {
  count: number
  finished: number
  failed: number
  minutes: number
  grams: number
  /** 有几单能查到克重 —— 用量是否完整，界面要说清楚 */
  weighed: number
}

export interface HistoryPayload {
  jobs: JobRecord[]
  running: { name: string; startedAt: number } | null
  stats: { month: HistoryStatsRow; all: HistoryStatsRow }
}

export interface TempSample {
  t: number
  n: number
  b: number
  /** 腔温取不到时为 null */
  c: number | null
  p: number
}

export const fetchTemps = (minutes = 60) =>
  request<{ samples: TempSample[] }>(`/api/history/temps?minutes=${minutes}`)

/**
 * 回看某一单的温度曲线。
 *
 * available 为 false 表示这一单跑在温度落盘上线之前 —— 是「没有记录」，
 * 不是「加载失败」，前端要分开说。
 */
/** 收菜（推件）。桥接自己从「刚打完的那一单」解出轮廓，前端不需要知道 bbox */
export interface HarvestWarning {
  code: string
  /** error 做不成 / warn 能做但要留神 / info 只是告知。分级由桥接给 */
  level: 'error' | 'warn' | 'info'
  objectId?: number
  params?: Record<string, string | number>
}
export interface HarvestPlan {
  dryRun?: boolean
  sent?: boolean
  /** 哪个文件的哪一盘。文案由前端拼，桥接只给数据 */
  path: string | null
  plate: number | null
  bedTemp: number
  objectCount: number
  maxZ: number
  brimWidth: number
  order: { id: number; name: string; pushX: number; startY: number }[]
  warnings: HarvestWarning[]
  gcode: string[]
}

export interface HarvestAuto {
  armed: boolean
  /** idle | waitingPrint | cooling | ejecting | done | failed */
  phase: string
  error: string | null
  bedTarget: number
}
/** 预约：这一单打完自动降温并收菜 */
export const fetchHarvestAuto = () => request<HarvestAuto>('/api/eject/auto')
export const armHarvest = (armed: boolean) =>
  request<HarvestAuto>('/api/eject/auto', { method: 'POST', data: { armed } })

export interface HarvestFilePlan {
  dryRun: boolean
  path: string
  plate: number
  objectCount: number
  maxZ: number
  brimWidth: number
  order: { id: number; name: string; pushX: number; startY: number }[]
  warnings: HarvestWarning[]
  /** 产物在打印机上的路径：<名字>.harvest.gcode.3mf */
  output: string
}
/** 只规划、回告警，不动文件 */
export const planHarvestFile = (path: string, plate: number) =>
  request<HarvestFilePlan>('/api/eject/inject', { method: 'POST', data: { path, plate } })
/** 真的生成带收菜的文件并传回打印机。文件大，给长一点超时 */
export const makeHarvestFile = (path: string, plate: number) =>
  request<HarvestFilePlan>('/api/eject/inject', { method: 'POST', data: { path, plate, confirm: true }, timeout: 120000 })

/** 不带 confirm 只算不发 */
export const planHarvest = () =>
  request<HarvestPlan>('/api/eject', { method: 'POST', data: {} })
export const runHarvest = () =>
  request<HarvestPlan>('/api/eject', { method: 'POST', data: { confirm: true }, timeout: 30000 })
/** 只吹风降温，不动任何轴 */
export const coolForHarvest = () =>
  request<HarvestPlan>('/api/eject', { method: 'POST', data: { coolOnly: true, confirm: true } })

/**
 * 打印中跳过零件。协议见 PROTOCOL.md §2.6；【已实现、未真机验证】。
 * id 是 slice_info.config 里的 identify_id，桥接自己解，前端只管勾选。
 */
export interface SkipObject {
  id: number
  name: string
  skipped: boolean
}
export interface SkipObjects {
  path: string
  plate: number
  /** 固件支持不支持（fun 第 49 位）。不支持就别出入口 */
  supported: boolean
  /** 这一盘切片时有没有打零件标签。没有就跳不了，单件盘一律没有 */
  labelObjectEnabled: boolean
  objects: SkipObject[]
}
export const fetchSkipObjects = () => request<SkipObjects>('/api/print/objects')
export const skipObjects = (ids: number[]) =>
  request<{ sent: boolean; ids: number[] }>('/api/print/skip', { method: 'POST', data: { ids } })

// ---- 云切片 ----

export interface SliceJob {
  id: string
  source: string
  /** 产物在打印机上的路径，done 之前为 null */
  output: string | null
  /** queued | downloading | slicing | patching | uploading | done | failed */
  phase: string
  error: string | null
  /** 纯切片耗时（毫秒），不含上传下载 */
  sliceMs: number | null
  /** 提交时才有：这次用的工艺和耗材 */
  process?: string
  /** true = 真正应用了这套工艺；false = 沿用模型作者自己的打印设置 */
  processApplied?: boolean
  /** 这套工艺改掉了模型里的哪些关键设置。enable_support 变 0 最要紧 */
  changes?: { key: string; from: string; to: string }[]
  filaments?: string[]
  /** 哪几个耗材是按类型猜的（模型里的编号在厂商 profile 里查不到） */
  guessedSlots?: number[]
  willWriteTo?: string
}

/** 用户能改的几项。不填的一律沿用模型作者的设置 */
export interface SliceParams {
  layerHeight?: number
  infillDensity?: number
  supports?: boolean
  wallLoops?: number
  brim?: boolean
}

export interface SliceOptions {
  available: boolean
  nozzle: number
  processes: string[]
  defaultProcess: string
  /** 层高的合法区间，随喷嘴口径变 */
  layerRange: { min: number; max: number }
  /** 这个文件能不能切（已经切过的就不能）。没带 path 查询时为 null */
  sliceable: boolean | null
  /** 模型作者定的参数，界面拿它做默认值。读不出来时为 null */
  current: SliceParams | null
  amsFilaments: { trayInfoIdx: string; type: string; profile: string | null }[]
}

/** 带上 path 才会返回该模型作者的设置 */
export const fetchSliceOptions = (path?: string) =>
  request<SliceOptions>(`/api/slice/options${path ? `?path=${encodeURIComponent(path)}` : ''}`)

/**
 * 提交切片。立刻返回任务号，之后靠轮询 —— 切片要几十秒到几分钟，
 * 手机上挂着这么长的请求，锁屏或切网就断了。
 */
export const startSlice = (
  req: { path: string; plate?: number; process?: string; params?: SliceParams },
) =>
  request<SliceJob>('/api/slice', { method: 'POST', data: req })

export const fetchSliceJob = (id: string) => request<SliceJob>(`/api/slice/jobs/${id}`)

export interface LoggedEvent {
  t: number
  /** 事件类型。文案在前端出，桥接只给类型 */
  kind: string
  /** 错误类事件带错误码 */
  code?: string
  /** 事件附带的摄像头快照（相对 URL，免鉴权）。首层完成、进度里程碑会有 */
  image?: string
}

// ---- 存储卡体检 ----

export interface FileCheckResult {
  name: string
  size: number
  /** ok | corrupt | notZip | error */
  status: string
  badEntries?: string[]
  detail?: string
}
export interface FileCheckStatus {
  running: boolean
  startedAt: number | null
  finishedAt: number | null
  total: number
  done: number
  current: string | null
  results: FileCheckResult[]
  error: string | null
}
export const fetchFileCheck = () => request<FileCheckStatus>('/api/files/check')
export const startFileCheck = () => request<FileCheckStatus>('/api/files/check', { method: 'POST' })

// ---- 定时打印 ----

export interface ScheduledPrint {
  at: number
  body: Record<string, unknown>
  name: string
  createdAt: number
}
export interface ScheduleStatus {
  pending: ScheduledPrint | null
  last: { at: number; name: string; ok: boolean; error: string | null } | null
}
export const fetchSchedule = () => request<ScheduleStatus>('/api/print/schedule')
export const setSchedule = (at: number, print: PrintRequest, name: string) =>
  request<ScheduleStatus>('/api/print/schedule', { method: 'POST', data: { at, print, name } })
export const cancelSchedule = () => request<ScheduleStatus>('/api/print/schedule', { method: 'DELETE' })

// ---- 打印队列 ----
/*
 * 队列由桥接自动执行：打完一件、收菜、确认床空了再起下一件。
 * 字段名和桥接的契约一一对应，这里只做类型描述，不做任何转换。
 */
export type QueueState = 'idle' | 'running' | 'paused'
/**
 * 暂停原因。
 *   safety  上一件收菜后要人看照片确认床已清空
 *   failed  开打或打印失败
 *   manual  用户按了暂停
 *   foreign 队列之外有人开了打印
 *   blocked 等热床冷却超时之类，机器状态不允许继续
 */
export type QueuePauseReason = 'safety' | 'failed' | 'manual' | 'foreign' | 'blocked'
export type QueuePhase = 'idle' | 'starting' | 'printing' | 'cooling' | 'ejecting' | 'settling' | 'gap'
export type QueueItemStatus = 'waiting' | 'printing' | 'harvesting' | 'done' | 'failed' | 'skipped'

export interface QueueWarning {
  code: string
  level: 'error' | 'warn' | 'info'
  params?: Record<string, string | number>
}

export interface QueueItem {
  id: string
  path: string
  name: string
  plate: number
  slots?: Record<string, number>
  status: QueueItemStatus
  error: string | null
  /** 文件本身带收菜序列（.harvest.gcode.3mf） */
  injected: boolean
  /** 收菜规划没有 warn/error 告警 → 打完可自动衔接下一件；否则打完停下等人确认 */
  harvestAuto: boolean
  warnings: QueueWarning[]
  addedAt: number
  startedAt: number | null
  endedAt: number | null
  /** 收菜后的快照相对 URL（/api/snapshots/<id>.jpg），免鉴权，拼上 baseUrl 即可显示 */
  photo: string | null
}

export interface QueueStatus {
  /** idle = 没在自动执行（可能有待打项）；running = 自动执行中；paused = 停下等人 */
  state: QueueState
  pause: { reason: QueuePauseReason; message: string; photo: string | null } | null
  /** 正在处理的 item id */
  current: string | null
  phase: QueuePhase
  items: QueueItem[]
  updatedAt: number
}

export const fetchQueue = () => request<QueueStatus>('/api/queue')
export const enqueue = (path: string, plate?: number, slots?: Record<string, number>) =>
  request<QueueStatus>('/api/queue', { method: 'POST', data: { path, plate, slots } })
export const dequeue = (id: string) =>
  request<QueueStatus>(`/api/queue/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** waiting 项的新顺序 */
export const reorderQueue = (ids: string[]) =>
  request<QueueStatus>('/api/queue/reorder', { method: 'POST', data: { ids } })
export const startQueue = () => request<QueueStatus>('/api/queue/start', { method: 'POST' })
/** 打完当前这件后不再起下一件 */
export const pauseQueue = () => request<QueueStatus>('/api/queue/pause', { method: 'POST' })
/** 从 paused 恢复。安全门就在这里：人看过照片确认床空了才点 */
export const resumeQueue = () => request<QueueStatus>('/api/queue/resume', { method: 'POST' })
/** 清掉 done/failed/skipped */
export const clearQueue = () => request<QueueStatus>('/api/queue/clear', { method: 'POST' })

/** 队列快照是免鉴权的相对地址，不走 tokenizedUrl —— 多带一个 token 参数反而会打进日志 */
export function queuePhotoUrl(photo: string): string {
  return url(photo)
}

/** 某一单期间发生过什么。和温度曲线叠起来看才能定位问题 */
export const fetchJobEvents = (jobId: string) =>
  request<{ events: LoggedEvent[] }>(`/api/history/events?job=${encodeURIComponent(jobId)}`)

export const fetchJobTemps = (jobId: string) =>
  request<{ samples: TempSample[]; available: boolean }>(
    `/api/history/temps?job=${encodeURIComponent(jobId)}`,
  )

export const fetchHistory = (limit = 50) =>
  request<HistoryPayload>(`/api/history?limit=${limit}`)

export interface NotifyStatus {
  enabled: boolean
  events: string[]
  kinds: string[]
  sinks: Record<string, boolean | number>
  /** 为 null 表示服务端没配 VAPID 密钥，Web Push 用不了 */
  vapidPublicKey: string | null
  recent: { kind: string; title: string; body: string; at: number }[]
}

export const fetchNotifyStatus = () => request<NotifyStatus>('/api/notify')

export const subscribePush = (sub: unknown) =>
  request<{ ok: boolean }>('/api/notify/subscribe', { method: 'POST', data: sub })

export const unsubscribePush = (endpoint: string) =>
  request<{ ok: boolean }>('/api/notify/unsubscribe', { method: 'POST', data: { endpoint } })

export const testNotify = () =>
  request<{ ok: boolean; results: { name: string; ok: boolean; detail?: string }[] }>(
    '/api/notify/test', { method: 'POST' },
  )

export const fetchPrintPlan = (path: string, plate: number) =>
  request<PrintPlan>(`/api/print/plan?path=${encodeURIComponent(path)}&plate=${plate}`)

export const startPrint = (req: PrintRequest) =>
  request<{ ok: boolean; plate: number }>('/api/print/start', { method: 'POST', data: req, timeout: 60000 })

// ---------- AMS 烘干 ----------

export interface DryStartRequest {
  amsId: number
  temp: number
  duration: number
  filament?: string
  rotateTray?: boolean
}

/** 被前置条件拦下时服务端会带回 blockers，让界面能给出具体的处理方式 */
export class DryBlockedError extends ApiError {
  constructor(message: string, readonly blockers: DryBlocker[]) {
    super(message, 409)
  }
}

export async function startDrying(req: DryStartRequest) {
  try {
    return await request<{ ok: boolean }>('/api/ams/dry/start', { method: 'POST', data: req })
  } catch (e) {
    const err = e as ApiError & { blockers?: DryBlocker[] }
    if (err.status === 409 && err.blockers) throw new DryBlockedError(err.message, err.blockers)
    throw e
  }
}

export interface PrinterErrorItem {
  /** 'print' 是可关闭的弹窗类错误；'hms' 是健康管理条目，条件消失才会撤下 */
  kind: 'print' | 'hms'
  code: string
  /** 官方错误库的说明；外网不通时为 null */
  text: string | null
  url: string
}

export const fetchErrors = (lang: string) =>
  request<{ items: PrinterErrorItem[]; clearable: boolean; state: string }>(
    `/api/errors?lang=${encodeURIComponent(lang)}`,
  )

export const clearErrors = () =>
  request<{ ok: boolean; cleared: number }>('/api/errors/clear', { method: 'POST' })

export const stopDrying = (amsId: number) =>
  request<{ ok: boolean }>('/api/ams/dry/stop', { method: 'POST', data: { amsId } })

export const unloadFilament = (amsId: number) =>
  request<{ ok: boolean }>('/api/ams/unload', { method: 'POST', data: { amsId }, timeout: 60000 })
