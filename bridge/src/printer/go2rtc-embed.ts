/**
 * 单容器模式下由桥接自己拉起 go2rtc（GO2RTC_EMBED=1）。
 *
 * 平时 go2rtc 是 compose 里单独的一个容器。但 Home Assistant 加载项、Unraid 模板都只能是
 * 一个容器，群晖用户也是越少越好 —— 所以镜像里带了 go2rtc 的静态二进制，这里负责启动、
 * 挂了就重启、桥接退出时一起停。配置是镜像里的 /app/go2rtc.yaml，端口避开了默认的
 * 1984/8554/8555（Frigate 自带的 go2rtc 就占着那几个）。
 */
import { spawn, type ChildProcess } from 'node:child_process'

const RESTART_MIN_MS = 2_000
const RESTART_MAX_MS = 60_000

export class EmbeddedGo2rtc {
  private child: ChildProcess | null = null
  private stopped = false
  private backoff = RESTART_MIN_MS
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly bin = process.env.GO2RTC_BIN ?? '/usr/local/bin/go2rtc',
    private readonly configPath = process.env.GO2RTC_CONFIG ?? '/app/go2rtc.yaml',
    private readonly log: (m: string) => void = (m) => console.log(m),
  ) {}

  start(): void {
    if (this.stopped || this.child) return
    const startedAt = Date.now()
    const child = spawn(this.bin, ['-config', this.configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    const relay = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) this.log(`[go2rtc] ${line.trim()}`)
    }
    child.stdout?.on('data', relay)
    child.stderr?.on('data', relay)
    child.on('error', (e) => this.log(`[go2rtc] 起不来：${e.message}`))
    child.on('exit', (code, sig) => {
      this.child = null
      if (this.stopped) return
      // 跑了一阵才挂的，退避从头算；刚起就挂的，越等越久，免得刷屏
      if (Date.now() - startedAt > 30_000) this.backoff = RESTART_MIN_MS
      this.log(`[go2rtc] 退出（${sig ?? code}），${Math.round(this.backoff / 1000)} 秒后重启`)
      this.timer = setTimeout(() => this.start(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS)
    })
    this.log(`[go2rtc] 已启动（内置，配置 ${this.configPath}）`)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.child?.kill('SIGTERM')
  }
}
