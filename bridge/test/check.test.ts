import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyBuffer, isCandidate, FileChecker } from '../src/check/index.js'
import { writeZip } from '../src/util/zipwrite.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const good = () => writeZip([
  { name: 'Metadata/plate_1.gcode', data: Buffer.from('G28\nG1 X10\n'.repeat(200)) },
  { name: 'Metadata/plate_1.png', data: Buffer.alloc(3000, 9), method: 0 },
])

test('完整的包判 ok', async () => {
  assert.deepEqual(await verifyBuffer(await good()), { status: 'ok' })
})

/*
 * 卡上真实的损坏形态是整扇区被替换 —— 中央目录还在、长度不变、内容错了。
 * 这种坏文件列表里看不出来，只有逐条目核 CRC 才抓得住。
 */
test('内容被改但结构完好的包判 corrupt，并指出坏条目', async () => {
  const buf = await good()
  // 改 gcode 条目 deflate 数据正中间的一个字节 —— 用中央目录定位，别靠猜偏移
  const { bufferSource, readCentralDirectory } = await import('../src/util/zip.js')
  const g = (await readCentralDirectory(bufferSource(buf))).find((e) => e.name.endsWith('.gcode'))!
  const nameLen = buf.readUInt16LE(g.localHeaderOffset + 26)
  const extraLen = buf.readUInt16LE(g.localHeaderOffset + 28)
  buf[g.localHeaderOffset + 30 + nameLen + extraLen + Math.floor(g.compressedSize / 2)] ^= 0xff
  const r = await verifyBuffer(buf)
  assert.equal(r.status, 'corrupt')
  assert.ok(r.badEntries?.includes('Metadata/plate_1.gcode'))
})

test('根本不是 zip 判 notZip', async () => {
  const r = await verifyBuffer(Buffer.from('这不是压缩包'.repeat(50)))
  assert.equal(r.status, 'notZip')
})

test('只体检 3mf，跳过 macOS 的资源分叉', () => {
  assert.ok(isCandidate('a.gcode.3mf')); assert.ok(isCandidate('b.3MF'))
  assert.ok(!isCandidate('._a.gcode.3mf')); assert.ok(!isCandidate('video.mp4'))
})

/*
 * 坏文件只在第一次发现时推送。每天体检一次，同一个坏文件天天响一遍
 * 就是噪声，用户会把整类推送关掉。
 */
test('新发现的坏文件推一次，再跑不重复响', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chk-'))
  const files = [{ name: 'good.3mf', size: 1, isDirectory: false }, { name: 'bad.3mf', size: 1, isDirectory: false }, { name: '._bad.3mf', size: 1, isDirectory: false }]
  const goodBuf = await good()
  const sent: string[] = []
  const c = new FileChecker(path.join(dir, 's.json'), {
    list: async () => files,
    download: async (p) => (p === '/good.3mf' ? goodBuf : Buffer.from('bad')),
    readsActive: () => 0,
    idle: () => true,
    notify: async (e) => { sent.push(e.kind + ':' + e.body) },
  }, 0)
  await c.start()
  const st = await c.run()
  assert.equal(st.total, 2, '资源分叉不算')
  assert.deepEqual(st.results.map((r) => r.status), ['ok', 'notZip'])
  assert.deepEqual(sent, ['fileCorrupt:bad.3mf'])
  await c.run()
  assert.equal(sent.length, 1, '第二次不该再响')
})
