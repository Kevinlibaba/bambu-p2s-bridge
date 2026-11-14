/**
 * MakerWorld（国际版）账号与模型下载。
 *
 * 全部走 api.bambulab.com，不走 makerworld.com/api：两边是同一个后端、认同一个
 * Bearer token，但 makerworld.com 前面挡着 Cloudflare 和极验验证码，服务端直连
 * 很容易被拦；api.bambulab.com 没有这一层（CT102 上实测，2026-11）。
 *
 * 国内版（makerworld.com.cn / api.bambulab.cn）是另一套账号、另一套模型库 ——
 * 同一个模型编号在两边是两个不相干的模型。这里只做国际版，国内链接直接拒掉，
 * 免得下错东西。
 *
 * 账号密码只经手一次（转发给 Bambu 换 token），从不落盘；落盘的只有 token。
 *
 * 几个实测/公开资料里确认过的行为：
 *   · 未登录调下载接口：403 {"code":1,"error":"Please log in to download models."}
 *   · 每个账号每天有下载上限：400 {"code":-1,"error":"You've reached your daily download limit."}
 *   · 风控会回一个带 captchaId 的 JSON（HTTP 418 或 200），只能去网页上手动过一次验证码
 *   · 下载接口回的是 {name, url}，url 是 CDN 上的签名链接，不用再带 token
 */
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'

const API = 'https://api.bambulab.com/v1'
const TFA_URL = 'https://bambulab.com/api/sign-in/tfa'
const CSRF_URL = 'https://bambulab.com/api/csrf'
const TIMEOUT_MS = 20_000

/** 本机打印机的型号代号，MakerWorld 在 compatibility.devModelName 里用的就是它 */
const OUR_MODEL = 'N7'

export type MwErrorCode =
  | 'auth' // 没登录或 token 失效
  | 'captcha' // 被风控要求过验证码
  | 'limit' // 今日下载次数用完
  | 'notFound'
  | 'badLink'
  | 'cnRegion' // 国内版链接
  | 'wrongCode' // 验证码错
  | 'codeExpired'
  | 'badPassword'
  | 'upstream'

export class MwError extends Error {
  constructor(readonly code: MwErrorCode, message: string, readonly status = 400) {
    super(message)
    this.name = 'MwError'
  }
}

export interface MwAccount {
  accessToken: string
  refreshToken?: string
  /** 毫秒时间戳。拿不到就不填，以 401 为准 */
  expiresAt?: number
  account: string
  uid?: number
  name?: string
  avatar?: string
  loginAt: number
}

export type LoginResult =
  | { ok: true; account: PublicAccount }
  /** 需要邮箱验证码。验证码已经发出去了 */
  | { ok: false; next: 'verifyCode' }
  /** 账号开了两步验证（验证器 App） */
  | { ok: false; next: 'tfa'; tfaKey: string }

export interface PublicAccount {
  account: string
  uid?: number
  name?: string
  avatar?: string
  loginAt: number
  expiresAt?: number
}

export interface DesignCard {
  id: number
  title: string
  cover: string
  creator: string
  likeCount: number
  downloadCount: number
}

export interface InstanceInfo {
  id: number
  profileId: number
  title: string
  cover: string
  isDefault: boolean
  /** 预计打印时间，秒 */
  printTime: number
  /** 预计耗材，克 */
  weight: number
  plates: number
  needAms: boolean
  filaments: { type: string; color: string }[]
  /** 原生针对哪台机器（P1S、X1C……） */
  printer: string
  /** 原生就是 P2S 的配置 */
  native: boolean
  layerHeight?: string
  downloadCount: number
  printCount: number
}

export interface DesignDetail extends DesignCard {
  instances: InstanceInfo[]
  /** 链接里点名的那个配置，没有就是默认配置 */
  selected: number | null
}

type Fetch = typeof fetch

