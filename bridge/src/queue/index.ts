/**
 * 打印队列：排 N 件 → 打完 → 收菜 → 拍照 → 起下一件。
 *
 * 这是整个项目「远程无人值守」的终点形态，所以这里的**安全门是硬规则，不给开关**：
 *
 *   · 起下一件之前，上一件必须已经收菜完成，并且它的收菜规划**没有 warn/error 级
 *     告警**（brim、又长又窄可能打转、太高……）。有告警的件打完就停下来，把收菜后
 *     拍的那张「床空了没」推给人看，人确认了才继续。机器没法确认件真的掉下去了 ——
 *     实测见过被 brim 拽回来的；在没清空的床上起下一件，第一层直接撞上去。
 *   · 开打走的是和手动完全相同的函数（自检、配料、不带 force）。自检不过就停，
 *     半夜没人守着，硬开比不开危险。
 *   · 打印失败、有人在队列外开了打印、等冷却超时 —— 一律停下等人，不自作聪明。
 *
 * 两种件的收菜路径不同：
 *   · `.harvest.gcode.3mf`（推件序列已注入结束 G-code）：打印机自己在任务末尾推，
 *     任务 FINISH 时床已经冷透、件已经推过。只需再等一会儿拍照。
 *   · 普通切片文件：FINISH 之后开风扇、盯着热床降到目标，再下发 standalone 推件序列。
 *     这一段和 eject/auto.ts 的预约收菜同源，但队列自己管，避免两个状态机互相踩。
 *
 * 落盘：队列内容和进行到哪一步都写进 /data，桥接重启（部署）不丢。重启后正在
 * 打印的那件继续盯着；收菜进行到一半的直接转成安全停 —— 不知道推没推，让人看。
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { Summary } from '../printer/state.js'
import type { NotifyEvent } from '../notify/events.js'
import type { EjectWarning } from '../eject/plan.js'

export type ItemStatus = 'waiting' | 'printing' | 'harvesting' | 'done' | 'failed' | 'skipped'
export type QueueState = 'idle' | 'running' | 'paused'
export type Phase = 'idle' | 'starting' | 'printing' | 'cooling' | 'ejecting' | 'settling' | 'gap'
export type PauseReason = 'safety' | 'failed' | 'manual' | 'foreign' | 'blocked'

export interface QueueItem {
  id: string
  path: string
  name: string
  plate: number
  slots?: Record<string, number>
  status: ItemStatus
  error: string | null
  /** 文件本身带收菜序列（.harvest.gcode.3mf） */
  injected: boolean
  /** 收菜规划没有 warn/error 级告警 —— 打完可以自动衔接下一件 */
  harvestAuto: boolean
  warnings: EjectWarning[]
  addedAt: number
  startedAt: number | null
  endedAt: number | null
  /** 收菜后拍的快照，相对 URL */
  photo: string | null
}

export interface PauseInfo {
  reason: PauseReason
  message: string
  photo: string | null
}

export interface QueueStatus {
  state: QueueState
  pause: PauseInfo | null
  current: string | null
  phase: Phase
  items: QueueItem[]
  updatedAt: number
}

export interface HarvestPlanInfo {
  injected: boolean
  warnings: EjectWarning[]
  /** 有没有可推的件。没有的话这一盘打完只能停下等人 */
  pushable: boolean
}

export interface QueueDeps {
  /** 和手动开打完全相同的函数。失败抛错 */
  start: (body: { path: string; plate: number; slots?: Record<string, number> }) => Promise<unknown>
  /** 收菜规划：给出告警和文件类型 */
  plan: (path: string, plate: number) => Promise<HarvestPlanInfo>
  /** 只开风扇降温，不动轴 */
  cool: () => Promise<void>
  /** 下发 standalone 推件序列（不触发别处的拍照，队列自己拍） */
  eject: (path: string, plate: number) => Promise<void>
  /** 抓一帧，失败返回 null */
  snapshot: () => Promise<{ url: string; file: string } | null>
  notify: (e: NotifyEvent) => Promise<void>
  /** 打印机此刻能不能开打（空闲、无报错、已连接） */
  printerReady: () => { ok: boolean; why: string }
  /** 预约收菜是否开着 —— 开着就不能同时跑队列，两个状态机会抢同一台机器 */
  autoHarvestArmed: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 打印中的状态。从这些跃迁到 FINISH 才算一单结束 */
const ACTIVE = new Set(['RUNNING', 'PREPARE', 'SLICING'])
/** 推件前热床要冷到的温度。与 eject/plan.ts 的 DEFAULT_BED_TARGET 一致 */
const BED_TARGET = 25
/** 等冷却最多这么久 */
const COOL_TIMEOUT_MS = 45 * 60_000
/** 推件序列下发之后，给动作走完留的时间 */
const SETTLE_MS = 60_000
/** 注入型文件 FINISH 时推件已经做过，只需短暂停顿再拍 */
const INJECTED_SETTLE_MS = 10_000
/** 起下一件之前等一下：让打印机把 FINISH 状态收拾干净 */
const GAP_MS = 5_000

export class QueueError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'QueueError'
  }
}

