import { PassThrough, Writable } from 'node:stream'

export interface TruncatedStream {
  /** 交给 basic-ftp 的写入端 */
  sink: Writable
  /** 交给 HTTP 响应的读取端，最多产出 length 字节 */
  out: PassThrough
  /** 幂等。传 err 表示异常收尾。 */
  finish(err?: Error): void
  readonly done: boolean
}

/**
 * 定长截断管道。
 *
 * FTP 没有"只取这一段"的语义 —— REST 能指定起点，却无法指定终点，
 * 也无法中途叫停一次传输。所以 Range 请求只能在写入侧数够字节就收工，
 * 再由 onFinish 去销毁那条连接。不这么做，每个 seek 都会漏一条 FTP 连接。
 */
export function createTruncatedStream(
  length: number,
  onFinish: (err?: Error) => void,
): TruncatedStream {
  const out = new PassThrough()
  let remaining = Math.max(0, length)
  let done = false

  const finish = (err?: Error) => {
    if (done) return
    done = true
    if (!out.destroyed) {
      if (err) out.destroy(err)
      else out.end()
    }
    onFinish(err)
  }

  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (done) return cb()
      const buf = chunk as Buffer
      const take = buf.length <= remaining ? buf : buf.subarray(0, remaining)
      remaining -= take.length
      const flushed = take.length === 0 || out.write(take)
      if (remaining <= 0) {
        finish()
        return cb()
      }
      if (flushed) cb()
      else out.once('drain', cb)
    },
    final(cb) {
      finish()
      cb()
    },
  })

  // basic-ftp 用 stream.pipeline，出错时会 destroy 这个 sink；
  // pipeline 自己挂了 error 监听，这里再兜一层，避免任何路径下抛未捕获异常。
  sink.on('error', () => finish())
  // 下游（浏览器）提前断开也要收工
  out.on('close', () => finish())

  if (remaining === 0) queueMicrotask(() => finish())

  return {
    sink,
    out,
    finish,
    get done() {
      return done
    },
  }
}
