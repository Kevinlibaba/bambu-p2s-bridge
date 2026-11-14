/**
 * 用向导里填的 IP / 序列号 / 访问码真的连一次打印机。
 *
 * 只连上 MQTT 还不够：序列号填错也能连上，只是那个主题上永远没消息。所以要订阅
 * device/<序列号>/report、发一次 pushall，真收到报告才算通 —— 三样一起被证明。
 *
 * 这也是向导唯一的防线：设置模式下谁都能打开网页，但只有站在打印机跟前、看得到
 * 屏幕上访问码的人才过得了这一步。
 */
import mqtt from 'mqtt'

export type VerifyError =
  | 'unreachable' // 连不上 8883：IP 不对、打印机没开、不在同一网段
  | 'auth' // 访问码不对
  | 'noReport' // 连上了但收不到报告：序列号不对，或没开局域网 / 开发者模式
  | 'invalid' // 输入格式不对

export interface VerifyResult {
  ok: boolean
  error?: VerifyError
  /** 收到的报告里能顺手拿到的信息 */
  state?: string
  detail?: string
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9.-]+$/i
const SERIAL_RE = /^[A-Z0-9]{8,20}$/i
const CODE_RE = /^[A-Za-z0-9]{8}$/

export function validateInput(host: string, serial: string, code: string): VerifyError | null {
  if (!IP_RE.test(host) || !SERIAL_RE.test(serial) || !CODE_RE.test(code)) return 'invalid'
  return null
}

export function verifyPrinter(host: string, serial: string, code: string, timeoutMs = 12_000): Promise<VerifyResult> {
  const bad = validateInput(host, serial, code)
  if (bad) return Promise.resolve({ ok: false, error: bad })

  return new Promise((resolve) => {
    let settled = false
    const client = mqtt.connect(`mqtts://${host}:8883`, {
      username: 'bblp',
      password: code,
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 6000,
      clientId: `bridge-setup-${Math.random().toString(16).slice(2, 10)}`,
    })
    const done = (r: VerifyResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end(true)
      resolve(r)
    }
    const timer = setTimeout(
      () => done(client.connected ? { ok: false, error: 'noReport' } : { ok: false, error: 'unreachable' }),
      timeoutMs,
    )

    client.on('connect', () => {
      client.subscribe(`device/${serial}/report`, { qos: 0 }, (err) => {
        if (err) return done({ ok: false, error: 'noReport', detail: err.message })
        client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }))
      })
    })
    client.on('message', (_t, payload) => {
      let state = ''
      try {
        state = String((JSON.parse(payload.toString()) as { print?: { gcode_state?: string } }).print?.gcode_state ?? '')
      } catch { /* 不是 JSON 也算收到了 */ }
      done({ ok: true, state })
    })
    client.on('error', (e: Error & { code?: number | string }) => {
      // CONNACK 4 / 5：用户名密码错误、未授权
      if (e.code === 4 || e.code === 5 || /not authorized|bad user ?name or password/i.test(e.message)) {
        return done({ ok: false, error: 'auth' })
      }
      done({ ok: false, error: 'unreachable', detail: e.message })
    })
  })
}
