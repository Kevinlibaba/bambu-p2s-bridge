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
    verify: async () => { calls.push('verify') },
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
  assert.deepEqual(r.calls, ['download', 'verify', 'slice', 'patch', 'upload', 'cleanup'])
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

/*
 * 损坏的文件要在切片之前就被拦下。切片器碰到它只会报一句 XML 解析错误
 * （not well-formed at line 28283），那句话会把人引向「模型有问题」，
 * 而正确的动作是重新上传这个文件。顺带省掉一次几十秒的白跑。
 */
test('文件损坏时在切片之前就拦下，不白跑一次切片', async () => {
  const r = rig({ verify: async () => { throw new Error('模型数据已损坏，请重新上传这个文件') } })
  const job = r.q.start('/a.3mf', r.slice)
  await r.settle(); await r.settle()
  const j = r.q.get(job.id)!
  assert.equal(j.phase, 'failed')
  assert.match(j.error!, /重新上传/)
  assert.ok(!r.calls.includes('slice'), '不该真的去切')
})

// ---- 继承链摊平 ----

/*
 * CLI 只覆盖文件里字面存在的键，`inherits` 一律不解析 —— 实测：传
 * `0.08mm High Quality @BBL P2S.json` 进去，产物的 print_settings_id 变成了它，
 * 但 layer_height 仍是模型自带的 0.2，因为 0.08 在链上第二层。
 * 所以要真正应用一套工艺，必须先自己摊平。
 */
test('摊平继承链：祖先在前，叶子最后写', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { flattenChain } = await import('../src/slice/profiles.js')

  const dir = mkdtempSync(path.join(tmpdir(), 'prof-'))
  const put = (n: string, o: unknown) =>
    writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(o))
  put('common', { layer_height: '0.2', wall_loops: '2', from: 'system' })
  put('single_008', { inherits: 'common', layer_height: '0.08' })
  put('leaf', { inherits: 'single_008', name: '0.08mm High Quality', top_shell_layers: '9' })

  const got = await flattenChain(dir, 'leaf')
  assert.equal(got.layer_height, '0.08', '中间层要盖住最顶层')
  assert.equal(got.wall_loops, '2', '只在祖先里的键要带下来')
  assert.equal(got.top_shell_layers, '9')
  assert.equal(got.name, '0.08mm High Quality', '叶子的 name 必须是最终值')
  assert.equal(got.from, 'system')
  assert.equal('inherits' in got, false, '摊平后要去掉 inherits，免得将来被再叠一遍')
})

test('链上某一环缺失时返回已有的部分，不炸', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { flattenChain } = await import('../src/slice/profiles.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'prof-'))
  writeFileSync(path.join(dir, 'leaf.json'), JSON.stringify({ inherits: '不存在', a: '1' }))
  const got = await flattenChain(dir, 'leaf')
  assert.equal(got.a, '1')
})

test('配置里有环时靠深度上限兜住', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { flattenChain } = await import('../src/slice/profiles.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'prof-'))
  writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ inherits: 'b', x: 'a' }))
  writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ inherits: 'a', x: 'b' }))
  const got = await flattenChain(dir, 'a')
  assert.equal(got.x, 'a', '不该死循环，且叶子仍然胜出')
})

// ---- 换工艺会改掉什么 ----

/*
 * 选一套工艺的意图通常是「层薄一点」，不是「顺便删掉我的支撑」。而摊平的标准
 * profile 里 enable_support 就是 0 —— 作者开了树状支撑，换过去悬空处直接打废。
 * Bambu Studio 里切换预设时勾选框会当场变化，用户看得见；这里没界面，只能报出来。
 */
test('报出换工艺会改掉的关键设置', async () => {
  const { notableChanges } = await import('../src/slice/profiles.js')
  const got = notableChanges(
    { layer_height: '0.2', enable_support: '1', wall_loops: '3', 某个无关键: 'x' },
    { layer_height: '0.08', enable_support: '0', wall_loops: '2', 某个无关键: 'y' },
  )
  assert.deepEqual(got, [
    { key: 'enable_support', from: '1', to: '0' },
    { key: 'layer_height', from: '0.2', to: '0.08' },
    { key: 'wall_loops', from: '3', to: '2' },
  ])
})

