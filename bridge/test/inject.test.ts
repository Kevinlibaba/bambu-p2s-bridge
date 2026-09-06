import test from 'node:test'
import assert from 'node:assert/strict'
import { injectBeforeM18, md5Upper, buildHarvestFile, harvestName, InjectError } from '../src/eject/inject.js'
import { writeZip } from '../src/util/zipwrite.js'
import { bufferSource, readCentralDirectory, readEntry, findEntry } from '../src/util/zip.js'

const END = 'G1 X1\nM400\nM18\nM73 P100 R0\n; EXECUTABLE_BLOCK_END\n'

test('插在最后一个 M18 之前', () => {
  const out = injectBeforeM18('M18 ; 早先某处也有\n' + END, ['; ==== 推件开始 ====', 'G0 Z10'])
  const rows = out.split('\n')
  const at = rows.lastIndexOf('M18')
  assert.deepEqual(rows.slice(at - 3, at + 2), ['M400', '; ==== 推件开始 ====', 'G0 Z10', 'M18', 'M73 P100 R0'])
  assert.equal(rows[0], 'M18 ; 早先某处也有', '前面那个 M18 不动')
})

/*
 * 找不到 M18 的时候瞎插比不插危险：插到结束 G-code 中间可能落在风扇还没关、
 * 料还没退回 AMS 的时候。
 */
test('没有 M18 就拒绝', () => {
  assert.throws(() => injectBeforeM18('G1 X1\nM400\n', ['G0 Z10']), InjectError)
})

test('md5 是大写、无换行，与打印机文件里的格式一致', () => {
  const m = md5Upper('abc')
  assert.equal(m, '900150983CD24FB0D6963F7D28E17F72')
})

test('生成的文件只换 gcode 和 md5，其余条目原样，md5 与新 gcode 一致', async () => {
  const src = await writeZip([
    { name: 'Metadata/plate_1.gcode', data: Buffer.from(END) },
    { name: 'Metadata/plate_1.gcode.md5', data: Buffer.from(md5Upper(END)) },
    { name: 'Metadata/plate_1.png', data: Buffer.from('png'), method: 0 },
  ])
  const out = await buildHarvestFile(src, 1, ['; ==== 推件开始 ====', 'G1 Y0'])
  const s = bufferSource(out); const entries = await readCentralDirectory(s)
  assert.deepEqual(entries.map((e) => e.name), ['Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5', 'Metadata/plate_1.png'])
  const g = (await readEntry(s, findEntry(entries, 'Metadata/plate_1.gcode')!, 1 << 20))
  const m = (await readEntry(s, findEntry(entries, 'Metadata/plate_1.gcode.md5')!, 1 << 20)).toString()
  assert.equal(m, md5Upper(g), 'md5 必须对应改过之后的 gcode，否则打印机拒收')
  assert.match(g.toString(), /G1 Y0\nM18/)
})

test('已经注入过的不再叠加', async () => {
  const done = END.replace('M18', '; ==== 推件开始 ====\nG1 Y0\nM18')
  const src = await writeZip([
    { name: 'Metadata/plate_1.gcode', data: Buffer.from(done) },
    { name: 'Metadata/plate_1.gcode.md5', data: Buffer.from(md5Upper(done)) },
  ])
  await assert.rejects(() => buildHarvestFile(src, 1, ['G1 Y0']), /已经带收菜/)
})

test('产物文件名', () => {
  assert.equal(harvestName('/a.gcode.3mf'), '/a.harvest.gcode.3mf')
  assert.equal(harvestName('/dir/b.GCODE.3MF'), '/dir/b.harvest.gcode.3mf')
})
