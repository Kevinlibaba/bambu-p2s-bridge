import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { parseRangeHeader, resolveRange } from '../src/util/range.js'
import { createTruncatedStream } from '../src/util/stream.js'
import { registerFileRoutes } from '../src/api/files.js'
import { makeThreeMf, memoryBackend, PLATE_1_PNG } from './helpers.js'

// ---------- 纯函数 ----------

test('parseRangeHeader 认得三种单区间写法', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-99'), { kind: 'spec', spec: { start: 0, end: 99 } })
  assert.deepEqual(parseRangeHeader('bytes=500-'), { kind: 'spec', spec: { start: 500 } })
  assert.deepEqual(parseRangeHeader('bytes=-256'), { kind: 'spec', spec: { suffix: 256 } })
  assert.deepEqual(parseRangeHeader(' bytes = 10-20 '), {
    kind: 'spec',
    spec: { start: 10, end: 20 },
  })
})

test('多区间与畸形写法一律忽略，回落成整体响应', () => {
  assert.deepEqual(parseRangeHeader(undefined), { kind: 'none' })
  assert.deepEqual(parseRangeHeader(''), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('bytes=0-9,20-29'), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('items=0-9'), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('bytes=abc-def'), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('bytes=1-2-3'), { kind: 'none' })
})

test('resolveRange 把请求区间对齐到实际大小', () => {
  assert.deepEqual(resolveRange(undefined, 100), { start: 0, end: 99 })
  assert.deepEqual(resolveRange({ start: 0, end: 0 }, 100), { start: 0, end: 0 })
  // 末尾越界要夹到 size-1，这是 <video> 首个请求最常见的形态
  assert.deepEqual(resolveRange({ start: 90, end: 1000 }, 100), { start: 90, end: 99 })
  assert.deepEqual(resolveRange({ start: 50 }, 100), { start: 50, end: 99 })
  assert.deepEqual(resolveRange({ suffix: 10 }, 100), { start: 90, end: 99 })
  assert.deepEqual(resolveRange({ suffix: 500 }, 100), { start: 0, end: 99 })

  assert.equal(resolveRange({ start: 100 }, 100), null)
  assert.equal(resolveRange({ start: 200, end: 300 }, 100), null)
  assert.equal(resolveRange({ suffix: 0 }, 100), null)
  assert.equal(resolveRange(undefined, 0), null)
})

// ---------- 截断管道 ----------

test('定长截断：够了就收工，并回调去销毁 FTP 连接', async () => {
  let finished = 0
  const pipe = createTruncatedStream(10, () => {
    finished += 1
  })

  const chunks: Buffer[] = []
  pipe.out.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((r) => pipe.out.on('end', () => r()))

  // FTP 那边会一直往下发，我们只要前 10 个字节
  pipe.sink.write(Buffer.from('0123456'))
  pipe.sink.write(Buffer.from('789abcdefghij'))
  pipe.sink.write(Buffer.from('还在发'))
  await done

  assert.equal(Buffer.concat(chunks).toString(), '0123456789')
  assert.equal(pipe.done, true)
  assert.equal(finished, 1, 'onFinish 必须恰好调用一次')

  pipe.finish()
  pipe.finish(new Error('迟到的错误'))
  assert.equal(finished, 1, 'finish 必须幂等')
})

test('下游提前断开也会触发收工', async () => {
  let finished = 0
  const pipe = createTruncatedStream(1_000_000, () => {
    finished += 1
  })
  pipe.out.destroy()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(finished, 1)
})

// ---------- HTTP 层 ----------

const VIDEO = Buffer.from(
  Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''),
  'utf8',
)

async function buildApp() {
  const backend = memoryBackend({
    '/timelapse/video_test.mp4': VIDEO,
    '/timelapse/thumbnail/video_test.jpg': PLATE_1_PNG,
    '/model.gcode.3mf': makeThreeMf(),
    '/broken.3mf': Buffer.alloc(4096, 7),
  })
  const app = Fastify()
  registerFileRoutes(app, backend)
  await app.ready()
  return { app, backend }
}

const VIDEO_URL = '/api/files/stream?path=' + encodeURIComponent('/timelapse/video_test.mp4')

