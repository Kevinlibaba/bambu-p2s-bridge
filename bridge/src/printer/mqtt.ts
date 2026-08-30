import mqtt, { type MqttClient } from 'mqtt'
import { config } from '../config.js'
import type { PrinterState, Json } from './state.js'

export class PrinterMqtt {
  private client?: MqttClient
  private seq = 1
  private pushallTimer?: NodeJS.Timeout
  private lastPushall = 0

  readonly reportTopic = `device/${config.printer.serial}/report`
  readonly requestTopic = `device/${config.printer.serial}/request`

  constructor(private state: PrinterState) {}

  start() {
    const { host, mqttPort, accessCode } = config.printer
    this.client = mqtt.connect(`mqtts://${host}:${mqttPort}`, {
      username: 'bblp',
      password: accessCode,
      clientId: `bambu-bridge-${Math.random().toString(16).slice(2, 10)}`,
      // 打印机使用自签证书；LAN 内 + Tailscale 加密通道，此处不做链验证
      rejectUnauthorized: false,
      protocolVersion: 4,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      clean: true,
    })

    this.client.on('connect', () => {
      console.log('[mqtt] 已连接打印机')
      this.state.setConnected(true)
      this.client!.subscribe(this.reportTopic, { qos: 0 }, (err) => {
        if (err) console.error('[mqtt] 订阅失败', err)
        else this.pushall('connect')
      })
    })

    this.client.on('message', (_topic, payload) => {
      let msg: Json
      try {
        msg = JSON.parse(payload.toString())
      } catch {
        return
      }
      this.state.applyReport(msg)
    })

    this.client.on('error', (e) => console.error('[mqtt] 错误:', e.message))
    this.client.on('close', () => {
      this.state.setConnected(false)
      console.warn('[mqtt] 连接断开')
    })
    this.client.on('reconnect', () => console.log('[mqtt] 重连中…'))

    // 长时间没收到增量时重新对齐。固件对 pushall 有限速，间隔不要调小。
    this.pushallTimer = setInterval(() => {
      const silent = Date.now() - this.state.lastReportAt
      if (silent > config.pushallIntervalMs) this.pushall('resync')
    }, 60_000)
  }

  stop() {
    if (this.pushallTimer) clearInterval(this.pushallTimer)
    this.client?.end(true)
  }

  private nextSeq() {
    return String(this.seq++)
  }

  publish(obj: Json): string {
    if (!this.client?.connected) throw new Error('打印机 MQTT 未连接')
    const seq = this.nextSeq()
    // 给命令体补上 sequence_id
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        ;(v as Json).sequence_id ??= seq
      }
    }
    this.client.publish(this.requestTopic, JSON.stringify(obj), { qos: 0 })
    return seq
  }

  /** pushall 有固件级限速，这里再加一道保险 */
  pushall(reason = 'manual') {
    const since = Date.now() - this.lastPushall
    if (since < 30_000) {
      console.log(`[mqtt] pushall 跳过 (${reason}，距上次 ${Math.round(since / 1000)}s)`)
      return false
    }
    this.lastPushall = Date.now()
    console.log(`[mqtt] pushall (${reason})`)
    this.publish({ pushing: { command: 'pushall' } })
    return true
  }

  get connected() {
    return !!this.client?.connected
  }
}