test('取值相同的不算改动', async () => {
  const { notableChanges } = await import('../src/slice/profiles.js')
  assert.deepEqual(notableChanges({ layer_height: '0.2' }, { layer_height: '0.2' }), [])
})

/*
 * 模型里没有的键谈不上「被改掉」—— 报出来只会让人以为丢了什么。
 */
test('只有一边有值的键不报', async () => {
  const { notableChanges } = await import('../src/slice/profiles.js')
  assert.deepEqual(notableChanges({}, { layer_height: '0.08' }), [])
  assert.deepEqual(notableChanges({ layer_height: '0.2' }, {}), [])
})

test('单元素数组按标量比，不会误报成改动', async () => {
  const { notableChanges } = await import('../src/slice/profiles.js')
  assert.deepEqual(notableChanges({ wall_loops: ['3'] }, { wall_loops: '3' }), [])
  assert.deepEqual(
    notableChanges({ wall_loops: ['3'] }, { wall_loops: ['2'] }),
    [{ key: 'wall_loops', from: '3', to: '2' }],
  )
})

// ---- 在作者设置之上逐项覆盖 ----

/*
 * 这条路子成立靠的是 CLI「只应用文件里字面存在的键」那个特性：把覆盖项合并进
 * 几乎是空的工艺叶子，就只有这几个键生效。实测只覆盖 layer_height=0.12 时，
 * 产物里 enable_support 仍是作者的 1、support_type 仍是 tree(auto)、
 * wall_loops 仍是 3、填充仍是 15%。
 */
test('参数转成配置里的字面格式', async () => {
  const { toConfigKeys } = await import('../src/slice/overrides.js')
  assert.deepEqual(
    toConfigKeys({ layerHeight: 0.12, infillDensity: 25, wallLoops: 4, supports: true, brim: false }, 0.4),
    {
      layer_height: '0.12',
      sparse_infill_density: '25%',
      wall_loops: '4',
      enable_support: '1',
      brim_type: 'no_brim',
    },
  )
})

test('没给的参数不写进去 —— 写了就等于覆盖了作者的值', async () => {
  const { toConfigKeys } = await import('../src/slice/overrides.js')
  assert.deepEqual(toConfigKeys({ layerHeight: 0.2 }, 0.4), { layer_height: '0.2' })
  assert.deepEqual(toConfigKeys({}, 0.4), {})
})

/*
 * 上限切片器自己会拒（Layer height cannot exceed nozzle diameter），但下限不会 ——
 * 层高填 0.01 它会老老实实去切五千多层，跑很久而机器上什么都没发生。
 * 所以这一关得服务端自己把住，而且要失败得快。
 */
test('层高超出喷嘴能力时直接拒绝', async () => {
  const { toConfigKeys, ParamError } = await import('../src/slice/overrides.js')
  assert.throws(() => toConfigKeys({ layerHeight: 0.5 }, 0.4), ParamError)
  assert.throws(() => toConfigKeys({ layerHeight: 0.01 }, 0.4), /0.08-0.3/)
  assert.throws(() => toConfigKeys({ layerHeight: NaN }, 0.4), /不是一个数/)
})

test('层高区间随喷嘴口径变', async () => {
  const { layerRange, toConfigKeys } = await import('../src/slice/overrides.js')
  assert.deepEqual(layerRange(0.4), { min: 0.08, max: 0.3 })
  assert.deepEqual(layerRange(0.8), { min: 0.16, max: 0.6 })
  // 0.4 喷嘴打不了的层高，0.8 喷嘴可以
  assert.deepEqual(toConfigKeys({ layerHeight: 0.4 }, 0.8), { layer_height: '0.4' })
})

