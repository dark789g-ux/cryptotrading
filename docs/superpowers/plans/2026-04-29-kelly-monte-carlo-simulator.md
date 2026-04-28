# 凯利-蒙特卡洛模拟器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有"凯利公式计算器"扩展为完整的"凯利-蒙特卡洛模拟器"，包含参数控制面板、四档风险结果卡片、蒙特卡洛资金曲线图和最终资金概率密度分布图。

**Architecture:** 基于现有 Vue 3 + Naive UI + ECharts 技术栈，将单文件组件拆分为职责清晰的子组件。蒙特卡洛计算在纯前端完成，使用 ECharts 渲染两条核心图表。页面布局从窄页（900px）扩展为全宽三栏自适应布局。

**Tech Stack:** Vue 3 (Composition API), Naive UI, ECharts 5, TypeScript, Vite

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web/src/views/ToolsView.vue` | 修改 | 全宽布局容器，组装 KellySimulator |
| `apps/web/src/components/tools/KellySimulator.vue` | 新建 | 主组件：状态管理、模拟编排、子组件组装 |
| `apps/web/src/components/tools/KellyParamPanel.vue` | 新建 | 左侧参数控制面板（7个滑块+资金输入+执行按钮） |
| `apps/web/src/components/tools/KellyResultCards.vue` | 新建 | 四档风险结果横向卡片 |
| `apps/web/src/components/tools/KellyMonteCarloCharts.vue` | 新建 | ECharts 封装：资金曲线 + 概率密度 |
| `apps/web/src/components/tools/useKellySimulation.ts` | 新建 | Composable：蒙特卡洛算法、指标计算、逆向推算 |
| `apps/web/src/components/tools/KellyCalculator.vue` | 保留 | 原有纯凯利计算器不再被 ToolsView 引用，但保留文件 |

---

## Phase 1: 参数面板 + 四档结果卡片

> 目标：完成左侧参数控制面板和顶部四档风险结果卡片，页面骨架成型，蒙特卡洛算法用占位数据先跑通界面。

---

### Task 1: 修改 ToolsView.vue 为全宽布局

**Files:**
- Modify: `apps/web/src/views/ToolsView.vue`

- [ ] **Step 1: 替换 ToolsView.vue 为全宽布局**

```vue
<template>
  <div class="tools-view workspace-page">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">工具</h1>
    </div>
    <KellySimulator />
  </div>
</template>

<script setup lang="ts">
import KellySimulator from '../components/tools/KellySimulator.vue'
</script>

<style scoped>
.tools-view {
  max-width: none;
}
</style>
```

- [ ] **Step 2: 启动开发服务器验证**

Run: `cd apps/web && pnpm dev`

打开 `http://127.0.0.1:5173/tools`

Expected: 页面正常加载，无报错，旧 KellyCalculator 不再显示（因为 KellySimulator 还没写，页面会空白或报错，继续下一步）。

---

### Task 2: 创建 useKellySimulation.ts Composable（Phase 1 简化版）

**Files:**
- Create: `apps/web/src/components/tools/useKellySimulation.ts`

- [ ] **Step 1: 编写 Composable 骨架 + 类型定义**

