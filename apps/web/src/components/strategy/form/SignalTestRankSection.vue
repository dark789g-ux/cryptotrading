<template>
  <div>
    <div class="rank-section__head">
      <span class="rank-section__title">入场信号排序</span>
      <span class="rank-section__hint">
        同日候选超额时按综合排序分决定优先级；未配置因子 = 不排序（按 ts_code 升序）。仅启用回测层时生效。
      </span>
    </div>
    <RankSpecEditor
      :factors="model.btRankFactors"
      :disabled="disabled"
      @update:factors="(v: RankFactor[]) => patch({ btRankFactors: v })"
    />
    <div v-if="disabled" class="rank-section__disabled">
      未启用迷你回测层（在「风控与回测」tab 开启）。排序仅在回测层中生效。
    </div>
  </div>
</template>

<script setup lang="ts">
import RankSpecEditor from '../../portfolio-sim/RankSpecEditor.vue'
import type { RankFactor } from '../../../api/modules/strategy/portfolioSim'
import type { SignalTestFormModel } from '../../../composables/strategy/useSignalTestForm'

defineProps<{
  model: SignalTestFormModel
  /** 未启用回测层时排序无意义，禁用编辑。 */
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SignalTestFormModel>): void
}>()

function patch(p: Partial<SignalTestFormModel>) {
  emit('update', p)
}
</script>

<style scoped>
.rank-section__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.rank-section__title {
  font-size: 14px;
  font-weight: 600;
}

.rank-section__hint {
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}

.rank-section__disabled {
  margin-top: 10px;
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}
</style>
