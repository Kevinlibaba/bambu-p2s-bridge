import { config } from './config.js'
import { PrinterState } from './printer/state.js'
import { PrinterMqtt } from './printer/mqtt.js'
import { buildServer } from './api/server.js'

const state = new PrinterState()
const mqtt = new PrinterMqtt(state)

async function main() {
  if (!config.api.token) {
    console.warn('[警告] 未设置 API_TOKEN —— 接口无鉴权，仅限本地调试')
  }
  mqtt.start()
  const app = await buildServer(state, mqtt)
  await app.listen({ port: config.api.port, host: config.api.host })
  console.log(`[api] 监听 ${config.api.host}:${config.api.port}`)
  console.log(`[api] 打印机 ${config.printer.host} (${config.printer.serial})`)

  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 关闭中…`)
    mqtt.stop()
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