interface Persisted {
  items: QueueItem[]
  state: QueueState
  pause: PauseInfo | null
  current: string | null
  phase: Phase
}

export class PrintQueue {
  private items: QueueItem[] = []
  private state: QueueState = 'idle'
  private pause_: PauseInfo | null = null
  private current: string | null = null
  private phase: Phase = 'idle'
  private prevState = ''
  private coolingSince = 0
  private seq = 0
  private updatedAt = 0
  /** 重启后第一次拿到打印机状态时要做一次对账 */
  private reconciled = false
  /** 正在异步推进的一步（开打 / 拍照）。避免同一步被并发触发两次 */
  private busy = false

  constructor(private readonly path: string, private readonly deps: QueueDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }
  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  async load(): Promise<void> {
    try {
      const p = JSON.parse(await readFile(this.path, 'utf8')) as Persisted
      this.items = p.items ?? []
      this.state = p.state ?? 'idle'
      this.pause_ = p.pause ?? null
      this.current = p.current ?? null
      this.phase = p.phase ?? 'idle'
      this.seq = this.items.length
    } catch {
      /* 第一次，没有队列 */
    }
  }

  private async persist(): Promise<void> {
    this.updatedAt = this.now()
    const p: Persisted = { items: this.items, state: this.state, pause: this.pause_, current: this.current, phase: this.phase }
    await writeFile(this.path, JSON.stringify(p), 'utf8').catch(() => {})
  }

  status(): QueueStatus {
    return {
      state: this.state, pause: this.pause_, current: this.current, phase: this.phase,
      items: this.items.map((i) => ({ ...i })), updatedAt: this.updatedAt,
    }
  }

  // ---- 编辑 ----

  async add(input: { path: string; plate?: number; slots?: Record<string, number> }): Promise<QueueStatus> {
    const plate = Number(input.plate ?? 1)
    if (!Number.isInteger(plate) || plate < 1) throw new QueueError('盘号必须是正整数')
    const plan = await this.deps.plan(input.path, plate)
    const name = input.path.slice(input.path.lastIndexOf('/') + 1)
    const item: QueueItem = {
      id: `q${++this.seq}-${this.now().toString(36)}`,
      path: input.path, name, plate,
      ...(input.slots ? { slots: input.slots } : {}),
      status: 'waiting', error: null,
      injected: plan.injected,
      // 没有可推的件也算「不能自动衔接」—— 打完床上还有东西
      harvestAuto: plan.pushable && plan.warnings.every((w) => w.level === 'info'),
      warnings: plan.warnings,
      addedAt: this.now(), startedAt: null, endedAt: null, photo: null,
    }
    this.items.push(item)
    await this.persist()
    return this.status()
  }

  async remove(id: string): Promise<QueueStatus> {
    const it = this.items.find((i) => i.id === id)
    if (!it) throw new QueueError('队列里没有这一项', 404)
    if (it.id === this.current && (it.status === 'printing' || it.status === 'harvesting')) {
      throw new QueueError('这一项正在进行，不能删。要停就用暂停', 409)
    }
    this.items = this.items.filter((i) => i.id !== id)
    await this.persist()
    return this.status()
  }

