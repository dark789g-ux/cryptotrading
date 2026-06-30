<template>
  <div class="feature-label-fields">
    <n-divider title-placement="left">特征 / 标签参数（留空走后端默认）</n-divider>

    <n-form-item label="中性化维度">
      <n-select
        :value="modelValue.neutralize_cols"
        :options="neutralizeOptions"
        clearable
        placeholder="默认（行业+市值）"
        @update:value="(v: NeutralizeCols | null) => update('neutralize_cols', v)"
      />
    </n-form-item>

    <n-form-item label="稳健标准化 robust_z">
      <n-switch
        :value="modelValue.robust_z ?? undefined"
        @update:value="(v: boolean) => update('robust_z', v)"
      />
    </n-form-item>

    <n-form-item label="因子截尾 σ">
      <n-input-number
        :value="modelValue.factor_clip_sigma"
        :min="1.5"
        :max="5.0"
        :step="0.5"
        clearable
        placeholder="3.0"
        @update:value="(v: number | null) => update('factor_clip_sigma', v)"
      />
    </n-form-item>

    <n-form-item label="标签截尾下界" :feedback="winsorizeFeedback" :validation-status="winsorizeStatus">
      <n-input-number
        :value="modelValue.label_winsorize_lo"
        :min="-1.0"
        :max="0"
        :step="0.05"
        clearable
        placeholder="-0.5"
        @update:value="(v: number | null) => update('label_winsorize_lo', v)"
      />
    </n-form-item>

    <n-form-item label="标签截尾上界" :validation-status="winsorizeStatus">
      <n-input-number
        :value="modelValue.label_winsorize_hi"
        :min="0"
        :max="1.0"
        :step="0.05"
        clearable
        placeholder="0.5"
        @update:value="(v: number | null) => update('label_winsorize_hi', v)"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NDivider, NFormItem, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import type { SelectOption } from 'naive-ui'

export type NeutralizeCols = 'none' | 'industry' | 'industry_mv'

/**
 * 仅 E2E（train_e2e）模式有意义；留空（null）= 不传 → 后端用硬编码默认值。
 * label_winsorize_lo / hi 必须同填或同空（区间成对）。
 * fwd_horizon_days / max_hold_days 已移入标签定义（2026-06-05 spec），不再是训练超参。
 */
export interface FeatureLabelModel {
  neutralize_cols: NeutralizeCols | null
  robust_z: boolean | null
  factor_clip_sigma: number | null
  label_winsorize_lo: number | null
  label_winsorize_hi: number | null
}

interface NeutralizeOption extends SelectOption {
  label: string
  value: NeutralizeCols
}

const props = defineProps<{
  modelValue: FeatureLabelModel
}>()
const emit = defineEmits<{
  'update:modelValue': [value: FeatureLabelModel]
}>()

const neutralizeOptions: NeutralizeOption[] = [
  { label: '无中性化', value: 'none' },
  { label: '行业', value: 'industry' },
  { label: '行业+市值', value: 'industry_mv' },
]

/** 区间成对校验：只填一个时报错（lo 与 hi 必须同填或同空）。 */
const winsorizeStatus = computed<'error' | undefined>(() => {
  const loSet = props.modelValue.label_winsorize_lo != null
  const hiSet = props.modelValue.label_winsorize_hi != null
  return loSet !== hiSet ? 'error' : undefined
})
const winsorizeFeedback = computed(() =>
  winsorizeStatus.value === 'error' ? '上下界必须同时填写或同时留空' : undefined,
)

function update<K extends keyof FeatureLabelModel>(key: K, value: FeatureLabelModel[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<style scoped>
.feature-label-fields {
  display: contents;
}
</style>