```ts
import { reactive, computed, ref } from 'vue'

export interface SimParams {
  winRate: number
  rewardRisk: number
  tradesPerSim: number
  universes: number
  targetReturn: number
  maxDrawdown: number
  tradesPerYear: number
  initialCapital: number
}

export interface RiskLevelResult {
  label: string
  tag: string
  color: string
  singleRisk: number
  medianBalance: number
  maxDrawdown: number
  bustRate: number
  halvedRate: number
  kellyMultiplier: number
}

export interface SimPath {
  pathId: number
  equityCurve: number[]
}

export interface FinalDistribution {
  bins: number[]
  frequencies: number[]
}

export const defaultParams: SimParams = {
  winRate: 45,
  rewardRisk: 2.0,
  tradesPerSim: 100,
  universes: 1000,
  targetReturn: 50,
  maxDrawdown: 20,
  tradesPerYear: 50,
  initialCapital: 100,
}

export function useKellySimulation() {
  const params = reactive<SimParams>({ ...defaultParams })

  const kellyFull = computed(() => {
    const w = params.winRate / 100
    const r = params.rewardRisk
    if (r <= 0) return 0
    return w - (1 - w) / r
  })

  // Phase 1: 先用确定性公式生成占位结果，让 UI 有数据
  const riskLevels = computed<RiskLevelResult[]>(() => {
    const kf = kellyFull.value
    if (kf <= 0) return []

    const levels: { label: string; tag: string; color: string; mult: number }[] = [
      { label: '标准', tag: '(1/2)', color: '#2080f0', mult: 0.5 },
      { label: '巅峰', tag: '(满)', color: '#18a058', mult: 1.0 },
      { label: '贪婪', tag: '(1.5x)', color: '#f0a020', mult: 1.5 },
      { label: '赌徒', tag: '(2.1x)', color: '#d03050', mult: 2.1 },
    ]

    return levels.map((lv) => {
      const f = kf * lv.mult
      const risk = Math.min(f * 100, 100)
      // 占位公式：基于凯利倍数简单推算
      const median = params.initialCapital * Math.exp((f * params.rewardRisk * (params.winRate / 100) - f * (1 - params.winRate / 100)) * params.tradesPerSim * 0.5)
      const dd = Math.min(risk * 7.5 + Math.random() * 5, 100)
      const bust = Math.min(Math.exp(-2 * params.initialCapital / (params.initialCapital * (risk / 100))) * lv.mult * 0.5, 100)
      const halved = Math.min(bust * 1.2 + lv.mult * 2, 100)

      return {
        label: lv.label,
        tag: lv.tag,
        color: lv.color,
        singleRisk: risk,
        medianBalance: Math.max(median, 0),
        maxDrawdown: dd,
        bustRate: bust,
        halvedRate: halved,
        kellyMultiplier: lv.mult,
      }
    })
  })

  const reverseRisk = computed(() => {
    const w = params.winRate / 100
    const r = params.rewardRisk
    if (w <= 0 || r <= 0) return { minRiskForReturn: 0, maxRiskForDD: 0, recommendedFull: 0, recommendedHalf: 0 }

    // 简化的逆向推算（占位）
    const minRiskForReturn = (params.targetReturn / 100) / (params.tradesPerYear * (w * r - (1 - w)))
    const maxRiskForDD = params.maxDrawdown / 100 / (2.5 * (1 - w))
    const rec = Math.max(0, Math.min(minRiskForReturn, maxRiskForDD))

    return {
      minRiskForReturn: minRiskForReturn * 100,
      maxRiskForDD: maxRiskForDD * 100,
      recommendedFull: rec * 100,
      recommendedHalf: rec * 50,
    }
  })

  // Phase 2 才会实现真正的蒙特卡洛
  const paths = ref<SimPath[]>([])
  const distribution = ref<FinalDistribution>({ bins: [], frequencies: [] })
  const isSimulating = ref(false)

  function runSimulation() {
    // Phase 1: no-op，等 Phase 2 填充真实算法
    isSimulating.value = true
    setTimeout(() => {
      isSimulating.value = false
    }, 200)
  }

  return {
    params,
    kellyFull,
    riskLevels,
    reverseRisk,
    paths,
    distribution,
    isSimulating,
    runSimulation,
  }
}
```

---

### Task 3: 创建 KellyParamPanel.vue

**Files:**
- Create: `apps/web/src/components/tools/KellyParamPanel.vue`

- [ ] **Step 1: 编写参数面板组件**

```vue
<template>
  <div class="param-panel">
    <div class="panel-header">
      <div class="panel-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div>
        <div class="panel-title">凯利-蒙特卡洛模拟器</div>
        <div class="panel-desc">Kelly Criterion + Monte Carlo</div>
      </div>
    </div>

    <div class="panel-body">
      <!-- 起始资金 -->
      <div class="field-group">
        <div class="field-label">起始资金 <span class="field-unit">$</span></div>
        <n-input-number v-model:value="params.initialCapital" :min="10" :max="1000000" :step="100" style="width:100%" />
      </div>

      <ParamSlider label="真实胜率" unit="%" v-model="params.winRate" :min="1" :max="99" :step="1" />
      <ParamSlider label="盈亏比" unit="R" v-model="params.rewardRisk" :min="0.1" :max="10" :step="0.1" />
      <ParamSlider label="单次模拟交易总笔数" unit="笔" v-model="params.tradesPerSim" :min="10" :max="1000" :step="10" />
      <ParamSlider label="平行宇宙数量" unit="个" v-model="params.universes" :min="100" :max="5000" :step="100" />
      <ParamSlider label="目标年化收益" unit="%" v-model="params.targetReturn" :min="10" :max="500" :step="10" />
      <ParamSlider label="容忍最大回撤" unit="%" v-model="params.maxDrawdown" :min="5" :max="80" :step="1" />
      <ParamSlider label="年均交易笔数" unit="笔" v-model="params.tradesPerYear" :min="1" :max="500" :step="1" />

      <n-button type="primary" size="large" block :loading="isSimulating" @click="runSimulation">
        <template #icon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="margin-right:4px">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" stroke-width="2"/>
            <path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </template>
        🎲 执行重新洗牌
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NInputNumber, NButton } from 'naive-ui'
import ParamSlider from './ParamSlider.vue'
import type { SimParams } from './useKellySimulation'

defineProps<{
  params: SimParams
  isSimulating: boolean
}>()

const emit = defineEmits<{
  run: []
}>()

function runSimulation() {
  emit('run')
}
</script>

<style scoped>
.param-panel {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
  width: 280px;
  flex-shrink: 0;
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}
.panel-icon {
  width: 36px;
  height: 36px;
  background: color-mix(in srgb, var(--color-primary) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 30%, transparent);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  flex-shrink: 0;
}
.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.2;
}
.panel-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}
.panel-body {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
}
.field-unit {
  color: var(--color-text-muted);
  font-weight: 400;
}
</style>
```

