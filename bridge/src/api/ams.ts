/**
 * AMS 耗材烘干。
 *
 * 命令格式取自 BambuStudio 源码 DevFilaSystemCtrl.cpp 的
 * CtrlAmsStartDryingHour / CtrlAmsStopDrying，并在真机上验证过：
 * 启动后 dry_time 开始倒计时、仓温上升、info 位域切到 Drying。
 *
 * 前置条件（无 AMS 独立电源适配器时）：
 *   · 打印机必须空闲 —— 有任务时被拒，对应 CannotDryReason::TaskOccupied
 *   · 必须已退料   —— 耗材在出口时被拒，对应 ConsumableAtAmsOutlet
 * 两条都实测确认过：停掉任务并退料之前，启动一律返回 err 0x05004040。
 * 有适配器时可与打印并行，但手头没有适配器，那条路径不实现。
 */
import type { FastifyInstance } from 'fastify'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState, DryBlocker } from '../printer/state.js'

class AmsError extends Error {
  constructor(message: string, readonly status = 400, readonly blockers?: DryBlocker[]) {
    super(message)
    this.name = 'AmsError'
  }
}

/** AMS 2 Pro 的加热上限。协议下限 45，再低没有除湿意义 */
const TEMP_MIN = 45
const TEMP_MAX = 65
const HOURS_MIN = 1
const HOURS_MAX = 24

export interface DryStartRequest {
  amsId?: number
  temp?: number
  duration?: number
  filament?: string
  rotateTray?: boolean
}

export function registerAmsRoutes(
  app: FastifyInstance,
  mqtt: PrinterMqtt,
  state: PrinterState,
): void {
  function unitOrThrow(raw: unknown): number {
    const id = Number(raw ?? 0)
    if (!Number.isInteger(id) || id < 0) throw new AmsError('AMS 编号无效')
    if (!state.summary().amsUnits.some((u) => u.id === id)) {
      throw new AmsError(`没有编号为 ${id} 的 AMS`, 404)
    }
    return id
  }

  function requireConnected() {
    if (!mqtt.connected) throw new AmsError('打印机未连接', 503)
  }

  function fail(e: unknown) {
    const err = e as AmsError
    if (err.name === 'AmsError') {
      return { status: err.status, body: { error: err.message, blockers: err.blockers } }
    }
    return { status: 500, body: { error: (e as Error).message } }
  }

  app.post('/api/ams/dry/start', async (req, reply) => {
    try {
      requireConnected()
      const body = (req.body ?? {}) as DryStartRequest
      const amsId = unitOrThrow(body.amsId)

      // 服务端强制校验，不依赖客户端自觉
      const blockers = state.summary().dryBlockers
      if (blockers.length) {
        throw new AmsError('当前状态不允许开始烘干', 409, blockers)
      }

      const temp = Math.round(Number(body.temp))
      if (!Number.isFinite(temp) || temp < TEMP_MIN || temp > TEMP_MAX) {
        throw new AmsError(`温度必须在 ${TEMP_MIN}–${TEMP_MAX}℃`)
      }
      const duration = Math.round(Number(body.duration))
      if (!Number.isFinite(duration) || duration < HOURS_MIN || duration > HOURS_MAX) {
        throw new AmsError(`时长必须在 ${HOURS_MIN}–${HOURS_MAX} 小时`)
      }

      const sequenceId = mqtt.publish({
        print: {
          command: 'ams_filament_drying',
          ams_id: amsId,
          mode: 1, // DryCtrlMode::OnTime
          filament: String(body.filament ?? ''),
          temp,
          duration,
          humidity: 0,
          rotate_tray: body.rotateTray === true,
          cooling_temp: 40,
          close_power_conflict: false,
        },
      })
      return { ok: true, sequenceId, amsId, temp, duration }
    } catch (e) {
      const { status, body } = fail(e)
      return reply.code(status).send(body)
    }
  })

  app.post('/api/ams/dry/stop', async (req, reply) => {
    try {
      requireConnected()
      const amsId = unitOrThrow((req.body as { amsId?: number } | undefined)?.amsId)
      const sequenceId = mqtt.publish({
        print: {
          command: 'ams_filament_drying',
          ams_id: amsId,
          mode: 0, // DryCtrlMode::Off
          filament: '',
          temp: 0,
          duration: 0,
          humidity: 0,
          rotate_tray: false,
          cooling_temp: 0,
          close_power_conflict: false,
        },
      })
      return { ok: true, sequenceId, amsId }
    } catch (e) {
      const { status, body } = fail(e)
      return reply.code(status).send(body)
    }
  })

  /**
   * 退料。target/slot_id 都取 255 表示卸载，格式取自 BambuStudio 的
   * command_ams_change_filament。喷嘴温度由打印机自行升到 210 再抽出。
   */
  app.post('/api/ams/unload', async (req, reply) => {
    try {
      requireConnected()
      const amsId = unitOrThrow((req.body as { amsId?: number } | undefined)?.amsId)
      const st = state.summary()
      if (['RUNNING', 'PREPARE', 'SLICING'].includes(st.state)) {
        throw new AmsError('打印进行中，无法退料', 409)
      }
      const sequenceId = mqtt.publish({
        print: {
          command: 'ams_change_filament',
          curr_temp: 210,
          tar_temp: 210,
          ams_id: amsId,
          target: 255,
          slot_id: 255,
        },
      })
      return { ok: true, sequenceId, amsId }
    } catch (e) {
      const { status, body } = fail(e)
      return reply.code(status).send(body)
    }
  })
}
