/**
 * 收菜之后拍一张「床空了没」。
 *
 * 推件序列是 gcode_line 一次性下发的，打印机不会回一句「推完了」。所以只能
 * 自己等：序列里先等热床冷到目标温度（M190），冷透了才推 —— 那我们也盯着
 * 热床，降到目标之后再等一会儿让推件动作走完，然后抓帧。
 *
 * 这张图是打印队列的前置：机器没法确认件真的掉下去了（实测见过被 brim
 * 拽回来的），但人看一眼就知道。
 */
import type { PrinterState } from '../printer/state.js'
import type { NotifyEvent } from './events.js'

export interface AfterHarvestDeps {
  /** 当前热床温度 */
  bedTemp: () => number
  /** 带快照发出去。快照由 Notifier 负责抓 */
  notify: (e: NotifyEvent) => Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 热床到目标温度之后，再给推件动作留这么久 */
const SETTLE_MS = 60_000
/** 冷却最多等这么久，环境温度本来就可能高于目标 */
const MAX_WAIT_MS = 45 * 60_000
const POLL_MS = 5_000

export class HarvestSnapshot {
  private pending = false

  constructor(private readonly deps: AfterHarvestDeps) {}

  /**
   * 推件序列已经下发，安排一次拍照。同一时刻只安排一个 —— 连点两次收菜
   * 不该拍两张。
   */
  schedule(bedTarget: number): void {
    if (this.pending) return
    this.pending = true
    void this.run(bedTarget).finally(() => { this.pending = false })
  }

  private async run(bedTarget: number): Promise<void> {
    const now = this.deps.now ?? Date.now
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
    const start = now()
    // 目标温度留 2℃ 余量：M190 R 等的是「到达」，读数会在目标附近抖
    while (this.deps.bedTemp() > bedTarget + 2) {
      if (now() - start > MAX_WAIT_MS) return
      await sleep(POLL_MS)
    }
    await sleep(SETTLE_MS)
    await this.deps.notify({
      kind: 'harvestDone',
      key: `harvest:${start}`,
      title: '收菜完成',
      body: '看一眼热床是不是空了',
    }).catch(() => {})
  }
}
