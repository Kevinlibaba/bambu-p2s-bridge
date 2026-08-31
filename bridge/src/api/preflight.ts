/**
 * 打印前自检。
 *
 * 远程开打是无人值守的：等你发现不对，机器已经空跑了两小时，
 * 或者拿错料打了一半。这里把开打前能查的都查了，
 * 数据全部来自已有的两处 —— 切片文件与打印机状态，不额外访问任何东西。
 *
 * 只给结论和参数，文案交给前端本地化 —— 桥接不该假定用户用哪种语言。
 */
import type { AmsTray, Summary } from '../printer/state.js'
import type { ThreeMfPlate } from '../printer/threemf.js'

export type CheckLevel = 'error' | 'warn'

export interface Check {
  /** 前端据此选文案，参数放在 params 里 */
  code:
    | 'notSliced'
    | 'slotMissing'
    | 'filamentLow'
    | 'typeMismatch'
    | 'nozzleMismatch'
    | 'printerBusy'
    | 'noSdCard'
    | 'printerError'
    | 'sliceWarning'
  level: CheckLevel
  params?: Record<string, string | number>
}

/** 这些状态下开打会被打印机拒绝，或者会打断正在进行的任务 */
const BUSY = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'])

/** 料盘全局序号 → 料盘。外置料盘固定 254，不参与 编号*4+槽位 的换算 */
function trayAt(trays: AmsTray[], slot: number): AmsTray | undefined {
  return trays.find((t) => (t.unit < 0 ? 254 : t.unit * 4 + t.slot) === slot)
}

/** 外置料盘没有槽位号，提示里用 0 表示，前端据此换成「外置料盘」 */
const slotLabel = (t: AmsTray) => (t.unit < 0 ? 0 : t.slot + 1)

/** 归一化耗材类型，PLA Matte / PLA-CF 都算 PLA 系 */
function family(type: string): string {
  return type.toUpperCase().replace(/[^A-Z]/g, '').replace(/^(PLA|PETG|PET|PCTG|TPU|ABS|ASA|PC|PA|PVA|PP|PE).*$/, '$1')
}

/**
 * @param plate    要打的那个盘，读不出来时传 undefined
 * @param mapping  已经算好的 ams_mapping，null 表示配料失败
 */
export function preflight(
  plate: ThreeMfPlate | undefined,
  mapping: number[] | null,
  trays: AmsTray[],
  s: Summary,
): Check[] {
  const out: Check[] = []

  /*
   * 未切片的原始模型。MakerWorld / Printables 上下载的 .3mf 多半是这种 ——
   * 能上传、能存在卡上，但打印机只认已切片的 .gcode.3mf。
   * 这一条要单独说清楚，否则后面配料那步会报「读不出耗材信息」，
   * 对一个刚下完模型的人来说毫无线索。
   */
  if (!plate || plate.filamentCount <= 0) {
    out.push({ code: 'notSliced', level: 'error' })
  }

  if (BUSY.has(s.state)) out.push({ code: 'printerBusy', level: 'error', params: { state: s.state } })
  if (!s.sdcard) out.push({ code: 'noSdCard', level: 'error' })

  const errCount = (s.errors?.length ?? 0) + (s.printError ? 1 : 0)
  if (errCount > 0) out.push({ code: 'printerError', level: 'warn', params: { count: errCount } })

  // 喷嘴直径。切片文件可能写成 "0.4" 或 "0.4;0.4"（多喷嘴），取第一个比较
  const want = (plate?.nozzleDiameters ?? '').split(/[;,]/)[0]?.trim()
  const have = s.nozzle?.diameter?.trim()
  if (want && have && want !== have) {
    out.push({ code: 'nozzleMismatch', level: 'error', params: { want, have } })
  }

  for (const w of plate?.warnings ?? []) {
    out.push({
      code: 'sliceWarning',
      // 3 是 BambuStudio 里的红色告警，但它仍然允许你打，所以这里也只警告
      level: 'warn',
      params: { msg: w.msg, level: w.level },
    })
  }

  for (const f of plate?.filaments ?? []) {
    const id = f.id ?? 0
    const slot = mapping && id >= 1 && id <= mapping.length ? mapping[id - 1] : -1
    if (slot < 0) {
      out.push({ code: 'slotMissing', level: 'error', params: { id, type: f.type } })
      continue
    }
    const tray = trayAt(trays, slot)
    if (!tray) continue // 外置料盘等非 AMS 目标，没有余量可查

    if (f.type && tray.type && family(f.type) !== family(tray.type)) {
      out.push({
        code: 'typeMismatch',
        level: 'warn',
        params: { id, slot: slotLabel(tray), want: f.type, have: tray.type },
      })
    }

    // remain 为 -1 表示打印机没报余量（无 RFID 的第三方料），此时不猜
    const need = f.usedG ?? 0
    if (need > 0 && tray.remainPct >= 0 && tray.weightG > 0) {
      const left = Math.round((tray.remainPct / 100) * tray.weightG)
      if (left < need) {
        out.push({
          code: 'filamentLow',
          level: 'error',
          params: { id, slot: slotLabel(tray), need: Math.round(need), left },
        })
      } else if (left < need * 1.15) {
        // 余量刚好够，中途断料的代价太大，值得提醒一句
        out.push({
          code: 'filamentLow',
          level: 'warn',
          params: { id, slot: slotLabel(tray), need: Math.round(need), left },
        })
      }
    }
  }

  return out
}

export const blocking = (checks: Check[]): Check[] => checks.filter((c) => c.level === 'error')
