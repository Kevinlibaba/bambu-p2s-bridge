import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePath, BadPathError } from '../src/printer/ftp.js'

/*
 * 原来的实现用 path.includes('..') 判穿越。那是子串匹配：
 * 「Cool Model....3mf」这种从模型站下下来的名字会被当成攻击直接拒掉，
 * 而它和 ../ 毫无关系 —— 用户导入失败撞的就是这一条。
 * 改成按路径段判之后，这组用例守住两边：正常名字要放行，穿越要拦住。
 */
test('含连续点的正常文件名要放行', () => {
  for (const n of [
    '/Cool Model....3mf',
    '/Model..v2.3mf',
    '/A1 mini... slides.gcode.3mf',
    '/..leading-dots.3mf',
    '/trailing..',
    '/正常名字.3mf',
    "/Chillin' Summer Air Slides.3mf",
  ]) {
    assert.equal(normalizePath(n), n, n)
  }
})

test('真正的上级目录一律拦下', () => {
  for (const n of [
    '/../etc/passwd',
    '/a/../../b',
    '..',
    '/..',
    '/a/..',
    'timelapse/../../root',
    '/a/./../b',
  ]) {
    assert.throws(() => normalizePath(n), BadPathError, n)
  }
})

test('控制字符一律拦下 —— CRLF 拼进 FTP 命令行等同于命令注入', () => {
  for (const n of ['/a\r\nDELE x', '/a\u0001b', '/a\u007fb', '/a\tb']) {
    assert.throws(() => normalizePath(n), BadPathError, JSON.stringify(n))
  }
})

test('冗余的斜杠与当前目录段被归一化掉', () => {
  assert.equal(normalizePath('//a//b'), '/a/b')
  assert.equal(normalizePath('/a/./b'), '/a/b')
  assert.equal(normalizePath('a.3mf'), '/a.3mf')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath(''), '/')
})
