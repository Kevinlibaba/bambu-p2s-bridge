import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

export default defineConfig({
  plugins: [uni()],
  // uni-app 默认不启用 Vite 的 publicDir，PWA 的 manifest 与 sw.js
  // 必须原样落在 H5 产物根目录（sw 的作用域由它自己的路径决定），
  // 所以在这里显式打开。
  publicDir: 'public',
})
