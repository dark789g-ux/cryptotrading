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

<style scoped>
/* ── 外壳 ── */
.kelly-card {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
}

/* ── 头部 ── */
.kelly-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-surface) 60%, var(--color-surface-elevated));
}

.kelly-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.kelly-icon {
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

.kelly-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.2;
}

.kelly-desc {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 2px;
}

.formula-badge {
  background: color-mix(in srgb, var(--color-surface) 80%, transparent);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 5px 12px;
}

.formula-text {
  font-family: 'Fira Code', Consolas, monospace;
  font-size: 12px;
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
}

/* ── Tab 切换 ── */
.tab-bar {
  display: flex;
  gap: 0;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--color-border);
}

.tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  font-weight: 500;
  padding: 8px 20px 10px;
  cursor: pointer;
  transition: color 0.18s, border-color 0.18s;
  margin-bottom: -1px;
}

.tab-btn:hover { color: var(--color-text-secondary); }

.tab-btn.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}

/* ── 输入区 ── */
.input-section {
  padding: 20px 24px;
  background: color-mix(in srgb, var(--color-surface) 40%, var(--color-surface-elevated));
}

.input-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 20px;
}

.input-grid--3 {
  grid-template-columns: 1fr 1fr 1fr;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-bottom: 7px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.field-unit {
  color: var(--color-text-muted);
  font-weight: 400;
  text-transform: none;
}

.badge-optional {
  display: inline-block;
  background: color-mix(in srgb, var(--color-text-muted) 15%, transparent);
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  vertical-align: middle;
  text-transform: none;
  letter-spacing: 0;
}

.field-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 5px;
}

/* ── 警告栏 ── */
.warn-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 24px 0;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-error) 35%, transparent);
  border-radius: 8px;
  color: var(--color-error);
  font-size: 13px;
}

/* ── 结果区 ── */
.result-section {
  padding: 20px 24px 24px;
  border-top: 1px solid var(--color-border);
}

.result-section-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: 14px;
}

/* 主推荐卡 */
.hero-card {
  display: flex;
  gap: 0;
  background: color-mix(in srgb, var(--color-primary) 6%, var(--color-surface));
  border: 1px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 14px;
}

.hero-left {
  flex: 1;
  padding: 18px 22px;
  border-right: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
}

.hero-tag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-primary);
  margin-bottom: 8px;
}

.hero-value {
  font-size: 40px;
  font-weight: 700;
  color: var(--color-primary);
  line-height: 1;
  letter-spacing: -0.01em;
}

.hero-amount {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-top: 6px;
  min-height: 20px;
}

.hero-right {
  width: 220px;
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.hero-growth-label {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.hero-growth {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}

.hero-growth.pos { color: var(--color-success); }
.hero-growth.neg { color: var(--color-error); }

.hero-growth-unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-text-muted);
}

.hero-custom {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
}

.hero-custom-amt {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-text-muted);
  margin-left: 6px;
}

/* 三列明细 */
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}

.detail-card {
  position: relative;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 14px 16px 14px 20px;
  overflow: hidden;
}

.detail-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--color-border);
  border-radius: 0;
}

.detail-card--green::before { background: var(--color-success); }
.detail-card--yellow::before { background: var(--color-primary); }

.detail-dot {
  display: none;
}

.detail-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: 8px;
}

.detail-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.detail-value--green { color: var(--color-success); }
.detail-value--yellow { color: var(--color-primary); }

.detail-amt {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 5px;
  min-height: 18px;
}

.detail-note {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 6px;
}

/* n-input-number 深度覆盖 */
:deep(.n-input-number .n-input) {
  background: var(--color-surface) !important;
  border-color: var(--color-border) !important;
}

:deep(.n-input-number .n-input:hover) {
  border-color: var(--color-primary) !important;
}

:deep(.n-input-number .n-input.n-input--focus) {
  border-color: var(--color-primary) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 20%, transparent) !important;
}
</style>