test('填充和壁圈数的范围也把住', async () => {
  const { toConfigKeys } = await import('../src/slice/overrides.js')
  assert.throws(() => toConfigKeys({ infillDensity: 150 }, 0.4), /0-100/)
  assert.throws(() => toConfigKeys({ infillDensity: -1 }, 0.4), /0-100/)
  assert.throws(() => toConfigKeys({ wallLoops: 0 }, 0.4), /1-10/)
  assert.throws(() => toConfigKeys({ wallLoops: 2.5 }, 0.4), /整数/)
  // 边界值要放行
  assert.deepEqual(toConfigKeys({ infillDensity: 0 }, 0.4), { sparse_infill_density: '0%' })
  assert.deepEqual(toConfigKeys({ infillDensity: 100 }, 0.4), { sparse_infill_density: '100%' })
})

test('读出作者定的参数，给界面做默认值', async () => {
  const { fromConfig } = await import('../src/slice/overrides.js')
  assert.deepEqual(
    fromConfig({
      layer_height: '0.2',
      sparse_infill_density: '15%',
      wall_loops: '3',
      enable_support: '1',
      brim_type: 'auto_brim',
    }),
    { layerHeight: 0.2, infillDensity: 15, wallLoops: 3, supports: true, brim: true },
  )
})

test('作者的配置里没有的项就不给默认值，别瞎猜', async () => {
  const { fromConfig } = await import('../src/slice/overrides.js')
  assert.deepEqual(fromConfig({}), {})
  assert.deepEqual(fromConfig({ layer_height: ['0.16'] }), { layerHeight: 0.16 }, '单元素数组也认')
})

/*
 * 界面会把所有字段都发上来（它拿作者的值做默认值）。照单全收的话，每次都会
 * 写进一堆其实没变的键 —— 那样「这次改了什么」这个信息就是假的，而且产物
 * 跟不改参数时会有无谓的差异。
 */
test('只留真正改动的项', async () => {
  const { changedOnly } = await import('../src/slice/overrides.js')
  const author = { layerHeight: 0.2, infillDensity: 15, supports: true, wallLoops: 3 }
  assert.deepEqual(changedOnly({ ...author }, author), {}, '一项没改就该是空的')
  assert.deepEqual(
    changedOnly({ ...author, layerHeight: 0.12 }, author),
    { layerHeight: 0.12 },
  )
  assert.deepEqual(
    changedOnly({ ...author, supports: false }, author),
    { supports: false },
    'false 是有效值，不能被当成没填',
  )
})

test('浮点比较不被精度坑到', async () => {
  const { changedOnly } = await import('../src/slice/overrides.js')
  assert.deepEqual(changedOnly({ layerHeight: 0.1 + 0.2 }, { layerHeight: 0.3 }), {})
})

/*
 * `Number('')` 是 0 而不是 NaN。填充密度 0 又是个合法取值，所以光看数字分不出
 * 「作者设成了 0」和「作者根本没设」—— 后者被读成 0 的话，界面会显示一个
 * 作者从没定过的默认值，用户照着确认下去就真按 0% 切了。
 */
test('空串不能被读成 0', async () => {
  const { fromConfig } = await import('../src/slice/overrides.js')
  assert.deepEqual(fromConfig({ sparse_infill_density: '' }), {})
  assert.deepEqual(fromConfig({ sparse_infill_density: '   ' }), {})
  assert.deepEqual(fromConfig({ sparse_infill_density: [] }), {})
  assert.deepEqual(
    fromConfig({ sparse_infill_density: '0%' }),
    { infillDensity: 0 },
    '真的写了 0% 就要认',
  )
})

/*
 * 打开一个文件的预览会同时打三个接口，都在读同一份中央目录。缓存是为了
 * 让第二次打开不再重复这几次 FTP 往返 —— 实测参数卡的出现时间因此从
 * 580ms 降到 88ms。但缓存只该用在「看」上：同名文件被换掉之后，拿旧的耗材
 * 信息去配 AMS 映射会真的按错的料打出来。
 */
test('缓存只服务预览，开打必须读新的', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(
    new URL('../src/api/print.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    src,
    /locate\(body\.path, body\.plate \?\? 1, true\)/,
    '开打那条路要传 fresh=true 跳过缓存',
  )
  assert.match(src, /async function describe\(path: string, fresh = false\)/)
})
