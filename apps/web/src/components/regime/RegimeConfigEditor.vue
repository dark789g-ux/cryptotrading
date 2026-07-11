<template>
  <div class="regime-config-editor">
    <n-form v-if="!embedded" label-placement="left" label-width="80" :model="form">
      <n-form-item label="版本">
        <n-input-number
          v-model:value="form.version"
          :min="1"
          :max="9999"
          style="width: 120px"
        />
      </n-form-item>
      <n-form-item label="备注">
        <n-input
          v-model:value="form.note"
          placeholder="配置备注（可选）"
          style="max-width: 400px"
        />
      </n-form-item>
    </n-form>

    <regime-quadrant-chrome
      v-model:active-tab="activeTab"
      :quadrants="form.quadrants"
      :overlap-warnings="overlapWarnings"
      :is-single-quadrant="isSingleQuadrant"
      @add="addQuadrant"
      @import="handleImportQuadrants"
      @remove="removeQuadrant"
    >
      <template #default="{ quadrant: q }">
        <regime-quadrant-form-body :quadrant="q" :is-single-quadrant="isSingleQuadrant" />
      </template>
    </regime-quadrant-chrome>

    <div v-if="!embedded" class="regime-config-editor__actions">
      <n-button @click="emit('cancel')">取消</n-button>
      <n-button type="primary" :loading="saving" @click="onSave">保存</n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { NForm, NFormItem, NInput, NInputNumber, NButton } from 'naive-ui'
import RegimeQuadrantChrome from '@/components/regime/RegimeQuadrantChrome.vue'
import RegimeQuadrantFormBody from '@/components/regime/RegimeQuadrantFormBody.vue'
import { useRegimeConfigForm } from '@/components/regime/useRegimeConfigForm'
import type {
  RegimeStrategyConfig,
  CreateRegimeConfigDto,
} from '@/api/modules/strategy/regimeEngine'

interface Props {
  initialData?: RegimeStrategyConfig | null
  mode: 'create' | 'edit' | 'duplicate'
  /** true → 隐藏版本号、备注、底部保存（由父级提交） */
  embedded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  initialData: null,
  embedded: false,
})

const emit = defineEmits<{
  save: [dto: CreateRegimeConfigDto]
  cancel: []
}>()

const {
  form,
  activeTab,
  saving,
  isSingleQuadrant,
  overlapWarnings,
  addQuadrant,
  handleImportQuadrants,
  removeQuadrant,
  handleSave,
  validateAndGetConfig,
} = useRegimeConfigForm({
  initialData: toRef(props, 'initialData'),
  mode: toRef(props, 'mode'),
})

function onSave() {
  handleSave((dto) => emit('save', dto))
}

defineExpose({ validateAndGetConfig })
</script>

<style scoped>
.regime-config-editor {
  padding: 4px 0;
}

.regime-config-editor__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
