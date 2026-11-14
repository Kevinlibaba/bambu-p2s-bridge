<script setup lang="ts">
/*
 * MakerWorld（国际版）：登录、粘贴链接或从收藏/点赞里挑模型，导入到打印机。
 *
 * 账号密码只经桥接转给 Bambu 换 token，桥接只存 token。下载、上传到打印机都由
 * 桥接完成（有线千兆），手机只发一个请求 —— 和「从链接导入」是同一条路。
 * 导入完跳回文件页并直接打开这个文件，接着走切片 / 打印。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app'
import {
  configured, mwAccount, mwLogin, mwLogout, mwSendCode, mwDesign, mwList, mwImport,
  type MwAccount, type MwCard, type MwDesign, type MwInstance,
} from '../../api/client'
import { themeClass, applyChrome } from '../../store/prefs'
import { requestOpen } from '../../store/reprint'
import { confirm, toast } from '../../util/dialog'
import Sheet from '../../components/Sheet.vue'
import Spinner from '../../components/Spinner.vue'

const { t, te } = useI18n()

/** 桥接回的错误带 code 的，按 code 翻译；没有就原样显示 */
function errText(e: unknown): string {
  const code = (e as { code?: string }).code
  if (code && te(`mw.err.${code}`)) return t(`mw.err.${code}`)
  return (e as Error).message
}

// ---- 账号 ----
const account = ref<MwAccount | null>(null)
const accountLoaded = ref(false)

async function loadAccount() {
  try {
    account.value = (await mwAccount()).account
  } catch (e) {
    toast(errText(e))
  } finally {
    accountLoaded.value = true
  }
}

type Mode = 'password' | 'code'
const mode = ref<Mode>('password')
/** 密码登录后服务端要求补的下一步 */
const step = ref<'' | 'verifyCode' | 'tfa'>('')
const tfaKey = ref('')
const form = ref({ account: '', password: '', code: '' })
const busy = ref(false)
const cooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

const needCode = computed(() => mode.value === 'code' || step.value !== '')
const canLogin = computed(() => {
  if (busy.value || !form.value.account.trim()) return false
  return needCode.value ? form.value.code.trim().length >= 4 : !!form.value.password
})

function setMode(m: Mode) {
  mode.value = m
  step.value = ''
  form.value.code = ''
}

function startCooldown() {
  cooldown.value = 60
  if (cooldownTimer) clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0 && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null }
  }, 1000)
}

async function sendCode() {
  if (cooldown.value > 0 || !form.value.account.trim()) return
  try {
    await mwSendCode(form.value.account.trim())
    startCooldown()
    toast(t('mw.codeSent'))
  } catch (e) {
    toast(errText(e))
  }
}

async function login() {
  if (!canLogin.value) return
  busy.value = true
  const acc = form.value.account.trim()
  try {
    const r = needCode.value
      ? await mwLogin({ account: acc, code: form.value.code.trim(), ...(step.value === 'tfa' ? { tfaKey: tfaKey.value } : {}) })
      : await mwLogin({ account: acc, password: form.value.password })
    if (r.ok) {
      account.value = r.account
      form.value = { account: '', password: '', code: '' }
      step.value = ''
      void loadList(true)
      return
    }
    // 密码对了，还要再验一步。邮箱验证码桥接已经发出去了
    step.value = r.next
    if (r.next === 'tfa') tfaKey.value = r.tfaKey
    else startCooldown()
    form.value.password = ''
    toast(r.next === 'tfa' ? t('mw.needTfa') : t('mw.codeSent'))
  } catch (e) {
    toast(errText(e))
  } finally {
    busy.value = false
  }
}

async function logout() {
  if (!(await confirm(t('mw.logoutTitle'), t('mw.logoutDesc')))) return
  await mwLogout().catch(() => {})
  account.value = null
  items.value = []
}

// ---- 列表 ----
type Kind = 'favorites' | 'likes'
const kind = ref<Kind>('favorites')
const items = ref<MwCard[]>([])
const total = ref(0)
const listLoading = ref(false)
const listErr = ref('')

async function loadList(reset = false) {
  if (!account.value || listLoading.value) return
  listLoading.value = true
  listErr.value = ''
  try {
    const r = await mwList(kind.value, reset ? 0 : items.value.length)
    items.value = reset ? r.items : [...items.value, ...r.items]
    total.value = r.total
  } catch (e) {
    listErr.value = errText(e)
    if ((e as { code?: string }).code === 'auth') account.value = null
  } finally {
    listLoading.value = false
  }
}

