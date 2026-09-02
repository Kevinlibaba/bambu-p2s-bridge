/**
 * 把延时摄影视频对回历史里的某一单。
 *
 * 打印机不提供任何关联信息，只能靠时间撞。
 * `/timelapse/video_2026-09-02_16-05-34.mp4` 里的时间戳是**打印机本地时区的
 * 开始时间**，而 FTP 的 modifiedAt 是**结束时间**（UTC）。本地时区未知，
 * 所以文件名不可靠 —— 用结束时间撞任务的 endedAt 才是可比的。
 *
 * 实测 6 个视频里能对上 5 个，对不上的那个是当时正在打的那一单。
 */

export interface VideoFile {
  name: string
  /** ISO 时间串，FTP 报的修改时间 ≈ 录制结束时间 */
  modifiedAt: string | null
}

export interface JobWindow {
  id: string
  startedAt: number
  endedAt: number
}

/** 结束时间差在这个范围内才认。打印机写完文件有延迟，给宽一点 */
const TOLERANCE_MS = 15 * 60_000

/**
 * 返回 任务 id → 视频文件名。
 *
 * 两条纪律：
 *  - 一对一。连着打的两单结束时间可能只差几分钟，不做约束的话
 *    同一个视频会被挂到两单上，两边都显示成"这是你这一单的录像"。
 *  - 取最近的。先把所有可能的配对按时间差排序，再从小到大占位，
 *    这样最贴合的那一对不会被一个凑合的配对抢走。
 */
export function matchTimelapse(
  videos: VideoFile[],
  jobs: JobWindow[],
  toleranceMs = TOLERANCE_MS,
): Map<string, string> {
  type Pair = { job: string; video: string; diff: number }
  const pairs: Pair[] = []

  for (const v of videos) {
    if (!v.name.toLowerCase().endsWith('.mp4') || !v.modifiedAt) continue
    const end = Date.parse(v.modifiedAt)
    if (!Number.isFinite(end)) continue
    for (const j of jobs) {
      // 录像不可能在这一单开始之前就结束
      if (end < j.startedAt) continue
      const diff = Math.abs(end - j.endedAt)
      if (diff <= toleranceMs) pairs.push({ job: j.id, video: v.name, diff })
    }
  }

  pairs.sort((a, b) => a.diff - b.diff || a.video.localeCompare(b.video))

  const out = new Map<string, string>()
  const usedVideo = new Set<string>()
  for (const p of pairs) {
    if (out.has(p.job) || usedVideo.has(p.video)) continue
    out.set(p.job, p.video)
    usedVideo.add(p.video)
  }
  return out
}
