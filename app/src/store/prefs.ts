import { computed, reactive, readonly } from 'vue'
import { i18n, systemLocale, messages, type LocaleCode } from '../locale'

const KEY_LOCALE = 'bambu.locale'
const KEY_THEME = 'bambu.theme'

export type LocalePref = 'auto' | LocaleCode
export type ThemePref = 'auto' | 'dark' | 'light'

/** 与 App.vue 中的令牌保持一致 —— 导航栏/tabBar 是原生组件，改不到 CSS 变量 */
const CHROME = {
  dark: { bg: '#000000', front: '#ffffff', tabColor: '#6e6e73', tabSelected: '#f5f5f7' },
  light: { bg: '#fbfbfd', front: '#000000', tabColor: '#86868b', tabSelected: '#1d1d1f' },
} as const

interface Prefs {
  locale: LocalePref
  theme: ThemePref
  /** 实际生效的值（auto 解析之后） */
  effectiveLocale: LocaleCode
  effectiveTheme: 'dark' | 'light'
}

function systemTheme(): 'dark' | 'light' {
  // #ifdef H5
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  // #endif
  try {
    const info = uni.getSystemInfoSync() as { theme?: string }
    return info.theme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

const state = reactive<Prefs>({
  locale: (uni.getStorageSync(KEY_LOCALE) as LocalePref) || 'auto',
  theme: (uni.getStorageSync(KEY_THEME) as ThemePref) || 'auto',
  effectiveLocale: systemLocale(),
  effectiveTheme: systemTheme(),
})

function resolve() {
  state.effectiveLocale = state.locale === 'auto' ? systemLocale() : state.locale
  state.effectiveTheme = state.theme === 'auto' ? systemTheme() : state.theme
  i18n.global.locale.value = state.effectiveLocale
}

export function setLocale(v: LocalePref) {
  state.locale = v
  uni.setStorageSync(KEY_LOCALE, v)
  resolve()
  applyChrome()
}

export function setTheme(v: ThemePref) {
  state.theme = v
  uni.setStorageSync(KEY_THEME, v)
  resolve()
  applyChrome()
}

/** 页面根节点的主题类。auto 时不加类，交给 CSS 媒体查询。 */
export const themeClass = computed(() =>
  state.theme === 'auto' ? '' : `theme-${state.theme}`,
)

/** 导航栏标题、tabBar 文案与配色 —— 这些是原生 chrome，必须走 API 而非 CSS */
export function applyChrome(titleKey?: string) {
  const c = CHROME[state.effectiveTheme]
  const tt = i18n.global.t

  // #ifdef H5
  // html/body 拿不到 page 上的 CSS 变量，手动模式下要单独打标记
  if (typeof document !== 'undefined') {
    if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', state.effectiveTheme)
    document.documentElement.setAttribute('lang', state.effectiveLocale)
  }
  // #endif

  try {
    uni.setNavigationBarColor({
      frontColor: c.front as '#ffffff' | '#000000',
      backgroundColor: c.bg,
    })
  } catch { /* 部分端在页面就绪前调用会抛错，忽略 */ }

  if (titleKey) {
    try { uni.setNavigationBarTitle({ title: tt(titleKey) }) } catch { /* noop */ }
  }

  try {
    uni.setTabBarStyle({
      color: c.tabColor,
      selectedColor: c.tabSelected,
      backgroundColor: c.bg,
      borderStyle: state.effectiveTheme === 'dark' ? 'black' : 'white',
    })
    const tabs = ['tab.monitor', 'tab.control', 'tab.files', 'tab.settings']
    tabs.forEach((k, index) => uni.setTabBarItem({ index, text: tt(k) }))
  } catch { /* noop */ }
}

/** 系统主题变化时，auto 模式要跟着走 */
export function watchSystem() {
  // #ifdef H5
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      if (state.theme === 'auto') { resolve(); applyChrome() }
    }
    mq.addEventListener?.('change', onChange)
  }
  // #endif
  try {
    uni.onThemeChange?.(() => {
      if (state.theme === 'auto') { resolve(); applyChrome() }
    })
  } catch { /* noop */ }
}

export function localeName(code: LocaleCode): string {
  return (messages[code] as { lang: { name: string } }).lang.name
}

resolve()
export const prefs = readonly(state)
