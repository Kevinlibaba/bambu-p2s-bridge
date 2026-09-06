/*
 * 历史页「再打一次」到文件页的接力。
 *
 * 文件页是 tabBar 页，uni.switchTab 带不了参数，两页之间只能靠这个模块级变量传话。
 * 文件页在 onShow 里取走即清 —— 否则下次随便切回文件页，同一个文件又会自己弹出来。
 */
export interface PendingOpen {
  /** 打印机上的 3mf 路径，如 /foo.gcode.3mf */
  path: string
  /** 上次打的盘号（1 起）；历史记录里没有就为 null */
  plate: number | null
}

let pending: PendingOpen | null = null

export function requestOpen(p: PendingOpen) {
  pending = p
}

export function takePendingOpen(): PendingOpen | null {
  const p = pending
  pending = null
  return p
}
