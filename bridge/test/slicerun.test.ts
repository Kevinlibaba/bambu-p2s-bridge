import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isTimeout, runSlice } from '../src/slice/run.js'
import { verifySliced, ModelCorruptError } from '../src/slice/verify.js'
import { writeZip } from '../src/util/zipwrite.js'

/*
 * execFile 的 timeout 触发时给的是 killed=true / signal=SIGTERM，code 是 null。
 * 之前按 code==='ETIMEDOUT' 判，永远判不到 —— 超时变成一句「没有产出文件」，
 * 用户会再等一次同样长的 15 分钟。
 */
test('isTimeout 认 killed/SIGTERM，不认普通失败', () => {
  assert.equal(isTimeout({ killed: true, signal: 'SIGTERM', code: null }), true)
  assert.equal(isTimeout({ killed: false, signal: null, code: 'ENOENT' }), false)
  assert.equal(isTimeout(null), false)
})

/** 造一个假切片器目录：AppRun 是一段 shell */
function fakeSlicer(script: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'slicer-'))
  writeFileSync(path.join(root, 'AppRun'), `#!/bin/sh\n${script}\n`)
  chmodSync(path.join(root, 'AppRun'), 0o755)
  const work = path.join(root, 'work'); mkdirSync(work)
  return { root, work }
}
const base = (root: string, work: string) => ({
  slicerRoot: root, model: '/dev/null', workDir: work, machineJson: '{}',
  processFile: '/dev/null', filaments: [],
})

test('超时被杀掉时明确报「超时」，而不是「没有产出文件」', async () => {
  const { root, work } = fakeSlicer('sleep 5')
  await assert.rejects(
    () => runSlice({ ...base(root, work), timeoutMs: 300 }),
    (e: Error) => /超时/.test(e.message),
  )
})

/*
 * 被杀在写到一半时文件是「在」的。只看存在与否会把半成品当成功传上打印机 ——
 * 打印机上就多了一个打不了的 .gcode.3mf。
 */
test('产物文件在但不完整，判失败', async () => {
  const { root, work } = fakeSlicer('printf "PK\\003\\004 half written" > "$(dirname "$0")/work/sliced.gcode.3mf"')
  await assert.rejects(
    () => runSlice({ ...base(root, work), timeoutMs: 5000 }),
    (e: Error) => /不是完整的压缩包/.test(e.message),
  )
})

test('产物完整且有 plate gcode 才算成功', async () => {
  const { root, work } = fakeSlicer('true')
  const good = await writeZip([
    { name: 'Metadata/plate_1.gcode', data: Buffer.from('G28\n') },
    { name: 'Metadata/plate_1.gcode.md5', data: Buffer.from('x') },
  ])
  writeFileSync(path.join(work, 'sliced.gcode.3mf'), good)
  const r = await runSlice({ ...base(root, work), timeoutMs: 5000 })
  assert.equal(path.basename(r.file), 'sliced.gcode.3mf')
})

test('verifySliced：合法包但没有任何 gcode 也不行；大小写不敏感', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vs-'))
  const noGcode = path.join(dir, 'a.3mf')
  writeFileSync(noGcode, await writeZip([{ name: 'Metadata/plate_1.png', data: Buffer.from('p') }]))
  await assert.rejects(() => verifySliced(noGcode), ModelCorruptError)
  const lower = path.join(dir, 'b.3mf')
  writeFileSync(lower, await writeZip([{ name: 'metadata/plate_2.gcode', data: Buffer.from('G1') }]))
  await verifySliced(lower)
})
