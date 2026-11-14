/**
 * 首次设置向导写下的配置：打印机三件套、接口 token、Web Push 密钥。
 *
 * 放在 /data/config.json（跟着数据卷走，0600）。环境变量仍然优先 —— 用 .env 部署的
 * 老安装照旧，什么都不用改；只有环境变量里缺的项才从这里补。两边都没有打印机凭据时，
 * 桥接进入设置模式，只提供向导。
 *
 * 读是同步的：config.ts 在模块加载时就要定下来，整个进程只读这一次。
 * 改了配置要重启进程才生效（向导应用后桥接会自己退出，交给 Docker 拉起来）。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StoredConfig {
  printer?: { host?: string; serial?: string; accessCode?: string }
  apiToken?: string
  vapid?: { publicKey?: string; privateKey?: string; subject?: string }
  /** 写入时间，排查用 */
  savedAt?: string
}

export const CONFIG_PATH = process.env.BRIDGE_CONFIG ?? '/data/config.json'

export function readStoredConfig(path = CONFIG_PATH): StoredConfig {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as StoredConfig) : {}
  } catch {
    // 文件不在（新装）或坏了：当作没配置。坏文件不删，留着给人看
    return {}
  }
}

export function writeStoredConfig(cfg: StoredConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...cfg, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** 环境变量非空就用环境变量，否则用文件里的值 */
export function pick(envName: string, stored: string | undefined): string {
  const v = process.env[envName]
  return v && v.trim() ? v.trim() : (stored ?? '').trim()
}
