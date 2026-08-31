/**
 * 跨端网络层。
 * uni.request / uni.connectSocket 已抹平 H5 / App / 小程序 的差异，
 * 这里只负责拼地址、带 token、统一错误。
 */

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

export function saveSettings(s: Settings) {
  uni.setStorageSync(KEY_BASE, s.baseUrl.replace(/\/+$/, ''))
  uni.setStorageSync(KEY_TOKEN, s.token)
}

export function isConfigured(): boolean {
  const s = loadSettings()
  return !!s.baseUrl && !!s.token
}

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
      header: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      success: (res) => {
        const code = res.statusCode
        if (code >= 200 && code < 300) return resolve(res.data as T)
        const payload = res.data as { error?: string; blockers?: unknown } | undefined
        const msg = payload?.error ?? `HTTP ${code}`
        const err = new ApiError(code === 401 ? 'Token 无效或未授权' : msg, code) as ApiError & {
          blockers?: unknown
        }
        // 409 时服务端会附带 blockers，调用方要靠它决定给出哪种补救操作
        if (payload?.blockers) err.blockers = payload.blockers
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
  wifi: string
  sdcard: boolean
  ams: AmsTray[]
  amsUnits: AmsUnit[]
  dryBlockers: DryBlocker[]
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

export const deleteFile = (path: string) =>
  request<{ ok: boolean }>('/api/files?path=' + encodeURIComponent(path), { method: 'DELETE' })

export interface PrintRequest {
  path: string
  plate?: number
  useAms?: boolean
  amsMapping?: number[]
  timelapse?: boolean
}

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
