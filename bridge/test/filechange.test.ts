import test from 'node:test'
import assert from 'node:assert/strict'
import { onFileChange, fileChanged } from '../src/api/filechange.js'

/*
 * 四层按路径缓存的东西各自封闭在自己的模块里，写入方够不着别人的缓存。
 * 这里是唯一的广播点 —— 谁缓存谁注册，谁写文件谁广播。
 */
test('广播到达每一个注册者，且带的是同一个路径', () => {
  const got: string[] = []
  onFileChange((p) => got.push('a:' + p))
  onFileChange((p) => got.push('b:' + p))
  fileChanged('/x.gcode.3mf')
  assert.deepEqual(got.slice(-2), ['a:/x.gcode.3mf', 'b:/x.gcode.3mf'])
})
