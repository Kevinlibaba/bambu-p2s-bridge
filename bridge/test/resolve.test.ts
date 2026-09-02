import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeName, resolveJobFile, type Candidate } from '../src/history/resolve.js'
import { matchTimelapse, type VideoFile, type JobWindow } from '../src/history/timelapse.js'

const f = (name: string, isDirectory = false): Candidate => ({ name, isDirectory })

/*
 * 打印机上报的 taskName 把下划线换成了空格：盘上是
 * M107_Barret_Sniper_rifle.gcode.3mf，历史里记的是 M107 Barret Sniper rifle。
 * 直接拼路径一律 404，克重和预估时长因此全是 null。
 */
test('下划线与空格视为等价 —— 这正是克重查不到的原因', () => {
  const files = [f('M107_Barret_Sniper_rifle.gcode.3mf'), f('别的.3mf')]
  assert.equal(resolveJobFile('M107 Barret Sniper rifle', files),
    '/M107_Barret_Sniper_rifle.gcode.3mf')
})

test('大小写与连续空白都不影响匹配', () => {
  const files = [f('Cool__Model  v2.gcode.3mf')]
  assert.equal(resolveJobFile('cool model v2', files), '/Cool__Model  v2.gcode.3mf')
})

test('同名时优先 .gcode.3mf —— 只有它带切好的盘信息', () => {
  const files = [f('a.3mf'), f('a.gcode.3mf')]
  assert.equal(resolveJobFile('a', files), '/a.gcode.3mf')
  // 顺序反过来结论要一致，不能取决于目录列出的先后
  assert.equal(resolveJobFile('a', [f('a.gcode.3mf'), f('a.3mf')]), '/a.gcode.3mf')
})

test('只有 .3mf 时也认', () => {
  assert.equal(resolveJobFile('a', [f('a.3mf')]), '/a.3mf')
})

test('目录、非 3mf、名字对不上的一律不认', () => {
  const files = [f('a', true), f('a.gcode'), f('a.txt'), f('b.3mf')]
  assert.equal(resolveJobFile('a', files), null)
})

test('空任务名不去乱猜', () => {
  assert.equal(resolveJobFile('', [f('a.3mf')]), null)
  assert.equal(resolveJobFile('   ', [f('a.3mf')]), null)
})

test('normalizeName 去掉三种后缀', () => {
  assert.equal(normalizeName('x.gcode.3mf'), 'x')
  assert.equal(normalizeName('x.3mf'), 'x')
  assert.equal(normalizeName('x.gcode'), 'x')
  assert.equal(normalizeName('x.3MF'), 'x', '后缀大小写不敏感')
})

// ---- 延时摄影关联 ----

const v = (name: string, iso: string | null): VideoFile => ({ name, modifiedAt: iso })
const j = (id: string, start: string, end: string): JobWindow =>
  ({ id, startedAt: Date.parse(start), endedAt: Date.parse(end) })

test('按结束时间把视频对到任务上', () => {
  const jobs = [j('1', '2026-09-01T08:00:00Z', '2026-09-01T10:51:00Z')]
  const got = matchTimelapse([v('video_2026-09-01_17-12-48.mp4', '2026-09-01T10:51:00Z')], jobs)
  assert.equal(got.get('1'), 'video_2026-09-01_17-12-48.mp4')
})

/*
 * 连着打的两单结束时间可能只差几分钟。不做一对一约束的话，同一个视频
 * 会被挂到两单上，两边都声称"这是你这一单的录像"。
 */
test('一个视频只归一单，且归给时间最贴合的那个', () => {
  const jobs = [
    j('近', '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
    j('更近', '2026-09-01T09:00:00Z', '2026-09-01T10:05:00Z'),
  ]
  const got = matchTimelapse([v('a.mp4', '2026-09-01T10:06:00Z')], jobs)
  assert.equal(got.size, 1)
  assert.equal(got.get('更近'), 'a.mp4')
})

test('两单两视频各归各的，不会串', () => {
  const jobs = [
    j('A', '2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z'),
    j('B', '2026-09-01T09:10:00Z', '2026-09-01T09:20:00Z'),
  ]
  const got = matchTimelapse(
    [v('later.mp4', '2026-09-01T09:21:00Z'), v('earlier.mp4', '2026-09-01T09:01:00Z')],
    jobs,
  )
  assert.equal(got.get('A'), 'earlier.mp4')
  assert.equal(got.get('B'), 'later.mp4')
})

test('超出容差就不认，宁可不显示也不要挂错', () => {
  const jobs = [j('1', '2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z')]
  assert.equal(matchTimelapse([v('a.mp4', '2026-09-01T09:20:00Z')], jobs).size, 0)
})

test('录像不可能在这一单开始之前就结束', () => {
  const jobs = [j('1', '2026-09-01T09:00:00Z', '2026-09-01T09:05:00Z')]
  // 结束时间落在容差内，但早于开始时间 —— 那是上一单的录像
  assert.equal(matchTimelapse([v('a.mp4', '2026-09-01T08:55:00Z')], jobs).size, 0)
})

test('非 mp4、缺时间、时间畸形的一律跳过', () => {
  const jobs = [j('1', '2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z')]
  const got = matchTimelapse([
    v('thumbnail', '2026-09-01T09:00:00Z'),
    v('a.mp4', null),
    v('b.mp4', '不是时间'),
  ], jobs)
  assert.equal(got.size, 0)
})