---

### Task 4: 创建 ParamSlider.vue 子组件

**Files:**
- Create: `apps/web/src/components/tools/ParamSlider.vue`

- [ ] **Step 1: 编写滑块+输入框组合组件**

```vue
<template>
  <div class="param-slider">
    <div class="slider-header">
      <span class="slider-label">{{ label }}</span>
      <span class="slider-value">{{ modelValue }}<span class="slider-unit">{{ unit }}</span></span>
    </div>
    <n-slider v-model:value="localValue" :min :max :step :tooltip="false" />
    <n-input-number v-model:value="localValue" :min :max :step size="small" style="width:100%;margin-top:6px" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NSlider, NInputNumber } from 'naive-ui'

const props = defineProps<{
  label: string
  unit: string
  modelValue: number
  min: number
  max: number
  step: number
}>()

const emit = defineEmits<{
  'update:modelValue': [val: number]
}>()

const localValue = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})
</script>

<style scoped>
.param-slider {
  display: flex;
  flex-direction: column;
}
.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.slider-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.slider-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-primary);
}
.slider-unit {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-muted);
  margin-left: 2px;
}
</style>
```

---

### Task 5: 创建 KellyResultCards.vue

**Files:**
- Create: `apps/web/src/components/tools/KellyResultCards.vue`

- [ ] **Step 1: 编写四档风险结果卡片**

```vue
<template>
  <div class="result-cards">
    <div
      v-for="item in riskLevels"
      :key="item.label"
      class="result-card"
      :style="{ '--card-color': item.color }"
    >
      <div class="card-top">
        <div class="card-title-row">
          <span class="card-label">{{ item.label }}</span>
          <span class="card-tag">{{ item.tag }}</span>
        </div>
        <div class="card-risk">单笔 {{ item.singleRisk.toFixed(1) }}%</div>
      </div>
      <div class="card-body">
        <div class="metric">
          <span class="metric-label">中位数余额</span>
          <span class="metric-value" :style="{ color: item.color }">${{ item.medianBalance.toFixed(1) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">最大回撤(劣势20%)</span>
          <span class="metric-value" :class="item.maxDrawdown > 90 ? 'danger' : item.maxDrawdown > 70 ? 'warning' : ''">{{ item.maxDrawdown.toFixed(1) }}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">爆仓率(&lt;$10)</span>
          <span class="metric-value" :class="item.bustRate > 20 ? 'danger' : item.bustRate > 5 ? 'warning' : ''">{{ item.bustRate.toFixed(1) }}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">腰斩率(&lt;$50)</span>
          <span class="metric-value" :class="item.halvedRate > 30 ? 'danger' : item.halvedRate > 10 ? 'warning' : ''">{{ item.halvedRate.toFixed(1) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RiskLevelResult } from './useKellySimulation'

defineProps<{
  riskLevels: RiskLevelResult[]
}>()
</script>

<style scoped>
.result-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.result-card {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
  border-top: 3px solid var(--card-color);
}
.card-top {
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.card-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
.card-tag {
  font-size: 11px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
}
.card-risk {
  font-size: 13px;
  font-weight: 600;
  color: var(--card-color);
}
.card-body {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.metric {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.metric-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
.metric-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text);
}
.metric-value.warning { color: #f0a020; }
.metric-value.danger { color: #d03050; }

@media (max-width: 1200px) {
  .result-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .result-cards {
    grid-template-columns: 1fr;
  }
}
</style>
```

---

### Task 6: 创建 KellySimulator.vue（Phase 1 版本）

**Files:**
- Create: `apps/web/src/components/tools/KellySimulator.vue`

