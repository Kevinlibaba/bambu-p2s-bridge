import { createI18n } from 'vue-i18n'
import en from './en.json'
import zhHans from './zh-Hans.json'
import zhHant from './zh-Hant.json'
import ja from './ja.json'

export const messages = {
  en,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  ja,
}

export type LocaleCode = keyof typeof messages
export const LOCALES = Object.keys(messages) as LocaleCode[]

/** 系统语言。uni.getLocale() 已按各端差异归一化成 zh-Hans / zh-Hant / en / ja 这种形式。 */
export function systemLocale(): LocaleCode {
  const raw = (uni.getLocale?.() || 'en') as string
  if (raw in messages) return raw as LocaleCode
  // zh-CN → zh-Hans，en-US → en，诸如此类
  const lower = raw.toLowerCase()
  if (lower.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(lower) ? 'zh-Hant' : 'zh-Hans'
  }
  const base = lower.split('-')[0]
  return (LOCALES.find((l) => l.toLowerCase().split('-')[0] === base) ?? 'en') as LocaleCode
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: systemLocale(),
  fallbackLocale: 'en',
  messages,
})

export const t = i18n.global.t
