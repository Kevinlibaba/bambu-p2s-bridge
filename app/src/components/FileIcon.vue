<script setup lang="ts">
/*
 * 文件类型图标。
 *
 * 全部用 CSS 画，不用 Unicode 字符 —— 这个项目在全屏按钮上已经踩过一次：
 * ⛶ / ⤢ 这类字形在不同系统上缺字或粗细不一，同一个界面在两台设备上长得不一样。
 *
 * 形状承载类型，颜色只做分层：目录是唯一可进入的，给主色；
 * 其余按大类分色，但都用「淡底 + 同色图形」的组合，读起来是分类而不是警示。
 */
defineProps<{ kind: 'dir' | 'model' | 'video' | 'image' | 'other' }>()
</script>

<template>
  <view class="ic" :class="kind">
    <!-- 目录：主体 + 左上角的小页签 -->
    <view v-if="kind === 'dir'" class="folder" />

    <!-- 模型：逐层收窄的三条横杠，和应用图标同一套语汇 -->
    <view v-else-if="kind === 'model'" class="stack">
      <view class="bar b1" />
      <view class="bar b2" />
      <view class="bar b3" />
    </view>

    <!-- 视频：播放三角，用边框画，任何字体环境下都一致 -->
    <view v-else-if="kind === 'video'" class="play" />

    <!-- 图片：相框 + 日头 + 远山，三者齐了才读得出是照片 -->
    <view v-else-if="kind === 'image'" class="photo" />

    <!-- 其他：文稿，两条横线示意正文 -->
    <view v-else class="doc"><view class="ln l1" /><view class="ln l2" /></view>
  </view>
</template>

<style scoped>
.ic {
  width: 56rpx; height: 56rpx; border-radius: 16rpx; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
/* 淡底取自同一个色相，深浅主题下都不刺眼 */
.ic.dir { background: var(--accent-dim); }
.ic.model { background: rgba(48, 209, 88, 0.16); }
.ic.video { background: rgba(255, 159, 10, 0.18); }
.ic.image,
.ic.other { background: var(--surface-2); }

/* —— 目录 —— */
.folder {
  position: relative; width: 30rpx; height: 22rpx;
  border-radius: 4rpx 6rpx 6rpx 6rpx; background: var(--accent);
}
.folder::before {
  content: ''; position: absolute; left: 0; top: -6rpx;
  width: 13rpx; height: 6rpx; border-radius: 3rpx 3rpx 0 0; background: var(--accent);
}

/* —— 模型 —— */
.stack { display: flex; flex-direction: column; align-items: center; gap: 4rpx; }
.bar { height: 5rpx; border-radius: 3rpx; background: var(--good); }
.b1 { width: 14rpx; }
.b2 { width: 22rpx; }
.b3 { width: 30rpx; }

/* —— 视频 —— */
.play {
  width: 0; height: 0; margin-left: 4rpx;
  border-top: 10rpx solid transparent;
  border-bottom: 10rpx solid transparent;
  border-left: 17rpx solid var(--warning);
}

/* —— 图片 —— */
.photo {
  position: relative; width: 32rpx; height: 26rpx; box-sizing: border-box;
  border: 3rpx solid var(--ink-2); border-radius: 7rpx;
  /* 山形要被相框裁住，否则会戳出边界，看着像个箭头 */
  overflow: hidden;
}
/* 日头 */
.photo::before {
  content: ''; position: absolute; left: 3rpx; top: 3rpx;
  width: 8rpx; height: 8rpx; border-radius: 50%; background: var(--ink-2);
}
/* 远山：直角三角形贴着右下角 */
.photo::after {
  content: ''; position: absolute; right: -3rpx; bottom: -3rpx; width: 0; height: 0;
  border-left: 15rpx solid transparent; border-bottom: 13rpx solid var(--ink-2);
}

/* —— 其他 —— */
.doc {
  width: 24rpx; height: 30rpx; box-sizing: border-box;
  border: 3rpx solid var(--ink-3); border-radius: 5rpx;
  display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4rpx;
}
.ln { height: 3rpx; border-radius: 2rpx; background: var(--ink-3); }
.l1 { width: 12rpx; }
.l2 { width: 8rpx; }
</style>
