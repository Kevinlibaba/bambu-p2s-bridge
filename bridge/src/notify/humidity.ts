/**
 * AMS 受潮提醒。
 *
 * PETG、TPU、尼龙受潮的后果是拉丝、爆米花、层间不粘，而且是慢慢变差，
 * 不会有哪一刻「报错」。AMS 自己有湿度读数，但没人天天去看。这里盯着它：
 * 湿度**持续**偏高超过若干小时才提醒 —— 开盖换料那一会儿湿度会蹿一下，
 * 立刻响就是噪声。烘干进行中不提醒（湿度本来就在降）。每个仓一天最多一次。
 *
 * 纯逻辑，不碰时钟也不碰网络，方便脱机测试。
 */
import type { Summary } from '../printer/state.js'
import type { NotifyEvent } from './events.js'

export interface HumidityOptions {
  /** 湿度百分比阈值。有百分比读数时用它 */
  pct: number
  /** 没有百分比时退回等级：1 最干、5 最湿，≥ 这个等级算偏高 */
  level: number
  /** 持续偏高多久才提醒（毫秒） */
  sustainMs: number
  /** 同一个仓两次提醒的最小间隔（毫秒） */
  repeatMs: number
}

export const DEFAULT_HUMIDITY: HumidityOptions = {
  pct: 50,
  level: 4,
  sustainMs: 2 * 3_600_000,
  repeatMs: 24 * 3_600_000,
}

interface UnitTrack {
  highSince: number | null
  /** null = 从没响过。不能用 0：那会被当成「0 时刻响过一次」把第一次压掉 */
  lastNotified: number | null
}

export class HumidityWatch {
  private readonly units = new Map<number, UnitTrack>()

  constructor(private readonly opts: HumidityOptions = DEFAULT_HUMIDITY) {}

  /** 某个仓此刻算不算偏高 */
  private isHigh(u: Summary['amsUnits'][number]): boolean {
    if (u.humidityPct !== null && u.humidityPct !== undefined) return u.humidityPct >= this.opts.pct
    return u.humidity >= this.opts.level
  }

  update(s: Summary, now: number): NotifyEvent[] {
    const out: NotifyEvent[] = []
    for (const u of s.amsUnits ?? []) {
      const t = this.units.get(u.id) ?? { highSince: null, lastNotified: null }
      this.units.set(u.id, t)
      const drying = u.dryStatus === 'drying' || u.dryStatus === 'checking'
      if (!this.isHigh(u) || drying) {
        // 降下来了（或正在烘）就重新计时 —— 下次偏高要再持续够久才算
        t.highSince = null
        continue
      }
      if (t.highSince === null) t.highSince = now
      if (now - t.highSince < this.opts.sustainMs) continue
      if (t.lastNotified !== null && now - t.lastNotified < this.opts.repeatMs) continue
      t.lastNotified = now
      const reading = u.humidityPct !== null && u.humidityPct !== undefined
        ? `${Math.round(u.humidityPct)}%`
        : `等级 ${u.humidity}/5`
      const hours = Math.round((now - t.highSince) / 3_600_000)
      out.push({
        kind: 'amsHumid',
        key: `humid:${u.id}`,
        title: `AMS ${u.id + 1} 该烘干了`,
        body: `仓内湿度 ${reading}，已持续 ${hours} 小时偏高`,
      })
    }
    return out
  }
}
