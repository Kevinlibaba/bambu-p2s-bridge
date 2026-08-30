<script setup lang="ts">
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app'
import { start, stop } from './store/printer'

onLaunch(() => start())
onShow(() => start())
onHide(() => stop())
</script>

<style>
/*
 * 设计令牌 —— Apple 系统色阶。
 * 单色基底，蓝色只给可交互元素；状态色沿用 iOS system colors，
 * 且永远与文字并列出现，不单靠颜色表意。
 */
page {
  --bg: #000000;
  --surface: #1c1c1e;
  --surface-2: #2c2c2e;
  --ink: #f5f5f7;
  --ink-2: #86868b;
  --ink-3: #6e6e73;
  --separator: rgba(255, 255, 255, 0.08);
  --hairline: rgba(255, 255, 255, 0.06);

  --accent: #2997ff;
  --accent-dim: rgba(41, 151, 255, 0.16);

  --good: #30d158;
  --warning: #ff9f0a;
  --critical: #ff453a;

  background-color: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text',
    'Helvetica Neue', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: light) {
  page {
    --bg: #fbfbfd;
    --surface: #ffffff;
    --surface-2: #f5f5f7;
    --ink: #1d1d1f;
    --ink-2: #86868b;
    --ink-3: #a1a1a6;
    --separator: rgba(0, 0, 0, 0.08);
    --hairline: rgba(0, 0, 0, 0.06);
    --accent: #0066cc;
    --accent-dim: rgba(0, 102, 204, 0.1);
    --good: #248a3d;
    --warning: #b25000;
    --critical: #d70015;
  }
}

/* #ifdef H5 */
html, body, uni-app, uni-page, uni-page-wrapper, uni-page-body {
  background-color: #000000;
}
uni-page-body { min-height: 100vh; }
@media (prefers-color-scheme: light) {
  html, body, uni-app, uni-page, uni-page-wrapper, uni-page-body {
    background-color: #fbfbfd;
  }
}
/* #endif */
</style>
