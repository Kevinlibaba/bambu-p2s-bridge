<script setup lang="ts">
import { ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { loadSettings, saveSettings, api, type Settings } from '../../api/client'
import { printer, restart, stop } from '../../store/printer'

const form = ref<Settings>({ baseUrl: '', token: '' })
const testing = ref(false)
const result = ref('')
const ok = ref(false)

onShow(() => { form.value = loadSettings() })

async function testAndSave() {
  testing.value = true; result.value = ''
  const prev = loadSettings()
  saveSettings(form.value)
  try {
    const h = await api.health()
    const st = await api.state()
    ok.value = true
    result.value = `已连接 · 打印机${h.printerConnected ? '在线' : '离线'} · ${st.state}`
    restart()
  } catch (e) {
    ok.value = false
    result.value = (e as Error).message
    saveSettings(prev)          // 校验不过就回滚，避免把界面搞成半死状态
  } finally { testing.value = false }
}

function clearAll() {
  uni.showModal({
    title: '清除配置', content: '将删除本机保存的地址与 Token。', confirmColor: '#ff453a',
    success: (r) => {
      if (!r.confirm) return
      stop(); saveSettings({ baseUrl: '', token: '' })
      form.value = { baseUrl: '', token: '' }; result.value = ''
    },
  })
}

const LINK: Record<string, string> = {
  idle: '未连接', connecting: '连接中', live: '实时', polling: '轮询', error: '异常',
}
</script>

<template>
  <view class="root">
    <view class="body">
      <text class="grouphead">服务器</text>
      <view class="card">
        <view class="field">
          <text class="flabel">地址</text>
          <input class="finput" v-model="form.baseUrl"
            placeholder="https://your-node.your-tailnet.ts.net" placeholder-class="ph" />
        </view>
        <view class="hsep" />
        <view class="field">
          <text class="flabel">Token</text>
          <input class="finput" v-model="form.token" password
            placeholder="服务端 .env 中的 API_TOKEN" placeholder-class="ph" />
        </view>
      </view>
      <text class="note">Tailscale MagicDNS 域名，Let's Encrypt 正式证书。凭据只存本机。</text>

      <button class="cta" :disabled="testing" @click="testAndSave">
        {{ testing ? '测试中' : '测试并保存' }}
      </button>
      <view v-if="result" class="result">
        <view class="rdot" :class="ok ? 'good' : 'bad'" />
        <text class="rtext">{{ result }}</text>
      </view>

      <text class="grouphead">状态</text>
      <view class="card">
        <view class="line"><text class="k">通道</text><text class="v">{{ LINK[printer.link] }}</text></view>
        <view class="hsep" />
        <view class="line"><text class="k">打印机</text>
          <text class="v">{{ printer.summary?.online ? '在线' : '离线' }}</text></view>
        <view class="hsep" />
        <view class="line"><text class="k">更新</text>
          <text class="v">{{ printer.lastAt ? new Date(printer.lastAt).toLocaleTimeString() : '—' }}</text></view>
        <view v-if="printer.error" class="hsep" />
        <view v-if="printer.error" class="line">
          <text class="k">错误</text><text class="v bad">{{ printer.error }}</text></view>
      </view>

      <view class="card mt">
        <view class="line tappable" @click="restart">
          <text class="k accent">重新连接</text><text class="v">›</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="clearAll">
          <text class="k danger">清除配置</text><text class="v">›</text>
        </view>
      </view>

      <text class="foot">Bambu Lab P2S 远程监控{{ '\n' }}经 Tailscale 端到端加密，不经任何云服务。</text>
    </view>
  </view>
</template>

<style scoped>
.root { background: var(--bg); min-height: 100vh; }
.body { padding: 36rpx 36rpx 140rpx; }
.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 44rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.grouphead:first-child { margin-top: 8rpx; }

.card { background: var(--surface); border-radius: 28rpx; padding: 0 34rpx; }
.mt { margin-top: 20rpx; }
.hsep { height: 1rpx; background: var(--separator); }

/* 地址很长，标签压在上方、输入独占一行才不会被截断 */
.field { padding: 26rpx 0 30rpx; }
.flabel { display: block; font-size: 23rpx; color: var(--ink-2);
  letter-spacing: 0.01em; margin-bottom: 12rpx; }
.finput { width: 100%; font-size: 29rpx; color: var(--ink); letter-spacing: -0.01em; }
.ph { color: var(--ink-3); }

.cta { margin-top: 32rpx; width: 100%; font-size: 31rpx; font-weight: 500;
  height: 100rpx; line-height: 100rpx; background: var(--accent); color: #fff;
  border: none; border-radius: 999rpx; letter-spacing: -0.02em; padding: 0;
  transition: opacity 0.25s ease; }
.cta::after { border: none; }
.cta[disabled] { opacity: 0.45; }

.result { display: flex; align-items: center; justify-content: center; margin-top: 22rpx; }
.rdot { width: 12rpx; height: 12rpx; border-radius: 50%; margin-right: 12rpx; }
.rdot.good { background: var(--good); }
.rdot.bad { background: var(--critical); }
.rtext { font-size: 25rpx; color: var(--ink-2); letter-spacing: -0.01em; }

.line { display: flex; align-items: center; justify-content: space-between; min-height: 100rpx; }
.tappable:active { opacity: 0.55; }
.k { font-size: 30rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.accent { color: var(--accent); }
.k.danger { color: var(--critical); }
.v { font-size: 29rpx; color: var(--ink-2); letter-spacing: -0.02em; }
.v.bad { color: var(--critical); }

.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin: 16rpx 0 0; padding: 0 8rpx; line-height: 1.6; letter-spacing: -0.01em; }
.foot { display: block; text-align: center; font-size: 22rpx; color: var(--ink-3);
  margin-top: 60rpx; line-height: 1.7; letter-spacing: -0.01em; }
</style>
