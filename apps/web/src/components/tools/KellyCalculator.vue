<template>
  <div class="kelly-card">
    <!-- 头部 -->
    <div class="kelly-header">
      <div class="kelly-header-left">
        <div class="kelly-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3 3h18v18H3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M8 17V10M12 17V7M16 17v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div>
          <div class="kelly-title">凯利公式计算器</div>
          <div class="kelly-desc">Kelly Criterion — 最优仓位比例</div>
        </div>
      </div>
      <div class="formula-badge">
        <span class="formula-text">f* = W − (1−W) / R</span>
      </div>
    </div>

    <!-- Tab 切换 -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'ratio' }"
        @click="activeTab = 'ratio'"
      >胜率 + 盈亏比</button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'amount' }"
        @click="activeTab = 'amount'"
      >胜率 + 盈亏金额</button>
    </div>

    <!-- 输入区 -->
    <div class="input-section">
      <template v-if="activeTab === 'ratio'">
        <div class="input-grid">
          <div class="field">
            <div class="field-label">胜率 W <span class="field-unit">%</span></div>
            <n-input-number
              v-model:value="ratioForm.winRate"
              :min="1" :max="99" :precision="2"
              placeholder="55" style="width:100%"
            />
            <div class="field-hint">历史胜率，范围 1–99</div>
          </div>
          <div class="field">
            <div class="field-label">盈亏比 R</div>
            <n-input-number
              v-model:value="ratioForm.ratio"
              :min="0.01" :precision="2"
              placeholder="1.5" style="width:100%"
            />
            <div class="field-hint">平均盈利 / 平均亏损</div>
          </div>
          <div class="field">
            <div class="field-label">账户资金 <span class="field-unit">$</span> <span class="badge-optional">可选</span></div>
            <n-input-number
              v-model:value="ratioForm.capital"
              :min="0" :precision="2"
              placeholder="10000" style="width:100%"
            />
            <div class="field-hint">填入后显示建议金额</div>
          </div>
          <div class="field">
            <div class="field-label">凯利分数 <span class="field-unit">×</span></div>
            <n-input-number
              v-model:value="ratioForm.fraction"
              :min="0.01" :max="1" :precision="2"
              placeholder="0.5" style="width:100%"
            />
            <div class="field-hint">实盘推荐 0.25–0.5</div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="input-grid input-grid--3">
          <div class="field">
            <div class="field-label">胜率 W <span class="field-unit">%</span></div>
            <n-input-number
              v-model:value="amountForm.winRate"
              :min="1" :max="99" :precision="2"
              placeholder="55" style="width:100%"
            />
            <div class="field-hint">历史胜率，范围 1–99</div>
          </div>
          <div class="field">
            <div class="field-label">平均盈利 <span class="field-unit">$</span></div>
            <n-input-number
              v-model:value="amountForm.avgWin"
              :min="0.01" :precision="2"
              placeholder="150" style="width:100%"
            />
            <div class="field-hint">每笔盈利交易的平均盈利</div>
          </div>
          <div class="field">
            <div class="field-label">平均亏损 <span class="field-unit">$</span></div>
            <n-input-number
              v-model:value="amountForm.avgLoss"
              :min="0.01" :precision="2"
              placeholder="100" style="width:100%"
            />
            <div class="field-hint">每笔亏损交易的平均亏损</div>
          </div>
          <div class="field">
            <div class="field-label">账户资金 <span class="field-unit">$</span> <span class="badge-optional">可选</span></div>
            <n-input-number
              v-model:value="amountForm.capital"
              :min="0" :precision="2"
              placeholder="10000" style="width:100%"
            />
            <div class="field-hint">填入后显示建议金额</div>
          </div>
          <div class="field">
            <div class="field-label">凯利分数 <span class="field-unit">×</span></div>
            <n-input-number
              v-model:value="amountForm.fraction"
              :min="0.01" :max="1" :precision="2"
              placeholder="0.5" style="width:100%"
            />
            <div class="field-hint">实盘推荐 0.25–0.5</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 负凯利警告 -->
    <div v-if="result !== null && result <= 0" class="warn-bar">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
        <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      凯利值为负或零（当前参数无正期望），建议不入场。
    </div>

    <!-- 结果区 -->
    <template v-if="result !== null && result > 0">
      <div class="result-section">
        <div class="result-section-label">计算结果</div>

        <!-- 主推荐（半凯利） -->
        <div class="hero-card">
          <div class="hero-left">
            <div class="hero-tag">推荐仓位（半凯利）</div>
            <div class="hero-value">{{ fmtPct(result * 0.5) }}</div>
            <div class="hero-amount">{{ fmtAmt(result * 0.5, currentCapital) }}</div>
          </div>
          <div class="hero-right">
            <div class="hero-growth-label">期望对数增长率</div>
            <div class="hero-growth" :class="growth >= 0 ? 'pos' : 'neg'">
              {{ growth >= 0 ? '+' : '' }}{{ (growth * 100).toFixed(3) }}% <span class="hero-growth-unit">/ 笔</span>
            </div>
            <div class="hero-growth-label" style="margin-top:10px">自定义仓位 (×{{ currentFraction }})</div>
            <div class="hero-custom">{{ fmtPct(result * currentFraction) }}
              <span class="hero-custom-amt">{{ fmtAmt(result * currentFraction, currentCapital) }}</span>
            </div>
          </div>
        </div>

        <!-- 三列明细 -->
        <div class="detail-grid">
          <div class="detail-card detail-card--green">
            <div class="detail-dot detail-dot--green"></div>
            <div class="detail-label">完整凯利</div>
            <div class="detail-value detail-value--green">{{ fmtPct(result) }}</div>
            <div class="detail-amt">{{ fmtAmt(result, currentCapital) }}</div>
            <div class="detail-note">理论最大值，波动大</div>
          </div>
          <div class="detail-card detail-card--yellow">
            <div class="detail-dot detail-dot--yellow"></div>
            <div class="detail-label">半凯利</div>
            <div class="detail-value detail-value--yellow">{{ fmtPct(result * 0.5) }}</div>
            <div class="detail-amt">{{ fmtAmt(result * 0.5, currentCapital) }}</div>
            <div class="detail-note">实盘推荐起点</div>
          </div>
          <div class="detail-card">
            <div class="detail-dot"></div>
            <div class="detail-label">四分之一凯利</div>
            <div class="detail-value">{{ fmtPct(result * 0.25) }}</div>
            <div class="detail-amt">{{ fmtAmt(result * 0.25, currentCapital) }}</div>
            <div class="detail-note">极保守策略</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { NInputNumber } from 'naive-ui'

