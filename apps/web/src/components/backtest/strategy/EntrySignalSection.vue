<template>
  <n-divider>入场信号</n-divider>

  <div v-if="activeList.length === 0" class="signal-empty">
    暂无入场信号，点击「添加信号」开始配置
  </div>

  <template v-for="(type, i) in activeList" :key="type">
    <div class="signal-card">
      <div class="signal-card-header">
        <span>{{ SIGNAL_LABELS[type] }}</span>
        <div class="header-actions">
          <n-dropdown v-if="type === 'ma'" :options="maPresetDropdownOptions" @select="applyMaPreset">
            <n-button text type="primary" size="small">应用预设</n-button>
          </n-dropdown>
          <n-button text size="small" @click="removeSignal(type)">删除</n-button>
        </div>
      </div>
      <div class="signal-card-body">

        <!-- KDJ 超卖 -->
        <template v-if="type === 'kdj'">
          <n-form-item label="周期" :show-feedback="false" label-placement="left" label-width="120px">
            <div class="kdj-periods">
              <div class="period-item">
                <span class="period-label">N</span>
                <n-input-number v-model:value="p.kdjN" :min="1" :max="99" :show-button="false" style="width:60px" size="small" />
              </div>
              <div class="period-item">
                <span class="period-label">M1</span>
                <n-input-number v-model:value="p.kdjM1" :min="1" :max="99" :show-button="false" style="width:60px" size="small" />
              </div>
              <div class="period-item">
                <span class="period-label">M2</span>
                <n-input-number v-model:value="p.kdjM2" :min="1" :max="99" :show-button="false" style="width:60px" size="small" />
              </div>
            </div>
          </n-form-item>
          <n-form-item :show-feedback="false" label-placement="left" label-width="120px">
            <template #label>
              <span class="label-with-tip">J 阈值
                <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
                  J 值低于此阈值视为超卖，触发入场信号；建议设 10～20
                </n-tooltip>
              </span>
            </template>
            <n-input-number v-model:value="p.kdjJOversold" :min="-200" :max="200" style="width:120px" size="small" />
          </n-form-item>
          <n-form-item :show-feedback="false" label-placement="left" label-width="120px">
            <template #label>
              <span class="label-with-tip">J 取值偏移
                <n-tooltip style="max-width:280px"><template #trigger><span class="tip-icon">?</span></template>
                  与「J 阈值」比较时使用的 K 线：0 = 当前 K 线，1 = 上一根，以此类推（最多 99）
                </n-tooltip>
              </span>
            </template>
            <n-input-number v-model:value="p.kdjOversoldJOffset" :min="0" :max="99" :show-button="false" style="width:120px" size="small" />
          </n-form-item>
        </template>

        <!-- MA 条件 -->
        <template v-if="type === 'ma'">
          <n-form-item :show-feedback="false">
            <template #label>
              <span class="label-with-tip">MA 条件
                <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
                  所有条件 AND 连接。例：CLOSE &gt; MA60 AND MA30 &gt; MA60<br/>
                  为空时回退到默认硬编码条件
                </n-tooltip>
              </span>
            </template>
            <n-dynamic-input
              v-model:value="p.maConditions"
              :on-create="createMaCondition"
              item-class="ma-cond-item"
            >
              <template #default="{ value }">
                <div class="ma-row">
                  <n-select v-model:value="value.left" :options="maOperandOptions" style="width:90px" size="small" />
                  <n-select v-model:value="value.op"   :options="maOperatorOptions" style="width:68px" size="small" />
                  <n-select v-model:value="value.right" :options="maOperandOptions" style="width:90px" size="small" />
                </div>
              </template>
            </n-dynamic-input>
          </n-form-item>
        </template>

        <!-- 入场距低点 -->
        <template v-if="type === 'dist'">
          <n-form-item :show-feedback="false">
            <template #label>
              <span class="label-with-tip">最大初始止损(%)
                <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
                  按止损策略估算的预期初始止损幅度，超过该值的信号将被过滤。<br/>
                  · ATR 模式：(收盘价 - 阶段低点 × 止损因子) ÷ 收盘价 × 100<br/>
                  · 固定止损：直接使用固定止损百分比<br/>
                  · 中点止损：(收盘价 - 信号K线中点 × 止损因子) ÷ 收盘价 × 100
                </n-tooltip>
              </span>
            </template>
            <n-input-number v-model:value="p.entryMaxDistFromLowPct" :min="0.1" :max="50" :step="0.5" style="width:100%" size="small" />
          </n-form-item>
        </template>

        <!-- 最小盈亏比 -->
        <template v-if="type === 'rr'">
          <n-form-item :show-feedback="false">
            <template #label>
              <span class="label-with-tip">最小盈亏比
                <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
                  入场前要求「(阶段高点 - 入场价) ÷ (入场价 - 止损价)」≥ 该值，否则放弃信号
                </n-tooltip>
              </span>
            </template>
            <n-input-number v-model:value="p.minRiskRewardRatio" :min="0.1" :max="20" :step="0.5" style="width:100%" size="small" />
          </n-form-item>
        </template>

        <!-- 砖型图 XG -->
        <template v-if="type === 'brick'">
          <div class="brick-desc">
            砖型图 XG 转折信号：双重平滑随机振荡量之差从下降转上涨的第一根触发入场<br/>
            <span class="brick-formula">HHV/LLV=4，SMA(4,1) + SMA(6,1) 双重平滑</span>
          </div>
          <n-form-item :show-feedback="false">
            <template #label>
              <span class="label-with-tip">DELTA 加速阈值
                <n-tooltip style="max-width:280px"><template #trigger><span class="tip-icon">?</span></template>
                  DELTA = |砖型图变化量| ÷ |前一期变化量|<br/>
                  0 = 不过滤；&gt;1 = 要求加速（当前变化 > 前期变化）；建议 1～2
                </n-tooltip>
              </span>
            </template>
            <n-input-number v-model:value="p.brickDeltaMin" :min="0" :max="10" :step="0.1" style="width:100%" size="small" />
          </n-form-item>
        </template>

      </div>
    </div>
    <div v-if="i < activeList.length - 1" class="and-connector">AND</div>
  </template>

  <div class="add-signal-row">
    <n-dropdown :options="dropdownOptions" @select="addSignal">
      <n-button dashed style="width:100%">+ 添加信号</n-button>
    </n-dropdown>
  </div>