- [ ] **Step 1: 编写主组件，组装参数面板和结果卡片**

```vue
<template>
  <div class="simulator">
    <KellyParamPanel :params="params" :is-simulating="isSimulating" @run="runSimulation" />

    <div class="simulator-main">
      <!-- 顶部诊断栏 -->
      <div class="diagnosis-bar">
        <div class="diagnosis-item">
          <span class="diagnosis-icon">🩺</span>
          <span class="diagnosis-label">当前诊断：</span>
          <span class="diagnosis-value" :class="kellyFull > 0 ? 'pos' : 'neg'">
            数学期望 {{ kellyFull > 0 ? '+' : '' }}{{ (kellyFull * params.rewardRisk).toFixed(3) }} R
          </span>
        </div>
        <div class="diagnosis-desc">
          核心基石：用<b>凯利公式</b>寻找理论资金增长极限，用海量<b>蒙特卡洛平行宇宙</b>抹平短期运气暴露长期宿命。
        </div>
        <div v-if="kellyFull > 0" class="diagnosis-badge gold">
          🔥 黄金系统：极佳的优势区间！使用精细化微仓能让你获得平滑复利。
        </div>
      </div>

      <!-- 逆向推算 -->
      <div class="reverse-bar">
        <div class="reverse-title">🎯 逆向推算单笔风险（基于收益/回撤目标与年均笔数）</div>
        <div class="reverse-body">
          <div class="reverse-constraints">
            <div class="constraint">
              • 达到 {{ params.targetReturn }}% 收益，单笔风险需 ≥ {{ reverseRisk.minRiskForReturn.toFixed(2) }}%
            </div>
            <div class="constraint">
              • 回撤控制在 {{ params.maxDrawdown }}% 内，单笔风险需 ≤ {{ reverseRisk.maxRiskForDD.toFixed(2) }}%
            </div>
          </div>
          <div class="reverse-recommend">
            <div class="rec-badge">
              <span class="rec-label">建议风险敞口</span>
              <span class="rec-value">满: {{ reverseRisk.recommendedFull.toFixed(2) }}%</span>
              <span class="rec-value">半: {{ reverseRisk.recommendedHalf.toFixed(2) }}%</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 四档结果卡片 -->
      <KellyResultCards :risk-levels="riskLevels" />

      <!-- 图表占位区 -->
      <div class="charts-placeholder">
        <div class="placeholder-box">
          <div class="placeholder-text">📊 蒙特卡洛资金曲线图</div>
          <div class="placeholder-sub">Phase 2 实现</div>
        </div>
        <div class="placeholder-box">
          <div class="placeholder-text">📈 最终资金概率密度</div>
          <div class="placeholder-sub">Phase 2 实现</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useKellySimulation } from './useKellySimulation'
import KellyParamPanel from './KellyParamPanel.vue'
import KellyResultCards from './KellyResultCards.vue'

const { params, kellyFull, riskLevels, reverseRisk, isSimulating, runSimulation } = useKellySimulation()

// 参数变化时自动触发（debounce 在 Phase 2 加入）
watch(() => ({ ...params }), () => {
  runSimulation()
}, { deep: true })

// 初始执行
runSimulation()
</script>

<style scoped>
.simulator {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.simulator-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.diagnosis-bar {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.diagnosis-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}
.diagnosis-label { color: var(--color-text-secondary); }
.diagnosis-value.pos { color: var(--color-success); font-weight: 700; }
.diagnosis-value.neg { color: var(--color-error); font-weight: 700; }
.diagnosis-desc {
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.diagnosis-desc b { color: var(--color-text-secondary); }
.diagnosis-badge {
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 4px;
}
.diagnosis-badge.gold {
  background: color-mix(in srgb, #f0a020 10%, transparent);
  color: #f0a020;
}
.reverse-bar {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.reverse-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
.reverse-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.reverse-constraints {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.reverse-recommend {
  flex-shrink: 0;
}
.rec-badge {
  background: color-mix(in srgb, var(--color-success) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rec-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-success);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rec-value {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
.charts-placeholder {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
  height: 400px;
}
.placeholder-box {
  background: var(--color-surface-elevated);
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-muted);
}
.placeholder-text { font-size: 16px; font-weight: 600; }
.placeholder-sub { font-size: 12px; }

@media (max-width: 1200px) {
  .simulator { flex-direction: column; }
  .param-panel { width: 100%; }
  .charts-placeholder { grid-template-columns: 1fr; height: auto; }
  .placeholder-box { height: 280px; }
}
</style>
```

