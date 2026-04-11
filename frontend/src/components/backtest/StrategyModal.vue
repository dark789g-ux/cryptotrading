<template>
  <n-modal
    :show="show"
    @update:show="$emit('update:show', $event)"
    :title="isEdit ? '编辑策略' : '新建策略'"
    preset="dialog"
    style="width: 600px"
    :show-icon="false"
    :mask-closable="false"
    @after-leave="handleClose"
  >
    <n-form
      ref="formRef"
      :model="formData"
      :rules="rules"
      label-placement="left"
      label-width="120px"
      require-mark-placement="right-hanging"
      class="strategy-form"
    >
      <n-form-item label="策略名称" path="name">
        <n-input
          v-model:value="formData.name"
          placeholder="留空自动生成"
          clearable
        />
      </n-form-item>

      <n-form-item label="策略类型" path="type">
        <n-select
          v-model:value="formData.type"
          :options="strategyTypes"
          placeholder="选择策略类型"
        />
      </n-form-item>

      <n-form-item label="时间周期" path="params.timeframe">
        <n-select
          v-model:value="formData.params.timeframe"
          :options="timeframeOptions"
          placeholder="选择时间周期"
        />
      </n-form-item>

      <n-divider>资金配置</n-divider>

      <n-form-item label="初始资金" path="params.initial_capital">
        <n-input-number
          v-model:value="formData.params.initial_capital"
          :min="1000"
          :step="10000"
          style="width: 100%"
        />
      </n-form-item>

      <n-form-item label="仓位比例" path="params.position_ratio">
        <n-slider v-model:value="formData.params.position_ratio" :min="0" :max="1" :step="0.05" />
        <span class="param-value">{{ (formData.params.position_ratio * 100).toFixed(0) }}%</span>
      </n-form-item>

      <n-form-item label="最大持仓" path="params.max_positions">
        <n-input-number v-model:value="formData.params.max_positions" :min="1" :max="20" />
      </n-form-item>

      <n-divider>KDJ 参数</n-divider>

      <n-form-item label="K 最大值" path="params.kdj_k_max">
        <n-input-number v-model:value="formData.params.kdj_k_max" :min="0" :max="100" />
      </n-form-item>

      <n-form-item label="D 最大值" path="params.kdj_d_max">
        <n-input-number v-model:value="formData.params.kdj_d_max" :min="0" :max="100" />
      </n-form-item>

      <n-form-item label="J 最大值" path="params.kdj_j_max">
        <n-input-number v-model:value="formData.params.kdj_j_max" :min="-100" :max="100" />
      </n-form-item>

      <n-divider>风控参数</n-divider>

      <n-form-item label="止损因子" path="params.stop_loss_factor">
        <n-slider v-model:value="formData.params.stop_loss_factor" :min="0.5" :max="2" :step="0.1" />
        <span class="param-value">{{ formData.params.stop_loss_factor.toFixed(1) }}</span>
      </n-form-item>

      <n-form-item label="冷却时间(小时)" path="params.cooldown_hours">
        <n-input-number v-model:value="formData.params.cooldown_hours" :min="0" :max="48" />
      </n-form-item>

      <n-divider>回测区间</n-divider>

      <n-form-item label="开始日期" path="params.date_start">
        <n-date-picker
          v-model:formatted-value="formData.params.date_start"
          value-format="yyyy-MM-dd"
          type="date"
          style="width: 100%"
        />
      </n-form-item>

      <n-form-item label="结束日期" path="params.date_end">
        <n-date-picker
          v-model:formatted-value="formData.params.date_end"
          value-format="yyyy-MM-dd"
          type="date"
          style="width: 100%"
        />
      </n-form-item>
    </n-form>

    <template #action>
      <n-button @click="$emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="submitting" @click="handleSubmit">保存</n-button>
    </template>
  </n-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useMessage, NModal, NForm, NFormItem, NInput, NInputNumber, NSelect, NSlider, NDatePicker, NDivider, NButton } from 'naive-ui'
