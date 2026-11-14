/**
 * 把打印机的视频流注册进 go2rtc。
 *
 * 以前流写死在 go2rtc.yaml 里、靠 .env 插值拿访问码 —— 这样 go2rtc 启动时就得知道
 * 凭据，网页向导配置的打印机它看不到。现在 go2rtc.yaml 里不写流，由桥接在运行时
 * 通过 go2rtc 的 API 加上去，凭据只在桥接一处。
 *
 * go2rtc 1.9 的行为（实测）：PUT /api/streams?name=&src= 会新建或替换同名流，但因为
 * 想把改动写回只读挂载的配置文件而回 400 —— 内存里其实已经生效。所以不看状态码，
 * 写完再 GET 一次核对。go2rtc 重启后运行时加的流会丢，这里定时核对、缺了就补。
 */
import { config } from '../config.js'

const CHECK_MS = 60_000
const RETRY_MS = 5_000

export function streamSource(host: string, code: string): string {
  return `rtsps://bblp:${encodeURIComponent(code)}@${host}:322/streaming/live/1`
}

async function currentSources(base: string, name: string): Promise<string[] | null> {
  try {
    const r = await fetch(`${base}/api/streams`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return null
    const all = (await r.json()) as Record<string, { producers?: { url?: string }[] } | null>
    return (all[name]?.producers ?? []).map((p) => p.url ?? '')
  } catch {
    return null // go2rtc 还没起来
  }
}

/** 确保流在且指向这台打印机。返回是否已就绪 */
export async function ensureStream(
  base = config.camera.go2rtc,
  name = config.camera.stream,
  src = streamSource(config.printer.host, config.printer.accessCode),
): Promise<boolean> {
  const before = await currentSources(base, name)
  if (before === null) return false
  if (before.includes(src)) return true
  try {
    await fetch(`${base}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    return false
  }
  return (await currentSources(base, name))?.includes(src) ?? false
}

export class CameraStream {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  start(): void {
    const loop = async () => {
      if (this.stopped) return
      const ok = await ensureStream()
      this.timer = setTimeout(loop, ok ? CHECK_MS : RETRY_MS)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}
