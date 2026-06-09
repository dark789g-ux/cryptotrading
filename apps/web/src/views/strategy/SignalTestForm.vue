<template>
  <n-form ref="formRef" :model="form" label-placement="top">
    <!-- 方案名称 -->
    <n-form-item label="方案名称" path="name" :rule="{ required: true, message: '请输入方案名称' }">
      <n-input v-model:value="form.name" placeholder="输入方案名称" maxlength="100" show-count />
    </n-form-item>

    <!-- 买入条件 -->
    <n-divider>买入条件</n-divider>
    <condition-rows
      v-model:conditions="form.buyConditions"
      target-type="a-share"
      default-operator="gt"
    />

    <!-- 出场配置 -->
    <n-divider>出场配置</n-divider>
    <n-form-item label="出场模式">
      <n-radio-group v-model:value="form.exitMode">
        <n-radio value="fixed_n">固定 N 个交易日</n-radio>
        <n-radio value="strategy">卖出条件命中</n-radio>
        <n-radio value="trailing_lock">波段跟踪止损</n-radio>
      </n-radio-group>
    </n-form-item>

    <template v-if="form.exitMode === 'fixed_n'">
      <n-form-item
        label="持有天数 N"
        path="horizonN"
        :rule="{ type: 'number', required: true, min: 1, message: '请输入 ≥1 的正整数' }"
      >
        <n-input-number v-model:value="form.horizonN" :min="1" :precision="0" style="width: 140px" />
      </n-form-item>
    </template>

    <template v-else-if="form.exitMode === 'strategy'">
      <n-divider dashed>卖出条件</n-divider>
      <condition-rows
        v-model:conditions="form.exitConditions"
        target-type="a-share"
        default-operator="gt"
      />
      <n-form-item
        label="最长持有天数兜底"
        path="maxHold"
        :rule="{ type: 'number', required: true, min: 1, message: '请输入 ≥1 的正整数' }"
      >
        <n-input-number v-model:value="form.maxHold" :min="1" :precision="0" style="width: 140px" />
      </n-form-item>
    </template>

    <template v-else>
      <!-- trailing_lock：波段跟踪止损，无卖出条件编辑器，maxHold 可选 -->
      <n-form-item
        label="最长持有天数（可选，留空不封顶）"
        path="maxHold"
        :rule="{ type: 'number', min: 1, message: '请输入 ≥1 的正整数' }"
      >
        <n-input-number
          v-model:value="form.maxHold"
          :min="1"
          :precision="0"
          clearable
          placeholder="留空不封顶"
          style="width: 200px"
        />
      </n-form-item>
    </template>

    <!-- 统计区间 -->
    <n-divider>统计区间</n-divider>
    <n-form-item label="起止日期" path="dateRange" :rule="dateRangeRule">
      <n-date-picker
        v-model:value="form.dateRange"
        type="daterange"
        clearable
        style="width: 100%"
        :is-date-disabled="() => false"
      />
    </n-form-item>

    <!-- 标的池 -->
    <n-divider>标的池</n-divider>
    <n-form-item label="标的范围">
      <n-radio-group v-model:value="form.universeType">
        <n-radio value="all">全市场 A 股</n-radio>
        <n-radio value="list">指定标的列表</n-radio>
      </n-radio-group>
    </n-form-item>
    <n-form-item
      v-if="form.universeType === 'list'"
      label="标的列表"
      path="tsCodes"
      :rule="tsCodesRule"
    >
      <n-input
        v-model:value="form.tsCodesText"
        type="textarea"
        :rows="4"
        placeholder="每行或逗号分隔输入 ts_code，如 000001.SZ"
      />
    </n-form-item>
  </n-form>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NForm,
  NFormItem,
  NDivider,
  NInput,
  NInputNumber,
  NRadioGroup,
  NRadio,
  NDatePicker,
  useMessage,
  type FormInst,
} from 'naive-ui'
import type { FormItemRule } from 'naive-ui'
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions'
import type {
  SignalTest,
  CreateSignalTestDto,
  SignalTestExitMode,
} from '../../api/modules/strategy/signalStats'
import ConditionRows from '../../components/strategy-conditions/ConditionRows.vue'

// ── Main form ─────────────────────────────────────────────────────────────────

interface Props {
  initialData?: SignalTest
}

const props = defineProps<Props>()

const emit = defineEmits<{
  submit: [dto: CreateSignalTestDto]
}>()