/**
 * 可浏览的分类，取自 /search-service/homepage/nav（2026-11）。
 * 去掉了 Following / Foryou（要登录、走别的接口）和 LaserCut（激光切割，不是打印件）。
 */
export const NAV_KEYS = [
  'Trending',
  'category_400', 'category_800', 'category_700', 'category_300', 'category_900', 'category_100',
  'category_600', 'category_1000', 'category_200', 'category_2000', 'category_500',
]

/** 实测有效的排序。createTime 传了没效果，就不给 */
export type SearchSort = '' | 'downloadCount' | 'likeCount'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 从任意文本里抠出模型编号和配置编号。
 * 支持 App 里「分享 → 复制」出来的整段文字、带语言前缀的网址、`#profileId-` 锚点，
 * 也支持直接输入数字编号。
 */
export function parseLink(text: string): { designId: number; profileId: number | null } {
  const t = text.trim()
  if (/makerworld\.com\.cn/i.test(t)) {
    throw new MwError('cnRegion', '这是国内版 MakerWorld 的链接，目前只支持国际版（makerworld.com）')
  }
  if (/^\d{3,10}$/.test(t)) return { designId: Number(t), profileId: null }
  const m = /makerworld\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?models\/(\d+)/i.exec(t)
  if (!m) throw new MwError('badLink', '没认出 MakerWorld 模型链接')
  const p = /profileId-(\d+)/i.exec(t)
  return { designId: Number(m[1]), profileId: p ? Number(p[1]) : null }
}

function jwtExp(token: string): number | undefined {
  try {
    const part = token.split('.')[1]
    if (!part) return undefined
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number }
    return json.exp ? json.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function isCaptcha(data: unknown): boolean {
  if (!isRecord(data)) return false
  if (Object.entries(data).some(([k, v]) => k.toLowerCase().includes('captcha') && Boolean(v))) return true
  return ['error', 'message', 'msg'].some((k) => /captcha|robot/i.test(str(data[k])))
}

function isLimit(data: unknown): boolean {
  return isRecord(data) && ['error', 'message', 'msg'].some((k) => /download limit/i.test(str(data[k])))
}

export function toCard(raw: unknown): DesignCard | null {
  if (!isRecord(raw) || raw.id == null) return null
  const creator = isRecord(raw.designCreator) ? str(raw.designCreator.name) : ''
  return {
    id: num(raw.id),
    title: str(raw.title) || str(raw.titleTranslated),
    cover: str(raw.cover) || str(raw.coverUrl),
    creator,
    likeCount: num(raw.likeCount),
    downloadCount: num(raw.downloadCount),
  }
}

export function toInstance(raw: Record<string, unknown>): InstanceInfo {
  const ext = isRecord(raw.extention) ? raw.extention : {}
  const info = isRecord(ext.modelInfo) ? ext.modelInfo : {}
  const compat = isRecord(info.compatibility) ? info.compatibility : {}
  const settings = isRecord(info.projectSettings) ? info.projectSettings : {}
  const fil = Array.isArray(raw.instanceFilaments) ? raw.instanceFilaments.filter(isRecord) : []
  return {
    id: num(raw.id),
    profileId: num(raw.profileId),
    title: str(raw.title) || str(raw.titleTranslated),
    cover: str(raw.cover),
    isDefault: raw.isDefault === true,
    printTime: num(raw.prediction),
    weight: num(raw.weight),
    plates: Array.isArray(info.plates) ? info.plates.length : 0,
    needAms: raw.needAms === true,
    filaments: fil.map((f) => ({ type: str(f.type), color: str(f.color) })),
    printer: str(compat.devProductName),
    native: str(compat.devModelName) === OUR_MODEL,
    layerHeight: str(settings.layerHeight) || undefined,
    downloadCount: num(raw.downloadCount),
    printCount: num(raw.printCount),
  }
}

export function toDetail(raw: unknown, profileId: number | null): DesignDetail {
  const card = toCard(raw)
  if (!card || !isRecord(raw)) throw new MwError('notFound', '找不到这个模型', 404)
  const instances = (Array.isArray(raw.instances) ? raw.instances.filter(isRecord) : []).map(toInstance)
  const byProfile = profileId ? instances.find((i) => i.profileId === profileId) : undefined
  const def = instances.find((i) => i.id === num(raw.defaultInstanceId)) ?? instances.find((i) => i.isDefault)
  return {
    ...card,
    cover: str(raw.coverUrl) || card.cover,
    instances,
    selected: (byProfile ?? def ?? instances[0])?.id ?? null,
  }
}

/** 列表接口的数组字段名不统一，挨个找 */
function listOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!isRecord(data)) return []
  for (const k of ['hits', 'list', 'designs', 'items', 'data']) {
    const v = data[k]
    if (Array.isArray(v)) return v
    if (isRecord(v)) {
      const inner = listOf(v)
      if (inner.length) return inner
    }
  }
  return []
}

