/**
 * 从状态跃迁里识别「值得打扰用户」的事件。
 *
 * 纯函数：吃前后两个 Summary，吐事件列表，不碰网络也不碰时间。
 * 这样噪声控制的规则可以脱机测试 —— 推送最怕的就是乱响。
 */
import type { Summary } from '../printer/state.js'

export type NotifyKind =
  | 'printDone'
  | 'printFailed'
  | 'printPaused'
  | 'printStarted'
  | 'error'
  | 'dryDone'
  | 'offline'
  | 'online'

export const NOTIFY_KINDS: NotifyKind[] = [
  'printDone',
  'printFailed',
  'printPaused',
  'printStarted',
  'error',
  'dryDone',
  'offline',
  'online',
]

export interface NotifyEvent {
  kind: NotifyKind
  /** 同一件事的稳定标识，用于去重 */
  key: string
  title: string
  body: string
  /** 错误类事件带上错误码，接收端可以据此查官方释义 */
  code?: string
}

/** 打印中的状态。从这些状态跃迁出去才算「这一单结束了」 */
const ACTIVE = new Set(['RUNNING', 'PREPARE', 'SLICING'])

function taskOf(s: Summary): string {
  return s.taskName || s.file || ''
}

function hmsCodes(s: Summary): string[] {
  return (s.errors ?? []).map((e) => {
    const attr = Number((e as { attr?: unknown }).attr) >>> 0
    const code = Number((e as { code?: unknown }).code) >>> 0
    return attr.toString(16).toUpperCase().padStart(8, '0') +
      code.toString(16).toUpperCase().padStart(8, '0')
  })
}

const hex8 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0')

/**
 * 比较前后状态，给出应当推送的事件。
 *
 * prev 缺席时只认「离线」这一种，否则桥接重启一次就会把打印机当前的状态
 * 当成刚发生的事播报一遍。注意「缺席」不只是 prev === null：
 * MQTT 一连上就会先发一次空状态（还没收到任何 report，updatedAt 为 0），
 * 紧接着第一份 report 会让 state 从 '' 跳到实际值 —— 那不是一次真实跃迁。
 * 这是实测踩到的：重启后收到过一条「打印失败」，而那次失败是几小时前的事。
 */
function seen(s: Summary | null): s is Summary {
  return !!s && s.updatedAt > 0
}

export function detect(prev: Summary | null, next: Summary): NotifyEvent[] {
  const out: NotifyEvent[] = []
  const task = taskOf(next)

  if (!seen(prev)) {
    if (!next.online) {
      out.push({ kind: 'offline', key: 'offline', title: '打印机离线', body: '桥接连不上打印机' })
    }
    return out
  }

  // —— 在线状态 ——
  if (prev.online && !next.online) {
    out.push({ kind: 'offline', key: 'offline', title: '打印机离线', body: '桥接与打印机的连接断开了' })
  } else if (!prev.online && next.online) {
    out.push({ kind: 'online', key: 'online', title: '打印机已恢复', body: '连接恢复正常' })
  }

  // —— 打印任务 ——
  if (prev.state !== next.state) {
    if (next.state === 'FINISH' && ACTIVE.has(prev.state)) {
      out.push({
        kind: 'printDone',
        key: `done:${task}`,
        title: '打印完成',
        body: task || '任务已完成',
      })
    } else if (next.state === 'FAILED') {
      out.push({
        kind: 'printFailed',
        key: `failed:${task}:${next.printError}`,
        title: '打印失败',
        body: task ? `${task} · 进度 ${next.progress}%` : `进度 ${next.progress}%`,
        code: next.printError ? hex8(next.printError) : undefined,
      })
    } else if (next.state === 'PAUSE' && prev.state !== 'PAUSE') {
      out.push({
        kind: 'printPaused',
        key: `paused:${task}:${next.printError}`,
        title: '打印已暂停',
        body: task ? `${task} · 进度 ${next.progress}%` : `进度 ${next.progress}%`,
        code: next.printError ? hex8(next.printError) : undefined,
      })
    } else if (ACTIVE.has(next.state) && !ACTIVE.has(prev.state)) {
      out.push({
        kind: 'printStarted',
        key: `start:${task}`,
        title: '开始打印',
        body: task || '新任务已开始',
      })
    }
  }

  // —— 报错 ——
  // print_error 与 HMS 常常成对出现，合并成一条，别响两次
  const newHms = hmsCodes(next).filter((c) => !hmsCodes(prev).includes(c))
  const newPrintError = next.printError && next.printError !== prev.printError
  if (newPrintError || newHms.length) {
    const code = newPrintError ? hex8(next.printError) : newHms[0]
    // 暂停/失败已经带了错误码，不再单独响一次
    const alreadyTold = out.some((e) => e.code === code)
    if (!alreadyTold) {
      out.push({
        kind: 'error',
        key: `err:${code}`,
        title: '打印机报错',
        body: `错误码 ${code}`,
        code,
      })
    }
  }

  // —— 烘干 ——
  for (const u of next.amsUnits ?? []) {
    const before = (prev.amsUnits ?? []).find((x) => x.id === u.id)
    if (!before) continue
    const wasDrying = before.dryStatus === 'drying' || before.dryStatus === 'checking'
    const stopped = u.dryStatus === 'off' || u.dryStatus === 'cooling'
    if (wasDrying && stopped) {
      out.push({
        kind: 'dryDone',
        key: `dry:${u.id}`,
        title: '烘干结束',
        body: `AMS ${u.id + 1} · 仓温 ${Math.round(u.temp)}℃`,
      })
    }
  }

  return out
}
