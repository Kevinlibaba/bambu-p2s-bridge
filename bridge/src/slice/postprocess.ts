/**
 * 补上 CLI 没写的 `printer_model_id`。
 *
 * 首尾 G-code 那两个大坑靠合并 profile 已经解决了（见 profiles.ts），剩下这一个
 * 补不进去 —— 实测往机器 profile 里加 `model_id: N7` 完全无效，切片器是从厂商
 * 预设包里查这个值的，而 CLI 按路径加载 profile 时根本没有那个包。
 *
 * 所以只能切完之后改 3mf。`slice_info.config` 是个几百字节的 XML，没有校验和，
 * 换掉它不需要动 `plate_N.gcode.md5` —— 那才是真正麻烦的部分，这里躲开了。
 *
 * **这个字段留空会不会被打印机拒绝，至今没验过。** 补上它是「便宜且不会更糟」，
 * 不是「已知必需」。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { patchZip } from '../util/zipwrite.js'
import { bufferSource, findEntry, readCentralDirectory, readEntry } from '../util/zip.js'
import { PRINTER_MODEL_ID } from './profiles.js'

export const SLICE_INFO = 'Metadata/slice_info.config'

/**
 * 把 `<metadata key="printer_model_id" value=""/>` 填上。
 *
 * 已经有值就原样返回 —— 哪天 CLI 自己把它填对了，我们不该反过来覆盖它。
 * 找不到这个字段也原样返回：那说明输出结构跟预期不同，此时瞎插一行
 * 不如什么都不做，让上层的校验去发现问题。
 */
export function patchPrinterModelId(xml: string, modelId = PRINTER_MODEL_ID): string {
  return xml.replace(
    /(<metadata\s+key="printer_model_id"\s+value=")("\s*\/>)/,
    `$1${modelId}$2`,
  )
}

/** 读出 slice_info.config 里的 printer_model_id，读不到返回 null */
export function readPrinterModelId(xml: string): string | null {
  const m = /<metadata\s+key="printer_model_id"\s+value="([^"]*)"/.exec(xml)
  return m ? m[1] : null
}

/**
 * 就地修补一个切片产物。
 *
 * 整包读进内存再写回去：切片产物通常几 MB 到几十 MB，而这一步紧跟在
 * 一次几十秒的切片之后，多这一次读写无关紧要，换来的是不用做流式 ZIP 改写。
 */
export async function postprocess(file: string): Promise<{ patched: boolean; modelId: string | null }> {
  const buf = await readFile(file)
  const src = bufferSource(buf)
  const entries = await readCentralDirectory(src)
  const info = findEntry(entries, SLICE_INFO)
  if (!info) return { patched: false, modelId: null }

  const xml = (await readEntry(src, info, 1 << 20)).toString('utf8')
  if (readPrinterModelId(xml)) return { patched: false, modelId: readPrinterModelId(xml) }

  const fixed = patchPrinterModelId(xml)
  if (fixed === xml) return { patched: false, modelId: null }

  await writeFile(file, await patchZip(buf, new Map([[SLICE_INFO, Buffer.from(fixed, 'utf8')]])))
  return { patched: true, modelId: readPrinterModelId(fixed) }
}
