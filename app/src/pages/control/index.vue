<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, isConfigured, type Command } from '../../api/client'
import { printer } from '../../store/printer'

const s = computed(() => printer.summary)
const nozzle = ref(0)
const bed = ref(0)
let touched = false

watch(s, (v) => {
  if (!touched && v) { nozzle.value = Math.round(v.nozzle.target); bed.value = Math.round(v.bed.target) }
}, { immediate: true })

const SPEEDS = [
  { level: 1 as const, name: '静音', pct: '50%' },
  { level: 2 as const, name: '标准', pct: '100%' },
  { level: 3 as const, name: '运动', pct: '124%' },
  { level: 4 as const, name: '狂暴', pct: '166%' },
]
const lightOn = computed(() => s.value?.lights?.find((l) => l.node === 'chamber_light')?.mode === 'on')

async function send(c: Command, confirmText?: string) {
  if (confirmText) {
    const ok = await new Promise<boolean>((r) =>
      uni.showModal({ title: '确认操作', content: confirmText, confirmColor: '#2997ff',
        success: (m) => r(!!m.confirm), fail: () => r(false) }))
    if (!ok) return
  }
  try { await api.command(c); uni.showToast({ title: '已发送', icon: 'none' }) }
  catch (e) { uni.showToast({ title: (e as Error).message, icon: 'none', duration: 2500 }) }
}

const step = (which: 'n' | 'b', d: number) => {
  touched = true
  if (which === 'n') nozzle.value = Math.max(0, Math.min(300, nozzle.value + d))
  else bed.value = Math.max(0, Math.min(110, bed.value + d))
}
</script>

<template>
  <view class="root">
    <view v-if="!isConfigured()" class="empty"><text class="empty-s">请先在设置中配置服务器。</text></view>

    <view v-else class="body">
      <text class="grouphead">温度</text>
      <view class="card">
        <view class="line">
          <view class="line-l">
            <text class="line-t">喷嘴</text>
            <text class="line-s">当前 {{ Math.round(s?.nozzle.cur ?? 0) }}℃ · 最高 300℃</text>
          </view>
          <view class="stepper">
            <text class="sbtn" @click="step('n', -5)">−</text>
            <text class="sval">{{ nozzle }}℃</text>
            <text class="sbtn" @click="step('n', 5)">＋</text>
          </view>
        </view>
        <view class="hsep" />
        <view class="line">
          <text class="link" @click="send({ type: 'nozzleTemp', celsius: 0 }, '确定关闭喷嘴加热？')">关闭加热</text>
          <text class="link strong" @click="send({ type: 'nozzleTemp', celsius: nozzle }, `将喷嘴设为 ${nozzle}℃？`)">应用</text>
        </view>
      </view>

      <view class="card mt">
        <view class="line">
          <view class="line-l">
            <text class="line-t">热床</text>
            <text class="line-s">当前 {{ Math.round(s?.bed.cur ?? 0) }}℃ · 最高 110℃</text>
          </view>
          <view class="stepper">
            <text class="sbtn" @click="step('b', -5)">−</text>
            <text class="sval">{{ bed }}℃</text>
            <text class="sbtn" @click="step('b', 5)">＋</text>
          </view>
        </view>
        <view class="hsep" />
        <view class="line">
          <text class="link" @click="send({ type: 'bedTemp', celsius: 0 }, '确定关闭热床加热？')">关闭加热</text>
          <text class="link strong" @click="send({ type: 'bedTemp', celsius: bed }, `将热床设为 ${bed}℃？`)">应用</text>
        </view>
      </view>

      <text class="grouphead">速度 · 当前 {{ s?.speedPct ?? 100 }}%</text>
      <view class="segs">
        <view v-for="sp in SPEEDS" :key="sp.level" class="seg" :class="{ on: s?.speedLevel === sp.level }"
          @click="send({ type: 'speed', level: sp.level }, `切换到「${sp.name}」？`)">
          <text class="seg-n">{{ sp.name }}</text>
          <text class="seg-p">{{ sp.pct }}</text>
        </view>
      </view>

      <text class="grouphead">其他</text>
      <view class="card">
        <view class="line tappable" @click="send({ type: 'light', on: !lightOn })">
          <text class="line-t">腔内灯</text>
          <text class="line-v">{{ lightOn ? '开' : '关' }}</text>
        </view>
        <view class="hsep" />
        <view class="line tappable" @click="send({ type: 'pushall' })">
          <text class="line-t">刷新状态</text>
          <text class="line-v">›</text>
        </view>
        <view class="hsep" />
        <view class="line tappable"
          @click="send({ type: 'home' }, '归零会移动打印头。打印中执行将毁掉当前打印件。确定继续？')">
          <text class="line-t danger">回原点 G28</text>
          <text class="line-v">›</text>
        </view>
      </view>

      <text class="note">原始 G-code 通道默认关闭。需要时在服务端设置 ALLOW_RAW_GCODE=true。</text>
    </view>
  </view>
</template>

<style scoped>
.root { background: var(--bg); min-height: 100vh; }
.body { padding: 36rpx 36rpx 140rpx; }
.empty { padding: 200rpx 60rpx; text-align: center; }
.empty-s { font-size: 28rpx; color: var(--ink-2); letter-spacing: -0.01em; }

.grouphead { display: block; font-size: 24rpx; color: var(--ink-2);
  margin: 44rpx 0 16rpx 8rpx; letter-spacing: 0.01em; }
.grouphead:first-child { margin-top: 8rpx; }

.card { background: var(--surface); border-radius: 28rpx; padding: 0 34rpx; }
.mt { margin-top: 20rpx; }
.hsep { height: 1rpx; background: var(--separator); }

.line { display: flex; align-items: center; justify-content: space-between; min-height: 108rpx; }
.line-l { flex: 1; }
.line-t { font-size: 30rpx; color: var(--ink); letter-spacing: -0.02em; }
.line-t.danger { color: var(--critical); }
.line-s { display: block; font-size: 24rpx; color: var(--ink-2); margin-top: 6rpx; letter-spacing: -0.01em; }
.line-v { font-size: 30rpx; color: var(--ink-2); letter-spacing: -0.02em; }
.tappable:active { opacity: 0.55; }

.stepper { display: flex; align-items: center; background: var(--surface-2); border-radius: 999rpx; }
.sbtn { width: 74rpx; height: 66rpx; line-height: 66rpx; text-align: center;
  font-size: 32rpx; color: var(--accent); }
.sval { min-width: 118rpx; text-align: center; font-size: 30rpx; color: var(--ink);
  font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

.link { font-size: 30rpx; color: var(--accent); letter-spacing: -0.02em; }
.link.strong { font-weight: 600; }
.link:active { opacity: 0.55; }

.segs { display: flex; background: var(--surface); border-radius: 24rpx; padding: 8rpx; }
.seg { flex: 1; padding: 20rpx 0; text-align: center; border-radius: 18rpx;
  transition: background 0.25s ease; }
.seg.on { background: var(--surface-2); }
.seg-n { display: block; font-size: 28rpx; color: var(--ink); letter-spacing: -0.02em; }
.seg.on .seg-n { font-weight: 600; }
.seg-p { display: block; font-size: 22rpx; color: var(--ink-2); margin-top: 4rpx; }

.note { display: block; font-size: 22rpx; color: var(--ink-3);
  margin-top: 32rpx; padding: 0 8rpx; line-height: 1.6; letter-spacing: -0.01em; }
</style>