</template>

<script setup lang="ts">
import { h, ref, computed, watch } from 'vue'
import {
  NDivider, NFormItem, NInputNumber, NSelect, NTooltip, NDynamicInput,
  NButton, NDropdown,
  useMessage,
} from 'naive-ui'
import type { DropdownOption } from 'naive-ui'

export type MaOperand = 'close' | 'ma5' | 'ma30' | 'ma60' | 'ma120' | 'ma240'
export type MaOperator = '>' | '>=' | '<' | '<=' | '=' | '!='

export interface MaCondition {
  left: MaOperand
  op: MaOperator
  right: MaOperand
}

export interface EntrySignalParams {
  kdjN: number
  kdjM1: number
  kdjM2: number
  kdjJOversold: number
  kdjOversoldJOffset: number
  maConditions: MaCondition[]
  entryMaxDistFromLowPct: number
  minRiskRewardRatio: number
  brickXgEnabled: boolean
  brickDeltaMin: number
}

type SignalType = 'kdj' | 'ma' | 'dist' | 'rr' | 'brick'

const SIGNAL_LABELS: Record<SignalType, string> = {
  kdj: 'KDJ 超卖',
  ma: 'MA 条件',
  dist: '入场距低点',
  rr: '最小盈亏比',
  brick: '砖型图 XG',
}

const SIGNAL_ORDER: SignalType[] = ['kdj', 'ma', 'dist', 'rr', 'brick']

const SIGNAL_DEFAULTS: Record<SignalType, () => Partial<EntrySignalParams>> = {
  kdj:  () => ({ kdjN: 9, kdjM1: 3, kdjM2: 3, kdjJOversold: 10, kdjOversoldJOffset: 0 }),
  ma:   () => ({ maConditions: [{ left: 'close', op: '>', right: 'ma60' }] }),
  dist: () => ({ entryMaxDistFromLowPct: 5 }),
  rr:   () => ({ minRiskRewardRatio: 4.0 }),
  brick: () => ({ brickXgEnabled: true, brickDeltaMin: 0 }),
}

const SIGNAL_SENTINELS: Record<SignalType, () => Partial<EntrySignalParams>> = {
  kdj:  () => ({ kdjJOversold: 0, kdjOversoldJOffset: 0 }),
  ma:   () => ({ maConditions: [] }),
  dist: () => ({ entryMaxDistFromLowPct: 0 }),
  rr:   () => ({ minRiskRewardRatio: 0 }),
  brick: () => ({ brickXgEnabled: false, brickDeltaMin: 0 }),
}

const deriveActive = (params: EntrySignalParams): Set<SignalType> => {
  const s = new Set<SignalType>()
  if (params.kdjJOversold !== 0) s.add('kdj')
  if (params.maConditions.length > 0) s.add('ma')
  if (params.entryMaxDistFromLowPct !== 0) s.add('dist')
  if (params.minRiskRewardRatio !== 0) s.add('rr')
  if (params.brickXgEnabled) s.add('brick')
  return s
}

const p = defineModel<EntrySignalParams>('params', { required: true })

const message = useMessage()

const formatMaCondition = (cond: MaCondition): string => {
  const findLabel = (v: MaOperand) => maOperandOptions.find(o => o.value === v)?.label ?? v
  return `${findLabel(cond.left)} ${cond.op} ${findLabel(cond.right)}`
}

/** 多头排列：CLOSE>MA60 AND CLOSE>MA240 AND MA30>MA60 AND MA60>MA120 */
const MA_PRESET_BULL_ALIGN: readonly MaCondition[] = [
  { left: 'close', op: '>', right: 'ma60' },
  { left: 'close', op: '>', right: 'ma240' },
  { left: 'ma30', op: '>', right: 'ma60' },
  { left: 'ma60', op: '>', right: 'ma120' },
]

