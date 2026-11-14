import { createSSRApp } from 'vue'
import App from './App.vue'
import { i18n } from './locale'
import { bootstrapFromLocation } from './util/pair'

// 必须在 uni 的 hash 路由读地址栏之前：配对链接 #pair=… 不是路由，取走后要抹掉
bootstrapFromLocation()

export function createApp() {
  const app = createSSRApp(App)
  app.use(i18n)
  return { app }
}
