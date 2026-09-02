/**
 * 预约收菜：这一单打完之后自动把件推下热床。
 *
 * 为什么要有它 —— 手动收菜要求人守在旁边等打印结束、再等热床冷透，
 * 而这两件事加起来可能一个多小时。预约之后就不用守了。
 *
 * 时序是被实测钉死的，顺序不能改：
 *
 *   1. 状态从「打印中」跃迁到 FINISH  → 立刻开三个风扇
 *   2. 盯着 bed_temper，等它降到阈值   → 热的时候件粘在板上推不动，
 *                                        硬推只会把力顶在热端上
 *   3. 再下发推件序列
 *
 * 第 2 步刻意不用序列里的 M190 去等：M190 的 R/S 语义在这台机器上没验证过，
 * 万一它不按预期返回就会把指令队列一直卡着。自己盯温度是可控的。
 *
 * 一次性：执行过（或失败、或取消）就自动解除，不会在下一单继续生效 ——
 * 让机器在你不知情的时候动起来是最坏的结果。
 */
import type { PrinterState, Summary } from '../printer/state.js'

/** 这些状态算「正在打印」，从它们跃迁到 FINISH 才是一单结束 */
const ACTIVE = new Set(['RUNNING', 'PREPARE', 'SLICING'])

export type AutoPhase = 'idle' | 'waitingPrint' | 'cooling' | 'ejecting' | 'done' | 'failed'

export interface AutoStatus {
  armed: boolean
  phase: AutoPhase
  /** 失败时给出原因，成功时为 null */
  error: string | null
  bedTarget: number
}

export interface AutoDeps {
  /** 开风扇降温（不动轴、不带 M190） */
  cool: () => Promise<void>
  /** 真正下发推件序列 */
  eject: () => Promise<void>
  now?: () => number
}

/** 降到这个温度才推。实测 28℃ 就够，留一点余量 */
const DEFAULT_BED_TARGET = 30
/** 降温最多等这么久，超时就放弃 —— 环境温度本来就可能高于阈值 */
const COOL_TIMEOUT_MS = 45 * 60_000

export class AutoHarvest {
  private armed = false
  private phase: AutoPhase = 'idle'
  private error: string | null = null
  private prevState = ''
  private coolingSince = 0
  private running = false

  constructor(
    private readonly state: PrinterState,
    private readonly deps: AutoDeps,
    private readonly bedTarget = DEFAULT_BED_TARGET,
  ) {}

  start(): void {
    this.state.on('update', (s: Summary) => {
      void this.onUpdate(s)
    })
  }

  status(): AutoStatus {
    return { armed: this.armed, phase: this.phase, error: this.error, bedTarget: this.bedTarget }
  }

  arm(on: boolean): AutoStatus {
    this.armed = on
    this.phase = on ? 'waitingPrint' : 'idle'
    this.error = null
    this.coolingSince = 0
    return this.status()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private fail(msg: string): void {
    this.armed = false
    this.phase = 'failed'
    this.error = msg
  }

  private async onUpdate(s: Summary): Promise<void> {
    const prev = this.prevState
    this.prevState = s.state
    if (!this.armed || this.running) return

    if (this.phase === 'waitingPrint') {
      // 只认「打印中 → FINISH」这一次跃迁。已经是 FINISH 的状态不算，
      // 否则预约的瞬间就会对着上一单触发
      if (!(s.state === 'FINISH' && ACTIVE.has(prev))) return
      this.phase = 'cooling'
      this.coolingSince = this.now()
      this.running = true
      try {
        await this.deps.cool()
      } catch (e) {
        this.fail(`开风扇失败: ${(e as Error).message}`)
      } finally {
        this.running = false
      }
      return
    }

    if (this.phase === 'cooling') {
      // 打印又开始了 —— 说明用户接着打下一单，这次预约作废
      if (ACTIVE.has(s.state)) {
        this.fail('等待降温期间又开始打印了')
        return
      }
      if (this.now() - this.coolingSince > COOL_TIMEOUT_MS) {
        this.fail('等了很久热床仍未降到目标温度')
        return
      }
      if (s.bed.cur > this.bedTarget) return

      this.phase = 'ejecting'
      this.running = true
      try {
        await this.deps.eject()
        this.armed = false
        this.phase = 'done'
      } catch (e) {
        this.fail((e as Error).message)
      } finally {
        this.running = false
      }
    }
  }
}
