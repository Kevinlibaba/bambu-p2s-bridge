import test from 'node:test'
import assert from 'node:assert/strict'
import { parseListDate } from '../src/printer/ftp.js'

/*
 * 这台打印机的 FTP 走 Unix LIST，basic-ftp 只在 MLSD 时才填 modifiedAt，
 * 于是列表里所有文件的时间都是 null —— 实测根目录 46 个文件全是。
 * 日期其实一直在 rawModifiedAt 里（形如 "Jan 27 2026"），只是被丢掉了。
 */
const NOW = new Date(Date.UTC(2026, 7, 31, 12, 0)) // 2026-08-31

test('带年份的形态', () => {
  assert.equal(parseListDate('Jan 27 2026', NOW)?.toISOString(), '2026-01-27T00:00:00.000Z')
  assert.equal(parseListDate('Dec  1 2024', NOW)?.toISOString(), '2024-12-01T00:00:00.000Z')
})

test('带时刻的形态按当年算', () => {
  assert.equal(parseListDate('Aug 31 17:11', NOW)?.toISOString(), '2026-08-31T17:11:00.000Z')
  assert.equal(parseListDate('Mar  5 09:00', NOW)?.toISOString(), '2026-03-05T09:00:00.000Z')
})

/*
 * 12 月的文件在 1 月列出来时，按当年算会落在未来 —— 要退一年。
 * 留一天余量：打印机和本机时区不同，边界上可能显得稍微超前。
 */
test('跨年时退一年', () => {
  const jan = new Date(Date.UTC(2026, 0, 5, 12, 0))
  assert.equal(parseListDate('Dec 28 23:30', jan)?.toISOString(), '2025-12-28T23:30:00.000Z')
  // 只超前几小时的当成当年，不要误退
  assert.equal(parseListDate('Jan  5 20:00', jan)?.toISOString(), '2026-01-05T20:00:00.000Z')
})

test('认不出的一律返回 null，不要瞎猜', () => {
  for (const v of [undefined, '', '   ', 'not a date', '2026-01-27', 'Xxx 27 2026',
                   'Jan 99 2026', 'Jan 27 25:00', 'Jan 27 12:99']) {
    assert.equal(parseListDate(v as string | undefined, NOW), null, JSON.stringify(v))
  }
})

test('月份大小写与多余空格都要认', () => {
  assert.equal(parseListDate('JAN 27 2026', NOW)?.toISOString(), '2026-01-27T00:00:00.000Z')
  assert.equal(parseListDate('  jan   7   2026  ', NOW)?.toISOString(), '2026-01-07T00:00:00.000Z')
})