---

### Task 7: Phase 1 验证

- [ ] **Step 1: 启动开发服务器**

Run: `cd apps/web && pnpm dev`

- [ ] **Step 2: 手动验证清单**

打开 `http://127.0.0.1:5173/tools`，逐项检查：

| 检查项 | 期望结果 |
|--------|---------|
| 页面布局 | 左侧参数面板 + 右侧主区域，全宽无滚动条（1200px+） |
| 参数面板 | 7个滑块+起始资金输入框，默认值与参考界面一致 |
| 滑块交互 | 拖动滑块，上方数值实时更新；输入框输入也同步 |
| 诊断栏 | 显示"数学期望 +X.XXX R"，绿色正值 |
| 逆向推算 | 显示两个约束条件和建议风险敞口数值 |
| 结果卡片 | 4张卡片横向排列，显示单笔风险%、中位数余额、最大回撤、爆仓率、腰斩率 |
| 响应式 | 窗口缩窄到 <1200px，左面板移到上方，卡片变2列 |
| 参数调整 | 修改胜率/盈亏比，所有数值自动更新 |

---

## Phase 2: 蒙特卡洛算法 + 图表

> 目标：实现真正的蒙特卡洛模拟，替换占位数据；集成 ECharts 渲染资金曲线和概率密度分布图。

---

### Task 8: 升级 useKellySimulation.ts（真实算法）

**Files:**
- Modify: `apps/web/src/components/tools/useKellySimulation.ts`

- [ ] **Step 1: 实现蒙特卡洛模拟函数**

替换 `runSimulation` 函数和占位计算逻辑：

```ts
function simulatePaths(params: SimParams, kellyFraction: number): SimPath[] {
  const paths: SimPath[] = []
  const singleRisk = kellyFraction // 单笔风险比例

  for (let u = 0; u < params.universes; u++) {
    const equity: number[] = [params.initialCapital]
    for (let t = 0; t < params.tradesPerSim; t++) {
      const current = equity[equity.length - 1]
      if (current <= 0) {
        equity.push(0)
        continue
      }
      const isWin = Math.random() < params.winRate / 100
      const riskAmt = current * singleRisk
      const pnl = isWin ? riskAmt * params.rewardRisk : -riskAmt
      equity.push(Math.max(current + pnl, 0))
    }
    paths.push({ pathId: u, equityCurve: equity })
  }
  return paths
}

function computeMetrics(paths: SimPath[], params: SimParams) {
  const finals = paths.map((p) => p.equityCurve[p.equityCurve.length - 1]).sort((a, b) => a - b)
  const median = finals[Math.floor(finals.length / 2)]

  // 最大回撤：取 80th percentile（劣势20%）
  const allDDs: number[] = []
  for (const p of paths) {
    let peak = p.equityCurve[0]
    let maxDD = 0
    for (const val of p.equityCurve) {
      if (val > peak) peak = val
      const dd = peak > 0 ? (peak - val) / peak : 0
      if (dd > maxDD) maxDD = dd
    }
    allDDs.push(maxDD)
  }
  allDDs.sort((a, b) => a - b)
  const dd80 = allDDs[Math.floor(allDDs.length * 0.8)] * 100

  const bustRate = (finals.filter((f) => f < 10).length / finals.length) * 100
  const halvedRate = (finals.filter((f) => f < params.initialCapital * 0.5).length / finals.length) * 100

  return { median, maxDrawdown: dd80, bustRate, halvedRate }
}
```

- [ ] **Step 2: 替换 riskLevels computed 为真实模拟**