const message = useMessage()
const formRef = ref<FormInst | null>(null)

/** Parse YYYYMMDD string to local midnight ms for n-date-picker */
function parseDateStr(s: string): number {
  const y = parseInt(s.slice(0, 4), 10)
  const m = parseInt(s.slice(4, 6), 10) - 1
  const d = parseInt(s.slice(6, 8), 10)
  return new Date(y, m, d).getTime()
}

/** Format local midnight ms to YYYYMMDD string */
function formatDateMs(ms: number): string {
  const dt = new Date(ms)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function buildDefaultRange(): [number, number] {
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setFullYear(start.getFullYear() - 2)
  return [start.getTime(), end.getTime()]
}

const form = ref({
  name: '',
  buyConditions: [] as StrategyConditionItem[],
  exitMode: 'fixed_n' as SignalTestExitMode,
  horizonN: 5 as number | null,
  exitConditions: [] as StrategyConditionItem[],
  maxHold: 20 as number | null,
  dateRange: buildDefaultRange() as [number, number] | null,
  universeType: 'all' as 'all' | 'list',
  tsCodesText: '',
})

watch(
  () => props.initialData,
  (data) => {
    if (!data) return
    form.value.name = data.name
    form.value.buyConditions = data.buyConditions.map((c) => ({ ...c }))
    form.value.exitMode = data.exitMode
    form.value.horizonN = data.horizonN
    form.value.exitConditions = (data.exitConditions ?? []).map((c) => ({ ...c }))
    form.value.maxHold = data.maxHold
    form.value.universeType = data.universe.type
    form.value.tsCodesText = (data.universe.tsCodes ?? []).join('\n')
    if (data.dateStart && data.dateEnd) {
      form.value.dateRange = [parseDateStr(data.dateStart), parseDateStr(data.dateEnd)]
    }
  },
  { immediate: true },
)

// 切换出场模式时复位 maxHold：trailing_lock 默认空=不封顶（spec 03 §1.3）；
// strategy maxHold 必填，从空切回时回填默认 20 避免立刻校验报错。
// 默认懒执行（不 immediate）——只响应用户切换动作，不冲掉初始化回填的 initialData.maxHold。
watch(
  () => form.value.exitMode,
  (mode) => {
    if (mode === 'trailing_lock') {
      form.value.maxHold = null
    } else if (mode === 'strategy' && form.value.maxHold == null) {
      form.value.maxHold = 20
    }
  },
)

const dateRangeRule: FormItemRule = {
  required: true,
  validator: () => {
    if (!form.value.dateRange) return new Error('请选择统计区间')
    return true
  },
}

const tsCodesRule: FormItemRule = {
  required: true,
  validator: () => {
    if (form.value.universeType === 'list' && parseTsCodes().length === 0)
      return new Error('请输入至少一个标的代码')
    return true
  },
}

function parseTsCodes(): string[] {
  return form.value.tsCodesText
    .split(/[\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function handleSubmit() {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }

  if (form.value.buyConditions.length === 0) {
    message.warning('请至少添加一个买入条件')
    return
  }

  if (form.value.exitMode === 'strategy' && form.value.exitConditions.length === 0) {
    message.warning('卖出条件模式下请至少添加一个卖出条件')
    return
  }

  if (!form.value.dateRange) {
    message.warning('请选择统计区间')
    return
  }

  const [startMs, endMs] = form.value.dateRange
  const dateStart = formatDateMs(startMs)
  const dateEnd = formatDateMs(endMs)

  const dto: CreateSignalTestDto = {
    name: form.value.name,
    buyConditions: form.value.buyConditions,
    exitMode: form.value.exitMode,
    universe:
      form.value.universeType === 'all'
        ? { type: 'all' }
        : { type: 'list', tsCodes: parseTsCodes() },
    dateStart,
    dateEnd,
  }

  if (form.value.exitMode === 'fixed_n') {
    dto.horizonN = form.value.horizonN ?? undefined
  } else if (form.value.exitMode === 'strategy') {
    dto.exitConditions = form.value.exitConditions
    dto.maxHold = form.value.maxHold ?? undefined
  } else {
    // trailing_lock: 无 exitConditions、无 horizonN，maxHold 可选（留空不封顶）
    dto.maxHold = form.value.maxHold ?? undefined
  }

  emit('submit', dto)
}

defineExpose({ submit: handleSubmit })
</script>

<style scoped>
.condition-rows {
  padding: 0;
}
</style>
