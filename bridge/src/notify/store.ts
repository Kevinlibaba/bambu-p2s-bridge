/**
 * Web Push 订阅的持久化。
 *
 * 订阅本身不是密钥 —— 它是浏览器给出的推送端点，泄露了只能给你发通知，
 * 但仍然按 0600 存，没必要让同机其他进程读到。
 * 内容量很小（每个订阅几百字节），一个 JSON 文件足够，不值得引数据库。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

function valid(s: unknown): s is PushSubscription {
  const o = s as PushSubscription
  return (
    !!o &&
    typeof o.endpoint === 'string' &&
    /^https:\/\//.test(o.endpoint) &&
    !!o.keys &&
    typeof o.keys.p256dh === 'string' &&
    typeof o.keys.auth === 'string'
  )
}

export class PushStore {
  private subs: PushSubscription[] = []

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.subs = Array.isArray(raw) ? raw.filter(valid) : []
    } catch {
      this.subs = [] // 首次运行没有文件，属正常
    }
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.subs, null, 2), { mode: 0o600 })
  }

  all(): PushSubscription[] {
    return this.subs
  }

  /** 同一个 endpoint 只留一份，重复订阅不该造成重复推送 */
  async add(sub: unknown): Promise<boolean> {
    if (!valid(sub)) return false
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint)
    this.subs.push(sub)
    await this.flush()
    return true
  }

  async remove(endpoint: string): Promise<boolean> {
    const before = this.subs.length
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint)
    if (this.subs.length === before) return false
    await this.flush()
    return true
  }

  async removeMany(endpoints: string[]): Promise<void> {
    const gone = new Set(endpoints)
    this.subs = this.subs.filter((s) => !gone.has(s.endpoint))
    await this.flush()
  }
}
