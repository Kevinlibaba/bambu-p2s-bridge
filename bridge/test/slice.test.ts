import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeGcodeTemplates, matchesNozzle, isTemplateOf } from '../src/slice/profiles.js'
import { patchPrinterModelId, readPrinterModelId } from '../src/slice/postprocess.js'
import { errorLines } from '../src/slice/run.js'
import {
  isSliced, outputPath, filamentsForModel, parseModelFilaments, type FilamentLookup,
} from '../src/api/slice.js'
import { SliceQueue, SliceBusyError, type SliceSteps } from '../src/slice/job.js'

/*
 * 这是整个云切片里最要紧的一个函数：机器 profile 自己一条 gcode 都没有，
 * 首尾段全在同名的 template 兄弟文件里，而 CLI 不会去找它们。不合并的话
 * 切出来的文件起始段没有调平、结束段不把料退回 AMS —— 都是实测确认过的。
 */
test('把模板里的 gcode 合并进机器 profile', () => {
  const got = mergeGcodeTemplates(
    { name: 'Bambu Lab P2S 0.4 nozzle', printable_height: '256' },
    [{ machine_end_gcode: 'M400\nM18' }, { machine_start_gcode: 'G28\nG29' }],
  )
  assert.equal(got.machine_end_gcode, 'M400\nM18')
  assert.equal(got.machine_start_gcode, 'G28\nG29')
  assert.equal(got.printable_height, '256', '原有字段不该丢')
})

/*
 * 模板文件里也有 name / instantiation。覆盖过去会把机器名改掉，而 CLI 会拿
 * name 去跟 3mf 里记录的打印机做兼容校验 —— 实测报
 * `current 3mf file not support the new printer` 直接切不了。
 */
test('只合并 gcode 键，绝不动 name/inherits', () => {
  const got = mergeGcodeTemplates(
    { name: '真名', inherits: 'fdm_bbl_3dp_001_common', from: 'system' },
    [{ name: '模板名', instantiation: 'false', machine_end_gcode: 'M18' }],
  )
  assert.equal(got.name, '真名')
  assert.equal(got.inherits, 'fdm_bbl_3dp_001_common')
  assert.equal(got.from, 'system')
  assert.equal(got.instantiation, undefined)
})

test('后面的模板覆盖前面的同名键', () => {
  const got = mergeGcodeTemplates({}, [{ machine_end_gcode: 'A' }, { machine_end_gcode: 'B' }])
  assert.equal(got.machine_end_gcode, 'B')
})

/*
 * 命名规律：带 `0.6 nozzle` 后缀的是该口径专用，不带后缀的属于默认的 0.4。
 * 认错就会拿 0.8 的工艺去切 0.4 喷嘴的活。
 */
test('喷嘴口径匹配：0.4 要同时认两种写法', () => {
  assert.ok(matchesNozzle('0.20mm Standard @BBL P2S.json', 0.4), '不带后缀的属于 0.4')
  assert.ok(matchesNozzle('Bambu ASA @BBL P2S 0.4 nozzle.json', 0.4))
  assert.ok(!matchesNozzle('0.30mm Standard @BBL P2S 0.6 nozzle.json', 0.4))
})

test('喷嘴口径匹配：非 0.4 只认带后缀的', () => {
  assert.ok(matchesNozzle('0.30mm Standard @BBL P2S 0.6 nozzle.json', 0.6))
  assert.ok(!matchesNozzle('0.20mm Standard @BBL P2S.json', 0.6), '不带后缀的不属于 0.6')
  assert.ok(!matchesNozzle('Bambu ABS @BBL P2S 0.8 nozzle.json', 0.6))
})

test('认出属于这台机器的模板文件', () => {
  const m = 'Bambu Lab P2S 0.4 nozzle'
  assert.ok(isTemplateOf('Bambu Lab P2S 0.4 nozzle template machine_end_gcode.json', m))
  assert.ok(!isTemplateOf('Bambu Lab P1S 0.4 nozzle template machine_end_gcode.json', m))
  assert.ok(!isTemplateOf('Bambu Lab P2S 0.4 nozzle.json', m), '机器 profile 本身不是模板')
})

// ---- printer_model_id ----

const XML = `<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value=""/>
  </plate>
</config>`

test('补上空的 printer_model_id', () => {
  const got = patchPrinterModelId(XML)
  assert.equal(readPrinterModelId(got), 'N7')
  assert.match(got, /key="index" value="1"/, '别的字段不该被动')
})

/*
 * 哪天 CLI 自己把这个字段填对了，我们不该反过来覆盖它 ——
 * 尤其是万一将来换了机型。
 */
test('已经有值就不动', () => {
  const filled = XML.replace('value=""', 'value="N9"')
  assert.equal(readPrinterModelId(patchPrinterModelId(filled)), 'N9')
})

test('没有这个字段就原样返回，不瞎插', () => {
  const none = '<config><plate/></config>'
  assert.equal(patchPrinterModelId(none), none)
  assert.equal(readPrinterModelId(none), null)
})

