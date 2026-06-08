<template>
  <div class="data-source-header">
    <div class="data-source-icon">
      <n-icon><component :is="icon" /></n-icon>
    </div>
    <div class="data-source-heading">
      <span class="data-source-eyebrow">{{ eyebrow }}</span>
      <h3 class="data-source-title">{{ title }}</h3>
      <p class="data-source-desc">{{ description }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { NIcon } from 'naive-ui'

// 6 张数据源卡统一卡头（瘦身 SyncView）。class 名/结构与 SyncView 原卡头逐字对齐。
// 样式自带 scoped：Vue 3 scoped 只给子组件根元素加父 scopeId，嵌套元素拿不到
// SyncView 的 scopeId，必须本组件自带这几条规则（与 SyncView.styles.css 同源，无视觉差异）。
defineProps<{
  eyebrow: string
  title: string
  description: string
  icon: Component
}>()
</script>

<style scoped>
/* 以下 6 条卡头规则逐字复刻自 SyncView.styles.css（.data-source-header 等），
   保证根元素与所有嵌套元素在本组件 scopeId 下均有样式来源。
   引用的 css 变量（--color-primary / --color-text / --color-text-secondary）均为
   styles/tokens/colors.css 的 :root 全局变量，scoped 上下文可正常解析。 */
.data-source-header {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.data-source-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, transparent);
  border-radius: 12px;
  font-size: 20px;
}

.data-source-heading {
  min-width: 0;
}

.data-source-eyebrow {
  display: block;
  margin-bottom: 5px;
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 1;
  text-transform: uppercase;
}

.data-source-title {
  margin: 0;
  color: var(--color-text);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.data-source-desc {
  margin: 7px 0 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.55;
}
</style>
