import { Client, type FileInfo } from 'basic-ftp'
import { Writable, Readable } from 'node:stream'
import { config } from '../config.js'

/**
 * 打印机的 vsftpd 开了 require_ssl_reuse，数据连接必须复用控制连接的 TLS session。
 * basic-ftp 会自动处理（Python 的 ftplib 则需手动传 session）。
 */
async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client(20_000)
  try {
    await c.access({
      host: config.printer.host,
      port: config.printer.ftpPort,
      user: 'bblp',
      password: config.printer.accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false },
    })
    return await fn(c)
  } finally {
    c.close()
  }
}

export interface RemoteFile {
  name: string
  size: number
  isDirectory: boolean
  modifiedAt: string | null
}

function normalize(path: string): string {
  const p = '/' + path.replace(/^\/+/, '')
  // 挡掉路径穿越
  if (p.includes('..')) throw new Error('非法路径')
  return p
}

export async function listDir(path = '/'): Promise<RemoteFile[]> {
  const dir = normalize(path)
  const items: FileInfo[] = await withClient((c) => c.list(dir))
  return items.map((f) => ({
    name: f.name,
    size: f.size,
    isDirectory: f.isDirectory,
    modifiedAt: f.modifiedAt ? f.modifiedAt.toISOString() : null,
  }))
}

export async function download(path: string): Promise<Buffer> {
  const file = normalize(path)
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  await withClient((c) => c.downloadTo(sink, file))
  return Buffer.concat(chunks)
}

export async function upload(path: string, data: Buffer): Promise<void> {
  const file = normalize(path)
  await withClient((c) => c.uploadFrom(Readable.from(data), file))
}