// ---- 请求侧的小函数 ----

test('切过的包里有 plate_N.gcode', () => {
  assert.ok(isSliced(['Metadata/plate_1.gcode', 'Metadata/plate_1.json']))
  assert.ok(isSliced(['Metadata/plate_12.gcode']))
  assert.ok(!isSliced(['Metadata/plate_1.json', 'Metadata/project_settings.config']))
  assert.ok(!isSliced(['Metadata/plate_1.gcode.md5']), 'md5 不算')
})

test('产物落在源文件旁边，不覆盖原件', () => {
  assert.equal(outputPath('/model.3mf'), '/model.gcode.3mf')
  assert.equal(outputPath('/dir/a b.3mf'), '/dir/a b.gcode.3mf')
  assert.equal(outputPath('/x.gcode.3mf'), '/x.gcode.3mf', '已经是产物名就不再叠加')
})

test('从切片器日志里挑出错误原因', () => {
  const log = [
    '[2026-09-05 15:23:50] [0x1] [trace]   Initializing',
    '[2026-09-05 15:23:51] [0x1] [error]   current 3mf file not support the new printer',
    'run found error, return -16, exit...',
  ].join('\n')
  const got = errorLines(log)
  assert.equal(got[0], 'current 3mf file not support the new printer')
  assert.equal(got.length, 2)
})

test('没有错误行时返回空数组', () => {
  assert.deepEqual(errorLines('[trace] 一切正常\n'), [])
})

// ---- 任务状态机 ----

function rig(over: Partial<SliceSteps> = {}) {
  const calls: string[] = []
  const steps: SliceSteps = {
    workDirFor: (id) => `/tmp/${id}`,
    download: async () => { calls.push('download'); return '/tmp/m.3mf' },
    patch: async () => { calls.push('patch') },
    upload: async () => { calls.push('upload'); return '/out.gcode.3mf' },
    cleanup: async () => { calls.push('cleanup') },
    ...over,
  }
  const q = new SliceQueue(steps)
  const slice = async () => { calls.push('slice'); return { file: '/tmp/s.3mf', ms: 1234 } }
  return { q, calls, slice, settle: () => new Promise((r) => setImmediate(r)) }
}

test('走完整条链路并记下切片耗时', async () => {
  const r = rig()
  const job = r.q.start('/a.3mf', r.slice)
  // start 返回的是活引用，同步跑到第一个 await 就已经进 downloading 了。
  // 要断言的是「没有等整条链路跑完」，不是某个具体阶段
  assert.notEqual(job.phase, 'done', '提交后立刻返回，不等切完')
  assert.deepEqual(r.calls, ['download'], '返回时只启动了第一步')
  await r.settle(); await r.settle()
  assert.deepEqual(r.calls, ['download', 'slice', 'patch', 'upload', 'cleanup'])
  assert.equal(r.q.get(job.id)!.phase, 'done')
  assert.equal(r.q.get(job.id)!.output, '/out.gcode.3mf')
  assert.equal(r.q.get(job.id)!.sliceMs, 1234)
})

/*
 * 切片满载 CPU，这台机器只有 2 核还要扛 MQTT 和摄像头。
 * 并发跑两个的结果是两个都慢。
 */
test('同一时刻只跑一个，忙的时候直接拒绝', async () => {
  let release: (() => void) | null = null
  const r = rig({ download: () => new Promise<string>((res) => { release = () => res('/m') }) })
  r.q.start('/a.3mf', r.slice)
  assert.throws(() => r.q.start('/b.3mf', r.slice), SliceBusyError)
  assert.ok(r.q.busy())
  release!()
  await r.settle(); await r.settle()
  assert.ok(!r.q.busy(), '跑完要放开')
  r.q.start('/b.3mf', r.slice)  // 这次应该能提交
})

test('失败时如实记下阶段和原因', async () => {
  const r = rig({ upload: async () => { throw new Error('打印机拒绝了这个文件') } })
  const job = r.q.start('/a.3mf', r.slice)
  await r.settle(); await r.settle()
  const j = r.q.get(job.id)!
  assert.equal(j.phase, 'failed')
  assert.equal(j.error, '打印机拒绝了这个文件')
  assert.equal(j.output, null)
})

/*
 * 切片器的输出对排查是唯一线索 —— 失败时必须留下，成功时没必要占内存。
 */
test('失败时保留切片器日志', async () => {
  const r = rig()
  const boom = async () => {
    const e = new Error('切片失败: 模型超出打印范围') as Error & { log: string }
    e.log = '[error] out of bed'
    throw e
  }
  const job = r.q.start('/a.3mf', boom)
  await r.settle(); await r.settle()
  assert.equal(r.q.get(job.id)!.log, '[error] out of bed')
})

/*
 * 文件已经切出来并传上去了，只是临时目录没删掉 ——
 * 把这种情况标成失败会让人以为要重切。
 */
