<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow } from '@dcloudio/uni-app'
import {
  loadSettings, saveSettings, api, fetchNotifyStatus, testNotify,
  type Settings, type NotifyStatus,
} from '../../api/client'
import {
  pushSupport, isStandalone, isIOS, currentSubscription, enablePush, disablePush,
} from '../../api/push'
import { printer, restart, stop } from '../../store/printer'
import {
  prefs, setLocale, setTheme, themeClass, applyChrome, localeName,
  type ThemePref, type LocalePref,
} from '../../store/prefs'
import { LOCALES } from '../../locale'

const { t } = useI18n()
const form = ref<Settings>({ baseUrl: '', token: '' })
const testing = ref(false)
const result = ref('')
const ok = ref(false)

onShow(() => {
  applyChrome('tab.settings')
  form.value = loadSettings()
  void loadNotify()
})

// ---- 推送 ----
/*
 * iOS 的 Safari 只在「已添加到主屏」的 PWA 里给 Notification 权限，
 * 普通标签页里请求会被直接拒。所以这里先判断运行形态，
 * 没装到主屏时不给订阅开关，而是给一句能照做的引导。
 */
const notify = ref<NotifyStatus | null>(null)
const subscribed = ref(false)
const pushBusy = ref(false)
const pushNote = ref('')

const support = computed(() => pushSupport())
const needsInstall = computed(() => isIOS() && !isStandalone())
const canSubscribe = computed(
  () => support.value === 'ok' && !!notify.value?.vapidPublicKey && !needsInstall.value,
)

async function loadNotify() {
  try {
    notify.value = await fetchNotifyStatus()
  } catch {
    notify.value = null
  }
  subscribed.value = !!(await currentSubscription())
}

const PUSH_REASON: Record<string, string> = {
  insecure: 'settings.pushInsecure',
  'no-sw': 'settings.pushUnsupported',
  'no-push': 'settings.pushUnsupported',
  'not-h5': 'settings.pushUnsupported',
  'no-vapid': 'settings.pushNoVapid',
  denied: 'settings.pushDenied',
}

async function togglePush() {
  if (pushBusy.value) return
  pushBusy.value = true
  pushNote.value = ''
  try {
    if (subscribed.value) {
      await disablePush()
      subscribed.value = false
    } else {
      const r = await enablePush()
      if (!r.ok) pushNote.value = t(PUSH_REASON[r.reason ?? ''] ?? 'settings.pushFailed')
      subscribed.value = r.ok
    }
    await loadNotify()
  } catch (e) {
    pushNote.value = (e as Error).message
  } finally {
    pushBusy.value = false
  }
}

async function sendTest() {
  pushBusy.value = true
  pushNote.value = ''
  try {
    const r = await testNotify()
    const hit = r.results.filter((x) => x.ok).map((x) => x.name)
    pushNote.value = hit.length
      ? t('settings.pushTestOk', { names: hit.join('、') })
      : t('settings.pushTestNone')
  } catch (e) {
    pushNote.value = (e as Error).message
  } finally {
    pushBusy.value = false
  }
}

/** 已配置的出口，只列启用了的 */
const activeSinks = computed(() => {
  const s = notify.value?.sinks ?? {}
  return ['webpush', 'bark', 'ntfy', 'telegram', 'webhook'].filter((k) => s[k] === true)
})

async function testAndSave() {
  testing.value = true; result.value = ''
  const prev = loadSettings()
  saveSettings(form.value)
  try {
    const h = await api.health()
    const st = await api.state()
    ok.value = true
    result.value = t('settings.connected', {
      state: h.printerConnected ? t('common.online') : t('common.offline'),
      gcode: st.state,
    })
    restart()
  } catch (e) {
    ok.value = false
    result.value = (e as Error).message
    saveSettings(prev)          // 校验不过就回滚，避免把界面搞成半死状态
  } finally { testing.value = false }
}

function clearAll() {
  uni.showModal({
    title: t('settings.clearTitle'), content: t('settings.clearDesc'), confirmColor: '#ff453a',
    success: (r) => {
      if (!r.confirm) return
      stop(); saveSettings({ baseUrl: '', token: '' })
      form.value = { baseUrl: '', token: '' }; result.value = ''
    },
  })
}

// ---- 外观 ----
const themeOptions = computed(() => [
  { key: 'auto' as ThemePref, label: t('settings.themeAuto') },
  { key: 'dark' as ThemePref, label: t('settings.themeDark') },
  { key: 'light' as ThemePref, label: t('settings.themeLight') },
])

const localeOptions = computed<{ key: LocalePref; label: string }[]>(() => [
  { key: 'auto', label: t('settings.langAuto') },
  ...LOCALES.map((c) => ({ key: c as LocalePref, label: localeName(c) })),
])
const currentLocaleLabel = computed(
  () => localeOptions.value.find((o) => o.key === prefs.locale)?.label ?? '',
)

function pickLocale() {
  const opts = localeOptions.value
  uni.showActionSheet({
    itemList: opts.map((o) => o.label),
    success: (r) => setLocale(opts[r.tapIndex].key),
    fail: () => {},
  })
}
</script>