test('无 Range：200 且 Content-Length 等于文件大小', async () => {
  const { app } = await buildApp()
  const res = await app.inject({ method: 'GET', url: VIDEO_URL })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(res.headers['content-type'], 'video/mp4')
  assert.equal(res.headers['content-length'], String(VIDEO.length))
  assert.equal(res.headers['content-range'], undefined)
  assert.deepEqual(res.rawPayload, VIDEO)
  await app.close()
})

test('带 Range：206、Content-Range 正确、字节确实是被请求的那一段', async () => {
  const { app } = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: VIDEO_URL,
    headers: { range: 'bytes=1000-1099' },
  })

  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-range'], `bytes 1000-1099/${VIDEO.length}`)
  assert.equal(res.headers['content-length'], '100')
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(res.rawPayload.length, 100)
  assert.deepEqual(res.rawPayload, VIDEO.subarray(1000, 1100))
  await app.close()
})

test('开放式 Range 与末尾 N 字节', async () => {
  const { app } = await buildApp()

  const tail = await app.inject({
    method: 'GET',
    url: VIDEO_URL,
    headers: { range: 'bytes=4900-' },
  })
  assert.equal(tail.statusCode, 206)
  assert.equal(tail.headers['content-range'], `bytes 4900-4999/${VIDEO.length}`)
  assert.deepEqual(tail.rawPayload, VIDEO.subarray(4900))

  const suffix = await app.inject({
    method: 'GET',
    url: VIDEO_URL,
    headers: { range: 'bytes=-64' },
  })
  assert.equal(suffix.statusCode, 206)
  assert.equal(suffix.headers['content-range'], `bytes 4936-4999/${VIDEO.length}`)
  assert.deepEqual(suffix.rawPayload, VIDEO.subarray(VIDEO.length - 64))
  await app.close()
})

test('Safari 的首个探测请求 bytes=0-1 要拿到恰好两个字节', async () => {
  const { app } = await buildApp()
  const res = await app.inject({ method: 'GET', url: VIDEO_URL, headers: { range: 'bytes=0-1' } })
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-length'], '2')
  assert.equal(res.headers['content-range'], `bytes 0-1/${VIDEO.length}`)
  assert.deepEqual(res.rawPayload, VIDEO.subarray(0, 2))
  await app.close()
})

test('末尾越界的 Range 被夹回文件尾，而不是 416', async () => {
  const { app } = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: VIDEO_URL,
    headers: { range: 'bytes=4990-999999' },
  })
  assert.equal(res.statusCode, 206)
  assert.equal(res.headers['content-range'], `bytes 4990-4999/${VIDEO.length}`)
  assert.equal(res.headers['content-length'], '10')
  await app.close()
})

test('起点越界返回 416 并带上 Content-Range: bytes */size', async () => {
  const { app } = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: VIDEO_URL,
    headers: { range: 'bytes=99999-' },
  })
  assert.equal(res.statusCode, 416)
  assert.equal(res.headers['content-range'], `bytes */${VIDEO.length}`)
  await app.close()
})

test('多区间请求回落成 200 整体响应', async () => {
  const { app } = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: VIDEO_URL,
    headers: { range: 'bytes=0-9,100-109' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], String(VIDEO.length))
  await app.close()
})

test('HEAD 不开数据连接，只给大小', async () => {
  const { app, backend } = await buildApp()
  const res = await app.inject({ method: 'HEAD', url: VIDEO_URL })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], String(VIDEO.length))
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(res.rawPayload.length, 0)
  assert.equal(backend.openStreams(), 0, 'HEAD 不应该开流')
  await app.close()
})

test('响应结束后没有流被漏下', async () => {
  const { app, backend } = await buildApp()
  await app.inject({ method: 'GET', url: VIDEO_URL, headers: { range: 'bytes=0-1' } })
  await app.inject({ method: 'GET', url: VIDEO_URL })
  assert.equal(backend.openStreams(), 0)
  await app.close()
})

