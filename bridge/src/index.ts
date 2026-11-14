import { config } from './config.js'
import { PrinterState } from './printer/state.js'
import { PrinterMqtt } from './printer/mqtt.js'
import { buildServer } from './api/server.js'
import { Notifier } from './notify/index.js'
import { History } from './history/index.js'
import { lookupPlate } from './history/lookup.js'
import { Temps } from './history/temps.js'
import { EventLog } from './history/eventlog.js'
import { AutoHarvest } from './eject/auto.js'
import { makeHarvestRunner } from './api/eject.js'
import { Snapshots } from './notify/snapshots.js'
import { HarvestSnapshot } from './notify/afterharvest.js'
import { FileChecker } from './check/index.js'
import { RecordingQuota } from './check/recordings.js'
import { PrintSchedule } from './schedule/index.js'
import { PrintQueue } from './queue/index.js'
import { readEjectSource } from './eject/source.js'
import { planEject } from './eject/plan.js'
import * as ftp from './printer/ftp.js'
import { CameraStream } from './printer/camera.js'
import { EmbeddedGo2rtc } from './printer/go2rtc-embed.js'
import { buildSetupServer } from './setup/server.js'

const state = new PrinterState()
const mqtt = new PrinterMqtt(state)
const events = new EventLog(config.history.eventsDir, config.history.tempsKeepDays)
const snapshots = new Snapshots(config.notify.snapshotDir)
const notifier = new Notifier(state, events, snapshots)
const BUSY = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'])
const checker = new FileChecker(
  config.check.statePath,
  {
    list: () => ftp.listDir('/'),
    download: (p) => ftp.download(p),
    readsActive: () => ftp.readsActive(),
    idle: () => !BUSY.has(state.summary().state),
    notify: (e) => notifier.notifyIfEnabled(e),
  },
  config.check.intervalH * 3_600_000,
)
const recordings = new RecordingQuota(
  {
    list: (p) => ftp.listDir(p),
    remove: (p) => ftp.remove(p),
    readsActive: () => ftp.readsActive(),
    log: (m) => console.log(m),
  },
  config.recordings.quotaMB * 1048576,
)
const schedule = new PrintSchedule(config.schedule.path, { notify: (e) => notifier.notifyIfEnabled(e) })
const history = new History(state, lookupPlate)
const temps = new Temps(state, 10_000, 1080, config.history.tempsDir, 6, config.history.tempsKeepDays)
const harvestSnap = new HarvestSnapshot({
  bedTemp: () => state.summary().bed.cur,
  notify: (e) => notifier.notifyIfEnabled(e),
})
const onEjected = (bedTarget: number) => harvestSnap.schedule(bedTarget)
const runner = makeHarvestRunner(state, mqtt, history, onEjected)
const autoHarvest = new AutoHarvest(state, runner)
const queue = new PrintQueue(config.queue.path, {
  start: (body) => startPrintRef.current(body),
  plan: async (path, plate) => {
    const src = await readEjectSource(path, plate)
    const injected = /\.harvest\.gcode\.3mf$/i.test(path)
    const plan = planEject(src.objects, { bed: { width: 256, depth: 256 }, maxZ: src.maxZ }, {
      mode: injected ? 'endGcode' : 'standalone', brimWidth: src.brimWidth,
    })
    return { injected, warnings: plan.warnings, pushable: plan.order.length > 0 }
  },
  cool: () => runner.cool(),
  eject: (path, plate) => runner.ejectFile(path, plate),
  snapshot: () => snapshots.capture().then((s) => (s ? { url: s.url, file: s.file } : null)),
  notify: (e) => notifier.notifyIfEnabled(e),
  printerReady: () => {
    const s = state.summary()
    if (!mqtt.connected) return { ok: false, why: '打印机未连接' }
    if (BUSY.has(s.state)) return { ok: false, why: `打印机正忙（${s.state}）` }
    if (s.printError) return { ok: false, why: '打印机有未清除的报错' }
    return { ok: true, why: '' }
  },
  autoHarvestArmed: () => autoHarvest.status().armed,
})
/** 开打函数在路由模块里建好之后才有，先留一个引用 */
const startPrintRef = { current: (_b: Record<string, unknown>): Promise<unknown> => Promise.reject(new Error('服务还没起来')) }

/**
 * 设置模式：还没配置打印机。只起网页 App 和向导，什么都不连。
 * 向导写完配置后进程退出，交给 Docker 按新配置重新拉起（restart: unless-stopped）。
 */
async function setupMain() {
  const app = await buildSetupServer(() => {
    console.log('[setup] 配置已写入，重启以生效')
    process.exit(0)
  })
  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[setup] 还没配置打印机。用浏览器打开 http://<本机IP>:${config.api.port}/ 完成设置`)
  const stop = async () => { await app.close(); process.exit(0) }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
}

const camera = new CameraStream()
const go2rtc = config.camera.embed ? new EmbeddedGo2rtc() : null

async function main() {
  if (config.setupMode) return setupMain()
  if (!config.api.token) {
    console.warn('[警告] 未设置 API_TOKEN —— 接口无鉴权，仅限本地调试')
  }
  await events.start()
  await snapshots.start()
  await notifier.start()
  await checker.start()
  recordings.start()
  await history.start()
  await temps.start()
  autoHarvest.start()
  mqtt.start()
  go2rtc?.start()
  camera.start()
  const app = await buildServer(state, mqtt, notifier, history, temps, events, autoHarvest, {
    snapshots, checker, schedule, onEjected, queue,
    attachStart: (fn) => { startPrintRef.current = fn },
  })
  await queue.load()
  state.on('update', (s) => { void queue.onUpdate(s) })
  // 开打逻辑在服务器里，接上之后定时器才有意义
  await schedule.start()
  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[api] 监听 ${config.api.host}:${config.api.port}`)
  console.log(`[api] 打印机 ${config.printer.host} (${config.printer.serial})`)

  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 关闭中…`)
    mqtt.stop()
    camera.stop()
    go2rtc?.stop()
    schedule.stop()
    checker.stop()
    recordings.stop()
    // 先把没落盘的采样冲下去，否则最后一段曲线会丢
    await temps.flush()
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((e) => {
  console.error('启动失败:', e)
  process.exit(1)
})
