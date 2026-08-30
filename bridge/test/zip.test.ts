import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferSource, findEntry, readCentralDirectory, readEntry } from '../src/util/zip.js'
import { describeThreeMf, parseSliceInfo, plateImageEntry } from '../src/printer/threemf.js'
import {
  PLATE_1_PNG,
  PLATE_2_PNG,
  SLICE_INFO_XML,
  makeThreeMf,
  makeZip,
} from './helpers.js'

const MB = 1024 * 1024

test('夹具确实是一个合法 ZIP —— 用系统 unzip 交叉验证', () => {
  let unzip = true
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
  } catch {
    unzip = false
  }
  if (!unzip) return // 环境没装 unzip，跳过而不是失败

  const dir = mkdtempSync(join(tmpdir(), 'bambu-3mf-'))
  const file = join(dir, 'fixture.gcode.3mf')
  writeFileSync(file, makeThreeMf())
  execFileSync('unzip', ['-t', file], { stdio: 'ignore' })

  const listed = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n')
  assert.ok(listed.includes('Metadata/slice_info.config'))
  assert.ok(listed.includes('Metadata/plate_1.png'))
})

test('中央目录解析出全部条目', async () => {
  const entries = await readCentralDirectory(bufferSource(makeThreeMf()))
  assert.equal(entries.length, 6)
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    [
      '3D/3dmodel.model',
      'Metadata/plate_1.json',
      'Metadata/plate_1.png',
      'Metadata/plate_2.png',
      'Metadata/slice_info.config',
      '[Content_Types].xml',
    ],
  )
})

test('取条目：deflate 与 store 两种压缩方式都能原样还原', async () => {
  const src = bufferSource(makeThreeMf())
  const entries = await readCentralDirectory(src)

  const info = findEntry(entries, 'Metadata/slice_info.config')!
  assert.equal(info.method, 8)
  assert.equal((await readEntry(src, info, MB)).toString('utf8'), SLICE_INFO_XML)

  const png1 = findEntry(entries, 'Metadata/plate_1.png')!
  assert.equal(png1.method, 0)
  assert.deepEqual(await readEntry(src, png1, MB), PLATE_1_PNG)

  const png2 = plateImageEntry(entries, 2)!
  assert.deepEqual(await readEntry(src, png2, MB), PLATE_2_PNG)
})

test('找条目大小写不敏感', async () => {
  const entries = await readCentralDirectory(bufferSource(makeThreeMf()))
  assert.ok(findEntry(entries, 'metadata/SLICE_INFO.config'))
})

test('条目大小超过上限直接拒绝，而不是先解压再爆内存', async () => {
  const src = bufferSource(makeThreeMf())
  const entries = await readCentralDirectory(src)
  const png = findEntry(entries, 'Metadata/plate_2.png')!
  await assert.rejects(() => readEntry(src, png, 128), /条目过大/)
})

test('随机读取只碰到需要的字节 —— 大文件不会被整包搬下来', async () => {
  const zip = makeThreeMf()
  let bytesRead = 0
  const src = {
    size: zip.length,
    async read(start: number, end: number) {
      const s = zip.subarray(Math.max(0, start), Math.min(zip.length, end + 1))
      bytesRead += s.length
      return s
    },
  }
  const entries = await readCentralDirectory(src)
  await readEntry(src, findEntry(entries, 'Metadata/plate_1.png')!, MB)
  // 尾部扫描本来就会覆盖整个夹具（只有十几 KB），这里验证的是"不会重复整包读"
  assert.ok(bytesRead < zip.length * 2, `读了 ${bytesRead} 字节，包只有 ${zip.length}`)
})

test('EOCD 缺失时给出明确报错，而不是越界读', async () => {
  await assert.rejects(
    () => readCentralDirectory(bufferSource(Buffer.alloc(4096, 7))),
    /未找到中央目录结尾记录/,
  )
  await assert.rejects(() => readCentralDirectory(bufferSource(Buffer.alloc(4))), /文件过小/)
})

test('空 ZIP 解析为零条目', async () => {
  const entries = await readCentralDirectory(bufferSource(makeZip([])))
  assert.deepEqual(entries, [])
})

// ---------- slice_info.config ----------

test('parseSliceInfo 抽出逐盘信息', () => {
  const plates = parseSliceInfo(SLICE_INFO_XML)
  assert.equal(plates.length, 2)

  const [p1, p2] = plates
  assert.equal(p1.index, 1)
  assert.equal(p1.prediction, 8130)
  assert.equal(p1.weight, 42.75)
  assert.equal(p1.nozzleDiameters, '0.4')
  assert.equal(p1.printerModel, 'C13')
  assert.equal(p1.supportUsed, false)
  assert.deepEqual(p1.objects, ['bracket.stl', 'cap.stl'])
  assert.deepEqual(p1.filaments, [
    { id: 1, type: 'PLA', color: '#2C2C2E', usedM: 14.31, usedG: 42.75 },
  ])

  assert.equal(p2.index, 2)
  assert.equal(p2.supportUsed, true)
  assert.equal(p2.filaments[0].type, 'PETG')
  assert.equal(p2.filaments[0].color, '#FF9F0A')
})

test('parseSliceInfo 容忍缺字段与畸形输入', () => {
  assert.deepEqual(parseSliceInfo(''), [])
  assert.deepEqual(parseSliceInfo('<config></config>'), [])

  const [p] = parseSliceInfo('<config><plate><metadata key="weight" value=""/></plate></config>')
  assert.equal(p.index, 1) // 缺 index 时按出现顺序补
  assert.equal(p.weight, null)
  assert.equal(p.prediction, null)
  assert.equal(p.supportUsed, null)
  assert.deepEqual(p.objects, [])
})

test('颜色统一成 #RRGGBB，认得带 alpha 与不带井号的写法', () => {
  const [p] = parseSliceInfo(
    '<config><plate><filament id="1" type="PLA" color="00FF7FAA"/></plate></config>',
  )
  assert.equal(p.filaments[0].color, '#00FF7F')
})

// ---------- 汇总 ----------

test('describeThreeMf 汇总出可直接下发前端的结构', async () => {
  const src = bufferSource(makeThreeMf())
  const entries = await readCentralDirectory(src)
  const info = await describeThreeMf(src, entries)

  assert.equal(info.entryCount, 6)
  assert.equal(info.hasModel, true)
  assert.equal(info.metadataMissing, false)
  assert.equal(info.plates.length, 2)
  assert.deepEqual(info.plates.map((p) => p.hasThumbnail), [true, true])
})

test('没有 slice_info.config 时退回按预览图推断盘号', async () => {
  const zip = makeZip([
    { name: 'Metadata/plate_1.png', data: PLATE_1_PNG, store: true },
    { name: 'Metadata/plate_3.png', data: PLATE_2_PNG, store: true },
  ])
  const src = bufferSource(zip)
  const info = await describeThreeMf(src, await readCentralDirectory(src))

  assert.equal(info.metadataMissing, true)
  assert.equal(info.hasModel, false)
  assert.deepEqual(info.plates.map((p) => p.index), [1, 3])
  assert.deepEqual(info.plates.map((p) => p.hasThumbnail), [true, true])
})

test('只有小图时也算有预览图', async () => {
  const zip = makeZip([{ name: 'Metadata/plate_1_small.png', data: PLATE_1_PNG, store: true }])
  const src = bufferSource(zip)
  const entries = await readCentralDirectory(src)
  assert.equal(plateImageEntry(entries, 1)?.name, 'Metadata/plate_1_small.png')
  assert.equal(plateImageEntry(entries, 2), null)
})
