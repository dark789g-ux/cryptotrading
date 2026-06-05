<template>
  <div class="exit-rules-editor">
    <div class="editor-header">
      <span class="editor-title">出场规则（按顺序判定，命中即出场）</span>
      <span class="editor-hint">必须含一条「最大持仓」；同类型至多一条</span>
    </div>

    <n-spin :show="metaLoading">
      <n-alert
        v-if="metaError"
        type="error"
        :title="metaError"
        size="small"
        style="margin-bottom: 8px;"
      />

      <div v-if="modelValue.length === 0" class="empty-rules">
        尚无规则，点击下方「添加规则」
      </div>

      <ExitRuleRow
        v-for="(rule, idx) in modelValue"
        :key="idx"
        :rule="rule"
        :index="idx"
        :total="modelValue.length"
        :all-meta="allMeta"
        :used-types="usedTypesExcluding(idx)"
        @update:rule="(v) => onRuleUpdate(idx, v)"
        @move-up="onMoveUp"
        @move-down="onMoveDown"
        @remove="onRemove"
      />

      <div class="editor-footer">
        <n-button
          size="small"
          dashed
          :disabled="!canAddMore"
          data-testid="exit-rule-add"
          @click="onAdd"
        >
          + 添加规则
        </n-button>
        <span v-if="!canAddMore && allMeta.length > 0" class="footer-hint">
          所有规则类型已添加完毕
        </span>
      </div>

      <ul v-if="errors.length > 0" class="error-list" data-testid="exit-rule-errors">
        <li v-for="(e, i) in errors" :key="i">⚠ {{ e }}</li>
      </ul>
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NSpin } from 'naive-ui'
import type {
  ExitRuleDef,
  ExitRuleType,
  ExitRuleTypeMeta,
} from '@cryptotrading/shared-types'
import { quantApi } from '@/api/modules/quant'
import ExitRuleRow from './ExitRuleRow.vue'
import {
  buildDefaultRule,
  indexMetaByType,
  validateExitRules,
} from './exitRulesValidation'

const props = defineProps<{
  /** 当前 exit_rules 列表（受控，父持有真值） */
  modelValue: ExitRuleDef[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: ExitRuleDef[]]
  /** 校验通过/失败 + 错误列表上抛父组件，用于禁用「保存」 */
  'update:valid': [valid: boolean]
}>()

const allMeta = ref<ExitRuleTypeMeta[]>([])
const metaLoading = ref(false)
const metaError = ref('')

const metaByType = computed(() => indexMetaByType(allMeta.value))

const errors = computed(() => {
  // meta 未加载完成时不报范围错（避免误判），仅在有 meta 后校验
  if (allMeta.value.length === 0) return []
  return validateExitRules(props.modelValue, metaByType.value)
})

const isValid = computed(() => allMeta.value.length > 0 && errors.value.length === 0)

// 已被占用的 type 全集（添加新规则时从可选列表剔除）
const usedTypes = computed<ExitRuleType[]>(() => props.modelValue.map((r) => r.type))

const canAddMore = computed(
  () => allMeta.value.length > 0 && usedTypes.value.length < allMeta.value.length,
)

/** 某行之外其它行占用的 type（供该行 type 下拉置灰用） */
function usedTypesExcluding(idx: number): ExitRuleType[] {
  return props.modelValue.filter((_, i) => i !== idx).map((r) => r.type)
}

function emitRules(rules: ExitRuleDef[]) {
  emit('update:modelValue', rules)
}

function onRuleUpdate(idx: number, v: ExitRuleDef) {
  const next = props.modelValue.slice()
  next.splice(idx, 1, v)
  emitRules(next)
}

function onMoveUp(idx: number) {
  if (idx <= 0) return
  const next = props.modelValue.slice()
  ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
  emitRules(next)
}

function onMoveDown(idx: number) {
  if (idx >= props.modelValue.length - 1) return
  const next = props.modelValue.slice()
  ;[next[idx + 1], next[idx]] = [next[idx], next[idx + 1]]
  emitRules(next)
}

function onRemove(idx: number) {
  const next = props.modelValue.slice()
  next.splice(idx, 1)
  emitRules(next)
}

function onAdd() {
  // 选第一个尚未占用的 type
  const avail = allMeta.value.find((m) => !usedTypes.value.includes(m.type))
  if (!avail) return
  emitRules([...props.modelValue, buildDefaultRule(avail)])
}

async function loadMeta() {
  metaLoading.value = true
  metaError.value = ''
  try {
    const res = await quantApi.listExitRuleTypes()
    allMeta.value = res.items ?? []
  } catch (e) {
    metaError.value = `加载出场规则类型失败：${(e as Error).message}`
    allMeta.value = []
  } finally {
    metaLoading.value = false
  }
}

// 校验结果变化时上抛父组件
watch(isValid, (v) => emit('update:valid', v), { immediate: true })

onMounted(loadMeta)

defineExpose({ loadMeta, errors, isValid })
</script>

<style scoped>
.exit-rules-editor {
  margin-bottom: 8px;
}
.editor-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.editor-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.editor-hint {
  font-size: 12px;
  color: var(--color-text-muted);
}
.empty-rules {
  padding: 12px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
  border: 1px dashed color-mix(in srgb, var(--color-border) 55%, transparent);
  border-radius: 8px;
  margin-bottom: 8px;
}
.editor-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.footer-hint {
  font-size: 12px;
  color: var(--color-text-muted);
}
.error-list {
  margin: 10px 0 0;
  padding: 8px 10px 8px 12px;
  list-style: none;
  font-size: 12px;
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
  border-radius: 6px;
  border-left: 2px solid color-mix(in srgb, var(--color-error) 50%, transparent);
}
.error-list li {
  line-height: 1.6;
}
</style>