<template>
  <view class="root" :class="themeClass">
    <view class="body">
      <text class="grouphead">{{ t('settings.serverGroup') }}</text>
      <view class="card">
        <view class="field">
          <text class="flabel">{{ t('settings.address') }}</text>
          <input class="finput" v-model="form.baseUrl"
            :placeholder="t('settings.addressPlaceholder')" placeholder-class="ph" />
        </view>
        <view class="hsep" />
        <view class="field">
          <text class="flabel">{{ t('settings.token') }}</text>
          <input class="finput" v-model="form.token" password
            :placeholder="t('settings.tokenPlaceholder')" placeholder-class="ph" />
        </view>
      </view>
      <text class="note">{{ t('settings.serverNote') }}</text>

      <button class="cta" :disabled="testing" @click="testAndSave">
        {{ testing ? t('settings.testing') : t('settings.testAndSave') }}
      </button>
      <view v-if="result" class="result">
        <view class="rdot" :class="ok ? 'good' : 'bad'" />
        <text class="rtext">{{ result }}</text>
      </view>

      <!-- 外观：语言与主题都以「跟随系统」为默认 -->
      <text class="grouphead">{{ t('settings.appearanceGroup') }}</text>
      <view class="card">
        <view class="line tappable" @click="pickLocale">
          <text class="k">{{ t('settings.language') }}</text>
          <text class="v">{{ currentLocaleLabel }} ›</text>
        </view>
        <view class="hsep" />
        <view class="line stack">
          <text class="k">{{ t('settings.theme') }}</text>
          <view class="segs">
            <view v-for="o in themeOptions" :key="o.key" class="seg"
              :class="{ on: prefs.theme === o.key }" @click="setTheme(o.key)">
              <text class="seg-t">{{ o.label }}</text>
            </view>
          </view>
        </view>
      </view>

      <!-- 推送：出事的时候主动叫你，不用一直开着 app -->
      <text class="grouphead">{{ t('settings.notifyGroup') }}</text>
      <view class="card">
        <view v-if="needsInstall" class="line stack">
          <text class="k">{{ t('settings.pushInstallTitle') }}</text>
          <text class="opt-sub">{{ t('settings.pushInstallDesc') }}</text>
        </view>
        <template v-else>
          <view class="line">
            <text class="k">{{ t('settings.pushEnable') }}</text>
            <switch :checked="subscribed" :disabled="!canSubscribe || pushBusy"
              color="#0A84FF" @change="togglePush" />
          </view>
          <view v-if="!canSubscribe" class="hsep" />
          <view v-if="!canSubscribe" class="line stack">
            <text class="opt-sub">
              {{ notify && !notify.vapidPublicKey ? t('settings.pushNoVapid') : t('settings.pushUnsupported') }}
            </text>
          </view>
        </template>
        <view class="hsep" />
        <view class="line">
          <text class="k">{{ t('settings.pushSinks') }}</text>
          <text class="v">{{ activeSinks.length ? activeSinks.join('、') : t('settings.pushNoSink') }}</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="sendTest">
          <text class="k accent">{{ t('settings.pushTest') }}</text>
          <text class="v">›</text>
        </view>
      </view>
      <text v-if="pushNote" class="note">{{ pushNote }}</text>

      <text class="grouphead">{{ t('settings.statusGroup') }}</text>
      <view class="card">
        <view class="line"><text class="k">{{ t('settings.channel') }}</text>
          <text class="v">{{ t('link.' + printer.link) }}</text></view>
        <view class="hsep" />
        <view class="line"><text class="k">{{ t('settings.printer') }}</text>
          <text class="v">{{ printer.summary?.online ? t('common.online') : t('common.offline') }}</text></view>
        <view class="hsep" />
        <view class="line"><text class="k">{{ t('settings.updated') }}</text>
          <text class="v">{{ printer.lastAt ? new Date(printer.lastAt).toLocaleTimeString() : t('common.none') }}</text></view>
        <view v-if="printer.error" class="hsep" />
        <view v-if="printer.error" class="line">
          <text class="k">{{ t('settings.error') }}</text>
          <text class="v bad">{{ printer.error }}</text></view>
      </view>

      <view class="card mt">
        <view class="line tappable" @click="restart">
          <text class="k accent">{{ t('settings.reconnect') }}</text><text class="v">›</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="clearAll">
          <text class="k danger">{{ t('settings.clearConfig') }}</text><text class="v">›</text>
        </view>
      </view>

      <text class="foot">{{ t('settings.footer') }}</text>
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
.line.stack { display: block; padding: 26rpx 0 30rpx; }
.tappable:active { opacity: 0.55; }
.k { font-size: 30rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.accent { color: var(--accent); }
.k.danger { color: var(--critical); }
.v { font-size: 29rpx; color: var(--ink-2); letter-spacing: -0.02em; }
.v.bad { color: var(--critical); }

.segs { display: flex; background: var(--surface-2); border-radius: 20rpx;
  padding: 6rpx; margin-top: 20rpx; }
.seg { flex: 1; padding: 16rpx 0; text-align: center; border-radius: 15rpx;
  transition: background 0.25s ease; }
.seg.on { background: var(--surface); }
.seg-t { font-size: 26rpx; color: var(--ink); letter-spacing: -0.02em; }
.seg.on .seg-t { font-weight: 600; }

.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin: 16rpx 0 0; padding: 0 8rpx; line-height: 1.6; letter-spacing: -0.01em; }
.foot { display: block; text-align: center; font-size: 22rpx; color: var(--ink-3);
  margin-top: 60rpx; line-height: 1.7; letter-spacing: -0.01em; }
.opt-sub { display: block; font-size: 23rpx; color: var(--ink-2);
  margin-top: 10rpx; line-height: 1.5; letter-spacing: -0.01em; }
</style>
