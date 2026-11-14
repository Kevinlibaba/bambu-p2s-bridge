import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EmbeddedGo2rtc } from '../src/printer/go2rtc-embed.js'

async function fakeBin(body: string) {
  const f = path.join(await mkdtemp(path.join(tmpdir(), 'g2r-')), 'go2rtc')
  await writeFile(f, `#!/bin/sh\n${body}\n`)
  await chmod(f, 0o755)
  return f
}

test('内置 go2rtc：带上配置路径启动，输出转进日志；挂了会重启；stop 后不再拉起', async () => {
  const bin = await fakeBin('echo "args: $*"; exit 3')
  const logs: string[] = []
  const g = new EmbeddedGo2rtc(bin, '/app/go2rtc.yaml', (m) => logs.push(m))
  g.start()
  await new Promise((r) => setTimeout(r, 2600)) // 第一次退出后 2 秒重启
  g.stop()
  const started = logs.filter((l) => l.includes('已启动')).length
  assert.ok(logs.some((l) => l.includes('args: -config /app/go2rtc.yaml')), '要带上配置文件')
  assert.ok(logs.some((l) => l.includes('退出（3）')), '退出码要记下来')
  assert.ok(started >= 2, `挂了要重启（启动了 ${started} 次）`)
  const before = logs.length
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(logs.filter((l) => l.includes('已启动')).length, started, 'stop 之后不再拉起')
  assert.ok(logs.length >= before)
})
