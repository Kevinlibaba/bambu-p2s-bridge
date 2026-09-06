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
import {
  Profiles, SlicerUnavailableError, notableChanges,
  type ProfileRef, type SettingChange,
} from '../slice/profiles.js'
import { runSlice } from '../slice/run.js'
import {
  toConfigKeys, fromConfig, changedOnly, layerRange, ParamError, type SliceParams,
} from '../slice/overrides.js'
import { postprocess } from '../slice/postprocess.js'
import { verifyModel } from '../slice/verify.js'
import { fileChanged, onFileChange } from './filechange.js'
import { SliceQueue, SliceBusyError } from '../slice/job.js'
import {
  findEntry, readCentralDirectory, readEntry, withTail, ZipFormatError,
  type ZipEntry, type ZipSource,
} from '../util/zip.js'

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
/*
 * 作者设置的缓存。同名文件被换掉的情况给个 TTL 兜底，不做失效通知那么复杂的东西 ——
 * 跟 eject/source.ts 里那份缓存同样的取舍。
 */
const PARAMS_TTL_MS = 10 * 60_000
const PARAMS_CACHE_MAX = 32

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
  /**
   * 在作者设置之上要改的参数。只写这里给出且**确实与作者不同**的那几项，
   * 其余一律保持模型自带的设置。
   */
  params?: SliceParams
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
export function modelFilamentsOf(d: Record<string, unknown>): ModelFilaments {
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

export function parseModelFilaments(json: string): ModelFilaments {
  try {
    return modelFilamentsOf(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return { ids: [], types: [] }
  }
}

/**
 * 读出模型自带的 project_settings.config。
 *
 * 它有 570 个键，是作者调好的一整套设置 —— 层高、填充、支撑、甚至他那台机器的
 * 首尾 G-code 全在里面。切片时它是**底板**，`--load-settings` 在它上面逐键覆盖。
 * 读不出来就当空的：那样等于不做任何比较，不影响切片本身。
 */
async function readSettings(
  src: ZipSource,
  entry: ZipEntry,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readEntry(src, entry, MAX_SETTINGS_BYTES)
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
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

interface ModelInfo {
  /** 还没切过，可以切 */
  sliceable: boolean
  /** 作者定的打印参数，读不出来为 null */
  params: SliceParams | null
}

/** 取标量。配置里这些键既可能写成标量，也可能是单元素数组 */
function scalarOf(v: unknown): string {
  if (Array.isArray(v)) return v.length ? String(v[0]) : ''
  return v === undefined || v === null ? '' : String(v)
}

export function registerSliceRoutes(app: FastifyInstance, state: PrinterState): void {
  const profiles = new Profiles(config.slicer.root)

  const nozzleOf = (req?: number): number => {
    if (req) return req
    const d = Number(state.summary().nozzle.diameter)
    return Number.isFinite(d) && d > 0 ? d : 0.4
  }

  /**
   * 读出模型作者定的打印参数，给界面做默认值。
   *
   * 只读尾部的中央目录再取 project_settings.config 这一个条目 —— 为了几个
   * 数字把几十 MB 拖回来不值当。即便如此仍要走两三次 FTP 往返，实测约 190ms，
   * 所以带缓存：同一个文件的作者设置不会变，而界面每次点开都要问一遍。
   *
   * 缓存的必要性是实测出来的 —— 不缓存的话弹层打开约 1 秒后参数卡才蹦出来，
   * 内容往下跳一大截，看着就是卡了一下。
   */
  const paramsCache = new Map<string, { at: number; value: ModelInfo }>()
  /*
   * 同名重传必须清掉。否则界面拿 10 分钟前的作者设置当基准，用户只碰了层高，
   * 桥接却把「旧基准 vs 新文件」的所有差异都当成用户改动写进去 —— 作者刚开的
   * 支撑就这样被关掉，恰恰是逐项覆盖这个设计要防的事。
   */
  onFileChange((path) => paramsCache.delete(path))

  /**
   * 顺带回答「这个文件能不能切」。
   *
   * 中央目录本来就读了，判断有没有 plate_N.gcode 是白得的 —— 而界面拿这个
   * 决定显示「切片」还是「打印」。之前它是从打印前自检里推的，那要等
   * `/api/print/plan`（实测 550ms），比这里晚一截，参数卡就得跟着一起等。
   */
  async function readModelInfo(source: string): Promise<ModelInfo> {
    const hit = paramsCache.get(source)
    if (hit && Date.now() - hit.at < PARAMS_TTL_MS) return hit.value

    const tail = await ftp.readRange(source, { suffix: 96 * 1024 })
    const src: ZipSource = withTail(tail.size, tail.start, tail.data, async (a, b) =>
      (await ftp.readRange(source, { start: a, end: b })).data,
    )
    const entries = await readCentralDirectory(src)
    const e = findEntry(entries, 'Metadata/project_settings.config')
    const value: ModelInfo = {
      sliceable: !isSliced(entries.map((x) => x.name)),
      params: e ? await readSettings(src, e).then(fromConfig) : null,
    }

    paramsCache.set(source, { at: Date.now(), value })
    while (paramsCache.size > PARAMS_CACHE_MAX) {
      const oldest = paramsCache.keys().next()
      if (oldest.done) break
      paramsCache.delete(oldest.value)
    }
    return value
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
      // 产物可能覆盖同名旧文件：中央目录、预览图、解析结果、作者参数全都不能再信
      fileChanged(target)
      return target
    },
    cleanup: async (workDir) => {
      await rm(workDir, { recursive: true, force: true })
    },
  })

  app.get<{ Querystring: { path?: string } }>('/api/slice/options', async (req, reply) => {
    try {
      const nozzle = nozzleOf()
      const [procs, index] = await Promise.all([
        profiles.processes(nozzle),
        profiles.filamentIndex(nozzle),
      ])
      const trays = state.summary().ams

      /*
       * 带上模型作者自己的设置，界面拿它做各个控件的默认值 —— 「在作者的基础上
       * 改」这件事，前提是先看得见作者定的是什么。
       */
      let info: ModelInfo | null = null
      if (req.query.path) {
        // normalizePath 是同步抛的，放在 .catch() 外面会直接变成 500
        let norm: string
        try {
          norm = ftp.normalizePath(req.query.path)
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message })
        }
        info = await readModelInfo(norm).catch(() => null)
      }

      return {
        available: true,
        nozzle,
        /** 层高的合法区间，随喷嘴口径变 */
        layerRange: layerRange(nozzle),
        /** 这个文件能不能切（已经切过的就不能）。没给 path 时为 null */
        sliceable: info ? info.sliceable : null,
        current: info?.params ?? null,
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

      /*
       * 工艺的取舍，实测之后定的：
       *
       * 不给 process 时用模型自带的打印设置 —— 传厂商目录里那个未摊平的叶子，
       * 它几乎不定义什么键，CLI 又只覆盖字面存在的键，所以等于不覆盖。
       * 从 MakerWorld 下来的模型，层高、填充、支撑都是作者按这个件调过的。
       *
       * 给了 process 才摊平继承链真正应用它。代价要说清楚：摊平的标准 profile
       * 会覆盖 67 个键，其中 `enable_support: 1 → 0` 会把作者开的支撑关掉。
       */
      const procs = await profiles.processes(nozzle)
      const wantProc = body.process ?? DEFAULT_PROCESS
      const proc = procs.find((p) => p.name === wantProc)
      // 指名了就必须找到。悄悄换成默认再整套应用，会把作者的支撑一起换掉，
      // 而响应里还报着 processApplied:true —— 比直接拒绝危险得多
      if (!proc) throw new SliceRequestError(`找不到工艺配置: ${wantProc}`)

      const settingsEntry = (entries ? findEntry(entries, 'Metadata/project_settings.config') : null)
      const modelSettings = settingsEntry
        ? await readSettings(zsrc, settingsEntry)
        : {}

      /*
       * 两条路，默认走第二条：
       *
       * process —— 套用一整套工艺。会覆盖几十个键（包括支撑开关），所以只在
       *   调用方明确指名时才走，并把改掉的关键项报回去。
       * params  —— 在作者设置之上只改指定的几项。叶子几乎是空的，合并之后
       *   生效的就只有这几个键，其余原样保留。这是界面用的那条。
       */
      let processJson: string | undefined
      let changes: SettingChange[] = []
      const current = fromConfig(modelSettings)

      if (body.process) {
        const flat = await profiles.mergedProcess(proc)
        processJson = JSON.stringify(flat, null, 1)
        changes = notableChanges(modelSettings, flat)
      } else if (body.params) {
        // 界面会把所有字段都发上来（它拿作者的值做默认），只留真正变了的
        const want = changedOnly(body.params, current)
        const keys = toConfigKeys(want, nozzle)
        if (Object.keys(keys).length) {
          processJson = JSON.stringify(await profiles.processWithOverrides(proc, keys), null, 1)
          changes = Object.entries(keys).map(([key, to]) => ({
            key,
            from: scalarOf(modelSettings[key]),
            to,
          }))
        }
      }

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
        const declared = modelFilamentsOf(modelSettings)
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
          processJson,
          filaments: filamentJson,
          plate: body.plate,
          timeoutMs: config.slicer.timeoutMs,
        }),
      )
      return reply.code(202).send({
        ...job,
        process: proc.name,
        /** true = 套用了整套工艺；false = 以作者设置为底，最多改了 changes 里那几项 */
        processApplied: !!body.process,
        /**
         * 这套工艺改掉了模型里的哪些关键设置。
         * enable_support 从 1 变 0 是这里最要紧的一条 —— 作者开的支撑没了。
         */
        changes,
        filaments: filaments.map((f) => f.name),
        // 哪几个槽位是猜的，让界面能提醒一句：第三方料没有厂商 profile
        guessedSlots: guessed,
        willWriteTo: outputPath(source),
      })
    } catch (e) {
      if (e instanceof ParamError) return reply.code(400).send({ error: e.message })
      if (e instanceof SliceBusyError) return reply.code(409).send({ error: e.message })
      if (e instanceof SliceRequestError) return reply.code(e.status).send({ error: e.message })
      if (e instanceof SlicerUnavailableError) return reply.code(503).send({ error: e.message })
      if (e instanceof ftp.BadPathError) return reply.code(400).send({ error: e.message })
      // 下面这些和 files.ts 的 fail() 保持一致 —— 打印机忙、文件没了都不该变成
      // 一句「Internal Server Error」，那会把人引向排查桥接而不是等一会儿
      if (e instanceof ftp.TooManyReadsError) return reply.code(503).send({ error: e.message })
      if (e instanceof ftp.NotAFileError) return reply.code(e.status).send({ error: e.message })
      if (e instanceof ZipFormatError) return reply.code(422).send({ error: e.message })
      return reply.code(502).send({ error: `FTPS 失败: ${(e as Error).message}` })
    }
  })

  app.get('/api/slice/jobs', async () => ({ jobs: queue.list(), busy: queue.busy() }))

  app.get<{ Params: { id: string } }>('/api/slice/jobs/:id', async (req, reply) => {
    const job = queue.get(req.params.id)
    if (!job) return reply.code(404).send({ error: '没有这个切片任务' })
    return job
  })
}
