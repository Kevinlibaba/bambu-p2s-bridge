/**
 * 错误码解析。
 *
 * 打印机只上报数字：`print_error` 是单个当前错误，`hms[]` 是健康管理条目
 * （每条 attr + code 两个整数）。可读文案在 Bambu 自己的错误库里，
 * BambuStudio 走的也是同一个接口：
 *
 *   https://e.bambulab.com/query.php?lang=<lang>&e=<code>
 *
 * print_error 取 8 位十六进制，HMS 取 16 位（attr 高低半字 + code 高低半字）。
 * 返回体里 device_error / device_hms 两种容器，字段是 ecode + intro。
 */

const HOST = 'https://e.bambulab.com'

/**
 * Bambu 错误库自己的语言代码 —— **不是** BCP-47，别拿它当应用的语言标识。
 * 繁体在这里必须写 zh-tw：实测 zh-hant / zh-hk / zh-mo 都返回 result=201
 * 空数据，只有 zh-tw（大小写均可）能取到繁体文案。
 * 本项目内部一律用 zh-Hant 这种文字子标签，只在出网请求这一步转成它家的写法。
 */
export type BambuLang = 'zh-cn' | 'zh-tw' | 'en' | 'ja'

/**
 * 应用语言 → Bambu 的语言代码。
 * 除本项目使用的 zh-Hans / zh-Hant 外，也认浏览器常见的区域写法 ——
 * 第三方直接调 /api/errors 时多半传的是 navigator.language。
 * 繁体在台港澳都用，所以三个地区码都要落到 zh-tw。
 */
const LANGS: Record<string, BambuLang> = {
  'zh-hans': 'zh-cn',
  'zh-cn': 'zh-cn',
  'zh-sg': 'zh-cn',
  zh: 'zh-cn',
  'zh-hant': 'zh-tw',
  'zh-tw': 'zh-tw',
  'zh-hk': 'zh-tw',
  'zh-mo': 'zh-tw',
  en: 'en',
  ja: 'ja',
}

export function toBambuLang(locale: string | undefined): BambuLang {
  const raw = (locale ?? '').trim().toLowerCase()
  if (!raw) return 'en'
  if (raw in LANGS) return LANGS[raw]
  // en-US、ja-JP 这类带区域的，退回主语言再查一次
  const base = raw.split('-')[0]
  return LANGS[base] ?? 'en'
}

/** print_error → 8 位十六进制，如 117456933 → "07004025" */
export function printErrorCode(v: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/** HMS 条目 → 16 位十六进制，如 attr=0x07002100 code=0x00010086 → "0700210000010086" */
export function hmsCode(attr: number, code: number): string {
  return printErrorCode(attr) + printErrorCode(code)
}

/** 官方错误页，手机上可以直接打开看图文说明 */
export function wikiUrl(code: string, lang: BambuLang): string {
  return `${HOST}/index.php?e=${code}&s=device_hms&lang=${lang}`
}

interface CacheEntry {
  text: string | null
  at: number
}

/** 错误文案基本不变，缓存一天；查不到的缓存十分钟，免得每次刷新都打外网 */
const OK_TTL = 24 * 60 * 60 * 1000
const MISS_TTL = 10 * 60 * 1000
const cache = new Map<string, CacheEntry>()

function fresh(e: CacheEntry): boolean {
  return Date.now() - e.at < (e.text === null ? MISS_TTL : OK_TTL)
}

async function fetchText(code: string, lang: BambuLang): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${HOST}/query.php?lang=${lang}&e=${code}`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      result?: number
      data?: Record<string, { [k: string]: { ecode: string; intro: string }[] }>
    }
    if (body.result !== 0 || !body.data) return null
    // 8 位码落在 device_error，16 位码落在 device_hms
    for (const container of Object.values(body.data)) {
      const list = container?.[lang]
      if (Array.isArray(list) && list.length && list[0].intro) return list[0].intro
    }
    return null
  } catch {
    // 外网不通时不该拖垮整个接口，退回只显示错误码
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 查错误码文案。查不到返回 null，调用方自己决定怎么兜底。 */
export async function describe(code: string, lang: BambuLang): Promise<string | null> {
  const key = `${lang}:${code}`
  const hit = cache.get(key)
  if (hit && fresh(hit)) return hit.text
  const text = await fetchText(code, lang)
  cache.set(key, { text, at: Date.now() })
  return text
}
