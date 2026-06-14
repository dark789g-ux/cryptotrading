<template>
  <AppModal
    :show="show"
    title="新建组合模拟"
    description="把若干既有信号方案的逐笔交易合并到一个组合账户里逐日回放净值"
    width="min(880px, 96vw)"
    :mask-closable="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="create-form">
      <!-- 基本 -->
      <div class="section">
        <div class="section__title">方案名称</div>
        <n-input v-model:value="name" placeholder="如 Q3+Q1 组合 v1" />
      </div>

      <!-- ③ 锚点模式（放最前，因为会覆盖①②）-->
      <div class="section">
        <div class="section__title">
          锚点模式
          <n-tooltip>
            <template #trigger><span class="section__q">?</span></template>
            开启后：无任何约束（maxPositions / exposureCap / already_held 全停用）+ 零成本，
            每笔信号必成交，realizedRetNet ≡ ret，用于「官方 vs 复算」代数恒等对账门禁。
            此模式下强制只允许 1 个源，且 ①② 的约束 / 成本设置被覆盖。
          </n-tooltip>
        </div>
        <n-space align="center">
          <n-switch v-model:value="anchorMode" @update:value="onAnchorToggle" />
          <span class="section__hint">{{ anchorMode ? '已开启：约束与成本被强制覆盖' : '关闭（正常组合回放）' }}</span>
        </n-space>
      </div>

      <!-- ① 源策略 -->
      <div class="section">
        <div class="section__title">
          信号源（{{ sources.length }} / {{ anchorMode ? 1 : MAX_SOURCES }}）
          <n-button
            v-if="!anchorMode && sources.length < MAX_SOURCES"
            size="tiny"
            type="primary"
            @click="addSource"
          >
            + 增加源
          </n-button>
        </div>
        <PortfolioSimSourceRow
          v-for="(src, i) in sources"
          :key="i"
          :index="i"
          :model="src"
          :schemes="schemes"
          :removable="sources.length > 1"
          :disabled="false"
          @update="(p) => updateSource(i, p)"
          @remove="removeSource(i)"
        />
      </div>

      <!-- ② 资金与成本 -->
      <div class="section">
        <div class="section__title">资金与成本</div>
        <div class="section__field">
          <div class="section__field-label">初始资金 initialCapital</div>
          <n-input-number
            v-model:value="initialCapital"
            :min="1000"
            :step="100000"
            style="width: 100%"
          />
        </div>

        <div class="section__field">
          <div class="section__field-label">
            成本档
            <span v-if="anchorMode" class="section__hint">（锚点模式下强制零成本）</span>
          </div>
          <n-radio-group v-model:value="costTier" :disabled="anchorMode" @update:value="onTierChange">
            <n-space>
              <n-radio v-for="t in tierKeys" :key="t" :value="t">{{ COST_TIER_LABELS[t] }}</n-radio>
            </n-space>
          </n-radio-group>
          <div class="section__rate-preview">
            {{ ratePreviewText }}
          </div>
        </div>

        <!-- 自定义五费率 -->
        <div v-if="costTier === 'custom' && !anchorMode" class="custom-rates">
          <div v-for="f in feeFields" :key="f.key" class="custom-rates__row">
            <span class="custom-rates__label">{{ f.label }}</span>
            <n-input-number
              :value="cost[f.key]"
              :min="0"
              :step="0.0001"
              size="small"
              style="width: 160px"
              @update:value="(v: number | null) => (cost[f.key] = v ?? 0)"
            />
          </div>
        </div>
      </div>

      <!-- ④ 账户级熔断 -->
      <div class="section">
        <div class="section__title">
          熔断（账户级）
          <n-tooltip>
            <template #trigger><span class="section__q">?</span></template>
            连亏熔断：连亏 N 笔后冻结开仓若干交易日；回撤熔断：自峰值回撤超阈值停开仓、回升复位。
            两闸默认关闭、anchorMode 下强制全旁路。
          </n-tooltip>
        </div>
        <CircuitBreakerPanel
          :model="circuitBreaker"
          :disabled="anchorMode"
          :anchor-mode="anchorMode"
          @update="onCircuitBreakerPatch"
        />
      </div>
    </div>

    <template #actions>
      <n-button @click="emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="onSubmit">
        创建
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NButton,
  NInput,
  NInputNumber,
  NRadio,
  NRadioGroup,
  NSpace,
  NSwitch,
  NTooltip,
  useMessage,
} from 'naive-ui'
import AppModal from '../common/AppModal.vue'
import PortfolioSimSourceRow from './PortfolioSimSourceRow.vue'
import CircuitBreakerPanel from './CircuitBreakerPanel.vue'
import { signalStatsApi } from '../../api/modules/strategy/signalStats'
import type { SignalTestWithLatestRun } from '../../api/modules/strategy/signalStats'
import { usePortfolioSimStore } from '../../stores/portfolioSim'
import type {
  CreatePortfolioSimDto,
  PortfolioSimSource,
  PortfolioSimCostRates,
  CircuitBreaker,
} from '../../api/modules/strategy/portfolioSim'
import {
  COST_TIER_PRESETS,
  COST_TIER_LABELS,
  COST_PRESET_REALISTIC,
  COST_PRESET_ZERO,
  DEFAULT_CIRCUIT_BREAKER,
  estimateRoundTripRate,
  formatRatePct,
  type CostTier,
} from './portfolioSimPresets'

