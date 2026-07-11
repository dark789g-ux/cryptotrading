<template>
  <n-modal
    :show="show"
    preset="card"
    :title="step === 1 ? '新建回测' : stepTitle"
    :mask-closable="false"
    style="width: min(920px, 96vw)"
    @update:show="$emit('update:show', $event)"
  >
    <!-- Step 1: 选择市场 -->
    <div v-if="step === 1" class="market-step">
      <p class="market-step-hint">选择要回测的市场类型</p>
      <div class="market-cards">
        <button type="button" class="market-card" @click="selectMarket('ashare')">
          <span class="market-card-title">A股日频</span>
          <span class="market-card-desc">Regime 引擎 · 日频组合回测</span>
        </button>
        <button type="button" class="market-card" @click="selectMarket('crypto')">
          <span class="market-card-title">加密货币</span>
          <span class="market-card-desc">MA+KDJ 策略 · 多周期 K 线回测</span>
        </button>
      </div>
    </div>

    <!-- Step 2: 对应市场表单 -->
    <div v-else class="form-step">
      <n-button quaternary size="small" class="back-btn" @click="goBack">
        ← 更换市场
      </n-button>
      <RegimeBacktestFormPanel
        v-if="market === 'ashare'"
        ref="ashareFormRef"
        :active="show && step === 2"
        @success="handleAshareSuccess"
      />
      <StrategyFormPanel
        v-else-if="market === 'crypto'"
        ref="cryptoFormRef"
        :active="show && step === 2"
        :is-edit="false"
        :show-actions="false"
        @success="handleCryptoSuccess"
      />
    </div>

    <template #footer>
      <div class="wizard-footer">
        <n-button @click="close">取消</n-button>
        <n-button
          v-if="step === 2"
          type="primary"
          :loading="submitting"
          @click="handleSubmit"
        >
          {{ market === 'ashare' ? '保存方案' : '保存策略' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NModal, NButton } from 'naive-ui'
import type { RegimeBacktestRun } from '@/api/modules/strategy/regimeEngine'
import RegimeBacktestFormPanel from '@/components/strategy/regime-backtest/RegimeBacktestFormPanel.vue'
import StrategyFormPanel from '@/components/backtest/StrategyFormPanel.vue'

type Market = 'ashare' | 'crypto'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  'ashare-success': [run: RegimeBacktestRun]
  'crypto-success': []
}>()

const step = ref<1 | 2>(1)
const market = ref<Market | null>(null)
const ashareFormRef = ref<InstanceType<typeof RegimeBacktestFormPanel> | null>(null)
const cryptoFormRef = ref<InstanceType<typeof StrategyFormPanel> | null>(null)

const stepTitle = computed(() => {
  if (market.value === 'ashare') return '新建 A股 Regime 回测'
  if (market.value === 'crypto') return '新建加密策略'
  return '新建回测'
})

const submitting = computed(() => {
  if (market.value === 'ashare') return ashareFormRef.value?.submitting ?? false
  if (market.value === 'crypto') return cryptoFormRef.value?.submitting ?? false
  return false
})

function selectMarket(m: Market) {
  market.value = m
  step.value = 2
}

function goBack() {
  step.value = 1
  market.value = null
}

function resetWizard() {
  step.value = 1
  market.value = null
  ashareFormRef.value?.resetForm()
}

function close() {
  emit('update:show', false)
}

watch(
  () => props.show,
  (v, prev) => {
    if (prev && !v) resetWizard()
  },
)

async function handleSubmit() {
  if (market.value === 'ashare') {
    const ok = await ashareFormRef.value?.submit()
    if (ok) close()
  } else if (market.value === 'crypto') {
    await cryptoFormRef.value?.submit()
  }
}

function handleAshareSuccess(run: RegimeBacktestRun) {
  emit('ashare-success', run)
  close()
}

function handleCryptoSuccess() {
  emit('crypto-success')
  close()
}
</script>

<style scoped>
.market-step-hint {
  margin: 0 0 16px;
  color: var(--color-text-secondary);
  font-size: 14px;
}
.market-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.market-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-border) 12%, transparent);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.market-card:hover {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.market-card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
}
.market-card-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
}
.form-step {
  min-height: 200px;
}
.back-btn {
  margin-bottom: 12px;
}
.wizard-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