  async reorder(ids: string[]): Promise<QueueStatus> {
    const waiting = this.items.filter((i) => i.status === 'waiting')
    const set = new Set(waiting.map((i) => i.id))
    if (ids.length !== waiting.length || !ids.every((id) => set.has(id))) {
      throw new QueueError('顺序里必须恰好包含所有等待中的项')
    }
    const byId = new Map(waiting.map((i) => [i.id, i]))
    const others = this.items.filter((i) => i.status !== 'waiting')
    this.items = [...others, ...ids.map((id) => byId.get(id)!)]
    await this.persist()
    return this.status()
  }

  async clear(): Promise<QueueStatus> {
    this.items = this.items.filter((i) => !['done', 'failed', 'skipped'].includes(i.status))
    await this.persist()
    return this.status()
  }

  // ---- 控制 ----

  async start(): Promise<QueueStatus> {
    if (this.state === 'running') return this.status()
    if (!this.items.some((i) => i.status === 'waiting')) throw new QueueError('队列里没有待打的项', 409)
    if (this.deps.autoHarvestArmed()) throw new QueueError('「打完这一件后收菜」还开着，先取消它再跑队列', 409)
    if (this.phase === 'idle') {
      const r = this.deps.printerReady()
      if (!r.ok) throw new QueueError(r.why, 409)
    }
    this.state = 'running'
    this.pause_ = null
    await this.persist()
    if (this.phase === 'idle') void this.runNext()
    return this.status()
  }

  /** 打完当前这件就停，不再起下一件。空闲时立刻生效 */
  async pause(): Promise<QueueStatus> {
    if (this.state !== 'running') return this.status()
    this.state = 'paused'
    this.pause_ = { reason: 'manual', message: '已暂停，打完当前这件不再继续', photo: null }
    await this.persist()
    return this.status()
  }

  /** 从暂停恢复。安全门就在这里：人看过照片、确认床空了才点 */
  async resume(): Promise<QueueStatus> {
    return this.start()
  }

  private async halt(reason: PauseReason, message: string, photo: string | null = null): Promise<void> {
    this.state = 'paused'
    this.pause_ = { reason, message, photo }
    this.phase = 'idle'
    await this.persist()
    await this.deps.notify({
      kind: 'queuePaused',
      key: `queue:${reason}:${this.now()}`,
      title: reason === 'safety' ? '队列等你确认' : '打印队列已停下',
      body: message,
      ...(photo ? { image: photo } : {}),
    }).catch(() => {})
  }

  // ---- 状态机 ----

  private async runNext(): Promise<void> {
    if (this.busy) return
    const next = this.items.find((i) => i.status === 'waiting')
    if (!next) {
      this.state = 'idle'
      this.current = null
      this.phase = 'idle'
      await this.persist()
      await this.deps.notify({ kind: 'queueDone', key: `queueDone:${this.now()}`, title: '打印队列全部完成', body: '所有排队的件都打完并收菜了' }).catch(() => {})
      return
    }
    const r = this.deps.printerReady()
    if (!r.ok) {
      await this.halt('blocked', r.why)
      return
    }
    this.busy = true
    this.current = next.id
    this.phase = 'starting'
    await this.persist()
    try {
      await this.deps.start({ path: next.path, plate: next.plate, ...(next.slots ? { slots: next.slots } : {}) })
      next.status = 'printing'
      next.startedAt = this.now()
      this.phase = 'printing'
      await this.persist()
    } catch (e) {
      next.status = 'failed'
      next.error = (e as Error).message
      next.endedAt = this.now()
      await this.halt('failed', `「${next.name}」没能开始：${next.error}`)
    } finally {
      this.busy = false
    }
  }

  /** 由打印机状态推动。每次 Summary 更新调一次 */
  async onUpdate(s: Summary): Promise<void> {
    const prev = this.prevState
    this.prevState = s.state
    if (!this.reconciled) {
      this.reconciled = true
      await this.reconcile(s)
      return
    }
    const cur = this.items.find((i) => i.id === this.current)

    if (this.phase === 'printing' && cur) {
      if (s.state === 'FINISH' && ACTIVE.has(prev)) {
        await this.beginHarvest(cur, s)
      } else if (s.state === 'FAILED' && prev !== 'FAILED') {
        cur.status = 'failed'
        cur.error = s.printError ? `打印失败，错误码 ${(s.printError >>> 0).toString(16).toUpperCase()}` : '打印失败'
        cur.endedAt = this.now()
        await this.halt('failed', `「${cur.name}」${cur.error}`)
      }
      return
    }

    if (this.phase === 'cooling' && cur) {
      if (ACTIVE.has(s.state)) {
        await this.halt('foreign', '等冷却的时候又开始打印了，队列停下')
        return
      }
      if (this.now() - this.coolingSince > COOL_TIMEOUT_MS) {
        await this.halt('blocked', '等了很久热床仍未降到目标温度')
        return
      }
      if (s.bed.cur > BED_TARGET) return
      await this.dispatchEject(cur)
      return
    }

    // 空档期或没在跑：队列外有人开了打印就别再接着起
    if ((this.phase === 'gap' || this.phase === 'idle') && this.state === 'running' && ACTIVE.has(s.state) && !ACTIVE.has(prev)) {
      await this.halt('foreign', '有人在队列外开始了打印，队列停下')
    }
  }