const MAX_SOURCES = 5

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'created'): void
}>()

const message = useMessage()
const store = usePortfolioSimStore()

// ── 表单状态 ─────────────────────────────────────────────────────────────────
const name = ref('')
const anchorMode = ref(false)
const initialCapital = ref(1_000_000)
const costTier = ref<CostTier>('realistic')
const cost = reactive<PortfolioSimCostRates>({ ...COST_PRESET_REALISTIC })
const circuitBreaker = reactive<CircuitBreaker>({ ...DEFAULT_CIRCUIT_BREAKER })
const submitting = ref(false)

function freshSource(): PortfolioSimSource {
  return {
    runId: '',
    label: '',
    positionRatio: 0.1,
    maxPositions: null,
    exposureCap: null,
    rankField: 'none',
    rankDir: 'asc',
  }
}

const sources = ref<PortfolioSimSource[]>([freshSource()])

// ── 方案列表（signal-tests 原始结果，含 latestRun，供 RunPicker 二级下拉用）──────
const schemes = ref<SignalTestWithLatestRun[]>([])

async function loadSchemes() {
  try {
    schemes.value = await signalStatsApi.findAll()
  } catch (e) {
    message.warning(e instanceof Error ? e.message : '加载信号方案列表失败')
  }
}

// 打开弹窗时重置 + 拉方案
watch(
  () => props.show,
  (v) => {
    if (v) {
      resetForm()
      void loadSchemes()
    }
  },
)

function resetForm() {
  name.value = ''
  anchorMode.value = false
  initialCapital.value = 1_000_000
  costTier.value = 'realistic'
  Object.assign(cost, COST_PRESET_REALISTIC)
  Object.assign(circuitBreaker, DEFAULT_CIRCUIT_BREAKER)
  sources.value = [freshSource()]
}

function onCircuitBreakerPatch(patch: Partial<CircuitBreaker>) {
  Object.assign(circuitBreaker, patch)
}

// ── 源行操作 ─────────────────────────────────────────────────────────────────
function addSource() {
  if (sources.value.length >= MAX_SOURCES) return
  sources.value.push(freshSource())
}

function removeSource(i: number) {
  if (sources.value.length <= 1) return
  sources.value.splice(i, 1)
}

function updateSource(i: number, patch: Partial<PortfolioSimSource>) {
  sources.value[i] = { ...sources.value[i], ...patch }
}

