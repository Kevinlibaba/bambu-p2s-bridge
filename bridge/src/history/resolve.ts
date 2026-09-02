/**
 * 把历史里的任务名对回打印机上的真实文件。
 *
 * 不能直接拼路径。打印机上报的 taskName 已经把下划线换成了空格 ——
 * 盘上躺着的是 `M107_Barret_Sniper_rifle.gcode.3mf`，历史里记的却是
 * `M107 Barret Sniper rifle`。按名字拼出来的路径一律取不到，
 * 于是克重、预估时长全是 null，缩略图也无从谈起。
 *
 * 所以只能去目录里找：把两边都归一化之后比对。
 */

/**
 * 归一化：去掉 3mf 相关后缀，下划线和连续空白都折成一个空格，转小写。
 *
 * 与 history 里判断「是不是同一单」用的是同一套规则 —— 两处若不一致，
 * 会出现「历史认得出是同一单、却找不到文件」这种自相矛盾的状态。
 */
export function normalizeName(s: string): string {
  return s
    .replace(/\.gcode\.3mf$/i, '')
    .replace(/\.(3mf|gcode)$/i, '')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase()
}

export interface Candidate {
  name: string
  isDirectory: boolean
}

/**
 * 在目录列表里找出这一单对应的 3mf。
 *
 * 只认 .gcode.3mf 与 .3mf；同名时优先前者 —— Studio 导出的是它，
 * 而只有它才带切好的盘信息。
 */
export function resolveJobFile(jobName: string, files: Candidate[]): string | null {
  const want = normalizeName(jobName)
  if (!want) return null

  let fallback: string | null = null
  for (const f of files) {
    if (f.isDirectory) continue
    const lower = f.name.toLowerCase()
    if (!lower.endsWith('.3mf')) continue
    if (normalizeName(f.name) !== want) continue
    if (lower.endsWith('.gcode.3mf')) return '/' + f.name
    fallback ??= '/' + f.name
  }
  return fallback
}