function setKind(k: Kind) {
  if (kind.value === k) return
  kind.value = k
  items.value = []
  void loadList(true)
}

const hasMore = computed(() => items.value.length < total.value)

// ---- 详情 ----
const linkText = ref('')
const detail = ref<MwDesign | null>(null)
const detailOpen = ref(false)
const detailLoading = ref(false)
const chosen = ref<number | null>(null)
const importing = ref(false)

async function openDesign(link: string) {
  if (!link.trim()) return
  detail.value = null
  detailOpen.value = true
  detailLoading.value = true
  try {
    const d = await mwDesign(link.trim())
    detail.value = d
    chosen.value = d.selected
  } catch (e) {
    toast(errText(e))
    detailOpen.value = false
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  if (importing.value) return
  detailOpen.value = false
}

function fmtDuration(sec: number) {
  const m = Math.max(1, Math.round(sec / 60))
  return m >= 60
    ? t('monitor.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
    : t('monitor.minutes', { m })
}

function instSub(i: MwInstance): string {
  const parts: string[] = []
  if (i.layerHeight) parts.push(t('mw.layer', { h: i.layerHeight }))
  if (i.plates) parts.push(t('mw.plates', { n: i.plates }))
  if (i.printTime) parts.push(fmtDuration(i.printTime))
  if (i.weight) parts.push(`${i.weight} g`)
  return parts.join(' · ')
}

function count(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

async function doImport() {
  if (!chosen.value || importing.value) return
  importing.value = true
  try {
    const r = await mwImport(chosen.value)
    toast(t('import.done', { name: r.name }))
    importing.value = false
    detailOpen.value = false
    // 跳回文件页直接打开它，接着切片 / 打印
    requestOpen({ path: r.path, plate: null })
    uni.switchTab({ url: '/pages/files/index' })
  } catch (e) {
    toast(errText(e))
    if ((e as { code?: string }).code === 'auth') {
      account.value = null
      detailOpen.value = false
    }
  } finally {
    importing.value = false
  }
}

onShow(async () => {
  applyChrome('mw.title')
  if (!configured.value) return
  await loadAccount()
  if (account.value && !items.value.length) void loadList(true)
})
onPullDownRefresh(async () => {
  await loadList(true)
  uni.stopPullDownRefresh()
})
</script>

<template>
  <view class="root" :class="themeClass">
    <view v-if="!configured" class="empty"><text class="empty-t">{{ t('common.notConfigured') }}</text></view>
    <view v-else-if="!accountLoaded" class="busy"><Spinner :size="40" /></view>

    <!-- 未登录 -->
    <template v-else-if="!account">
      <text class="grouphead">{{ t('mw.loginHead') }}</text>
      <view class="segs">
        <view class="seg" :class="{ on: mode === 'password' }" @click="setMode('password')">
          <text class="seg-t">{{ t('mw.byPassword') }}</text>
        </view>
        <view class="seg" :class="{ on: mode === 'code' }" @click="setMode('code')">
          <text class="seg-t">{{ t('mw.byCode') }}</text>
        </view>
      </view>
      <view class="card sheet-card">
        <view class="field">
          <input class="finput" v-model="form.account" type="text" :disabled="step !== ''"
            :placeholder="t('mw.accountPh')" placeholder-class="ph" />
        </view>
        <template v-if="!needCode">
          <view class="hsep" />
          <view class="field">
            <input class="finput" v-model="form.password" type="safe-password" password
              :placeholder="t('mw.passwordPh')" placeholder-class="ph" @confirm="login" />
          </view>
        </template>
        <template v-else>
          <view class="hsep" />
          <view class="field row">
            <input class="finput grow" v-model="form.code" type="number" maxlength="8"
              :placeholder="step === 'tfa' ? t('mw.tfaPh') : t('mw.codePh')" placeholder-class="ph"
              @confirm="login" />
            <text v-if="step !== 'tfa'" class="link" :class="{ off: cooldown > 0 || !form.account.trim() }"
              @click="sendCode">
              {{ cooldown > 0 ? t('mw.resendIn', { s: cooldown }) : t('mw.sendCode') }}
            </text>
          </view>
        </template>
      </view>
      <button class="cta fill" :disabled="!canLogin" @click="login">
        {{ busy ? t('mw.loggingIn') : t('mw.login') }}
      </button>
      <text v-if="step" class="link center" @click="setMode(mode)">{{ t('mw.restart') }}</text>
      <text class="hint">{{ t('mw.loginHint') }}</text>
    </template>

    <!-- 已登录 -->
    <template v-else>
      <view class="card who">
        <view class="line">
          <view class="row grow">
            <image v-if="account.avatar" class="avatar" :src="account.avatar" mode="aspectFill" />
            <view class="stackmeta">
              <text class="k">{{ account.name || account.account }}</text>
              <text class="sub">{{ t('mw.signedIn') }}</text>
            </view>
          </view>
          <text class="link" @click="logout">{{ t('mw.logout') }}</text>
        </view>
      </view>

      <text class="grouphead">{{ t('mw.linkHead') }}</text>
      <view class="card">
        <view class="field row">
          <input class="finput grow" v-model="linkText" type="text" confirm-type="go"
            :placeholder="t('mw.linkPh')" placeholder-class="ph" @confirm="openDesign(linkText)" />
          <text class="link" :class="{ off: !linkText.trim() }" @click="openDesign(linkText)">{{ t('mw.open') }}</text>
        </view>
      </view>
      <text class="hint">{{ t('mw.linkHint') }}</text>

      <view class="segs list-segs">
        <view class="seg" :class="{ on: kind === 'favorites' }" @click="setKind('favorites')">
          <text class="seg-t">{{ t('mw.favorites') }}</text>
        </view>
        <view class="seg" :class="{ on: kind === 'likes' }" @click="setKind('likes')">
          <text class="seg-t">{{ t('mw.likes') }}</text>
        </view>
      </view>

      <view v-if="listErr" class="card sheet-card"><view class="line"><text class="k dim">{{ listErr }}</text></view></view>
      <view v-else-if="!items.length && !listLoading" class="ph-box">
        <text class="ph-t">{{ kind === 'favorites' ? t('mw.noFavorites') : t('mw.noLikes') }}</text>
      </view>
      <view class="grid">
        <view v-for="d in items" :key="d.id" class="tile tappable" @click="openDesign(String(d.id))">
          <image class="cover" :src="d.cover" mode="aspectFill" lazy-load />
          <text class="tt">{{ d.title }}</text>
          <text class="sub">{{ d.creator }}</text>
        </view>
      </view>
      <view v-if="listLoading" class="busy"><Spinner :size="36" /></view>
      <button v-else-if="hasMore" class="cta more" @click="loadList()">{{ t('mw.more') }}</button>
    </template>

    <!-- 模型详情：选打印配置、导入 -->
    <Sheet :visible="detailOpen" :title="detail?.title || t('mw.title')" @close="closeDetail">
      <view v-if="detailLoading" class="busy"><Spinner :size="40" /></view>
      <template v-else-if="detail">
        <image class="hero" :src="detail.cover" mode="aspectFill" />
        <text class="cap">
          {{ detail.creator }} · ♥ {{ count(detail.likeCount) }} · ↓ {{ count(detail.downloadCount) }}
        </text>

        <text class="grouphead">{{ t('mw.profiles') }}</text>
        <view v-if="!detail.instances.length" class="card"><view class="line"><text class="k dim">{{ t('mw.noProfiles') }}</text></view></view>
        <view v-else class="card">
          <view v-for="(i, n) in detail.instances" :key="i.id">
            <view v-if="n > 0" class="hsep" />
            <view class="inst tappable" @click="chosen = i.id">
              <view class="radio" :class="{ on: chosen === i.id }" />
              <view class="stackmeta grow">
                <text class="k two">{{ i.title || t('mw.untitled') }}</text>
                <text class="sub">{{ instSub(i) }}</text>
                <view class="badges">
                  <text v-if="i.native" class="badge good">{{ t('mw.native') }}</text>
                  <text v-else-if="i.printer" class="badge">{{ t('mw.forPrinter', { p: i.printer }) }}</text>
                  <text v-if="i.needAms" class="badge">AMS</text>
                  <text v-if="i.isDefault" class="badge">{{ t('mw.default') }}</text>
                  <view v-for="(f, k) in i.filaments.slice(0, 8)" :key="k" class="swatch"
                    :style="{ background: f.color || '#888' }" />
                </view>
              </view>
            </view>
          </view>
        </view>
        <text class="hint">{{ t('mw.importHint') }}</text>
      </template>

      <template #footer>
        <button class="cta fill" :disabled="!chosen || importing || detailLoading" @click="doImport">
          {{ importing ? t('mw.importing') : t('mw.import') }}
        </button>
      </template>
    </Sheet>
  </view>
</template>

<style scoped>
.root { min-height: 100vh; background: var(--bg); padding: 0 32rpx 64rpx; box-sizing: border-box; }
.empty { padding: 200rpx 0; text-align: center; }
.empty-t { font-size: 30rpx; color: var(--ink-2); }
.busy { display: flex; justify-content: center; padding: 60rpx 0; }

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 40rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.card { background: var(--surface); border-radius: 22rpx; padding: 0 28rpx; }
.sheet-card { margin-top: 24rpx; }
.who { margin-top: 24rpx; }
.hsep { height: 1rpx; background: var(--separator); }
.line { display: flex; align-items: center; justify-content: space-between; min-height: 96rpx; }
.row { display: flex; align-items: center; }
.grow { flex: 1; min-width: 0; }
.k { font-size: 29rpx; color: var(--ink); letter-spacing: -0.02em; }
.k.dim { color: var(--ink-3); }
.k.two { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sub { display: block; font-size: 22rpx; color: var(--ink-3); margin-top: 6rpx; letter-spacing: -0.01em; }
.stackmeta { display: flex; flex-direction: column; min-width: 0; }
.tappable:active { opacity: 0.55; }

.field { padding: 26rpx 0; }
.finput { width: 100%; font-size: 29rpx; color: var(--ink); letter-spacing: -0.01em; }
.ph { color: var(--ink-3); }
.link { font-size: 27rpx; color: var(--accent); letter-spacing: -0.02em; padding-left: 24rpx; flex-shrink: 0; }
.link.off { opacity: 0.4; }
.link.center { display: block; text-align: center; padding: 28rpx 0 0; }

.segs { display: flex; background: var(--surface); border-radius: 24rpx; padding: 8rpx; }
.list-segs { margin-top: 40rpx; }
.seg { flex: 1; padding: 20rpx 0; text-align: center; border-radius: 18rpx; }
.seg.on { background: var(--surface-2); }
.seg-t { font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em; }
.seg.on .seg-t { font-weight: 600; }

.cta { margin-top: 32rpx; width: 100%; font-size: 31rpx; font-weight: 500;
  height: 96rpx; line-height: 96rpx; background: var(--surface); color: var(--accent);
  border: none; border-radius: 999rpx; letter-spacing: -0.02em; padding: 0; }
.cta::after { border: none; }
.cta.fill { background: var(--accent); color: #fff; }
.cta[disabled] { opacity: 0.4; }
.hint { display: block; font-size: 22rpx; color: var(--ink-3);
  margin: 20rpx 8rpx 0; line-height: 1.6; letter-spacing: -0.01em; }
.cap { display: block; font-size: 23rpx; color: var(--ink-2); margin: 18rpx 8rpx 0; letter-spacing: -0.01em; }

.avatar { width: 64rpx; height: 64rpx; border-radius: 50%; margin-right: 20rpx; background: var(--surface-2); flex-shrink: 0; }

.ph-box { margin-top: 24rpx; padding: 90rpx 0; background: var(--surface); border-radius: 24rpx; text-align: center; }
.ph-t { font-size: 26rpx; color: var(--ink-2); letter-spacing: -0.01em; }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20rpx; margin-top: 24rpx; }
.tile { background: var(--surface); border-radius: 22rpx; overflow: hidden; padding-bottom: 18rpx; min-width: 0; }
.cover { width: 100%; height: 260rpx; display: block; background: var(--surface-2); }
.tt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 25rpx; color: var(--ink); margin: 14rpx 18rpx 0; line-height: 1.35; letter-spacing: -0.01em; }
.tile .sub { margin: 6rpx 18rpx 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.more { margin-top: 28rpx; }

.hero { width: 100%; height: 360rpx; border-radius: 18rpx; margin-top: 12rpx; background: var(--surface-2); }
.inst { display: flex; align-items: flex-start; padding: 24rpx 0; }
.radio { width: 34rpx; height: 34rpx; border-radius: 50%; border: 3rpx solid var(--ink-3);
  margin: 4rpx 22rpx 0 0; flex-shrink: 0; box-sizing: border-box; }
.radio.on { border: 10rpx solid var(--accent); }
.badges { display: flex; flex-wrap: wrap; align-items: center; gap: 10rpx; margin-top: 12rpx; }
.badge { font-size: 20rpx; color: var(--ink-2); background: var(--surface-2); border-radius: 8rpx; padding: 4rpx 12rpx; }
.badge.good { color: var(--good); }
.swatch { width: 24rpx; height: 24rpx; border-radius: 50%; box-shadow: 0 0 0 1rpx var(--swatch-ring); }
</style>
