<template>
  <AppModal
    :show="show"
    :title="modalTitle"
    description="名称/描述/状态 可直接改；语义字段（出场规则 / ID / 版本）不可变，改了请新建版本"
    width="min(720px, 96vw)"
    @update:show="emit('update:show', $event)"
  >
    <n-alert v-if="errorText" type="error" :title="errorText" style="margin-bottom: 12px;" />

    <n-form
      v-if="form"
      ref="formRef"
      :model="form"
      label-placement="left"
      label-width="120"
      size="small"
    >
      <!-- 基本信息 -->
      <n-form-item label="策略 ID" required>
        <n-input
          v-model:value="form.strategy_id"
          :disabled="isEditMode"
          placeholder="default_exit（仅小写字母/数字/下划线）"
          data-testid="strategy-edit-id"
        />
      </n-form-item>

      <n-form-item label="版本" required>
        <n-input
          v-model:value="form.strategy_version"
          :disabled="isEditMode"
          placeholder="v1"
          style="width: 120px;"
          data-testid="strategy-edit-version"
        />
      </n-form-item>

      <n-form-item label="名称" required>
        <n-input
          v-model:value="form.name"
          placeholder="例：默认出场策略"
          maxlength="100"
          show-count
          data-testid="strategy-edit-name"
        />
      </n-form-item>

      <n-form-item label="描述">
        <n-input
          v-model:value="form.description"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="可选"
          maxlength="500"
          show-count
          data-testid="strategy-edit-description"
        />
      </n-form-item>

      <!-- 出场规则 -->
      <n-divider title-placement="left">出场规则</n-divider>

      <n-alert
        v-if="isEditMode"
        type="info"
        size="small"
        :bordered="false"
        style="margin-bottom: 10px;"
      >
        出场规则为语义字段，编辑模式下只读。如需修改请「新建版本」（同策略 ID，递增版本号）。
      </n-alert>

      <div :class="{ 'rules-readonly': isEditMode }">
        <ExitRulesEditor
          v-model="form.exit_rules"
          @update:valid="onRulesValid"
        />
      </div>

      <!-- 状态（仅编辑模式展示） -->
      <template v-if="isEditMode">
        <n-divider />
        <n-form-item label="启用">
          <n-switch v-model:value="form.enabled" data-testid="strategy-edit-enabled" />
        </n-form-item>
        <n-form-item label="显示顺序">
          <n-input-number
            v-model:value="form.display_order"
            :min="0"
            :max="9999"
            style="width: 160px;"
          />
        </n-form-item>
      </template>
    </n-form>

    <template #actions>
      <n-button :disabled="submitting" @click="onCancel">取消</n-button>
      <n-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        data-testid="strategy-edit-submit"
        @click="onSubmit"
      >
        {{ isEditMode ? '保存' : '新建' }}
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert, NButton, NDivider, NForm, NFormItem,
  NInput, NInputNumber, NSwitch, useMessage,
} from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import ExitRulesEditor from './ExitRulesEditor.vue'
import { quantApi } from '@/api/modules/quant'
import type { ExitRuleDef, StrategyDefinition } from '@cryptotrading/shared-types'

interface StrategyFormShape {
  strategy_id: string
  strategy_version: string
  name: string
  description: string
  exit_rules: ExitRuleDef[]
  enabled: boolean
  display_order: number
}

const props = defineProps<{
  show: boolean
  /** 编辑模式传已有行；null = 新建模式 */
  strategy: StrategyDefinition | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [item: StrategyDefinition]
}>()

const message = useMessage()

const form = ref<StrategyFormShape | null>(null)
const submitting = ref(false)
const errorText = ref('')
const rulesValid = ref(false)

const isEditMode = computed(() => props.strategy !== null)

const modalTitle = computed(() =>
  isEditMode.value
    ? `编辑策略：${props.strategy!.strategy_id} (${props.strategy!.strategy_version})`
    : '新建策略',
)

function onRulesValid(v: boolean) {
  rulesValid.value = v
}

// 校验（基本信息；exit_rules 由 ExitRulesEditor 上抛 rulesValid）
const idValid = computed(() => /^[a-z0-9_]{1,64}$/.test(form.value?.strategy_id ?? ''))
const versionValid = computed(() => /^v\d+$/.test(form.value?.strategy_version ?? ''))
const nameValid = computed(() => (form.value?.name?.trim().length ?? 0) >= 1)

const canSubmit = computed(() => {
  if (!form.value || submitting.value) return false
  if (!idValid.value || !versionValid.value || !nameValid.value) return false
  // 编辑模式只 PATCH 元数据，不校验 exit_rules（语义字段只读）
  if (isEditMode.value) return true
  return rulesValid.value
})

// 初始化 form
watch(
  () => [props.show, props.strategy] as const,
  ([show, strategy]) => {
    if (show) {
      if (strategy) {
        // 编辑模式：回填（exit_rules 深拷贝，避免直接改父对象）
        form.value = {
          strategy_id: strategy.strategy_id,
          strategy_version: strategy.strategy_version,
          name: strategy.name,
          description: strategy.description ?? '',
          exit_rules: strategy.exit_rules.map((r) => ({ type: r.type, params: { ...r.params } })),
          enabled: strategy.enabled,
          display_order: strategy.display_order,
        }
      } else {
        // 新建模式：空表单（exit_rules 起手为空，由用户在 Editor 里加）
        form.value = {
          strategy_id: '',
          strategy_version: 'v1',
          name: '',
          description: '',
          exit_rules: [],
          enabled: true,
          display_order: 0,
        }
      }
      errorText.value = ''
    } else {
      errorText.value = ''
    }
  },
  { immediate: true },
)

async function onSubmit() {
  if (!canSubmit.value || !form.value) return
  submitting.value = true
  errorText.value = ''
  try {
    if (isEditMode.value && props.strategy) {
      // 编辑模式：PATCH 元数据（不含 exit_rules）
      const res = await quantApi.updateStrategy(
        props.strategy.strategy_id,
        props.strategy.strategy_version,
        {
          name: form.value.name,
          description: form.value.description || null,
          enabled: form.value.enabled,
          display_order: form.value.display_order,
        },
      )
      message.success(`已保存策略 ${res.item.strategy_id}`)
      emit('saved', res.item)
    } else {
      // 新建模式：POST
      const res = await quantApi.createStrategy({
        strategy_id: form.value.strategy_id,
        strategy_version: form.value.strategy_version,
        name: form.value.name,
        description: form.value.description || null,
        exit_rules: form.value.exit_rules,
        display_order: form.value.display_order,
      })
      message.success(`已新建策略 ${res.item.strategy_id}`)
      emit('saved', res.item)
    }
    emit('update:show', false)
  } catch (e) {
    errorText.value = `操作失败：${(e as Error).message}`
  } finally {
    submitting.value = false
  }
}

function onCancel() {
  if (submitting.value) return
  emit('update:show', false)
}

defineExpose({ form, canSubmit })
</script>

<style scoped>
/* 编辑模式下出场规则只读：禁用交互但保留可读 */
.rules-readonly {
  pointer-events: none;
  opacity: 0.7;
}
</style>
