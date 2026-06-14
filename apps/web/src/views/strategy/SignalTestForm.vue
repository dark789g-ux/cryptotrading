<template>
  <n-form ref="formRef" :model="form" label-placement="top">
    <n-tabs v-model:value="activeTab" type="line" animated display-directive="show">
      <n-tab-pane name="basics" tab="基础信息">
        <SignalTestBasicSection
          :model="form"
          :parse-ts-codes="parseTsCodes"
          @update="applyPatch"
        />
      </n-tab-pane>

      <n-tab-pane name="baseConfig" tab="基础配置">
        <SignalTestBaseConfigSection :model="form" @update="applyPatch" />
      </n-tab-pane>

      <n-tab-pane name="entry" tab="入场信号">
        <n-divider>买入条件</n-divider>
        <condition-rows
          :conditions="form.buyConditions"
          target-type="a-share"
          default-operator="gt"
          @update:conditions="(v) => applyPatch({ buyConditions: v })"
        />
      </n-tab-pane>

      <n-tab-pane name="rank" tab="入场排序">
        <SignalTestRankSection
          :model="form"
          :disabled="!form.enableBacktest"
          @update="applyPatch"
        />
      </n-tab-pane>

      <n-tab-pane name="capital" tab="资金与仓位">
        <SignalTestCapitalSection
          :model="form"
          :disabled="!form.enableBacktest"
          @update="applyPatch"
        />
      </n-tab-pane>

      <n-tab-pane name="exit" tab="止损与出场">
        <SignalTestExitSection :model="form" @update="applyPatch" />
      </n-tab-pane>

      <n-tab-pane name="riskBacktest" tab="风控与回测">
        <SignalTestRiskSection :model="form" @update="applyPatch" />
      </n-tab-pane>
    </n-tabs>
  </n-form>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { NForm, NTabs, NTabPane, NDivider, useMessage, type FormInst } from 'naive-ui'
import type {
  SignalTest,
  CreateSignalTestDto,
} from '../../api/modules/strategy/signalStats'
import ConditionRows from '../../components/strategy-conditions/ConditionRows.vue'
import SignalTestBasicSection from '../../components/strategy/form/SignalTestBasicSection.vue'
import SignalTestBaseConfigSection from '../../components/strategy/form/SignalTestBaseConfigSection.vue'
import SignalTestRankSection from '../../components/strategy/form/SignalTestRankSection.vue'
import SignalTestCapitalSection from '../../components/strategy/form/SignalTestCapitalSection.vue'
import SignalTestExitSection from '../../components/strategy/form/SignalTestExitSection.vue'
import SignalTestRiskSection from '../../components/strategy/form/SignalTestRiskSection.vue'
import {
  useSignalTestForm,
  type SignalTestFormModel,
} from '../../composables/strategy/useSignalTestForm'

interface Props {
  initialData?: SignalTest
  prefillData?: SignalTest
}

const props = defineProps<Props>()

const emit = defineEmits<{
  submit: [dto: CreateSignalTestDto]
}>()

const message = useMessage()
const formRef = ref<FormInst | null>(null)
const activeTab = ref('basics')

const { form, parseTsCodes, buildDto } = useSignalTestForm(
  { get value() { return props.initialData } },
  { get value() { return props.prefillData } },
)

/** 子组件 patch 统一回写 form（单一可变源在本壳，子组件无状态）。 */
function applyPatch(p: Partial<SignalTestFormModel>) {
  Object.assign(form.value, p)
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

  emit('submit', buildDto())
}

defineExpose({ submit: handleSubmit })
</script>

<style scoped>
.condition-rows {
  padding: 0;
}
</style>
