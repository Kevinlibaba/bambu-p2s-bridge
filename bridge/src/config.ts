function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`缺少必需的环境变量: ${name}`)
  return v
}

export const config = {
  printer: {
    host: req('BAMBU_HOST'),
    serial: req('BAMBU_SERIAL'),
    accessCode: req('BAMBU_ACCESS_CODE'),
    mqttPort: 8883,
    ftpPort: 990,
  },
  api: {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.BIND_HOST ?? '0.0.0.0',
    /** 为空则不鉴权（仅限本地调试）。生产必须设置。 */
    token: process.env.API_TOKEN ?? '',
  },
  camera: {
    /** go2rtc 地址，桥接服务在其前面做鉴权代理 */
    go2rtc: process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984',
    stream: process.env.GO2RTC_STREAM ?? 'bambu_p2s',
  },
  /** 长时间没收到 report 时重新对齐的间隔（毫秒）。固件对 pushall 有限速，勿调小。 */
  pushallIntervalMs: Number(process.env.PUSHALL_INTERVAL_MS ?? 5 * 60 * 1000),
  /** 允许 gcode_line 这类危险命令 */
  allowRawGcode: process.env.ALLOW_RAW_GCODE === 'true',
}
