/**
 * 云切片：把打印机上一个**未切片**的 3mf 切成可打印的 `.gcode.3mf`，再传回去。
 *
 * 「云」是相对手机说的 —— 切片跑在这台常开的桥接机上，不经过任何厂商服务，
 * 手机只负责点一下和看进度。
 *
 * 整条链路：从打印机取文件 → 本地切 → 补 printer_model_id → 传回打印机。
 * 切完不自动开打：切片是可逆的（大不了删掉重来），开打不是。
 *
 * 默认选料按 AMS 里实际装着的耗材走：AMS 上报的 trayInfoIdx 和耗材 profile 的
 * filament_id 是同一套编号，能精确对上，不用按「PLA」这种类型名去猜。
 */
import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import * as ftp from '../printer/ftp.js'
import type { PrinterState } from '../printer/state.js'
import { Profiles, SlicerUnavailableError, type ProfileRef } from '../slice/profiles.js'
import { runSlice } from '../slice/run.js'
import { postprocess } from '../slice/postprocess.js'
import { verifyModel } from '../slice/verify.js'
import { SliceQueue, SliceBusyError } from '../slice/job.js'
import { readCentralDirectory, readEntry, withTail, type ZipSource } from '../util/zip.js'

class SliceRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'SliceRequestError'
  }
}

/** 切片器满载 CPU，机器在动的时候不该跟它抢 */
const BUSY = new Set(['RUNNING', 'PREPARE', 'SLICING'])

/** 默认工艺。P2S 上 0.20mm Standard 是出厂默认，也是最常用的 */
const DEFAULT_PROCESS = '0.20mm Standard @BBL P2S'
/** project_settings.config 的读取上限。实测几十 KB */
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
/** 查不到对应 profile 时的兜底耗材 */
const FALLBACK_FILAMENT = 'Bambu PLA Basic @BBL P2S'

export interface SliceRequest {
  /** 打印机上待切的 3mf 路径 */
  path?: string
  /** 盘号，1 起；不给就切全部 */
  plate?: number
  /** process profile 的 name。不给用 DEFAULT_PROCESS */
  process?: string
  /** filament profile 的 name 列表。不给按 AMS 自动选 */
  filaments?: string[]
  /** 喷嘴口径，默认按打印机上报的 */
  nozzle?: number
}

/** 一个 3mf 是否已经切过 —— 切过的包里有 Metadata/plate_N.gcode */
export function isSliced(names: string[]): boolean {
  return names.some((n) => /^Metadata\/plate_\d+\.gcode$/.test(n))
}

/**
 * 产物在打印机上的落点：跟源文件同目录，`.3mf` 换成 `.gcode.3mf`。
 *
 * 不覆盖源文件 —— 未切片的原件是唯一能重切的东西，换个工艺重来就得靠它。
 */
export function outputPath(source: string): string {
  const dir = path.posix.dirname(source)
  const base = path.posix.basename(source).replace(/\.gcode\.3mf$/i, '.3mf').replace(/\.3mf$/i, '')
  return path.posix.join(dir, `${base}.gcode.3mf`)
}

export interface FilamentLookup {
  filamentIndex(nozzle: number): Promise<Map<string, ProfileRef>>
  filaments(nozzle: number): Promise<ProfileRef[]>
}

/**
 * 模型自己声明的耗材。未切片的 3mf 里 `project_settings.config` 带着
 * `filament_ids`（厂商编号）和 `filament_type`，两者等长。
 */
export interface ModelFilaments {
  ids: string[]
  types: string[]
}

/**
 * 读出模型声明了哪几种耗材。
 *
 * **数量必须照着模型走。** 实测传多了切片器会一声不吭地退出 —— 日志里只有
 * 一行 `Initializing StaticPrintConfigs`，没有产物也没有错误。模型声明 4 种、
 * 却按 AMS 的 5 个槽位传了 5 个，就是这个下场，排查起来毫无线索。
 */
export function parseModelFilaments(json: string): ModelFilaments {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(json) as Record<string, unknown>
  } catch {
    return { ids: [], types: [] }
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : []
  const ids = arr(d.filament_ids)
  const types = arr(d.filament_type)
  // 两者应当等长；不等长时以长的为准补空
  const n = Math.max(ids.length, types.length)
  return {
    ids: Array.from({ length: n }, (_, i) => ids[i] ?? ''),
    types: Array.from({ length: n }, (_, i) => types[i] ?? ''),
  }
}