import { strategyApi } from '../../composables/useApi.js'

const props = defineProps({
  show: Boolean,
  isEdit: Boolean,
  strategy: Object
})

const emit = defineEmits(['update:show', 'success'])

const message = useMessage()
const formRef = ref(null)
const submitting = ref(false)

// 策略类型选项
const strategyTypes = ref([])

// 时间周期选项
const timeframeOptions = [
  { label: '1分钟', value: '1m' },
  { label: '5分钟', value: '5m' },
  { label: '15分钟', value: '15m' },
  { label: '1小时', value: '1h' },
  { label: '4小时', value: '4h' },
  { label: '1天', value: '1d' }
]

// 表单数据
const defaultParams = {
  initial_capital: 1000000,
  position_ratio: 0.4,
  max_positions: 2,
  timeframe: '1h',
  date_start: null,
  date_end: null,
  ma_periods: [30, 60, 120, 240],
  kdj_k_max: 200,
  kdj_d_max: 200,
  kdj_j_max: 0,
  stop_loss_factor: 1.0,
  enable_partial_profit: false,
  max_init_loss: 0.01,
  min_risk_reward_ratio: 4.0,
  cooldown_hours: 2,
  consecutive_losses_threshold: 2,
  base_cooldown_candles: 1,
  max_cooldown_candles: 10000,
  consecutive_losses_reduce_on_profit: 2,
  warmup_bars: 240,
  max_backtest_bars: 10000,
  lookback_buffer: 50,
  min_open_cash: 100
}

const formData = ref({
  name: '',
  type: 'ma_kdj',
  params: { ...defaultParams }
})

// 表单验证规则
const rules = {
  'params.timeframe': {
    required: true,
    message: '请选择时间周期',
    trigger: 'change'
  },
  'params.date_start': {
    required: true,
    message: '请选择开始日期',
    trigger: 'change'
  },
  'params.date_end': {
    required: true,
    message: '请选择结束日期',
    trigger: 'change'
  }
}

// 加载策略类型
const loadStrategyTypes = async () => {
  try {
    const types = await strategyApi.getStrategyTypes()
    strategyTypes.value = types.map(t => ({
      label: t.name,
      value: t.id
    }))
  } catch (err) {
    console.error('加载策略类型失败:', err)
  }
}

// 监听编辑数据
watch(() => props.strategy, (val) => {
  if (val && props.isEdit) {
    formData.value = {
      name: val.name || '',
      type: val.type || 'ma_kdj',
      params: { ...defaultParams, ...val.params }
    }
  } else {
    formData.value = {
      name: '',
      type: 'ma_kdj',
      params: { ...defaultParams }
    }
  }
}, { immediate: true })

// 提交表单
const handleSubmit = async () => {
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true
  try {
    const payload = {
      name: formData.value.name || undefined,
      type: formData.value.type,
      params: { ...formData.value.params }
    }

    if (props.isEdit) {
      await strategyApi.updateStrategy(props.strategy.id, payload)
      message.success('更新成功')
    } else {
      await strategyApi.createStrategy(payload)
      message.success('创建成功')
    }

    emit('success')
    emit('update:show', false)
  } catch (err) {
    message.error(err.message)
  } finally {
    submitting.value = false
  }
}

// 关闭后重置
const handleClose = () => {
  formRef.value?.restoreValidation()
  if (!props.isEdit) {
    formData.value = {
      name: '',
      type: 'ma_kdj',
      params: { ...defaultParams }
    }
  }
}

// 初始化
loadStrategyTypes()
</script>

<style scoped>
.strategy-form {
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 12px;
}

.param-value {
  margin-left: 12px;
  color: var(--text-secondary);
  font-size: 14px;
}

:deep(.n-divider) {
  margin: 16px 0;
}
</style>
