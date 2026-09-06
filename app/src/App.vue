<script setup lang="ts">
import { watch } from 'vue'
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app'
import { start, stop, printer } from './store/printer'
import { applyChrome, watchSystem } from './store/prefs'
import { registerServiceWorker } from './util/sw'

onLaunch(() => {
  watchSystem()
  applyChrome()
  registerServiceWorker()
  start()
})
onShow(() => {
  applyChrome()
  start()
})
onHide(() => stop())

/*
 * 主屏图标上的角标显示打印进度。iOS 16.4+ 的 PWA 支持 Badging API，
 * 但只有数字 —— 角标就是百分比。不在打印就清掉，免得一直挂个 100。
 * 不支持的环境（普通网页、老系统）什么都不做。
 */
const PRINTING = new Set(['RUNNING', 'PAUSE', 'PREPARE'])
watch(() => printer.summary, (s) => {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  if (!nav.setAppBadge) return
  if (s && PRINTING.has(s.state)) {
    // 0 会被当成「清除」，刚开始也至少显示 1
    void nav.setAppBadge(Math.max(1, Math.round(s.progress))).catch(() => {})
  } else {
    void nav.clearAppBadge?.().catch(() => {})
  }
})
</script>

<style>
/*
 * 设计令牌 —— Apple 系统色阶。
 * 单色基底，蓝色只给可交互元素；状态色沿用 iOS system colors，
 * 且永远与文字并列出现，不单靠颜色表意。
 *
 * 三套作用域：
 *   page                     深色（默认）
 *   @media light + page      浅色（跟随系统）
 *   .theme-dark/.theme-light 手动覆盖，加在各页面根节点上
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
  --swatch-ring: rgba(255, 255, 255, 0.28);
  --accent: #2997ff;
  --accent-dim: rgba(41, 151, 255, 0.16);
  --good: #30d158;
  --warning: #ff9f0a;
  /* 警示块的底色。和 --accent-dim 同一个套路：同色低透明度 */
  --warning-bg: rgba(255, 159, 10, 0.14);
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
  --swatch-ring: rgba(0, 0, 0, 0.28);
    --accent: #0066cc;
    --accent-dim: rgba(0, 102, 204, 0.1);
    --good: #248a3d;
    --warning: #b25000;
    --warning-bg: rgba(178, 80, 0, 0.09);
    --critical: #d70015;
  }
}

/* 手动覆盖：优先级高于媒体查询，因为作用在 page 的后代节点上 */
.theme-dark {
  --bg: #000000;
  --surface: #1c1c1e;
  --surface-2: #2c2c2e;
  --ink: #f5f5f7;
  --ink-2: #86868b;
  --ink-3: #6e6e73;
  --separator: rgba(255, 255, 255, 0.08);
  --hairline: rgba(255, 255, 255, 0.06);
  --swatch-ring: rgba(255, 255, 255, 0.28);
  --accent: #2997ff;
  --accent-dim: rgba(41, 151, 255, 0.16);
  --good: #30d158;
  --warning: #ff9f0a;
  /* 警示块的底色。和 --accent-dim 同一个套路：同色低透明度 */
  --warning-bg: rgba(255, 159, 10, 0.14);
  --critical: #ff453a;
  color: var(--ink);
}

.theme-light {
  --bg: #fbfbfd;
  --surface: #ffffff;
  --surface-2: #f5f5f7;
  --ink: #1d1d1f;
  --ink-2: #86868b;
  --ink-3: #a1a1a6;
  --separator: rgba(0, 0, 0, 0.08);
  --hairline: rgba(0, 0, 0, 0.06);
  --swatch-ring: rgba(0, 0, 0, 0.28);
  --accent: #0066cc;
  --accent-dim: rgba(0, 102, 204, 0.1);
  --good: #248a3d;
  --warning: #b25000;
  --warning-bg: rgba(178, 80, 0, 0.09);
  --critical: #d70015;
  color: var(--ink);
}

/* #ifdef H5 */
/*
 * tabBar 在 DOM 里位于 uni-page-body 之外，拿不到 page 上的 font-family，
 * 会回退到浏览器默认衬线体（英文下明显是 Times）。字体必须设在更外层，
 * 让所有 uni-app chrome 都继承得到。
 */
html, body, uni-app {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text',
    'Helvetica Neue', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
/* 标签文字与页面内文字保持同样收紧的字距 */
.uni-tabbar__label {
  letter-spacing: -0.01em;
}

/*
 * uni-app 给 tabBar 的默认 z-index 是 998，和它自己的 toast/modal/actionsheet(999)
 * 只差一档，弹出卡片挤不进去。把 tabBar 压到 899，层级就变成确定的：
 *   uni 内置浮层 999 > 弹出卡片 900 > tabBar 899 > 页面内容
 * 不依赖「同层级看 DOM 顺序」这种脆弱假设。
 */
/*
 * tabBar 与导航栏都是 z-index 998 的 fixed 内层元素，压到遮罩之下，
 * 弹出卡片才能盖住它们、把整个界面一起压暗。
 */
uni-tabbar,
.uni-tabbar,
.uni-page-head {
  z-index: 899;
}

/* CSS 变量定义在 page(uni-page-body) 上，不会向上级联到 html/body */
html, body, uni-app, uni-page, uni-page-wrapper, uni-page-body {
  background-color: #000000;
}
uni-page-body { min-height: 100vh; }
@media (prefers-color-scheme: light) {
  html, body, uni-app, uni-page, uni-page-wrapper, uni-page-body {
    background-color: #fbfbfd;
  }
}
/* 手动覆盖时由 prefs.applyChrome() 在 <html> 上写 data-theme */
html[data-theme='dark'], html[data-theme='dark'] body,
html[data-theme='dark'] uni-app, html[data-theme='dark'] uni-page,
html[data-theme='dark'] uni-page-wrapper, html[data-theme='dark'] uni-page-body {
  background-color: #000000;
}
html[data-theme='light'], html[data-theme='light'] body,
html[data-theme='light'] uni-app, html[data-theme='light'] uni-page,
html[data-theme='light'] uni-page-wrapper, html[data-theme='light'] uni-page-body {
  background-color: #fbfbfd;
}
/* #endif */
</style>
