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
      label-placement="left"
      label-width="120px"
      class="strategy-form"
    >
      <n-form-item label="策略名称" path="name">
        <n-input v-model:value="formData.name" placeholder="留空自动生成" clearable />
      </n-form-item>

      <n-form-item label="策略类型" path="typeId">
        <n-select v-model:value="formData.typeId" :options="strategyTypeOptions" placeholder="选择策略类型" />
      </n-form-item>

      <n-form-item label="时间周期" path="params.timeframe">
        <n-select v-model:value="formData.params.timeframe" :options="timeframeOptions" />
      </n-form-item>

      <n-divider>资金配置</n-divider>

      <n-form-item label="初始资金">
        <n-input-number v-model:value="formData.params.initialCapital" :min="1000" :step="10000" style="width:100%" />
      </n-form-item>

      <n-form-item label="仓位比例">
        <n-slider v-model:value="formData.params.positionRatio" :min="0.05" :max="1" :step="0.05" />
        <span class="param-value">{{ (formData.params.positionRatio * 100).toFixed(0) }}%</span>
      </n-form-item>

      <n-form-item label="最大持仓">
        <n-input-number v-model:value="formData.params.maxPositions" :min="1" :max="20" />
      </n-form-item>

      <n-divider>KDJ 参数</n-divider>

      <n-form-item label="K 最大值">
        <n-input-number v-model:value="formData.params.kdjKMax" :min="0" :max="200" />
      </n-form-item>

      <n-form-item label="D 最大值">
        <n-input-number v-model:value="formData.params.kdjDMax" :min="0" :max="200" />
      </n-form-item>

      <n-form-item label="J 最大值">
        <n-input-number v-model:value="formData.params.kdjJMax" :min="-100" :max="100" />
      </n-form-item>

      <n-divider>风控参数</n-divider>

      <n-form-item label="止损因子">
        <n-slider v-model:value="formData.params.stopLossFactor" :min="0.5" :max="2" :step="0.1" />
        <span class="param-value">{{ formData.params.stopLossFactor.toFixed(1) }}</span>
      </n-form-item>

      <n-form-item label="最小盈亏比">
        <n-input-number v-model:value="formData.params.minRiskRewardRatio" :min="0.5" :max="20" :step="0.5" />
      </n-form-item>

      <n-form-item label="冷却时间(h)">
        <n-input-number v-model:value="formData.params.cooldownHours" :min="0" :max="48" />
      </n-form-item>

      <n-divider>回测区间</n-divider>

      <n-form-item label="开始日期">
        <n-date-picker v-model:formatted-value="formData.params.dateStart" value-format="yyyy-MM-dd" type="date" style="width:100%" clearable />
      </n-form-item>

      <n-form-item label="结束日期">
        <n-date-picker v-model:formatted-value="formData.params.dateEnd" value-format="yyyy-MM-dd" type="date" style="width:100%" clearable />
      </n-form-item>
    </n-form>

    <template #action>
      <n-button @click="$emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="submitting" @click="handleSubmit">保存</n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { strategyApi } from '../../composables/useApi'

const props = defineProps<{ show: boolean; isEdit: boolean; strategy?: any }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'success'): void }>()

const message = useMessage()
const formRef = ref()
const submitting = ref(false)
const strategyTypeOptions = ref<{ label: string; value: string }[]>([])

const timeframeOptions = [
  { label: '1小时', value: '1h' },
  { label: '4小时', value: '4h' },
  { label: '日线', value: '1d' },
]

const defaultParams = {
  initialCapital: 1000000, positionRatio: 0.4, maxPositions: 2,
  timeframe: '1h', dateStart: '', dateEnd: '',
  kdjKMax: 200, kdjDMax: 200, kdjJMax: 0,
  stopLossFactor: 1.0, minRiskRewardRatio: 4.0,
  cooldownHours: 2, maxInitLoss: 0.01,
}

const makeForm = (s?: any) => ({
  name: s?.name ?? '',
  typeId: s?.typeId ?? 'ma_kdj',
  params: { ...defaultParams, ...(s?.params ?? {}) },
})

const formData = ref(makeForm())

watch(() => props.strategy, (s) => { if (s) formData.value = makeForm(s) }, { immediate: true })
watch(() => props.show, (v) => { if (v && !props.isEdit) formData.value = makeForm() })

const handleSubmit = async () => {
  submitting.value = true
  try {
    const payload = { name: formData.value.name || undefined, typeId: formData.value.typeId, params: formData.value.params }
    if (props.isEdit) {
      await strategyApi.updateStrategy(props.strategy.id, payload)
      message.success('更新成功')
    } else {
      await strategyApi.createStrategy(payload)
      message.success('创建成功')
    }
    emit('success')
    emit('update:show', false)
  } catch (err: any) {
    message.error(err.message)
  } finally {
    submitting.value = false
  }
}

const handleClose = () => {
  if (!props.isEdit) formData.value = makeForm()
}

onMounted(async () => {
  try {
    const types = await strategyApi.getStrategyTypes()
    strategyTypeOptions.value = types.map((t: any) => ({ label: t.name, value: t.id }))
  } catch { /* ignore */ }
})
</script>

<style scoped>
.strategy-form { max-height: 60vh; overflow-y: auto; padding-right: 12px; }
.param-value { margin-left: 12px; color: var(--text-secondary); font-size: 14px; }
:deep(.n-divider) { margin: 16px 0; }
</style>
