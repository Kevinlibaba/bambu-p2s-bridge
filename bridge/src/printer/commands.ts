import { config } from '../config.js'
import type { PrinterMqtt } from './mqtt.js'
import type { Json } from './state.js'

export type CommandInput =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'light'; node?: string; on: boolean }
  | { type: 'speed'; level: 1 | 2 | 3 | 4 }
  | { type: 'nozzleTemp'; celsius: number }
  | { type: 'bedTemp'; celsius: number }
  | { type: 'home' }
  | { type: 'pushall' }
  | { type: 'gcode'; lines: string }

export class CommandError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const MAX_NOZZLE = 300
const MAX_BED = 110

/**
 * 命令白名单。任何不在此处的命令一律拒绝——
 * 直通 gcode 能控制加热和运动，必须显式开关 + 二次确认。
 */
export function buildCommand(input: CommandInput): Json {
  switch (input.type) {
    case 'pause':
      return { print: { command: 'pause' } }
    case 'resume':
      return { print: { command: 'resume' } }
    case 'stop':
      return { print: { command: 'stop' } }

    case 'light': {
      const node = input.node ?? 'chamber_light'
      if (!['chamber_light', 'work_light'].includes(node))
        throw new CommandError(`不支持的灯光节点: ${node}`)
      return {
        system: {
          command: 'ledctrl',
          led_node: node,
          led_mode: input.on ? 'on' : 'off',
          led_on_time: 500,
          led_off_time: 500,
          loop_times: 0,
          interval_time: 0,
        },
      }
    }

    case 'speed': {
      if (![1, 2, 3, 4].includes(input.level))
        throw new CommandError('速度档位必须是 1(静音) / 2(标准) / 3(运动) / 4(狂暴)')
      return { print: { command: 'print_speed', param: String(input.level) } }
    }

    case 'nozzleTemp': {
      const t = Math.round(input.celsius)
      if (!Number.isFinite(t) || t < 0 || t > MAX_NOZZLE)
        throw new CommandError(`喷嘴温度必须在 0-${MAX_NOZZLE}℃`)
      return { print: { command: 'gcode_line', param: `M104 S${t}\n` } }
    }

    case 'bedTemp': {
      const t = Math.round(input.celsius)
      if (!Number.isFinite(t) || t < 0 || t > MAX_BED)
        throw new CommandError(`热床温度必须在 0-${MAX_BED}℃`)
      return { print: { command: 'gcode_line', param: `M140 S${t}\n` } }
    }

    case 'home':
      return { print: { command: 'gcode_line', param: 'G28\n' } }

    case 'pushall':
      return { pushing: { command: 'pushall' } }

    case 'gcode': {
      if (!config.allowRawGcode)
        throw new CommandError('原始 G-code 已禁用（设置 ALLOW_RAW_GCODE=true 开启）', 403)
      if (typeof input.lines !== 'string' || !input.lines.trim())
        throw new CommandError('gcode 内容为空')
      if (input.lines.length > 2000) throw new CommandError('gcode 过长')
      const param = input.lines.endsWith('\n') ? input.lines : input.lines + '\n'
      return { print: { command: 'gcode_line', param } }
    }

    default:
      throw new CommandError(`未知命令: ${(input as any).type}`)
  }
}

export function execute(mqtt: PrinterMqtt, input: CommandInput) {
  if (input.type === 'pushall') {
    const sent = mqtt.pushall('api')
    return { ok: sent, throttled: !sent }
  }
  const seq = mqtt.publish(buildCommand(input))
  return { ok: true, sequenceId: seq }
}