export class MakerWorld {
  private acc: MwAccount | null = null
  private loaded = false

  constructor(
    private readonly storePath: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.storePath, 'utf8')) as MwAccount
      if (raw?.accessToken) this.acc = raw
    } catch {
      this.acc = null
    }
  }

  private async save(): Promise<void> {
    const tmp = `${this.storePath}.tmp`
    if (!this.acc) {
      await writeFile(this.storePath, '{}', { mode: 0o600 }).catch(() => {})
      return
    }
    await writeFile(tmp, JSON.stringify(this.acc), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, this.storePath)
  }

  async account(): Promise<PublicAccount | null> {
    await this.load()
    if (!this.acc) return null
    const { account, uid, name, avatar, loginAt, expiresAt } = this.acc
    return { account, uid, name, avatar, loginAt, expiresAt }
  }

  async logout(): Promise<void> {
    await this.load()
    this.acc = null
    await this.save()
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://makerworld.com/',
      ...extra,
    }
  }

  private async call(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: unknown; res: Response }> {
    const headers = this.headers(init.headers)
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (init.auth) {
      await this.load()
      if (!this.acc) throw new MwError('auth', '还没登录 MakerWorld', 401)
      headers.Authorization = `Bearer ${this.acc.accessToken}`
    }
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new MwError('upstream', `连不上 MakerWorld：${(e as Error).message}`, 502)
    }
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (isCaptcha(data)) {
      throw new MwError('captcha', 'MakerWorld 要求人工验证。去 makerworld.com 网页上手动下载一次任意模型、过一下验证码，再回来重试', 429)
    }
    if (isLimit(data)) throw new MwError('limit', '这个账号今天的下载次数用完了，明天再试', 429)
    if (init.auth && res.status === 401) {
      this.acc = null
      await this.save()
      throw new MwError('auth', 'MakerWorld 登录已失效，请重新登录', 401)
    }
    return { status: res.status, data, res }
  }

  // ---- 登录 ----

  private async finish(account: string, accessToken: string, refreshToken?: string, expiresIn?: number) {
    // 先把磁盘上的旧状态读进来，否则下面带 token 的请求会触发首次 load、把刚登上的账号盖掉
    await this.load()
    this.acc = {
      account,
      accessToken,
      refreshToken,
      expiresAt: jwtExp(accessToken) ?? (expiresIn ? Date.now() + expiresIn * 1000 : undefined),
      loginAt: Date.now(),
    }
    // 资料拿不到不影响登录本身
    try {
      const { status, data } = await this.call(`${API}/design-user-service/my/profile`, { auth: true })
      if (status === 200 && isRecord(data)) {
        this.acc.uid = num(data.uid) || undefined
        this.acc.name = str(data.name) || undefined
        this.acc.avatar = str(data.avatar) || undefined
      }
    } catch {
      /* 忽略 */
    }
    await this.save()
    return (await this.account())!
  }

  private loginError(data: unknown): MwError {
    const msg = isRecord(data) ? str(data.error) || str(data.message) : ''
    if (/incorrect|password/i.test(msg)) return new MwError('badPassword', '账号或密码不对')
    return new MwError('upstream', msg ? `登录失败：${msg}` : '登录失败')
  }

  /** 发邮箱验证码。既用于「验证码登录」，也用于密码登录后要求补验证码的情况 */
  async sendCode(account: string): Promise<void> {
    const { status, data } = await this.call(`${API}/user-service/user/sendemail/code`, {
      method: 'POST',
      body: { email: account, type: 'codeLogin' },
    })
    if (status !== 200) throw this.loginError(data)
  }

  async loginPassword(account: string, password: string): Promise<LoginResult> {
    const { status, data } = await this.call(`${API}/user-service/user/login`, {
      method: 'POST',
      body: { account, password, apiError: '' },
    })
    if (!isRecord(data) || status >= 400) throw this.loginError(data)
    if (str(data.accessToken)) {
      return { ok: true, account: await this.finish(account, str(data.accessToken), str(data.refreshToken) || undefined, num(data.expiresIn) || undefined) }
    }
    if (data.loginType === 'verifyCode') {
      await this.sendCode(account)
      return { ok: false, next: 'verifyCode' }
    }
    if (data.loginType === 'tfa' && str(data.tfaKey)) return { ok: false, next: 'tfa', tfaKey: str(data.tfaKey) }
    throw this.loginError(data)
  }

  async loginCode(account: string, code: string): Promise<PublicAccount> {
    const { status, data } = await this.call(`${API}/user-service/user/login`, {
      method: 'POST',
      body: { account, code },
    })
    if (isRecord(data) && str(data.accessToken)) {
      return this.finish(account, str(data.accessToken), str(data.refreshToken) || undefined, num(data.expiresIn) || undefined)
    }
    // ha-bambulab 摸出来的：code 1 = 过期，2 = 不对
    const c = isRecord(data) ? num(data.code) : 0
    if (c === 1) throw new MwError('codeExpired', '验证码过期了，请重新获取')
    if (c === 2 || status === 400) throw new MwError('wrongCode', '验证码不对')
    throw this.loginError(data)
  }

  /** 两步验证走的是 bambulab.com 网站接口，要先拿 CSRF cookie，token 也是从 cookie 回来的 */
  async loginTfa(account: string, tfaKey: string, code: string): Promise<PublicAccount> {
    let csrf = ''
    try {
      const r = await this.fetchImpl(CSRF_URL, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) })
      csrf = /bbl_csrf_token=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? ''
    } catch (e) {
      throw new MwError('upstream', `连不上 bambulab.com：${(e as Error).message}`, 502)
    }
    const { res, data } = await this.call(TFA_URL, {
      method: 'POST',
      body: { tfaKey, tfaCode: code },
      headers: csrf ? { 'x-bbl-csrf-token': csrf, Cookie: `bbl_csrf_token=${csrf}` } : {},
    })
    const token = /(?:^|[;,]\s*)token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
    if (!token) {
      if (res.status === 403 && typeof data === 'string' && /cloudflare/i.test(data)) {
        throw new MwError('upstream', 'bambulab.com 拦下了两步验证请求（Cloudflare），可以改用邮箱验证码登录', 502)
      }
      throw new MwError('wrongCode', '两步验证码不对')
    }
    return this.finish(account, decodeURIComponent(token))
  }

  // ---- 模型 ----

  async design(link: string): Promise<DesignDetail> {
    const { designId, profileId } = parseLink(link)
    // 详情是公开的，不带 token：token 过期时照样能看，不会被一次 401 顺手登出
    const { status, data } = await this.call(`${API}/design-service/design/${designId}`)
    if (status === 404 || (isRecord(data) && data.id == null)) throw new MwError('notFound', '找不到这个模型', 404)
    if (status !== 200) throw new MwError('upstream', `MakerWorld 返回 HTTP ${status}`, 502)
    return toDetail(data, profileId)
  }

  /** 我的收藏。收藏接口要用户编号，登录时顺手存下了 */
  async favorites(offset = 0, limit = 20): Promise<{ items: DesignCard[]; total: number }> {
    await this.load()
    if (!this.acc) throw new MwError('auth', '还没登录 MakerWorld', 401)
    if (!this.acc.uid) await this.finish(this.acc.account, this.acc.accessToken, this.acc.refreshToken)
    const { status, data } = await this.call(
      `${API}/design-service/favorites/designs/${this.acc!.uid ?? 0}?offset=${offset}&limit=${limit}`,
      { auth: true },
    )
    if (status !== 200) throw new MwError('upstream', `MakerWorld 返回 HTTP ${status}`, 502)
    return { items: listOf(data).map(toCard).filter((c): c is DesignCard => !!c), total: isRecord(data) ? num(data.total) : 0 }
  }

  async likes(offset = 0, limit = 20): Promise<{ items: DesignCard[]; total: number }> {
    const { status, data } = await this.call(`${API}/design-service/my/design/like?offset=${offset}&limit=${limit}`, {
      auth: true,
    })
    if (status !== 200) throw new MwError('upstream', `MakerWorld 返回 HTTP ${status}`, 502)
    return { items: listOf(data).map(toCard).filter((c): c is DesignCard => !!c), total: isRecord(data) ? num(data.total) : 0 }
  }

  /**
   * 社区浏览：热门（Trending）或某个分类（category_400 这种）。公开接口，不用登录。
   * 分类键取自 /search-service/homepage/nav，前端写死了一份，见 NAV_KEYS。
   */
  async browse(navKey: string, offset = 0, limit = 20): Promise<{ items: DesignCard[]; total: number }> {
    if (!NAV_KEYS.includes(navKey)) throw new MwError('badLink', '不认识的分类')
    const { status, data } = await this.call(
      `${API}/search-service/select/design/nav?navKey=${encodeURIComponent(navKey)}&offset=${offset}&limit=${limit}`,
    )
    if (status !== 200) throw new MwError('upstream', `MakerWorld 返回 HTTP ${status}`, 502)
    return { items: listOf(data).map(toCard).filter((c): c is DesignCard => !!c), total: isRecord(data) ? num(data.total) : 0 }
  }

  /**
   * 关键词搜索。是 design2 不是 design —— 后者对同样的关键词永远回 0 条（实测）。
   * 中文关键词照样能搜。sort 留空是按相关度。
   */
  async search(keyword: string, sort: SearchSort = '', offset = 0, limit = 20): Promise<{ items: DesignCard[]; total: number }> {
    const q = keyword.trim()
    if (!q) return { items: [], total: 0 }
    const order = sort ? `&orderBy=${sort}` : ''
    const { status, data } = await this.call(
      `${API}/search-service/select/design2?keyword=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}${order}`,
    )
    if (status !== 200) throw new MwError('upstream', `MakerWorld 返回 HTTP ${status}`, 502)
    return { items: listOf(data).map(toCard).filter((c): c is DesignCard => !!c), total: isRecord(data) ? num(data.total) : 0 }
  }

  /** 换下载用的签名链接。会消耗一次账号的每日下载次数 */
  async downloadUrl(instanceId: number): Promise<{ url: string; name: string }> {
    const { status, data } = await this.call(
      `${API}/design-service/instance/${instanceId}/f3mf?type=download&fileType=`,
      { auth: true },
    )
    if (status === 401 || status === 403) {
      throw new MwError('auth', isRecord(data) && str(data.error) ? str(data.error) : '没有下载权限，请重新登录', 401)
    }
    if (status !== 200 || !isRecord(data) || !str(data.url)) {
      throw new MwError('upstream', `MakerWorld 没给下载链接（HTTP ${status}）`, 502)
    }
    return { url: str(data.url), name: str(data.name) }
  }
}
