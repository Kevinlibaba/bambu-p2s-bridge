import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeZip, patchZip, crc32 } from '../src/util/zipwrite.js'
import { bufferSource, readCentralDirectory, readEntry } from '../src/util/zip.js'

async function names(buf: Buffer): Promise<string[]> {
  return (await readCentralDirectory(bufferSource(buf))).map((e) => e.name)
}

async function read(buf: Buffer, name: string): Promise<string> {
  const src = bufferSource(buf)
  const e = (await readCentralDirectory(src)).find((x) => x.name === name)!
  return (await readEntry(src, e, 1 << 20)).toString('utf8')
}

test('写出来的包能被自己的读取器读回去', async () => {
  const z = await writeZip([
    { name: 'a.txt', data: Buffer.from('第一个') },
    { name: 'dir/b.bin', data: Buffer.alloc(5000, 7) },
  ])
  assert.deepEqual(await names(z), ['a.txt', 'dir/b.bin'])
  assert.equal(await read(z, 'a.txt'), '第一个')
})

/*
 * CRC 写错的话我们自己的读取器照样能读（它不校验），但打印机不一定。
 * 拿 unzip -t 做外部校验 —— 它会真的核对 CRC 和中央目录。
 */
test('外部工具校验通过（CRC、中央目录都对）', async (t) => {
  let unzip = true
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
  } catch {
    unzip = false
  }
  if (!unzip) return t.skip('环境里没有 unzip')

  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'zw-'))
  const f = path.join(dir, 't.zip')
  writeFileSync(f, await writeZip([
    { name: 'a.txt', data: Buffer.from('hello'.repeat(500)) },
    { name: 'stored.bin', data: Buffer.from('原样存放'), method: 0 },
  ]))
  const out = execFileSync('unzip', ['-t', f], { encoding: 'utf8' })
  assert.match(out, /No errors detected/)
})

test('CRC-32 用的是 ZIP 那个多项式', () => {
  // 标准测试向量
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('STORE 的条目原样存放，不压缩', async () => {
  const data = Buffer.from('不要压我')
  const z = await writeZip([{ name: 's', data, method: 0 }])
  const e = (await readCentralDirectory(bufferSource(z)))[0]
  assert.equal(e.method, 0)
  assert.equal(e.compressedSize, data.length)
})

/*
 * patchZip 的核心承诺：只动指名的条目，其余连压缩方法都不变 ——
 * 把本来 STORE 的 PNG 重新 deflate 一遍是白费功夫。
 */
test('换掉一个条目，其余原样保留', async () => {
  const orig = await writeZip([
    { name: 'keep.txt', data: Buffer.from('别动我') },
    { name: 'Metadata/slice_info.config', data: Buffer.from('<config/>') },
    { name: 'png', data: Buffer.from('已压过'), method: 0 },
  ])
  const patched = await patchZip(
    orig,
    new Map([['Metadata/slice_info.config', Buffer.from('<config>改过</config>')]]),
  )
  assert.deepEqual(await names(patched), ['keep.txt', 'Metadata/slice_info.config', 'png'])
  assert.equal(await read(patched, 'keep.txt'), '别动我')
  assert.equal(await read(patched, 'Metadata/slice_info.config'), '<config>改过</config>')

  const e = (await readCentralDirectory(bufferSource(patched))).find((x) => x.name === 'png')!
  assert.equal(e.method, 0, 'STORE 的条目不该被重新压缩')
})

/*
 * 静默丢掉一个调用方明确要求写入的条目，比多出一个条目危险得多 ——
 * 调用方会以为补丁生效了。
 */
test('包里没有的名字会被追加，而不是悄悄丢掉', async () => {
  const orig = await writeZip([{ name: 'a', data: Buffer.from('x') }])
  const patched = await patchZip(orig, new Map([['新条目', Buffer.from('y')]]))
  assert.deepEqual(await names(patched), ['a', '新条目'])
  assert.equal(await read(patched, '新条目'), 'y')
})

test('空包也要是合法的 ZIP', async () => {
  const z = await writeZip([])
  assert.deepEqual(await names(z), [])
})

test('不认识的压缩方法直接报错，不写出坏包', async () => {
  await assert.rejects(
    () => writeZip([{ name: 'a', data: Buffer.from('x'), method: 99 }]),
    /不支持的压缩方法/,
  )
})