test('下载端点带 attachment，流端点带 inline', async () => {
  const { app } = await buildApp()
  const dl = await app.inject({
    method: 'GET',
    url: '/api/files/download?path=' + encodeURIComponent('/timelapse/video_test.mp4'),
  })
  assert.match(String(dl.headers['content-disposition']), /^attachment;/)
  assert.match(String(dl.headers['content-disposition']), /filename="video_test\.mp4"/)

  const st = await app.inject({ method: 'GET', url: VIDEO_URL })
  assert.match(String(st.headers['content-disposition']), /^inline;/)
  await app.close()
})

test('下载端点同样支持 Range', async () => {
  const { app } = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: '/api/files/download?path=' + encodeURIComponent('/timelapse/video_test.mp4'),
    headers: { range: 'bytes=10-19' },
  })
  assert.equal(res.statusCode, 206)
  assert.deepEqual(res.rawPayload, VIDEO.subarray(10, 20))
  await app.close()
})

// ---------- 路径安全 ----------

test('路径穿越与控制字符被拦下', async () => {
  const { app } = await buildApp()
  for (const bad of ['/../etc/passwd', '/timelapse/../../etc/passwd', '/a\r\nDELE x', '/a b']) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/files/stream?path=' + encodeURIComponent(bad),
    })
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} 应当被拒`)
  }
  const missing = await app.inject({ method: 'GET', url: '/api/files/stream' })
  assert.equal(missing.statusCode, 400)
  await app.close()
})

// ---------- 3MF ----------

const MODEL_URL = '/api/files/3mf?path=' + encodeURIComponent('/model.gcode.3mf')

test('3MF 元数据端点返回逐盘信息', async () => {
  const { app } = await buildApp()
  const res = await app.inject({ method: 'GET', url: MODEL_URL })
  assert.equal(res.statusCode, 200)

  const body = res.json()
  assert.equal(body.name, 'model.gcode.3mf')
  assert.equal(body.hasModel, true)
  assert.equal(body.metadataMissing, false)
  assert.equal(body.plates.length, 2)
  assert.equal(body.plates[0].prediction, 8130)
  assert.equal(body.plates[0].weight, 42.75)
  assert.equal(body.plates[0].hasThumbnail, true)
  assert.deepEqual(body.plates[0].objects, ['bracket.stl', 'cap.stl'])
  await app.close()
})

test('取盘预览图拿到的就是包内那张 PNG', async () => {
  const { app } = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: '/api/files/3mf/plate.png?path=' + encodeURIComponent('/model.gcode.3mf') + '&plate=1',
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.deepEqual(res.rawPayload, PLATE_1_PNG)
  await app.close()
})

test('不存在的盘返回 404，非法 plate 返回 400', async () => {
  const { app } = await buildApp()
  const p = encodeURIComponent('/model.gcode.3mf')

  const notFound = await app.inject({ method: 'GET', url: `/api/files/3mf/plate.png?path=${p}&plate=9` })
  assert.equal(notFound.statusCode, 404)

  const bad = await app.inject({ method: 'GET', url: `/api/files/3mf/plate.png?path=${p}&plate=0` })
  assert.equal(bad.statusCode, 400)
  await app.close()
})

test('非 3MF 与损坏的包分别是 400 和 422', async () => {
  const { app } = await buildApp()

  const notZip = await app.inject({
    method: 'GET',
    url: '/api/files/3mf?path=' + encodeURIComponent('/timelapse/video_test.mp4'),
  })
  assert.equal(notZip.statusCode, 400)

  const broken = await app.inject({
    method: 'GET',
    url: '/api/files/3mf?path=' + encodeURIComponent('/broken.3mf'),
  })
  assert.equal(broken.statusCode, 422)
  await app.close()
})

test('第二次取同一个包时中央目录走缓存，不再读尾部', async () => {
  const zip = makeThreeMf()
  let reads = 0
  const base = memoryBackend({ '/model.gcode.3mf': zip })
  const app = Fastify()
  registerFileRoutes(app, {
    ...base,
    readRange: (path, spec) => {
      reads += 1
      return base.readRange(path, spec)
    },
  })
  await app.ready()

  await app.inject({ method: 'GET', url: MODEL_URL })
  const first = reads
  await app.inject({ method: 'GET', url: MODEL_URL })
  assert.ok(reads - first < first, `第二次读取次数 ${reads - first} 应少于首次 ${first}`)
  await app.close()
})