// ── 成本档 ───────────────────────────────────────────────────────────────────
const tierKeys: CostTier[] = ['optimistic', 'realistic', 'conservative', 'zero', 'custom']
const feeFields: Array<{ key: keyof PortfolioSimCostRates; label: string }> = [
  { key: 'commissionPerSide', label: '佣金（单边）' },
  { key: 'transferPerSide', label: '过户费（单边）' },
  { key: 'stampSellBefore20230828', label: '印花税（卖, <2023-08-28）' },
  { key: 'stampSellFrom20230828', label: '印花税（卖, ≥2023-08-28）' },
  { key: 'slippagePerSide', label: '滑点（单边）' },
]

function onTierChange(tier: CostTier) {
  if (tier === 'custom') return
  Object.assign(cost, COST_TIER_PRESETS[tier])
}

const ratePreviewText = computed(() => {
  const rt = estimateRoundTripRate(cost)
  return (
    `佣金 ${formatRatePct(cost.commissionPerSide)} · 过户 ${formatRatePct(cost.transferPerSide)} · ` +
    `印花(减半后) ${formatRatePct(cost.stampSellFrom20230828)} · 滑点 ${formatRatePct(cost.slippagePerSide)} · ` +
    `双边合计≈ ${formatRatePct(rt)}`
  )
})

// ── 锚点模式 ─────────────────────────────────────────────────────────────────
function onAnchorToggle(v: boolean) {
  if (v) {
    // 强制单源 + 零成本（提交时仍会归一，这里即时反映 UI）
    if (sources.value.length > 1) sources.value = [sources.value[0]]
    costTier.value = 'zero'
    Object.assign(cost, COST_PRESET_ZERO)
  }
}

// ── 提交 ─────────────────────────────────────────────────────────────────────
const canSubmit = computed(() => {
  if (name.value.trim() === '') return false
  if (sources.value.length < 1) return false
  return sources.value.every((s) => s.runId.trim() !== '' && s.label.trim() !== '')
})

async function onSubmit() {
  if (!canSubmit.value) {
    message.warning('请填写方案名称，并确保每个源都有 run id 与标签')
    return
  }
  // anchorMode 下强制覆盖：单源 + 约束置空 + 零成本（与后端 anchorMode 语义对齐）
  const effectiveSources = anchorMode.value
    ? [
        {
          ...sources.value[0],
          maxPositions: null,
          exposureCap: null,
        },
      ]
    : sources.value
  const effectiveCost = anchorMode.value ? { ...COST_PRESET_ZERO } : { ...cost }

  // 熔断：anchorMode 强制全旁路；非锚点且至少一闸开启时才下发（缺省=全关则省略，由后端默认）。
  const cbEnabled = circuitBreaker.enableCooldown || circuitBreaker.enableDrawdownHalt
  const effectiveCircuitBreaker =
    !anchorMode.value && cbEnabled ? { ...circuitBreaker } : undefined

  const dto: CreatePortfolioSimDto = {
    name: name.value.trim(),
    config: {
      sources: effectiveSources,
      initialCapital: initialCapital.value,
      cost: effectiveCost,
      anchorMode: anchorMode.value,
      ...(effectiveCircuitBreaker ? { circuitBreaker: effectiveCircuitBreaker } : {}),
    },
  }

  submitting.value = true
  try {
    await store.createRun(dto)
    message.success('创建成功')
    emit('created')
    emit('update:show', false)
  } catch (e) {
    // 透传后端中文校验信息（如 positionRatio 区间、label 重复、anchorMode 单源约束）
    message.error(e instanceof Error ? e.message : '创建失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.create-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 70vh;
  overflow-y: auto;
  padding-right: 4px;
}

.section__title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.section__q {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--color-border, #ccc);
  font-size: 11px;
  color: var(--color-text-secondary, #888);
  cursor: help;
}

.section__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.section__field-label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.section__hint {
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}

.section__rate-preview {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-secondary, #888);
  font-variant-numeric: tabular-nums;
}

.custom-rates {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--color-border, #ddd);
  border-radius: 8px;
}

.custom-rates__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.custom-rates__label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}
</style>