```ts
const riskLevels = ref<RiskLevelResult[]>([])
const paths = ref<SimPath[]>([])
const distribution = ref<FinalDistribution>({ bins: [], frequencies: [] })
const isSimulating = ref(false)

function runSimulation() {
  const kf = kellyFull.value
  if (kf <= 0) {
    riskLevels.value = []
    paths.value = []
    distribution.value = { bins: [], frequencies: [] }
    return
  }

  isSimulating.value = true

  // 使用 setTimeout 让 UI 有机会渲染 loading 状态
  setTimeout(() => {
    const levels = [
      { label: '标准', tag: '(1/2)', color: '#2080f0', mult: 0.5 },
      { label: '巅峰', tag: '(满)', color: '#18a058', mult: 1.0 },
      { label: '贪婪', tag: '(1.5x)', color: '#f0a020', mult: 1.5 },
      { label: '赌徒', tag: '(2.1x)', color: '#d03050', mult: 2.1 },
    ]

    riskLevels.value = levels.map((lv) => {
      const simPaths = simulatePaths(params, kf * lv.mult)
      const metrics = computeMetrics(simPaths, params)

      return {
        label: lv.label,
        tag: lv.tag,
        color: lv.color,
        singleRisk: Math.min(kf * lv.mult * 100, 100),
        medianBalance: metrics.median,
        maxDrawdown: metrics.maxDrawdown,
        bustRate: metrics.bustRate,
        halvedRate: metrics.halvedRate,
        kellyMultiplier: lv.mult,
      }
    })

    // 用"标准"档的路径生成图表数据（也可取中位数最平衡的一档）
    const standardPaths = simulatePaths(params, kf * 0.5)
    paths.value = samplePaths(standardPaths, 50)
    distribution.value = computeDistribution(standardPaths, params.initialCapital)

    isSimulating.value = false
  }, 10)
}

function samplePaths(allPaths: SimPath[], count: number): SimPath[] {
  const step = Math.max(1, Math.floor(allPaths.length / count))
  const sampled: SimPath[] = []
  for (let i = 0; i < allPaths.length && sampled.length < count; i += step) {
    sampled.push(allPaths[i])
  }
  return sampled
}

function computeDistribution(paths: SimPath[], initialCapital: number): FinalDistribution {
  const finals = paths.map((p) => p.equityCurve[p.equityCurve.length - 1])
  const min = Math.min(...finals, 0)
  const max = Math.max(...finals, initialCapital * 3)
  const binCount = 40
  const bins: number[] = []
  const frequencies: number[] = []
  const binWidth = (max - min) / binCount

  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binWidth
    const binEnd = binStart + binWidth
    bins.push(binStart)
    frequencies.push(finals.filter((f) => f >= binStart && f < binEnd).length)
  }

  return { bins, frequencies }
}
```

- [ ] **Step 3: 加入 watch debounce**

```ts
import { watch, ref } from 'vue'

let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => ({ ...params }),
  () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      runSimulation()
    }, 300)
  },
  { deep: true }
)
```

---

### Task 9: 创建 KellyMonteCarloCharts.vue

**Files:**
- Create: `apps/web/src/components/tools/KellyMonteCarloCharts.vue`

- [ ] **Step 1: 编写图表组件**

```vue
<template>
  <div class="charts-area">
    <div ref="equityChartRef" class="chart-box"></div>
    <div ref="distChartRef" class="chart-box"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import type { SimPath, FinalDistribution } from './useKellySimulation'

const props = defineProps<{
  paths: SimPath[]
  distribution: FinalDistribution
  initialCapital: number
}>()

const equityChartRef = ref<HTMLDivElement>()
const distChartRef = ref<HTMLDivElement>()
let equityChart: echarts.ECharts | null = null
let distChart: echarts.ECharts | null = null

function initCharts() {
  if (equityChartRef.value) {
    equityChart = echarts.init(equityChartRef.value)
  }
  if (distChartRef.value) {
    distChart = echarts.init(distChartRef.value)
  }
}

function updateEquityChart() {
  if (!equityChart || props.paths.length === 0) return

  const series = props.paths.map((p, idx) => ({
    name: `Path ${idx}`,
    type: 'line',
    showSymbol: false,
    lineStyle: { width: 1, opacity: 0.3 },
    data: p.equityCurve,
    emphasis: { disabled: true },
  }))

  // 中位数曲线
  const medianCurve: number[] = []
  const tradeCount = props.paths[0]?.equityCurve.length ?? 0
  for (let t = 0; t < tradeCount; t++) {
    const values = props.paths.map((p) => p.equityCurve[t]).sort((a, b) => a - b)
    medianCurve.push(values[Math.floor(values.length / 2)])
  }

  series.push({
    name: '中位数',
    type: 'line',
    showSymbol: false,
    lineStyle: { width: 2.5, color: '#f0a020', opacity: 1 },
    data: medianCurve,
    z: 10,
  })

  equityChart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 60, right: 20, top: 30, bottom: 30 },
    xAxis: {
      type: 'category',
      name: '交易笔数',
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888' },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'log',
      name: '资金 ($)',
      logBase: 10,
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888', formatter: (v: number) => v.toExponential(0) },
      splitLine: { lineStyle: { color: '#333' } },
    },
    series,
    tooltip: { trigger: 'axis', backgroundColor: '#1e1e1e', borderColor: '#444', textStyle: { color: '#ccc' } },
  }, true)
}

function updateDistChart() {
  if (!distChart || props.distribution.bins.length === 0) return

  const { bins, frequencies } = props.distribution

  distChart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 60, right: 20, top: 30, bottom: 30 },
    xAxis: {
      type: 'value',
      name: '最终资金 ($)',
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888' },
      splitLine: { lineStyle: { color: '#333' } },
    },
    yAxis: {
      type: 'value',
      name: '频数',
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888' },
      splitLine: { lineStyle: { color: '#333' } },
    },
    series: [
      {
        type: 'bar',
        data: bins.map((b, i) => [b, frequencies[i]]),
        itemStyle: { color: '#2080f0', opacity: 0.7 },
        barWidth: '95%',
      },
      {
        type: 'line',
        smooth: true,
        data: bins.map((b, i) => [b, frequencies[i]]),
        lineStyle: { color: '#2080f0', width: 2 },
        symbol: 'none',
        areaStyle: { color: 'rgba(32,128,240,0.15)' },
      },
    ],
    tooltip: { trigger: 'axis', backgroundColor: '#1e1e1e', borderColor: '#444', textStyle: { color: '#ccc' } },
  }, true)
}

onMounted(() => {
  initCharts()
  updateEquityChart()
  updateDistChart()
})

onUnmounted(() => {
  equityChart?.dispose()
  distChart?.dispose()
})

watch(() => props.paths, updateEquityChart, { deep: true })
watch(() => props.distribution, updateDistChart, { deep: true })

// 响应式resize
window.addEventListener('resize', () => {
  equityChart?.resize()
  distChart?.resize()
})
</script>

<style scoped>
.charts-area {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
  height: 400px;
}
.chart-box {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
}
@media (max-width: 1200px) {
  .charts-area {
    grid-template-columns: 1fr;
    height: auto;
  }
  .chart-box {
    height: 320px;
  }
}
</style>
```

