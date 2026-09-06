/**
 * 推送用的摄像头快照。
 *
 * 为什么要落盘再给一个无鉴权的随机 URL，而不是直接把 /api/camera/snapshot.jpg
 * 的地址塞进推送：通知里的图片是由手机系统去取的，带不上我们的 Bearer token；
 * 把 token 拼进 URL 又等于把 API 钥匙写进每一条通知。所以每张图一个 128 位
 * 随机 id，猜不到，过期就删，泄露一张图的代价也只是一张图。
 *
 * 图本身走 go2rtc 的 frame.jpeg —— 它从正在转发的 H.264 流里解一帧，不额外
 * 连打印机的摄像头。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

/** 抓一帧最多等这么久。go2rtc 正常几百毫秒，流断了就别拖着推送 */
const CAPTURE_TIMEOUT_MS = 5000
const KEEP_MAX = 200
const KEEP_DAYS = 14

export interface Snapshot {
  id: string
  /** 本地路径 */
  file: string
  /** 相对 URL，前面拼上 PUBLIC_URL 才是完整地址 */
  url: string
}

export class Snapshots {
  constructor(private readonly dir: string) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.prune().catch(() => {})
  }

  /** 取不到（流断了、go2rtc 没起来）返回 null —— 推送照发，只是没图 */
  async capture(): Promise<Snapshot | null> {
    const src = `${config.camera.go2rtc}/api/frame.jpeg?src=${encodeURIComponent(config.camera.stream)}`
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1024) return null // 不是一张像样的图
      const id = randomBytes(16).toString('hex')
      const file = path.join(this.dir, `${id}.jpg`)
      await writeFile(file, buf)
      void this.prune().catch(() => {})
      return { id, file, url: `/api/snapshots/${id}.jpg` }
    } catch {
      return null
    }
  }

  /** 只认我们自己生成的文件名，别让路径拼接出目录之外 */
  filePath(name: string): string | null {
    if (!/^[a-f0-9]{32}\.jpg$/.test(name)) return null
    return path.join(this.dir, name)
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.jpg'))
    const infos = await Promise.all(names.map(async (n) => ({ n, at: (await stat(path.join(this.dir, n))).mtimeMs })))
    infos.sort((a, b) => b.at - a.at)
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    for (const [i, x] of infos.entries()) {
      if (i >= KEEP_MAX || x.at < cutoff) await unlink(path.join(this.dir, x.n)).catch(() => {})
    }
  }
}