const MA_PRESET_KEY_BULL_ALIGN = 'bull_align' as const

const maPresetDropdownOptions: DropdownOption[] = [
  {
    key: MA_PRESET_KEY_BULL_ALIGN,
    label: () => h('div', { class: 'ma-preset-option' }, [
      h('div', { class: 'ma-preset-title' }, '多头排列'),
      ...MA_PRESET_BULL_ALIGN.map(cond =>
        h('div', { class: 'ma-preset-cond' }, `• ${formatMaCondition(cond)}`),
      ),
    ]),
  },
]

const applyMaPreset = (key: string | number) => {
  if (key !== MA_PRESET_KEY_BULL_ALIGN) return
  p.value.maConditions = MA_PRESET_BULL_ALIGN.map((row) => ({
    left: row.left,
    op: row.op,
    right: row.right,
  }))
  message.success('已应用：多头排列')
}

const signalOrder = ref<SignalType[]>(SIGNAL_ORDER.filter(t => deriveActive(p.value).has(t)))

watch(p, (newVal) => {
  const active = deriveActive(newVal)
  let next = signalOrder.value.filter(t => active.has(t))
  for (const t of SIGNAL_ORDER) {
    if (active.has(t) && !next.includes(t)) next.push(t)
  }
  signalOrder.value = next
}, { deep: false })

const activeList = computed(() => signalOrder.value)

const activeSignalsSet = computed(() => new Set(signalOrder.value))

const addSignal = (type: SignalType) => {
  Object.assign(p.value, SIGNAL_DEFAULTS[type]())
  signalOrder.value = [...signalOrder.value, type]
}

const removeSignal = (type: SignalType) => {
  Object.assign(p.value, SIGNAL_SENTINELS[type]())
  signalOrder.value = signalOrder.value.filter(x => x !== type)
}

const dropdownOptions = computed(() => SIGNAL_ORDER.map(type => ({
  label: SIGNAL_LABELS[type],
  key: type,
  disabled: activeSignalsSet.value.has(type),
})))

const maOperandOptions = [
  { label: 'CLOSE', value: 'close' },
  { label: 'MA5',   value: 'ma5' },
  { label: 'MA30',  value: 'ma30' },
  { label: 'MA60',  value: 'ma60' },
  { label: 'MA120', value: 'ma120' },
  { label: 'MA240', value: 'ma240' },
]

const maOperatorOptions = [
  { label: '>',  value: '>' },
  { label: '>=', value: '>=' },
  { label: '<',  value: '<' },
  { label: '<=', value: '<=' },
  { label: '=',  value: '=' },
  { label: '!=', value: '!=' },
]

const createMaCondition = (): MaCondition => ({ left: 'close', op: '>', right: 'ma60' })
</script>

<style scoped>
.signal-empty {
  text-align: center;
  padding: 20px;
  color: var(--ember-neutral, var(--color-text-muted));
  font-size: 13px;
  border: 1px dashed var(--ember-border, var(--color-border));
  border-radius: 12px;
  margin-bottom: 8px;
}

.signal-card {
  background: var(--ember-surface, var(--color-surface));
  border: 1px solid var(--ember-border, var(--color-border));
  border-radius: 12px;
  overflow: hidden;
}

.signal-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--ember-surface-hover, var(--color-surface-elevated));
  border-bottom: 1px solid var(--ember-border, var(--color-border));
  font-weight: 600;
  font-size: 14px;
  color: var(--ember-text, var(--color-text));
}

.signal-card-body {
  padding: 12px 16px;
}

.and-connector {
  text-align: center;
  padding: 6px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ember-neutral, var(--color-text-muted));
}

.add-signal-row {
  margin-top: 8px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label-with-tip { display: inline-flex; align-items: center; gap: 4px; }
.tip-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--ember-neutral, var(--color-text-muted));
  font-size: 10px; color: var(--ember-neutral, var(--color-text-muted)); cursor: help; flex-shrink: 0;
}
.kdj-periods { display: flex; gap: 12px; align-items: center; }
.period-item { display: flex; align-items: center; gap: 6px; }
.period-label { color: var(--n-text-color-3); font-size: 13px; white-space: nowrap; }
.ma-row { display: flex; align-items: center; gap: 8px; flex: 1; }
:deep(.ma-cond-item) { flex: 1; }
.brick-desc {
  font-size: 12px;
  color: var(--ember-neutral, var(--color-text-muted));
  line-height: 1.6;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: var(--ember-surface-hover, var(--color-surface-elevated));
  border-radius: 8px;
}
.brick-formula {
  font-size: 11px;
  opacity: 0.75;
}

/* 下拉菜单挂载在 body，需 :global */
:global(.ma-preset-option) {
  padding: 6px 4px;
  line-height: 1.5;
}
:global(.ma-preset-title) {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
:global(.ma-preset-cond) {
  font-size: 12px;
  color: var(--n-text-color-3, var(--color-text-muted));
  white-space: nowrap;
  padding-left: 4px;
}
</style>
