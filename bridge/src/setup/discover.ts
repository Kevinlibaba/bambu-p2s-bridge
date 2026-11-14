/**
 * 在局域网里找 Bambu 打印机（scripts/discover.py 的 Node 版，给网页向导用）。
 *
 * 打印机会往 239.255.255.250:2021 周期性广播 SSDP NOTIFY，里面带序列号、型号、
 * 名字和固件版本。访问码印在打印机屏幕上，没法自动拿。
 *
 * 要收到广播，容器必须用宿主机网络（compose 里是 network_mode: host）。
 * 路由器开了组播隔离时一台也找不到 —— 向导会给手动填写的入口。
 */
import { createSocket } from 'node:dgram'

const GROUP = '239.255.255.250'
const PORT = 2021
/** M-SEARCH 两个端口都发：不同固件表现不一致 */
const SEARCH_PORTS = [1990, 2021]
const ST = 'urn:bambulab-com:device:3dprinter:1'

/** 只写实测确认过的；其余机型原样显示代号 */
const MODELS: Record<string, string> = { N7: 'P2S' }

export interface FoundPrinter {
  ip: string
  serial: string
  /** 型号代号，如 N7 */
  model: string
  /** 能认出来的型号名，如 P2S；认不出就是空 */
  modelName: string
  name: string
  version: string
}

/** 解析一条 SSDP 报文。自定义头形如 `DevModel.bambu.com: N7` */
export function parseSsdp(text: string, fromIp: string): FoundPrinter | null {
  const info: Record<string, string> = {}
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    let key = line.slice(0, i).trim().toLowerCase()
    if (key.endsWith('.bambu.com')) key = key.slice(0, -'.bambu.com'.length)
    info[key] = line.slice(i + 1).trim()
  }
  const serial = (info.usn ?? '').trim()
  if (!serial) return null
  const model = info.devmodel ?? ''
  return {
    ip: (info.location ?? '').trim() || fromIp,
    serial,
    model,
    modelName: MODELS[model] ?? '',
    name: info.devname ?? '',
    version: info.devversion ?? '',
  }
}

export function discoverPrinters(timeoutMs = 6000): Promise<FoundPrinter[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundPrinter>()
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock.close() } catch { /* 已关 */ }
      resolve([...found.values()])
    }
    const timer = setTimeout(finish, timeoutMs)

    sock.on('error', () => finish())
    sock.on('message', (msg, rinfo) => {
      const p = parseSsdp(msg.toString('utf8'), rinfo.address)
      if (p) found.set(p.serial, p)
    })
    sock.bind(PORT, () => {
      try {
        sock.addMembership(GROUP)
      } catch {
        // 没有组播路由（比如容器不是 host 网络）：照样等一会儿，可能还能收到单播回应
      }
      const search = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: ${GROUP}:${PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${ST}\r\n\r\n`,
      )
      for (const port of SEARCH_PORTS) sock.send(search, port, GROUP, () => {})
    })
  })
}
