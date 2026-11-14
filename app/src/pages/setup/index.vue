<script setup lang="ts">
/*
 * 首次设置向导。一行命令装好的桥接还没配置打印机时，App 一打开就到这里。
 *
 * 四步：准备 → 选打印机（局域网自动发现，找不到可手填）→ 输访问码 → 完成（扫码配对手机）。
 * 访问码在服务端真连一次打印机验证，通过才写配置；写完桥接自己重启，这里等它回来。
 * 设置这台设备顺手就拿到了 token，不用再抄；别的设备扫完成页的二维码。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow } from '@dcloudio/uni-app'
import {
  loadSettings, saveSettings, setupDiscover, setupApply, setupStatus, type FoundPrinter,
} from '../../api/client'
import { restart } from '../../store/printer'
import { themeClass, applyChrome } from '../../store/prefs'
import { pairUrl, qrDataUri } from '../../util/pair'
import Spinner from '../../components/Spinner.vue'

const { t, te } = useI18n()

type Step = 'intro' | 'pick' | 'code' | 'applying' | 'done'
const step = ref<Step>('intro')

// ---- 选打印机 ----
const searching = ref(false)
const found = ref<FoundPrinter[]>([])
const manual = ref(false)
const host = ref('')
const serial = ref('')
const pickedName = ref('')

async function search() {
  searching.value = true
  found.value = []
  try {
    found.value = (await setupDiscover()).printers
  } catch {
    found.value = []
  } finally {
    searching.value = false
  }
  // 一台都没找到就直接摆出手填的表单，别让人对着空列表发愣
  if (!found.value.length) manual.value = true
}

function begin() {
  step.value = 'pick'
  void search()
}

function choose(p: FoundPrinter) {
  host.value = p.ip
  serial.value = p.serial
  pickedName.value = [p.modelName || p.model, p.name].filter(Boolean).join(' · ')
  step.value = 'code'
}

const manualOk = computed(() => /^[\w.-]+$/.test(host.value.trim()) && /^[A-Za-z0-9]{8,20}$/.test(serial.value.trim()))
function useManual() {
  if (!manualOk.value) return
  pickedName.value = ''
  step.value = 'code'
}

// ---- 访问码 ----
const code = ref('')
const err = ref('')
const codeOk = computed(() => /^[A-Za-z0-9]{8}$/.test(code.value.trim()))

function errText(e: unknown): string {
  const c = (e as { code?: string }).code
  return c && te(`setup.err.${c}`) ? t(`setup.err.${c}`) : (e as Error).message
}

const token = ref('')
const base = computed(() => loadSettings().baseUrl || (typeof location !== 'undefined' ? location.origin : ''))

async function connect() {
  if (!codeOk.value) return
  err.value = ''
  step.value = 'applying'
  try {
    const r = await setupApply({ host: host.value.trim(), serial: serial.value.trim(), code: code.value.trim() })
    token.value = r.token
    // 这台设备直接用上，不用再抄 token
    saveSettings({ baseUrl: base.value, token: r.token })
    await waitForRestart()
    restart()
    step.value = 'done'
  } catch (e) {
    err.value = errText(e)
    step.value = 'code'
  }
}

/** 桥接写完配置会退出、由 Docker 拉起来。等它以正常模式回来 */
async function waitForRestart() {
  const until = Date.now() + 90_000
  await new Promise((r) => setTimeout(r, 2500))
  while (Date.now() < until) {
    try {
      if (!(await setupStatus()).needed) return
    } catch { /* 还在重启 */ }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw Object.assign(new Error(t('setup.err.restart')), { code: 'restart' })
}

// ---- 完成 ----
const link = computed(() => (token.value ? pairUrl(base.value, token.value) : ''))
const qr = computed(() => (link.value ? qrDataUri(link.value) : ''))

function finish() {
  uni.reLaunch({ url: '/pages/monitor/index' })
}

onShow(() => applyChrome('setup.title'))
</script>

<template>
  <view class="root" :class="themeClass">
    <!-- 进度点 -->
    <view class="dots">
      <view v-for="(s, i) in ['intro', 'pick', 'code', 'done']" :key="s" class="pip"
        :class="{ on: ['intro', 'pick', 'code', 'done'].indexOf(step === 'applying' ? 'code' : step) >= i }" />
    </view>

    <!-- 1. 准备 -->
    <template v-if="step === 'intro'">
      <text class="h1">{{ t('setup.introTitle') }}</text>
      <text class="lead">{{ t('setup.introLead') }}</text>
      <view class="card">
        <view v-for="(k, i) in ['prep1', 'prep2', 'prep3']" :key="k" class="prep" :class="{ sep: i > 0 }">
          <text class="num">{{ i + 1 }}</text>
          <view class="prep-m">
            <text class="k">{{ t(`setup.${k}`) }}</text>
            <text class="sub">{{ t(`setup.${k}Sub`) }}</text>
          </view>
        </view>
      </view>
      <view class="note warn"><text class="note-t">{{ t('setup.lanNote') }}</text></view>
      <button class="cta fill" @click="begin">{{ t('setup.start') }}</button>
    </template>

    <!-- 2. 选打印机 -->
    <template v-else-if="step === 'pick'">
      <text class="h1">{{ t('setup.pickTitle') }}</text>
      <view v-if="searching" class="searching">
        <Spinner :size="40" />
        <text class="sub center">{{ t('setup.searching') }}</text>
      </view>
      <template v-else>
        <view v-if="found.length" class="card">
          <view v-for="(p, i) in found" :key="p.serial" class="row tappable" :class="{ sep: i > 0 }" @click="choose(p)">
            <view class="prep-m">
              <text class="k">{{ p.modelName || p.model || t('setup.unknownModel') }}<text v-if="p.name" class="dim"> · {{ p.name }}</text></text>
              <text class="sub">{{ p.ip }} · {{ t('setup.serialShort', { s: p.serial.slice(-4) }) }}</text>
            </view>
            <text class="chev">›</text>
          </view>
        </view>
        <text v-else class="sub pad">{{ t('setup.noneFound') }}</text>

        <view class="links">
          <text class="link" @click="search">{{ t('setup.searchAgain') }}</text>
          <text v-if="!manual" class="link" @click="manual = true">{{ t('setup.manual') }}</text>
        </view>

        <template v-if="manual">
          <text class="grouphead">{{ t('setup.manualHead') }}</text>
          <view class="card">
            <view class="field">
              <text class="flabel">{{ t('setup.ip') }}</text>
              <input class="finput" v-model="host" type="text" placeholder="192.168.1.42" placeholder-class="ph" />
            </view>
            <view class="field sep">
              <text class="flabel">{{ t('setup.serial') }}</text>
              <input class="finput" v-model="serial" type="text" placeholder="22E00A000000000" placeholder-class="ph" />
            </view>
          </view>
          <text class="hint">{{ t('setup.serialHint') }}</text>
          <button class="cta fill" :disabled="!manualOk" @click="useManual">{{ t('setup.next') }}</button>
        </template>
      </template>
    </template>

    <!-- 3. 访问码 -->
    <template v-else-if="step === 'code' || step === 'applying'">
      <text class="h1">{{ t('setup.codeTitle') }}</text>
      <text class="lead">{{ pickedName ? `${pickedName} · ${host}` : host }}</text>
      <view class="card">
        <view class="field">
          <input class="finput code" v-model="code" type="text" maxlength="8" :disabled="step === 'applying'"
            :placeholder="t('setup.codePh')" placeholder-class="ph" confirm-type="done" @confirm="connect" />
        </view>
      </view>
      <text class="hint">{{ t('setup.codeHint') }}</text>
      <view v-if="err" class="note bad"><text class="note-t">{{ err }}</text></view>
      <button class="cta fill" :disabled="!codeOk || step === 'applying'" @click="connect">
        {{ step === 'applying' ? t('setup.connecting') : t('setup.connect') }}
      </button>
      <text v-if="step === 'code'" class="link center" @click="step = 'pick'">{{ t('setup.back') }}</text>
    </template>

    <!-- 4. 完成 -->
    <template v-else>
      <view class="ok"><text class="ok-g">✓</text></view>
      <text class="h1 center">{{ t('setup.doneTitle') }}</text>
      <text class="lead center">{{ t('setup.doneLead') }}</text>
      <view class="card qrcard">
        <image class="qr" :src="qr" mode="aspectFit" />
        <text class="k center">{{ t('setup.scanTitle') }}</text>
        <text class="sub center">{{ t('setup.scanSub') }}</text>
      </view>
      <button class="cta fill" @click="finish">{{ t('setup.finish') }}</button>
    </template>
  </view>
</template>

<style scoped>
.root { min-height: 100vh; background: var(--bg); padding: 24rpx 40rpx 80rpx; box-sizing: border-box; }
.dots { display: flex; justify-content: center; gap: 12rpx; margin: 8rpx 0 36rpx; }
.pip { width: 14rpx; height: 14rpx; border-radius: 50%; background: var(--separator); }
.pip.on { background: var(--accent); }

.h1 { display: block; font-size: 46rpx; font-weight: 700; color: var(--ink); letter-spacing: -0.03em; line-height: 1.25; }
.lead { display: block; font-size: 27rpx; color: var(--ink-2); margin: 14rpx 0 32rpx; line-height: 1.55; letter-spacing: -0.01em; }
.center { text-align: center; }

.card { background: var(--surface); border-radius: 24rpx; padding: 0 28rpx; }
.prep { display: flex; align-items: flex-start; padding: 26rpx 0; }
.sep { border-top: 1rpx solid var(--separator); }
.num { width: 44rpx; height: 44rpx; line-height: 44rpx; text-align: center; border-radius: 50%; flex-shrink: 0;
  background: var(--accent-dim); color: var(--accent); font-size: 24rpx; font-weight: 600; margin-right: 22rpx; }
.prep-m { flex: 1; min-width: 0; }
.k { display: block; font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; line-height: 1.4; }
.dim { color: var(--ink-2); }
.sub { display: block; font-size: 23rpx; color: var(--ink-2); margin-top: 6rpx; line-height: 1.5; letter-spacing: -0.01em; }
.sub.pad { padding: 20rpx 8rpx; }
.row { display: flex; align-items: center; padding: 26rpx 0; }
.chev { font-size: 34rpx; color: var(--ink-3); margin-left: 16rpx; }
.tappable:active { opacity: 0.55; }

.note { margin-top: 24rpx; padding: 22rpx 26rpx; border-radius: 20rpx; }
.note.warn { background: var(--warning-bg); }
.note.warn .note-t { color: var(--warning); }
.note.bad { background: rgba(255, 69, 58, 0.12); }
.note.bad .note-t { color: var(--critical); }
.note-t { display: block; font-size: 24rpx; line-height: 1.55; letter-spacing: -0.01em; }

.searching { display: flex; flex-direction: column; align-items: center; padding: 80rpx 0; gap: 20rpx; }
.links { display: flex; justify-content: space-between; margin: 24rpx 8rpx 0; }
.link { font-size: 27rpx; color: var(--accent); letter-spacing: -0.01em; }
.link.center { display: block; text-align: center; margin-top: 28rpx; }
.link:active { opacity: 0.55; }

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2); margin: 40rpx 0 16rpx 8rpx; }
.field { padding: 22rpx 0; }
.flabel { display: block; font-size: 22rpx; color: var(--ink-2); margin-bottom: 8rpx; }
.finput { width: 100%; font-size: 30rpx; color: var(--ink); letter-spacing: -0.01em; }
.finput.code { font-size: 44rpx; letter-spacing: 0.2em; font-variant-numeric: tabular-nums; text-align: center; height: 72rpx; }
.ph { color: var(--ink-3); letter-spacing: 0; }
.hint { display: block; font-size: 23rpx; color: var(--ink-3); margin: 18rpx 8rpx 0; line-height: 1.6; letter-spacing: -0.01em; }

.cta { margin-top: 40rpx; width: 100%; font-size: 31rpx; font-weight: 500; height: 100rpx; line-height: 100rpx;
  background: var(--surface); color: var(--accent); border: none; border-radius: 999rpx; letter-spacing: -0.02em; padding: 0; }
.cta::after { border: none; }
.cta.fill { background: var(--accent); color: #fff; }
.cta[disabled] { opacity: 0.4; }

.ok { width: 112rpx; height: 112rpx; border-radius: 50%; background: var(--good); margin: 20rpx auto 28rpx;
  display: flex; align-items: center; justify-content: center; }
.ok-g { color: #fff; font-size: 60rpx; font-weight: 700; }
.qrcard { display: flex; flex-direction: column; align-items: center; padding: 36rpx 28rpx 32rpx; }
.qr { width: 380rpx; height: 380rpx; background: #fff; border-radius: 16rpx; margin-bottom: 24rpx; }
</style>