test('清理失败不影响任务结果', async () => {
  const r = rig({ cleanup: async () => { throw new Error('目录被占用') } })
  const job = r.q.start('/a.3mf', r.slice)
  await r.settle(); await r.settle()
  assert.equal(r.q.get(job.id)!.phase, 'done')
})

test('查不到的任务号返回 null', () => {
  const r = rig()
  assert.equal(r.q.get('不存在'), null)
})

// ---- 按模型声明选料 ----

const ref = (name: string) => ({ name, file: `/p/${name}.json` })

const LOOKUP: FilamentLookup = {
  async filamentIndex() {
    return new Map([
      ['GFA00', ref('Bambu PLA Basic @BBL P2S')],
      ['GFA01', ref('Bambu PLA Matte @BBL P2S')],
      ['GFG01', ref('Bambu PETG HF @BBL P2S')],
    ])
  },
  async filaments() {
    return [
      ref('Bambu PLA Basic @BBL P2S'),
      ref('Bambu PLA Matte @BBL P2S'),
      ref('Bambu PETG HF @BBL P2S'),
      ref('Generic PLA @BBL P2S'),
      ref('Generic PETG @BBL P2S'),
    ]
  },
}

test('读出模型声明的耗材', () => {
  const got = parseModelFilaments(JSON.stringify({
    filament_ids: ['GFA00', 'GFA01'],
    filament_type: ['PLA', 'PLA'],
    printable_height: '256',
  }))
  assert.deepEqual(got.ids, ['GFA00', 'GFA01'])
  assert.deepEqual(got.types, ['PLA', 'PLA'])
})

test('读不出来时返回空，交给上层兜底', () => {
  assert.deepEqual(parseModelFilaments('不是 json'), { ids: [], types: [] })
  assert.deepEqual(parseModelFilaments('{}'), { ids: [], types: [] })
})

test('两个数组不等长时按长的补齐，不截断', () => {
  const got = parseModelFilaments(JSON.stringify({
    filament_ids: ['GFA00', 'GFA01', 'GFG01'],
    filament_type: ['PLA'],
  }))
  assert.equal(got.ids.length, 3)
  assert.equal(got.types.length, 3)
  assert.deepEqual(got.types, ['PLA', '', ''])
})

/*
 * 模型里的 filament_settings_id 常指向别的机型（MakerWorld 上下来的多半是 X1C），
 * 但 filament_ids 的厂商编号跨机型通用 —— 拿它查 P2S 的 profile 就完成了机型转换。
 */
test('按厂商编号把模型的耗材换成 P2S 的 profile', async () => {
  const got = await filamentsForModel(LOOKUP, 0.4, {
    ids: ['GFA00', 'GFA00', 'GFA01', 'GFG01'],
    types: ['PLA', 'PLA', 'PLA', 'PETG'],
  })
  assert.deepEqual(got.picked.map((p) => p.name), [
    'Bambu PLA Basic @BBL P2S',
    'Bambu PLA Basic @BBL P2S',
    'Bambu PLA Matte @BBL P2S',
    'Bambu PETG HF @BBL P2S',
  ])
  assert.deepEqual(got.guessed, [])
})

/*
 * 这是实测踩到的坑，也是最难查的一个：耗材数量给多了，切片器一声不吭地退出 ——
 * 日志里只有一行 Initializing StaticPrintConfigs，没有产物也没有错误。
 * 所以数量必须严格等于模型声明的个数，一个不多一个不少。
 */
test('产出的个数严格等于模型声明的个数', async () => {
  for (const n of [1, 2, 4, 8]) {
    const got = await filamentsForModel(LOOKUP, 0.4, {
      ids: Array(n).fill('GFA00'),
      types: Array(n).fill('PLA'),
    })
    assert.equal(got.picked.length, n, `声明 ${n} 个就该给 ${n} 个`)
  }
})

test('查不到的编号退到同类型 Generic，位置不变', async () => {
  const got = await filamentsForModel(LOOKUP, 0.4, {
    ids: ['GFA00', '第三方编号', 'GFA01'],
    types: ['PLA', 'PETG', 'PLA'],
  })
  assert.equal(got.picked.length, 3)
  assert.equal(got.picked[1].name, 'Generic PETG @BBL P2S')
  assert.equal(got.picked[2].name, 'Bambu PLA Matte @BBL P2S', '第三个不该被前移')
  assert.deepEqual(got.guessed, [1], '要如实报出哪一个是猜的')
})

test('连类型都不认识时退到 PLA Basic，仍然占住位置', async () => {
  const got = await filamentsForModel(LOOKUP, 0.4, {
    ids: ['未知'], types: ['没听过的材料'],
  })
  assert.deepEqual(got.picked.map((p) => p.name), ['Bambu PLA Basic @BBL P2S'])
  assert.deepEqual(got.guessed, [0])
})

test('模型什么都没声明就返回空，由调用方兜底', async () => {
  const got = await filamentsForModel(LOOKUP, 0.4, { ids: [], types: [] })
  assert.deepEqual(got.picked, [])
})