  /** 桥接重启后第一份状态：和落盘的进度对一下 */
  private async reconcile(s: Summary): Promise<void> {
    if (this.state !== 'running') return
    const cur = this.items.find((i) => i.id === this.current)
    if (!cur) {
      this.phase = 'idle'
      void this.runNext()
      return
    }
    if (this.phase === 'printing') {
      // 重启期间可能已经打完了。ACTIVE 就继续盯；FINISH 直接进收菜；别的都停下让人看
      if (ACTIVE.has(s.state)) return
      if (s.state === 'FINISH') { await this.beginHarvest(cur, s); return }
      await this.halt('blocked', `重启后发现「${cur.name}」处于 ${s.state}，不知道打没打完`)
      return
    }
    if (this.phase === 'starting' || this.phase === 'gap') {
      this.phase = 'idle'
      void this.runNext()
      return
    }
    // cooling / ejecting / settling：推没推不知道，让人看
    cur.status = 'done'
    cur.endedAt = this.now()
    await this.halt('safety', `重启前「${cur.name}」正在收菜，不确定推没推 —— 看一眼床再继续`)
  }

  private async beginHarvest(item: QueueItem, s: Summary): Promise<void> {
    item.status = 'harvesting'
    if (item.injected) {
      // 推件序列已经在打印任务末尾跑过了，床也冷了。停一下拍照
      this.phase = 'settling'
      await this.persist()
      await this.sleep(INJECTED_SETTLE_MS)
      await this.finishHarvest(item)
      return
    }
    this.phase = 'cooling'
    this.coolingSince = this.now()
    await this.persist()
    try {
      await this.deps.cool()
    } catch (e) {
      await this.halt('blocked', `开风扇失败: ${(e as Error).message}`)
      return
    }
    // 床可能早就凉了（比如打印结束后过了很久才重启队列），别干等下一次状态更新
    if (s.bed.cur <= BED_TARGET) await this.dispatchEject(item)
  }

  private async dispatchEject(item: QueueItem): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.phase = 'ejecting'
    await this.persist()
    try {
      await this.deps.eject(item.path, item.plate)
    } catch (e) {
      this.busy = false
      await this.halt('blocked', `推件下发失败: ${(e as Error).message}`)
      return
    }
    this.phase = 'settling'
    await this.persist()
    await this.sleep(SETTLE_MS)
    this.busy = false
    await this.finishHarvest(item)
  }

  private async finishHarvest(item: QueueItem): Promise<void> {
    const snap = await this.deps.snapshot().catch(() => null)
    item.photo = snap?.url ?? null
    item.status = 'done'
    item.endedAt = this.now()
    await this.deps.notify({
      kind: 'harvestDone',
      key: `queueHarvest:${item.id}`,
      title: '收菜完成',
      body: `「${item.name}」· 看一眼热床是不是空了`,
      ...(snap ? { image: snap.url, imagePath: snap.file } : {}),
    }).catch(() => {})

    if (this.state !== 'running') {
      // 用户中途按了暂停：打完这件就停，不评价床空没空
      this.phase = 'idle'
      await this.persist()
      return
    }
    if (!item.harvestAuto) {
      await this.halt('safety', `「${item.name}」的收菜规划有提醒，确认床空了再继续`, item.photo)
      return
    }
    this.phase = 'gap'
    await this.persist()
    await this.sleep(GAP_MS)
    if (this.state !== 'running') { this.phase = 'idle'; await this.persist(); return }
    this.phase = 'idle'
    await this.runNext()
  }
}
