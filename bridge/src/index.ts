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

const state = new PrinterState()
const mqtt = new PrinterMqtt(state)
const events = new EventLog(config.history.eventsDir, config.history.tempsKeepDays)
const notifier = new Notifier(state, events)
const history = new History(state, lookupPlate)
const temps = new Temps(state, 10_000, 1080, config.history.tempsDir, 6, config.history.tempsKeepDays)
const autoHarvest = new AutoHarvest(state, makeHarvestRunner(state, mqtt, history))

async function main() {
  if (!config.api.token) {
    console.warn('[警告] 未设置 API_TOKEN —— 接口无鉴权，仅限本地调试')
  }
  await events.start()
  await notifier.start()
  await history.start()
  await temps.start()
  autoHarvest.start()
  mqtt.start()
  const app = await buildServer(state, mqtt, notifier, history, temps, events, autoHarvest)
  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[api] 监听 ${config.api.host}:${config.api.port}`)
  console.log(`[api] 打印机 ${config.printer.host} (${config.printer.serial})`)

  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 关闭中…`)
    mqtt.stop()
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
