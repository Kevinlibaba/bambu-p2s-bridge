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
  /**
   * 等级阈值，按**界面显示**的 A–E（1 干 … 5 湿）计。官方 wiki 原话：
   * "when the display shows Level C or above, the AMS chamber is relatively humid,
   *  so please ensure proper sealing and replace the desiccant as needed."
   * 所以默认 3（C）。
   *
   * 注意 MQTT 报的 `humidity` 方向是反的：**1 = 湿、5 = 干**，Handy/Studio 显示时
   * 用 6 − 值 翻过来。这一条来自 ha-bambulab 源码的注释（definitions.py，
   * humidity_index：「printer sends 1 = wet, 5 = dry」），也和实测吻合：这台
   * AMS 2 Pro 干燥剂新换、Handy 显示很干，MQTT 报的就是 5。第一版按 wiki 的
   * 显示方向直接拿 MQTT 值比，方向反了，差点把「最干」当成「该烘干」推出去。
   */
  level: number
  /** 是否启用等级判断。这台固件在 LAN 上不报百分比（humidity_raw 恒为 0），全靠等级 */
  useLevel: boolean
  /** 持续偏高多久才提醒（毫秒） */
  sustainMs: number
  /** 同一个仓两次提醒的最小间隔（毫秒） */
  repeatMs: number
}

export const DEFAULT_HUMIDITY: HumidityOptions = {
  pct: 50,
  level: 3,
  useLevel: true,
  sustainMs: 2 * 3_600_000,
  repeatMs: 24 * 3_600_000,
}

/** MQTT 的 1（湿）…5（干） → 界面的 1（干）…5（湿） */
export function displayLevel(mqttLevel: number): number {
  const v = Math.round(mqttLevel)
  if (!(v >= 1 && v <= 5)) return 0
  return 6 - v
}

/** 界面上的字母：A 最干 … E 最湿。读数不在 1–5 内返回 '?' */
export function humidityLetter(mqttLevel: number): string {
  const d = displayLevel(mqttLevel)
  return d ? 'ABCDE'[d - 1] : '?'
}

interface UnitTrack {
  highSince: number | null
  /** null = 从没响过。不能用 0：那会被当成「0 时刻响过一次」把第一次压掉 */
  lastNotified: number | null
}

export class HumidityWatch {
  private readonly units = new Map<number, UnitTrack>()

  constructor(private readonly opts: HumidityOptions = DEFAULT_HUMIDITY) {}

  /**
   * 某个仓此刻算不算偏高：百分比或等级任一超过阈值。
   *
   * 两个刻度方向一致（数越大越湿：等级 1 最干、5 最湿），但不是每台都有百分比 ——
   * 旧款 AMS 的 humidity_raw 恒为 0，只有等级是真的。只看百分比的话，这种机器
   * 永远触发不了；只看等级的话，新款的百分比又白给了。所以两个都看。
   */
  private isHigh(u: Summary['amsUnits'][number]): boolean {
    // 百分比：只有 1–100 才是真读数，0 是「没报」
    const pct = u.humidityPct
    const pctHigh = pct !== null && pct !== undefined && pct >= 1 && pct >= this.opts.pct
    return pctHigh || (this.opts.useLevel && displayLevel(u.humidity) >= this.opts.level)
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
      // 界面上等级显示为 A–E（显示方向）；有真百分比就一起写
      const letter = humidityLetter(u.humidity)
      const reading = u.humidityPct
        ? `${Math.round(u.humidityPct)}%（${letter} 级）`
        : `${letter} 级`
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