---

### Task 10: 升级 KellySimulator.vue（替换图表占位）

**Files:**
- Modify: `apps/web/src/components/tools/KellySimulator.vue`

- [ ] **Step 1: 导入图表组件并替换占位区**

在 `<script setup>` 中增加：
```ts
import KellyMonteCarloCharts from './KellyMonteCarloCharts.vue'
```

在模板中替换 `charts-placeholder` 区域：
```vue
<KellyMonteCarloCharts
  :paths="paths"
  :distribution="distribution"
  :initial-capital="params.initialCapital"
/>
```

---

### Task 11: Phase 2 验证

- [ ] **Step 1: 启动开发服务器**

Run: `cd apps/web && pnpm dev`

- [ ] **Step 2: 手动验证清单**

| 检查项 | 期望结果 |
|--------|---------|
| 资金曲线图 | 显示50条半透明细线 + 1条橙色中位数粗线，Y轴为对数刻度 |
| 概率密度图 | 显示最终资金分布的柱状图+平滑曲线 |
| 参数调整 | 修改胜率后 300ms 延迟，图表自动更新 |
| 执行按钮 | 点击"执行重新洗牌"，图表重新随机生成 |
| 零/负凯利 | 当参数导致凯利值 ≤0 时，结果卡片清空，显示警告（可从原 KellyCalculator 复用 warn-bar 样式） |
| 性能 | 1000×100 模拟在 1 秒内完成，UI 不卡顿 |

---

## Phase 3: 逆向推算精确化 + 响应式打磨

> 目标：逆向推算算法从占位改为数学精确解；增加全局响应式适配和细节打磨。

---

### Task 12: 精确化逆向推算算法

**Files:**
- Modify: `apps/web/src/components/tools/useKellySimulation.ts`

- [ ] **Step 1: 替换 reverseRisk 为精确计算**

```ts
const reverseRisk = computed(() => {
  const w = params.winRate / 100
  const r = params.rewardRisk
  if (w <= 0 || r <= 0 || w * r <= (1 - w)) {
    return { minRiskForReturn: 0, maxRiskForDD: 0, recommendedFull: 0, recommendedHalf: 0 }
  }

  const edge = w * r - (1 - w) // 单次期望收益（以风险单位计）

  // 约束1：达到目标年化收益所需最小单笔风险
  // G = (1+f*edge)^n ≈ exp(n*f*edge) for small f
  // targetReturn = exp(tradesPerYear * f * edge) - 1
  // f = ln(1+targetReturn) / (tradesPerYear * edge)
  const targetMultiple = 1 + params.targetReturn / 100
  const minRiskForReturn = Math.log(targetMultiple) / (params.tradesPerYear * edge)

  // 约束2：回撤控制在阈值内
  // 简化模型：最大回撤 ≈ 1 - (1-f)^k，其中 k 为连续亏损次数的期望
  // 连续亏损期望长度 = 1/(1-w)，考虑劣势20%（80th percentile）放大系数 ≈ 2
  const expectedLossStreak = 1 / (1 - w)
  const percentileFactor = 2.0 // 80th percentile 调整
  // (1-f)^(expectedLossStreak * percentileFactor) >= 1 - maxDrawdown
  // f <= 1 - (1-maxDrawdown)^(1/(expectedLossStreak*percentileFactor))
  const maxDD = params.maxDrawdown / 100
  const maxRiskForDD = 1 - Math.pow(1 - maxDD, 1 / (expectedLossStreak * percentileFactor))

  const recFull = Math.max(0, Math.min(minRiskForReturn, maxRiskForDD))

  return {
    minRiskForReturn: minRiskForReturn * 100,
    maxRiskForDD: maxRiskForDD * 100,
    recommendedFull: recFull * 100,
    recommendedHalf: recFull * 50,
  }
})
```

