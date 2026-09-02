/**
 * 推件：把打完的件用打印头推下热床。
 *
 * 单独开一个接口，而不是让调用方走原始 G-code 通道。原因有两个：
 *  · 原始 G-code 等于把任意指令权限交给持有 token 的人，为了一个具体
 *    功能去打开它不划算；
 *  · 这个动作有真实机械风险，前置条件必须由服务端强制，不能指望调用方
 *    自觉。轨迹可以商量，护栏不行。
 *
 * 强制的前置条件：
 *  · 打印机必须空闲。打印中推件等于直接撞进正在打的件里。
 *  · 有未清除的报错时不动。状态不明的时候让机器动起来是最坏的选择。
 *  · 必须显式 confirm。默认只回 G-code 不下发。
 *
 * 冷却那一步默认开着。PEI 板在热的时候附着力极强，不冷到 ~25℃ 根本推不动，
 * 硬推只会把力全顶在热端上。允许关掉，但仅用于「床上没有任何东西」的
 * 空跑验证 —— 那时没有件可粘，也就没有可顶坏的东西。
 */
import type { FastifyInstance } from 'fastify'
import type { PrinterMqtt } from '../printer/mqtt.js'
import type { PrinterState } from '../printer/state.js'
import { planEject, type EjectOptions, type PlateObject } from '../eject/plan.js'

class EjectError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'EjectError'
  }
}

/** 这些状态下机器正在动，绝对不能插进去 */
const BUSY = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'])

export interface EjectRequest {
  /** 要推的件。bbox 为 [xmin, ymin, xmax, ymax]，床坐标 mm */
  objects?: PlateObject[]
  /** 整盘最高点，取自 gcode 头部的 max_z_height */
  maxZ?: number
  mode?: EjectOptions['mode']
  pushZ?: number
  bedTarget?: number
  /**
   * 是否等热床冷却。默认 true。
   * 只有在床上确实空无一物、纯粹验证运动路径时才允许关。
   */
  cool?: boolean
  /** 不显式确认就只回 G-code，不下发 */
  confirm?: boolean
}

const BED = { width: 256, depth: 256 }

export function registerEjectRoutes(
  app: FastifyInstance,
  state: PrinterState,
  mqtt: PrinterMqtt,
): void {
  app.post('/api/eject', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as EjectRequest
      const objects = Array.isArray(body.objects) ? body.objects : []
      if (objects.length === 0) throw new EjectError('没有给出要推的件')
      for (const o of objects) {
        if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || o.bbox.some((n) => !Number.isFinite(n)))
          throw new EjectError('bbox 必须是四个数：[xmin, ymin, xmax, ymax]')
      }
      const maxZ = Number(body.maxZ)
      if (!Number.isFinite(maxZ) || maxZ <= 0) throw new EjectError('maxZ 必须是正数')

      const plan = planEject(objects, { bed: BED, maxZ }, {
        mode: body.mode ?? 'standalone',
        ...(Number.isFinite(body.pushZ as number) ? { pushZ: Number(body.pushZ) } : {}),
        ...(Number.isFinite(body.bedTarget as number) ? { bedTarget: Number(body.bedTarget) } : {}),
      })

      // 冷却是安全措施，去掉它要显式说，并且只在空跑时有意义
      const cool = body.cool !== false
      const gcode = cool ? plan.gcode : plan.gcode.filter((l) => !/^M(190|140|106 P2)\b/.test(l))

      if (plan.order.length === 0) {
        return reply.code(409).send({ error: '没有可推的件', warnings: plan.warnings })
      }

      if (!body.confirm) {
        return { dryRun: true, cool, order: plan.order, warnings: plan.warnings, gcode }
      }

      const s = state.summary()
      if (!mqtt.connected) throw new EjectError('打印机未连接', 503)
      if (BUSY.has(s.state)) throw new EjectError(`打印机正忙（${s.state}），不能推件`, 409)
      if (s.printError) throw new EjectError('打印机有未清除的报错，先处理再推件', 409)

      const sequenceId = mqtt.publish({
        print: { command: 'gcode_line', param: gcode.join('\n') + '\n' },
      })
      return { sent: true, sequenceId, cool, order: plan.order, warnings: plan.warnings, gcode }
    } catch (e) {
      if (e instanceof EjectError) return reply.code(e.status).send({ error: e.message })
      return reply.code(500).send({ error: (e as Error).message })
    }
  })
}
