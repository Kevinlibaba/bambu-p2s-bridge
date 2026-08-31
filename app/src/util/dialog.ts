/**
 * 系统对话框的统一出口。
 *
 * uni.showModal 的 confirmText / cancelText 不传就是内置的中文「确定」「取消」，
 * 不跟随应用语言。这个坑在五个调用点各踩了一遍 —— 因为 confirm() 当初在
 * 三个页面里各写了一份。收成一处，语言就只需要正确一次。
 */
import { t } from '../locale'

/** iOS 系统蓝 / 系统红。破坏性操作用红色，与列表里的红色文字一致 */
const ACCENT = '#2997ff'
const DANGER = '#ff453a'

export function confirm(title: string, content: string, danger = false): Promise<boolean> {
  return new Promise((resolve) =>
    uni.showModal({
      title,
      content,
      confirmColor: danger ? DANGER : ACCENT,
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      success: (r) => resolve(!!r.confirm),
      // 被系统打断时按「没有确认」处理 —— 破坏性操作宁可不做
      fail: () => resolve(false),
    }),
  )
}

export const toast = (msg: string, ms = 2600) =>
  uni.showToast({ title: msg, icon: 'none', duration: ms })
