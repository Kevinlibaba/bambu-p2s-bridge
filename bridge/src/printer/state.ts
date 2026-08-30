import { EventEmitter } from 'node:events'

export type Json = Record<string, any>

/**
 * Bambu 的 report 是增量推送，只发变化字段，必须深合并。
 * 数组整体替换 —— AMS 料盘等结构固件是整段下发的，逐元素合并反而会残留脏数据。
 */
export function deepMerge<T extends Json>(target: T, patch: Json): T {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      ;(target as Json)[k] = v
    } else if (typeof v === 'object') {
      const cur = (target as Json)[k]
      ;(target as Json)[k] = deepMerge(
        cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {},
        v,
      )
    } else {
      ;(target as Json)[k] = v
    }
  }
  return target
}

export interface Summary {
  online: boolean
  state: string            // IDLE / RUNNING / PAUSE / FINISH / FAILED
  progress: number         // 0-100
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
  errors: any[]
  printError: number
  wifi: string
  sdcard: boolean
  ams: AmsTray[]
  updatedAt: number
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
  empty: boolean
}

const num = (v: any, d = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : d
}

export class PrinterState extends EventEmitter {
  /** 完整原始状态（95+ 字段的 print 子树） */
  raw: Json = {}
  lastReportAt = 0
  connected = false

  applyReport(msg: Json) {
    const p = msg.print
    if (!p) return
    deepMerge(this.raw, p)
    this.lastReportAt = Date.now()
    this.emit('update', this.summary(), p)
  }

  setConnected(v: boolean) {
    if (this.connected === v) return
    this.connected = v
    this.emit('update', this.summary(), {})
  }

  summary(): Summary {
    const r = this.raw
    const dev = r.device ?? {}
    return {
      online: this.connected,
      state: r.gcode_state ?? 'UNKNOWN',
      progress: num(r.mc_percent),
      remainingMin: num(r.mc_remaining_time),
      layer: num(r.layer_num),
      totalLayers: num(r.total_layer_num),
      taskName: r.subtask_name ?? '',
      file: r.gcode_file ?? '',
      nozzle: {
        cur: num(r.nozzle_temper),
        target: num(r.nozzle_target_temper),
        type: r.nozzle_type ?? '',
        diameter: r.nozzle_diameter ?? '',
      },
      bed: { cur: num(r.bed_temper), target: num(r.bed_target_temper) },
      // P2S 没有 chamber_temper，腔温在 device.ctc.info.temp
      chamber: dev.ctc?.info?.temp ?? (r.chamber_temper ?? null),
      fans: {
        cooling: num(r.cooling_fan_speed),
        aux: num(r.big_fan1_speed),
        chamber: num(r.big_fan2_speed),
        heatbreak: num(r.heatbreak_fan_speed),
      },
      speedLevel: num(r.spd_lvl),
      speedPct: num(r.spd_mag, 100),
      lights: r.lights_report ?? [],
      errors: r.hms ?? [],
      printError: num(r.print_error),
      wifi: r.wifi_signal ?? '',
      sdcard: !!r.sdcard,
      ams: this.amsTrays(),
      updatedAt: this.lastReportAt,
    }
  }

  private amsTrays(): AmsTray[] {
    const units = this.raw.ams?.ams
    if (!Array.isArray(units)) return []
    const out: AmsTray[] = []
    for (const unit of units) {
      const uid = num(unit.id)
      for (const t of unit.tray ?? []) {
        const type = t.tray_type ?? ''
        out.push({
          unit: uid,
          slot: num(t.id),
          type,
          subBrand: t.tray_sub_brands ?? '',
          color: t.tray_color ?? '',
          remainPct: num(t.remain, -1),
          nozzleTempMin: num(t.nozzle_temp_min),
          nozzleTempMax: num(t.nozzle_temp_max),
          empty: !type,
        })
      }
    }
    return out
  }
}
