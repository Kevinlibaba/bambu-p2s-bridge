import test from 'node:test'
import assert from 'node:assert/strict'
import { detect } from '../src/notify/events.js'
import type { Summary } from '../src/printer/state.js'

function sum(p: Partial<Summary> = {}): Summary {
  return {
    online: true,
    state: 'IDLE',
    progress: 0,
    remainingMin: 0,
    layer: 0,
    totalLayers: 0,
    taskName: '',
    file: '',
    nozzle: { cur: 20, target: 0, type: 'HS01', diameter: '0.4' },
    bed: { cur: 20, target: 0 },
    chamber: 20,
    fans: { cooling: 0, aux: 0, chamber: 0, heatbreak: 0 },
    speedLevel: 2,
    speedPct: 100,
    lights: [],
    errors: [],
    printError: 0,
    wifi: '',
    sdcard: true,
    ams: [],
    amsUnits: [],
    dryBlockers: [],
    updatedAt: 1,
    ...p,
  } as Summary
}

const hms = (attr: number, code: number) => ({ attr, code })

test('MQTT 刚连上的空状态不算一次真实跃迁', () => {
  // setConnected(true) 会先发一份还没收到 report 的空状态（updatedAt=0），
  // 紧接着第一份 report 把 state 从 '' 跳到实际值 —— 不该当成刚发生的事
  const blank = sum({ state: '', updatedAt: 0 })
  const first = sum({ state: 'FAILED', taskName: 'a.3mf', printError: 0x07004025 })
  assert.deepEqual(detect(blank, first), [])
})

test('冷启动不补播历史事件，只认离线', () => {
  assert.deepEqual(detect(null, sum({ state: 'FAILED', printError: 0x07004025 })), [])
  const off = detect(null, sum({ online: false }))
  assert.equal(off.length, 1)
  assert.equal(off[0].kind, 'offline')
})

test('打印完成只在从打印中跃迁时触发', () => {
  const done = detect(sum({ state: 'RUNNING', taskName: 'a.3mf' }), sum({ state: 'FINISH', taskName: 'a.3mf' }))
  assert.deepEqual(done.map((e) => e.kind), ['printDone'])
  // 空闲直接变 FINISH（比如重连后对齐）不该响
  assert.deepEqual(detect(sum({ state: 'IDLE' }), sum({ state: 'FINISH' })), [])
})

test('失败与暂停带上错误码', () => {
  const [e] = detect(
    sum({ state: 'RUNNING' }),
    sum({ state: 'PAUSE', printError: 0x07008012, progress: 3 }),
  )
  assert.equal(e.kind, 'printPaused')
  assert.equal(e.code, '07008012')
  assert.match(e.body, /3%/)
})

test('暂停与报错同码时只响一条，不重复打扰', () => {
  const events = detect(
    sum({ state: 'RUNNING' }),
    sum({ state: 'PAUSE', printError: 0x07008012, errors: [hms(0x07007000, 0x00020008)] }),
  )
  assert.deepEqual(events.map((e) => e.kind), ['printPaused'])
})

test('只有 HMS 新增时单独报错，码按 attr+code 拼 16 位', () => {
  const [e] = detect(sum({}), sum({ errors: [hms(0x07002100, 0x00010086)] }))
  assert.equal(e.kind, 'error')
  assert.equal(e.code, '0700210000010086')
})

test('已存在的 HMS 不会因为别的字段变化被重播', () => {
  const before = sum({ errors: [hms(0x07002100, 0x00010086)] })
  const after = sum({ errors: [hms(0x07002100, 0x00010086)], progress: 5 })
  assert.deepEqual(detect(before, after), [])
})

test('离线与恢复各响一次', () => {
  assert.deepEqual(detect(sum({}), sum({ online: false })).map((e) => e.kind), ['offline'])
  assert.deepEqual(detect(sum({ online: false }), sum({})).map((e) => e.kind), ['online'])
  assert.deepEqual(detect(sum({ online: false }), sum({ online: false })), [])
})

test('烘干由进行中转为停止时报结束', () => {
  const unit = (dryStatus: string) => ({
    id: 0, temp: 40, humidity: 5, humidityPct: 0,
    dryStatus, dryRemainMin: 0, loadedSlot: null,
  })
  const ev = detect(
    sum({ amsUnits: [unit('drying')] as never }),
    sum({ amsUnits: [unit('off')] as never }),
  )
  assert.deepEqual(ev.map((e) => e.kind), ['dryDone'])
  // 一直在烘不响
  assert.deepEqual(
    detect(sum({ amsUnits: [unit('drying')] as never }), sum({ amsUnits: [unit('drying')] as never })),
    [],
  )
})

test('开始打印会通知', () => {
  const ev = detect(sum({ state: 'IDLE' }), sum({ state: 'RUNNING', taskName: 'b.3mf' }))
  assert.deepEqual(ev.map((e) => e.kind), ['printStarted'])
  // PREPARE → RUNNING 属于同一单的内部流转，不该再响一次
  assert.deepEqual(detect(sum({ state: 'PREPARE' }), sum({ state: 'RUNNING' })), [])
})

// ---- VAPID subject ----
import { vapidSubjectProblem } from '../src/notify/sinks.js'
import { config } from '../src/config.js'

function withSubject<T>(sub: string, fn: () => T): T {
  const prev = config.notify.vapid.subject
  config.notify.vapid.subject = sub
  try { return fn() } finally { config.notify.vapid.subject = prev }
}

test('合法的 VAPID subject 不报问题', () => {
  for (const s of ['mailto:me@example.com', 'https://bridge.example.com',
                   'https://bridge.example.ts.net', '  mailto:a@b.co  ']) {
    assert.equal(withSubject(s, vapidSubjectProblem), null, s)
  }
})

/*
 * 这条是真机踩出来的：subject 写成 mailto:admin@bambu-bridge.local 时
 * Apple 回 403 BadJwtToken，而当时错误被吞掉，界面上只显示
 * 「没有出口送达成功」，完全无从查起。
 */
test('不可路由的域名会被判为问题', () => {
  for (const s of ['mailto:admin@bambu-bridge.local', 'https://localhost:8080',
                   'mailto:a@x.internal', 'mailto:a@x.test', 'mailto:a@x.invalid']) {
    assert.match(withSubject(s, vapidSubjectProblem) ?? '', /不可路由/, s)
  }
})

test('格式不对或为空同样报问题', () => {
  for (const s of ['', '   ', 'admin@example.com', 'http://example.com', 'mailto:nope']) {
    assert.ok(withSubject(s, vapidSubjectProblem), s)
  }
})
