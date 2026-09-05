/**
 * 调用 BambuStudio 的命令行切片。
 *
 * 几条踩过的坑，改这里之前先读：
 *
 *  · **必须走 AppRun，不能直接调 bin/bambu-studio。** AppImage 自带一套 FFmpeg
 *    动态库放在 bin/ 旁边，只有 AppRun 会导出找得到它们的 LD_LIBRARY_PATH。
 *    直接调二进制会以 `libavcodec.so.61: cannot open shared object file` 失败 ——
 *    库明明就在隔壁。
 *
 *  · **`--export-3mf` 是相对 `--outputdir` 的，不是相对当前目录。** 传
 *    `out/x.3mf` 配 `--outputdir out` 会写到 `out/out/x.3mf`，而那个目录不会
 *    被创建，报 `Unable to open the file`。只传裸文件名。
 *
 *  · **`LC_ALL=C` 是必需的**，否则 CLI 会按本地化规则误解析数字。
 *
 *  · 无头是设计使然，不是绕过：`start_gui = m_actions.empty() && ...`，带了
 *    `--slice` 就不会开窗口。不需要 X，也不需要 Xvfb。
 *
 * 失败不一定体现在退出码上 —— 实测遇到过打印出 `run found error, return -16`
 * 却仍然正常退出的情况。所以判定成功的唯一标准是**产物文件真的出现了**。
 */
import { execFile } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class SliceFailedError extends Error {
  constructor(message: string, readonly log: string) {
    super(message)
    this.name = 'SliceFailedError'
  }
}

export interface SliceRun {
  /** 解包后的切片器根目录，里面有 AppRun */
  slicerRoot: string
  /** 待切的 3mf（未切片的） */
  model: string
  /** 本次切片的工作目录，产物和临时 profile 都放这儿 */
  workDir: string
  /** 合并过 G-code 模板的机器 profile 内容（JSON 文本） */
  machineJson: string
  /** process profile 的绝对路径 */
  processFile: string
  /**
   * 耗材 profile 的 **JSON 内容**，按模型声明的顺序，个数必须与模型一致。
   *
   * 传内容不传路径，是因为厂商目录里的叶子缺 filament_id，要先补上再落盘
   * （见 Profiles.mergedFilament）。个数给多了切片器会一声不吭地退出。
   */
  filaments: string[]
  /** 盘号，1 起。0 表示全部 */
  plate?: number
  timeoutMs: number
}

export interface SliceResult {
  /** 产物 .gcode.3mf 的绝对路径 */
  file: string
  /** 切片器的完整输出，失败排查用 */
  log: string
  ms: number
}

const OUTPUT_NAME = 'sliced.gcode.3mf'

/** 从切片器日志里挑出 [error] 行，用来给出比「切片失败」更具体的原因 */
export function errorLines(log: string): string[] {
  return log
    .split('\n')
    .filter((l) => l.includes('[error]') || l.includes('found error'))
    .map((l) => l.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*\[error\]\s*/, '').trim())
    .filter(Boolean)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function runSlice(opt: SliceRun): Promise<SliceResult> {
  await mkdir(opt.workDir, { recursive: true })
  const machineFile = path.join(opt.workDir, 'machine.json')
  await writeFile(machineFile, opt.machineJson, 'utf8')

  const filamentFiles: string[] = []
  for (const [i, json] of opt.filaments.entries()) {
    const f = path.join(opt.workDir, `filament_${i}.json`)
    await writeFile(f, json, 'utf8')
    filamentFiles.push(f)
  }

  const args = [
    '--slice',
    String(opt.plate ?? 0),
    // 机器与工艺用同一个 --load-settings，分号分隔，顺序即优先级
    '--load-settings',
    `${machineFile};${opt.processFile}`,
    ...(filamentFiles.length ? ['--load-filaments', filamentFiles.join(';')] : []),
    '--outputdir',
    opt.workDir,
    // 裸文件名：这个参数是相对 --outputdir 的
    '--export-3mf',
    OUTPUT_NAME,
    opt.model,
  ]

  const started = Date.now()
  const log = await new Promise<string>((resolve, reject) => {
    execFile(
      path.join(opt.slicerRoot, 'AppRun'),
      args,
      {
        timeout: opt.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        cwd: opt.workDir,
        // AppRun 自己也会设 LC_ALL，这里显式再设一次：数字解析出错的症状
        // 非常隐蔽（尺寸温度全都偏），不值得赌它一定被设上
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`
        // 退出码不可信，交给下面按产物是否存在来判定；只有超时这类
        // 拿不到产物的情况需要在这里就带上原因
        if (err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          reject(new SliceFailedError(`切片超时（超过 ${Math.round(opt.timeoutMs / 1000)} 秒）`, out))
          return
        }
        resolve(out)
      },
    )
  })

  const file = path.join(opt.workDir, OUTPUT_NAME)
  if (!(await exists(file))) {
    const why = errorLines(log)[0]
    throw new SliceFailedError(why ? `切片失败: ${why}` : '切片失败，没有产出文件', log)
  }
  return { file, log, ms: Date.now() - started }
}