const activeTab = ref<'ratio' | 'amount'>('ratio')

const ratioForm = reactive({
  winRate: null as number | null,
  ratio: null as number | null,
  capital: null as number | null,
  fraction: 0.5 as number | null,
})

const amountForm = reactive({
  winRate: null as number | null,
  avgWin: null as number | null,
  avgLoss: null as number | null,
  capital: null as number | null,
  fraction: 0.5 as number | null,
})

const result = computed<number | null>(() => {
  if (activeTab.value === 'ratio') {
    const { winRate, ratio } = ratioForm
    if (winRate === null || ratio === null || ratio <= 0) return null
    const w = winRate / 100
    return w - (1 - w) / ratio
  } else {
    const { winRate, avgWin, avgLoss } = amountForm
    if (winRate === null || avgWin === null || avgLoss === null || avgWin <= 0) return null
    const w = winRate / 100
    return (w * avgWin - (1 - w) * avgLoss) / avgWin
  }
})

const currentCapital = computed(() =>
  activeTab.value === 'ratio' ? ratioForm.capital : amountForm.capital,
)

const currentFraction = computed(() => {
  const f = activeTab.value === 'ratio' ? ratioForm.fraction : amountForm.fraction
  return f ?? 0.5
})

const effectiveRatio = computed(() => {
  if (activeTab.value === 'ratio') return ratioForm.ratio ?? 1
  const { avgWin, avgLoss } = amountForm
  if (avgWin && avgLoss && avgLoss > 0) return avgWin / avgLoss
  return 1
})

const growth = computed(() => {
  const f = result.value
  if (f === null || f <= 0) return 0
  const w = (activeTab.value === 'ratio' ? ratioForm.winRate : amountForm.winRate) ?? 50
  const wDec = w / 100
  const r = effectiveRatio.value
  const logUp = Math.log(1 + f * r)
  const logDown = Math.log(1 - f)
  if (!isFinite(logUp) || !isFinite(logDown)) return 0
  return wDec * logUp + (1 - wDec) * logDown
})

function fmtPct(f: number): string {
  return (f * 100).toFixed(2) + '%'
}

function fmtAmt(f: number, capital: number | null): string {
  if (!capital || capital <= 0) return ''
  return '$' + (f * capital).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
</script>


<style scoped src="./KellyCalculator.styles.css"></style>