/**
 * 按模型声明的耗材挑 profile，**一个萝卜一个坑，数量必须完全相同**。
 *
 * 模型里的 filament_settings_id 常常指向别的机型（MakerWorld 上下来的多半是
 * X1C 的），不能直接用；但 filament_ids 里的厂商编号是跨机型通用的，拿它去查
 * P2S 的 profile 就完成了机型转换。
 *
 * 查不到就退到同类型的 Generic，再不行退到 PLA Basic —— 顺序即切片文件里的
 * 耗材序号，少一个会让后面全部错位，宁可参数不够贴切也不能串位。
 */
export async function filamentsForModel(
  profiles: FilamentLookup,
  nozzle: number,
  model: ModelFilaments,
): Promise<{ picked: ProfileRef[]; guessed: number[] }> {
  const index = await profiles.filamentIndex(nozzle)
  const all = await profiles.filaments(nozzle)
  const byName = (n: string) => all.find((f) => f.name === n)
  const picked: ProfileRef[] = []
  const guessed: number[] = []

  for (let i = 0; i < model.ids.length; i++) {
    const exact = index.get(model.ids[i])
    if (exact) {
      picked.push(exact)
      continue
    }
    const type = model.types[i]
    const fb = (type ? byName(`Generic ${type} @BBL P2S`) : undefined) ?? byName(FALLBACK_FILAMENT)
    if (!fb) continue
    picked.push(fb)
    guessed.push(i)
  }
  return { picked, guessed }
}

