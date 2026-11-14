import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SlicerInstaller, resolveSlicerRoot, looksInstalled, sourceFromEnv, PINNED } from '../src/slice/installer.js'

const BLOB = Buffer.from('pretend this is a 229 MB AppImage')
const SHA = createHash('sha256').update(BLOB).digest('hex')
const P2S = 'resources/profiles/BBL/machine/Bambu Lab P2S 0.4 nozzle.json'

async function fakeRoot(dir: string) {
  await mkdir(path.join(dir, path.dirname(P2S)), { recursive: true })
  await writeFile(path.join(dir, 'AppRun'), '#!/bin/sh\n')
  await writeFile(path.join(dir, P2S), '{}')
}

const fetchBlob = (async () => new Response(BLOB, { headers: { 'content-length': String(BLOB.length) } })) as typeof fetch
// 假装解包：在 cwd 下造一个完整的 squashfs-root
const extractOk = async (_f: string, cwd: string) => fakeRoot(path.join(cwd, 'squashfs-root'))

function make(dir: string, over: Partial<ConstructorParameters<typeof SlicerInstaller>[0]> = {}) {
  return new SlicerInstaller({
    dir,
    source: { url: 'https://example.invalid/v02.08.02.61/x.AppImage', sha256: SHA, version: '02.08.02.61', size: BLOB.length },
    fetchImpl: fetchBlob,
    extract: extractOk,
    arch: 'x64',
    freeBytes: async () => 10 * 1024 ** 3,
    ...over,
  })
}

test('一键安装：下载 → 校验 → 解包 → 换上，记下版本，临时文件都清掉', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slicer-'))
  const ins = make(dir)
  assert.equal(ins.start().state, 'downloading')
  await ins.settle()
  assert.equal(ins.current().state, 'done')
  assert.ok(looksInstalled(ins.root))
  assert.equal(await ins.installedVersion(), '02.08.02.61')
  assert.ok(!existsSync(path.join(dir, 'bambu-studio.AppImage.part')), 'AppImage 装完就删')
  assert.ok(!existsSync(path.join(dir, '.extract')))
})

test('校验不对：不安装，删掉下载的文件，报 checksum', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slicer-'))
  const ins = make(dir, { source: { url: 'x', sha256: '0'.repeat(64), version: 'v', size: 0 } })
  ins.start()
  await ins.settle()
  assert.equal(ins.current().state, 'error')
  assert.equal(ins.current().code, 'checksum')
  assert.ok(!looksInstalled(ins.root))
  assert.ok(!existsSync(path.join(dir, 'bambu-studio.AppImage.part')))
})

test('解包出来不完整：不替换已有的那份', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slicer-'))
  await fakeRoot(path.join(dir, 'squashfs-root'))
  await writeFile(path.join(dir, 'squashfs-root', 'marker'), 'old')
  const ins = make(dir, { extract: async (_f, cwd) => { await mkdir(path.join(cwd, 'squashfs-root'), { recursive: true }) } })
  ins.start()
  await ins.settle()
  assert.equal(ins.current().code, 'extract')
  assert.equal(await readFile(path.join(dir, 'squashfs-root', 'marker'), 'utf8'), 'old', '原来那份原封不动')
})

test('arm64 直接拒绝；空间不够在下载前拒绝；下载失败报 network', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slicer-'))
  assert.throws(() => make(dir, { arch: 'arm64' }).start(), (e: { code?: string }) => e.code === 'arch')

  let fetched = false
  const tight = make(dir, { freeBytes: async () => 100 * 1048576, fetchImpl: (async () => { fetched = true; return new Response('') }) as typeof fetch })
  tight.start()
  await tight.settle()
  assert.equal(tight.current().code, 'space')
  assert.equal(fetched, false, '空间不够就别去下')

  const down = make(dir, { fetchImpl: (async () => new Response('nope', { status: 404 })) as typeof fetch })
  down.start()
  await down.settle()
  assert.equal(down.current().code, 'network')
})

test('删掉一键安装的那份', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slicer-'))
  const ins = make(dir)
  ins.start()
  await ins.settle()
  await ins.remove()
  assert.ok(!looksInstalled(ins.root))
  assert.equal(await ins.installedVersion(), null)
})

test('用哪一份：手动挂载的优先，其次一键下载的', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'slicer-'))
  const mounted = path.join(base, 'mounted')
  const downloaded = path.join(base, 'downloaded')
  assert.equal(resolveSlicerRoot(mounted, downloaded), mounted, '都没有时返回挂载路径，好让报错指向它')
  await fakeRoot(downloaded)
  assert.equal(resolveSlicerRoot(mounted, downloaded), downloaded)
  await fakeRoot(mounted)
  assert.equal(resolveSlicerRoot(mounted, downloaded), mounted)
})

test('默认钉在实测可用的版本；SLICER_URL 和 SLICER_SHA256 要一起给才生效', () => {
  assert.equal(sourceFromEnv({}).version, PINNED.version)
  assert.equal(sourceFromEnv({ SLICER_URL: 'https://x/v02.09.01.70/a.AppImage' }).version, PINNED.version)
  const c = sourceFromEnv({ SLICER_URL: 'https://x/v02.09.01.70/a.AppImage', SLICER_SHA256: 'ABC' })
  assert.deepEqual([c.version, c.sha256], ['02.09.01.70', 'abc'])
})
