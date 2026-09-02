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
  history: {
    /** 打印历史（JSONL）落盘位置。容器里挂 /data */
    path: process.env.HISTORY_PATH ?? '/data/jobs.jsonl',
    /** 温度采样按天分文件放这里，用来回看历史某一单的曲线 */
    tempsDir: process.env.TEMPS_DIR ?? '/data/temps',
    /** 温度曲线保留天数 */
    tempsKeepDays: Number(process.env.TEMPS_KEEP_DAYS ?? 60),
  },
  notify: {
    enabled: process.env.NOTIFY_ENABLED !== 'false',
    /** 逗号分隔的事件类型，或 all */
    events: (process.env.NOTIFY_EVENTS ?? 'all').split(',').map((s) => s.trim()).filter(Boolean),
    /** 错误码释义用的语言，与 app 的语言包同名 */
    lang: process.env.NOTIFY_LANG ?? 'zh-Hans',
    /** Web Push 订阅落盘位置。容器里挂 /data */
    storePath: process.env.NOTIFY_STORE ?? '/data/push-subscriptions.json',
    vapid: {
      publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
      privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
      /** RFC 8292 要求的联系方式，浏览器厂商用它联系推送发起方 */
      subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    },
    /** https://api.day.app/<设备key> */
    bark: process.env.BARK_URL ?? '',
    /** https://ntfy.sh/<topic>，也可指向自建实例 */
    ntfy: process.env.NTFY_URL ?? '',
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN ?? '',
      chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    },
    webhook: process.env.NOTIFY_WEBHOOK ?? '',
  },
}
