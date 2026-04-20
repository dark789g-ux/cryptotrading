<template>
  <n-divider>入场信号</n-divider>

  <div v-if="activeList.length === 0" class="signal-empty">
    暂无入场信号，点击「添加信号」开始配置
  </div>

  <template v-for="(type, i) in activeList" :key="type">
    <div class="signal-card">
      <div class="signal-card-header">
        <span>{{ SIGNAL_LABELS[type] }}</span>
        <n-button text size="small" @click="removeSignal(type)">删除</n-button>
      </div>
      <div class="signal-card-body">

        <!-- KDJ 超卖 -->
        <template v-if="type === 'kdj'">
          <n-form-item label="周期" :show-feedback="false" label-placement="left" label-width="60px">
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
          <n-form-item :show-feedback="false" label-placement="left" label-width="60px">
            <template #label>
              <span class="label-with-tip">J 阈值
                <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
                  J 值低于此阈值视为超卖，触发入场信号；建议设 10～20
                </n-tooltip>
              </span>
            </template>
            <n-input-number v-model:value="p.kdjJOversold" :min="-200" :max="200" style="width:100%" size="small" />
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
              <span class="label-with-tip">最大距低点(%)
                <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
                  以阶段低点为止损点，入场后最大可接受的亏损幅度；超过该值的信号将被过滤。<br/>
                  公式：(收盘价 - 阶段低点) ÷ 收盘价 × 100 ≤ N%
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
import { ref, computed, watch } from 'vue'
import {
  NDivider, NFormItem, NInputNumber, NSelect, NTooltip, NDynamicInput,
  NButton, NDropdown,
} from 'naive-ui'

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
  maConditions: MaCondition[]
  entryMaxDistFromLowPct: number
  minRiskRewardRatio: number
}

type SignalType = 'kdj' | 'ma' | 'dist' | 'rr'

const SIGNAL_LABELS: Record<SignalType, string> = {
  kdj: 'KDJ 超卖',
  ma: 'MA 条件',
  dist: '入场距低点',
  rr: '最小盈亏比',
}

const SIGNAL_ORDER: SignalType[] = ['kdj', 'ma', 'dist', 'rr']

const SIGNAL_DEFAULTS: Record<SignalType, () => Partial<EntrySignalParams>> = {
  kdj:  () => ({ kdjN: 9, kdjM1: 3, kdjM2: 3, kdjJOversold: 10 }),
  ma:   () => ({ maConditions: [{ left: 'close', op: '>', right: 'ma60' }] }),
  dist: () => ({ entryMaxDistFromLowPct: 5 }),
  rr:   () => ({ minRiskRewardRatio: 4.0 }),
}

const SIGNAL_SENTINELS: Record<SignalType, () => Partial<EntrySignalParams>> = {
  kdj:  () => ({ kdjJOversold: 0 }),
  ma:   () => ({ maConditions: [] }),
  dist: () => ({ entryMaxDistFromLowPct: 0 }),
  rr:   () => ({ minRiskRewardRatio: 0 }),
}

const deriveActive = (params: EntrySignalParams): Set<SignalType> => {
  const s = new Set<SignalType>()
  if (params.kdjJOversold !== 0) s.add('kdj')
  if (params.maConditions.length > 0) s.add('ma')
  if (params.entryMaxDistFromLowPct !== 0) s.add('dist')
  if (params.minRiskRewardRatio !== 0) s.add('rr')
  return s
}

const p = defineModel<EntrySignalParams>('params', { required: true })

const activeSignals = ref<Set<SignalType>>(deriveActive(p.value))

watch(p, (newVal) => {
  activeSignals.value = deriveActive(newVal)
}, { deep: false })

const activeList = computed(() => SIGNAL_ORDER.filter(t => activeSignals.value.has(t)))

const addSignal = (type: SignalType) => {
  Object.assign(p.value, SIGNAL_DEFAULTS[type]())
  activeSignals.value = new Set([...activeSignals.value, type])
}

const removeSignal = (type: SignalType) => {
  Object.assign(p.value, SIGNAL_SENTINELS[type]())
  const next = new Set(activeSignals.value)
  next.delete(type)
  activeSignals.value = next
}

const dropdownOptions = computed(() => SIGNAL_ORDER.map(type => ({
  label: SIGNAL_LABELS[type],
  key: type,
  disabled: activeSignals.value.has(type),
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
  color: var(--ember-neutral, #78716C);
  font-size: 13px;
  border: 1px dashed var(--ember-border, #D6D3D1);
  border-radius: 12px;
  margin-bottom: 8px;
}

.signal-card {
  background: var(--ember-surface, #F5F5F4);
  border: 1px solid var(--ember-border, #D6D3D1);
  border-radius: 12px;
  overflow: hidden;
}

.signal-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--ember-surface-hover, #E7E5E4);
  border-bottom: 1px solid var(--ember-border, #D6D3D1);
  font-weight: 600;
  font-size: 14px;
  color: var(--ember-text, #1C1917);
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
  color: var(--ember-neutral, #78716C);
}

.add-signal-row {
  margin-top: 8px;
}

.label-with-tip { display: inline-flex; align-items: center; gap: 4px; }
.tip-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--n-text-color-3, #888);
  font-size: 10px; color: var(--n-text-color-3, #888); cursor: help; flex-shrink: 0;
}
.kdj-periods { display: flex; gap: 12px; align-items: center; }
.period-item { display: flex; align-items: center; gap: 6px; }
.period-label { color: var(--n-text-color-3); font-size: 13px; white-space: nowrap; }
.ma-row { display: flex; align-items: center; gap: 8px; flex: 1; }
:deep(.ma-cond-item) { flex: 1; }
</style>
