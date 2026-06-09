<template>
  <div class="row-detail">
    <div v-if="loading" class="state muted">加载中…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <template v-else-if="detail">
      <div class="section-title">入场条件</div>
      <div class="kv-grid">
        <span class="k">变体 ID</span>
        <span class="v mono">{{ baseTriggerText }}</span>
        <span class="k">过滤条件</span>
        <span class="v mono">{{ entryFiltersText }}</span>
        <span class="k">口径组</span>
        <span class="v">{{ detail.windowGroup }}</span>
      </div>

      <div class="section-title mt">出场配置</div>
      <div class="kv-grid">
        <span class="k">出场策略</span>
        <span class="v mono">{{ detail.exitId ?? '—' }}</span>
        <span class="k">出场参数</span>
        <span class="v mono">{{ exitConfigText }}</span>
      </div>

      <div class="metrics-row mt">
        <div class="metrics-box">
          <div class="box-title">训练集</div>
          <div class="kv-grid compact">
            <span class="k">样本数 n</span>
            <span class="v">{{ fmt(detail.nTrain) }}</span>
            <span class="k">Kelly f*</span>
            <span class="v kelly">{{ fmtNum(detail.kellyTrain) }}</span>
            <span class="k">胜率</span>
            <span class="v">{{ fmtPct(detail.winRateTrain) }}</span>
            <span class="k">盈亏比 b</span>
            <span class="v">{{ fmtNum(detail.payoffBTrain, 2) }}</span>
            <span class="k">PF</span>
            <span class="v">{{ fmtNum(detail.profitFactorTrain, 2) }}</span>
          </div>
        </div>
        <div class="metrics-box highlight">
          <div class="box-title">验证集</div>
          <div class="kv-grid compact">
            <span class="k">样本数 n</span>
            <span class="v">{{ fmt(detail.nValid) }}</span>
            <span class="k">Kelly f*</span>
            <span class="v kelly">{{ fmtNum(detail.kellyValid) }}</span>
            <span class="k">CI 95%</span>
            <span class="v">{{ ciText }}</span>
            <span class="k">胜率</span>
            <span class="v">{{ fmtPct(detail.winRateValid) }}</span>
            <span class="k">盈亏比 b</span>
            <span class="v">{{ fmtNum(detail.payoffBValid, 2) }}</span>
            <span class="k">PF</span>
            <span class="v">{{ fmtNum(detail.profitFactorValid, 2) }}</span>
          </div>
        </div>
      </div>

      <div class="section-title mt">标记</div>
      <div class="tags-row">
        <n-tag v-if="detail.isFrontier" type="warning" size="small">帕累托前沿</n-tag>
        <n-tag v-if="detail.isTopk" type="success" size="small">Top-K</n-tag>
        <n-tag v-if="detail.belowFloor" type="default" size="small">below_floor</n-tag>
        <span v-if="!detail.isFrontier && !detail.isTopk && !detail.belowFloor" class="muted">—</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import type { KellyRowDetail } from '@/api/modules/quant/kellySweep'

const props = defineProps<{
  detail: KellyRowDetail | null
  loading?: boolean
  error?: string | null
}>()

function fmt(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return String(v)
}

function fmtNum(v: number | null, digits = 3): string {
  if (v === null || v === undefined) return '—'
  return v.toFixed(digits)
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toFixed(1)}%`
}

const baseTriggerText = computed(() => {
  // variantFilters: [[feature, op, value], ...][] — 第一个 filter 组的 base 条件
  const filters = props.detail?.variantFilters
  if (!filters || filters.length === 0) return '—'
  // variant_id 已编码入场信息，直接展示 variantId 作为描述
  return props.detail?.variantId ?? '—'
})

const entryFiltersText = computed(() => {
  const filters = props.detail?.variantFilters
  if (!filters || filters.length === 0) return '无附加过滤'
  return JSON.stringify(filters)
})

const exitConfigText = computed(() => {
  if (!props.detail?.exitCfg) return '—'
  return JSON.stringify(props.detail.exitCfg)
})

const ciText = computed(() => {
  const d = props.detail
  if (!d || d.kellyCiLow === null || d.kellyCiHigh === null) return '—'
  return `[${fmtNum(d.kellyCiLow)}, ${fmtNum(d.kellyCiHigh)}]`
})
</script>

<style scoped>
.row-detail {
  font-size: 13px;
  line-height: 1.6;
}
.state {
  padding: 24px;
  text-align: center;
  font-size: 13px;
}
.muted { color: var(--color-text-muted); }
.err { color: var(--color-error, #d03050); }

.section-title {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.mt { margin-top: 16px; }

.kv-grid {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 4px 8px;
}
.kv-grid.compact {
  grid-template-columns: 72px 1fr;
}
.k { color: var(--color-text-muted); }
.v { color: var(--color-text); word-break: break-all; }
.v.mono { font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; }
.kelly { font-weight: 700; color: #f6a623; }

.metrics-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.metrics-box {
  flex: 1;
  min-width: 180px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.metrics-box.highlight {
  border-color: color-mix(in srgb, #f6a623 40%, var(--color-border));
  background: color-mix(in srgb, #f6a623 6%, var(--color-surface));
}
.box-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-bottom: 8px;
}

.tags-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
</style>