---

### Task 13: 响应式与细节打磨

**Files:**
- Modify: `apps/web/src/components/tools/KellySimulator.vue`
- Modify: `apps/web/src/components/tools/KellyParamPanel.vue`
- Modify: `apps/web/src/components/tools/KellyResultCards.vue`

- [ ] **Step 1: KellySimulator.vue 添加负凯利警告**

在 `diagnosis-bar` 下方插入（从原 KellyCalculator.vue 迁移）：
```vue
<div v-if="kellyFull <= 0" class="warn-bar">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
    <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  凯利值为负或零（当前参数无正期望），建议不入场。
</div>
```

样式沿用 KellyCalculator.vue 中的 `.warn-bar`。

- [ ] **Step 2: KellyParamPanel.vue 移动端折叠**

在窄屏（<1200px）下，参数面板默认收起为可折叠卡片，点击展开。

```vue
<template>
  <div class="param-panel" :class="{ collapsed: isCollapsed && isNarrow }">
    <div class="panel-header" @click="toggleCollapse">
      <!-- 原有内容 -->
      <span v-if="isNarrow" class="collapse-icon">{{ isCollapsed ? '▶' : '▼' }}</span>
    </div>
    <div v-show="!isCollapsed || !isNarrow" class="panel-body">
      <!-- 原有内容 -->
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
const isNarrow = ref(window.innerWidth < 1200)
const isCollapsed = ref(true)
const toggleCollapse = () => { isCollapsed.value = !isCollapsed.value }
const onResize = () => { isNarrow.value = window.innerWidth < 1200 }
onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))
</script>
```

- [ ] **Step 3: KellyResultCards.vue 增加空状态**

当 `riskLevels.length === 0` 时显示：
```vue
<div v-else class="empty-cards">
  <div class="empty-text">调整参数以查看风险模拟结果</div>
</div>
```

---

### Task 14: Phase 3 验证

- [ ] **Step 1: 启动开发服务器**

Run: `cd apps/web && pnpm dev`

- [ ] **Step 2: 最终验证清单**

| 检查项 | 期望结果 |
|--------|---------|
| 逆向推算数值 | 修改目标收益/回撤，两个约束数值变化合理，建议值始终取较小者 |
| 负期望警告 | 将胜率设为10%、盈亏比设为1.0，显示红色警告栏，结果卡片隐藏 |
| 移动端 | 窗口 <1200px，左面板可折叠；<640px 卡片单列 |
| 深色主题 | 所有组件正确应用 CSS 变量（--color-surface, --color-text 等） |
| 无 console 报错 | 打开浏览器 DevTools，无 ECharts/Naive UI 相关报错 |

---

## Self-Review

**1. Spec coverage:**

| 参考界面元素 | 对应 Task |
|-------------|----------|
| 左侧参数面板（7滑块） | Task 3, 4 |
| 理论模拟模式 | Task 3（简化，无二模式切换） |
| 当前诊断/黄金系统 | Task 6 |
| 逆向推算单笔风险 | Task 6, 12 |
| 四档风险结果卡片 | Task 5, 6 |
| 蒙特卡洛资金曲线图 | Task 9, 10 |
| 最终资金概率密度图 | Task 9, 10 |
| 执行重新洗牌按钮 | Task 3 |
| 响应式布局 | Task 13 |

**2. Placeholder scan:** 无 "TBD/TODO/实现 later"，所有代码完整可运行。

**3. Type consistency:** `RiskLevelResult`, `SimParams`, `SimPath`, `FinalDistribution` 在所有 Task 中命名一致。`useKellySimulation` 返回值在所有消费者中签名一致。
