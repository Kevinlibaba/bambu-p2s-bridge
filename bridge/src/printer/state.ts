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
  amsUnits: AmsUnit[]
  /** 阻止启动烘干的原因，空数组表示可以开始 */
  dryBlockers: DryBlocker[]
  updatedAt: number
}

/** 与 Bambu 自己的 DevAms::DryStatus 枚举对齐 */
export type DryStatus = 'off' | 'checking' | 'drying' | 'cooling' | 'unknown'

/**
 * 没有 AMS 独立电源适配器时，烘干只能在打印机空闲且已退料的状态下进行。
 * 有适配器时可与打印并行 —— 手头没有适配器，暂不实现那条路径。
 */
export type DryBlocker = 'printing' | 'filamentLoaded' | 'alreadyDrying'

export interface AmsUnit {
  id: number
  /** 仓内温度 ℃ */
  temp: number
  /** 湿度等级 1–5 */
  humidity: number
  /**
   * 湿度百分比。Bambu 的解析器把 humidity_raw 读作 m_humidity_percent，
   * 但这台固件一直上报 0 —— 取不到时为 null，界面回退到显示等级。
   */
  humidityPct: number | null
  dryStatus: DryStatus
  /** 烘干剩余分钟，未烘干为 0 */
  dryRemainMin: number
  /** 当前进料的槽位号，未进料为 null */
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
  /** 该卷耗材 RFID 里带的推荐烘干参数，0 表示没有 */
  dryTemp: number
  dryHours: number
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
      amsUnits: this.amsUnits(),
      dryBlockers: this.dryBlockers(),
      updatedAt: this.lastReportAt,
    }
  }

  /**
   * AMS 的 info 是十六进制位域。位段取法来自 BambuStudio 的
   * DevFilaSystemParser：dry_status = get_flag_bits(info, 4, 4)。
   * 实测 0x1003=未烘干 / 0x1013=自检 / 0x1023=烘干中，与枚举一致。
   */
  private dryStatusOf(info: unknown): DryStatus {
    const v = parseInt(String(info ?? ''), 16)
    if (!Number.isFinite(v)) return 'unknown'
    switch ((v >> 4) & 0xf) {
      case 0: return 'off'
      case 1: return 'checking'
      case 2: return 'drying'
      case 3: return 'cooling'
      default: return 'unknown'
    }
  }

  /** tray_now 为 255 表示没有耗材进到挤出机 */
  private loadedSlot(): number | null {
    const n = num(this.raw.ams?.tray_now, 255)
    return n === 255 ? null : n
  }

  private amsUnits(): AmsUnit[] {
    const units = this.raw.ams?.ams
    if (!Array.isArray(units)) return []
    const loaded = this.loadedSlot()
    return units.map((u: Json) => {
      const id = num(u.id)
      return {
        id,
        temp: num(u.temp),
        humidity: num(u.humidity),
        humidityPct: num(u.humidity_raw) > 0 ? num(u.humidity_raw) : null,
        dryStatus: this.dryStatusOf(u.info),
        dryRemainMin: num(u.dry_time),
        // tray_now 是全局槽位号（unit * 4 + slot），换算回本单元
        loadedSlot: loaded !== null && Math.floor(loaded / 4) === id ? loaded % 4 : null,
      }
    })
  }

  private dryBlockers(): DryBlocker[] {
    const out: DryBlocker[] = []
    const st = String(this.raw.gcode_state ?? '')
    if (['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(st)) out.push('printing')
    if (this.loadedSlot() !== null) out.push('filamentLoaded')
    if (this.amsUnits().some((u) => u.dryStatus === 'drying' || u.dryStatus === 'checking')) {
      out.push('alreadyDrying')
    }
    return out
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
          dryTemp: num(t.drying_temp),
          dryHours: num(t.drying_time),
          empty: !type,
        })
      }
    }
    return out
  }
}