export function registerSliceRoutes(app: FastifyInstance, state: PrinterState): void {
  const profiles = new Profiles(config.slicer.root)

  const nozzleOf = (req?: number): number => {
    if (req) return req
    const d = Number(state.summary().nozzle.diameter)
    return Number.isFinite(d) && d > 0 ? d : 0.4
  }

  const queue = new SliceQueue({
    workDirFor: (id) => path.join(config.slicer.workDir, id),
    download: async (source, workDir) => {
      await mkdir(workDir, { recursive: true })
      const local = path.join(workDir, 'model.3mf')
      await writeFile(local, await ftp.download(source))
      return local
    },
    verify: verifyModel,
    patch: async (file) => {
      await postprocess(file)
    },
    upload: async (file, source) => {
      const target = outputPath(source)
      await ftp.upload(target, await readFile(file))
      return target
    },
    cleanup: async (workDir) => {
      await rm(workDir, { recursive: true, force: true })
    },
  })

  app.get('/api/slice/options', async (_req, reply) => {
    try {
      const nozzle = nozzleOf()
      const [procs, index] = await Promise.all([
        profiles.processes(nozzle),
        profiles.filamentIndex(nozzle),
      ])
      const trays = state.summary().ams
      return {
        available: true,
        nozzle,
        processes: procs.map((p) => p.name),
        defaultProcess: DEFAULT_PROCESS,
        // 只回 AMS 里真装着的那几个，一百多个耗材列表对手机没有意义
        /*
         * 纯展示。切片用哪些耗材由**模型**决定（见 filamentsForModel），
         * 不是由 AMS 决定 —— AMS 装了什么是打印时 ams_mapping 的事。
         * 这里列出来只是让人知道机器上现在有什么。
         */
        amsFilaments: trays.map((t) => ({
          trayInfoIdx: t.trayInfoIdx,
          type: t.type,
          profile: index.get(t.trayInfoIdx)?.name ?? null,
        })),
      }
    } catch (e) {
      if (e instanceof SlicerUnavailableError) {
        return reply.code(503).send({ available: false, error: e.message })
      }
      throw e
    }
  })

  app.post('/api/slice', async (req, reply) => {
    const body = (req.body ?? {}) as SliceRequest
    try {
      if (!body.path) throw new SliceRequestError('要切哪个文件')
      const source = ftp.normalizePath(body.path)

      const s = state.summary()
      if (BUSY.has(s.state)) {
        throw new SliceRequestError('打印机正在打印，切片会跟它抢 CPU，等打完再切', 409)
      }

      /*
       * 已经切过的文件再切一次没有意义，而且产物会覆盖掉它自己。
       *
       * 只读尾部：中央目录在文件末尾，判断有没有 plate_N.gcode 不需要整包。
       * 注意必须用 withTail 而不是 bufferSource —— 中央目录里记的是相对整个
       * 文件的绝对偏移，把一段尾巴当成完整文件会把偏移全算错。
       */
      const tail = await ftp.readRange(source, { suffix: 96 * 1024 })
      const zsrc: ZipSource = withTail(tail.size, tail.start, tail.data, async (a, b) =>
        (await ftp.readRange(source, { start: a, end: b })).data,
      )
      const entries = await readCentralDirectory(zsrc).catch(() => null)
      if (entries && isSliced(entries.map((e) => e.name))) {
        throw new SliceRequestError('这个文件已经切过了，可以直接打印', 409)
      }

      const nozzle = nozzleOf(body.nozzle)
      const machine = (await profiles.machines()).find((m) => m.nozzle === nozzle)
      if (!machine) throw new SliceRequestError(`没有 ${nozzle}mm 喷嘴的机器配置`)

      const procs = await profiles.processes(nozzle)
      const proc = procs.find((p) => p.name === (body.process ?? DEFAULT_PROCESS))
        ?? procs.find((p) => p.name === DEFAULT_PROCESS)
      if (!proc) throw new SliceRequestError('找不到可用的工艺配置')

      let filaments: ProfileRef[]
      let guessed: number[] = []
      if (body.filaments?.length) {
        const all = await profiles.filaments(nozzle)
        filaments = body.filaments.map((n) => {
          const hit = all.find((f) => f.name === n)
          if (!hit) throw new SliceRequestError(`没有这个耗材配置: ${n}`)
          return hit
        })
      } else {
        /*
         * 耗材以**模型**声明的为准，数量必须一模一样 —— 多给一个切片器就会
         * 一声不吭地退出（日志里只有 Initializing StaticPrintConfigs，没有产物
         * 也没有错误）。所以这里不能拿 AMS 的槽位数来凑。
         */
        const settings = entries?.find((e) => e.name === 'Metadata/project_settings.config')
        const declared = settings
          ? parseModelFilaments((await readEntry(zsrc, settings, MAX_SETTINGS_BYTES)).toString('utf8'))
          : { ids: [], types: [] }
        const auto = await filamentsForModel(profiles, nozzle, declared)
        filaments = auto.picked
        guessed = auto.guessed
        if (filaments.length === 0) {
          // 模型没声明（裸网格 3mf）。给一个，让切片器按自己的默认走
          const all = await profiles.filaments(nozzle)
          const fb = all.find((f) => f.name === FALLBACK_FILAMENT)
          if (fb) filaments = [fb]
        }
      }

      const machineJson = await profiles.mergedMachine(machine)
      const filamentJson = await Promise.all(filaments.map((f) => profiles.mergedFilament(f)))
      const job = queue.start(source, async (model, workDir) =>
        runSlice({
          slicerRoot: config.slicer.root,
          model,
          workDir,
          machineJson,
          processFile: proc.file,
          filaments: filamentJson,
          plate: body.plate,
          timeoutMs: config.slicer.timeoutMs,
        }),
      )
      return reply.code(202).send({
        ...job,
        process: proc.name,
        filaments: filaments.map((f) => f.name),
        // 哪几个槽位是猜的，让界面能提醒一句：第三方料没有厂商 profile
        guessedSlots: guessed,
        willWriteTo: outputPath(source),
      })
    } catch (e) {
      if (e instanceof SliceBusyError) return reply.code(409).send({ error: e.message })
      if (e instanceof SliceRequestError) return reply.code(e.status).send({ error: e.message })
      if (e instanceof SlicerUnavailableError) return reply.code(503).send({ error: e.message })
      if (e instanceof ftp.BadPathError) return reply.code(400).send({ error: e.message })
      throw e
    }
  })

  app.get('/api/slice/jobs', async () => ({ jobs: queue.list(), busy: queue.busy() }))

  app.get<{ Params: { id: string } }>('/api/slice/jobs/:id', async (req, reply) => {
    const job = queue.get(req.params.id)
    if (!job) return reply.code(404).send({ error: '没有这个切片任务' })
    return job
  })
}
