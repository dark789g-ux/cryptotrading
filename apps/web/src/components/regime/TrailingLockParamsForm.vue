<template>
  <div class="trailing-lock-params">
    <n-form-item>
      <template #label>
        <span class="tl-label">maxHold <help-tip :text="HELP.maxHold" /></span>
      </template>
      <n-input-number
        :value="params.maxHold"
        :min="1"
        placeholder="空=不限"
        clearable
        style="width: 160px"
        @update:value="(v: number | null) => patch({ maxHold: v })"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <span class="tl-label">止损系数 <help-tip :text="HELP.stopRatio" /></span>
      </template>
      <n-input-number
        :value="params.stopRatio"
        :min="0.001"
        :max="1"
        :step="0.001"
        placeholder="0.999"
        style="width: 160px"
        @update:value="(v: number | null) => patch({ stopRatio: v ?? DEFAULTS.stopRatio })"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <span class="tl-label">保本地板 <help-tip :text="HELP.floorEnabled" /></span>
      </template>
      <n-switch
        :value="params.floorEnabled"
        @update:value="(v: boolean) => patch({ floorEnabled: v })"
      />
    </n-form-item>

    <n-collapse class="tl-advanced">
      <n-collapse-item name="advanced">
        <template #header>
          <n-space align="center" :size="8">
            <span>高级参数</span>
            <n-tag v-if="isCustomized" size="small" type="warning" :bordered="false">已自定义</n-tag>
          </n-space>
        </template>

        <n-form-item>
          <template #label>
            <span class="tl-label">地板系数 <help-tip :text="HELP.floorRatio" /></span>
          </template>
          <n-input-number
            :value="params.floorRatio"
            :min="0.001"
            :max="1"
            :step="0.001"
            :disabled="!params.floorEnabled"
            placeholder="0.999"
            style="width: 160px"
            @update:value="(v: number | null) => patch({ floorRatio: v ?? DEFAULTS.floorRatio })"
          />
        </n-form-item>

        <n-form-item>
          <template #label>
            <span class="tl-label">MA5 需下行 <help-tip :text="HELP.ma5RequireDown" /></span>
          </template>
          <n-switch
            :value="params.ma5RequireDown"
            @update:value="(v: boolean) => patch({ ma5RequireDown: v })"
          />
        </n-form-item>

        <n-button size="small" @click="resetAdvanced">恢复默认</n-button>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h } from 'vue'
import {
  NFormItem,
  NInputNumber,
  NSwitch,
  NCollapse,
  NCollapseItem,
  NButton,
  NSpace,
  NTag,
  NTooltip,
} from 'naive-ui'
import {
  TRAILING_LOCK_DEFAULTS,
  type TrailingLockExitParams,
} from '@/components/regime/trailingLockParams'

const DEFAULTS = TRAILING_LOCK_DEFAULTS

const HELP = {
  maxHold: '可交易持有日上限（停牌不计）。留空表示不设硬上限，仅靠止损/锁定后 MA5 出场。',
  stopRatio: '次日生效止损价 ≈ 基准价 × 该系数（默认 0.999）。越小止损越宽。未锁定时随日低点更新；锁定后冻结。',
  floorEnabled: '仅方案二（买入日收盘≤开盘）有意义：曾收盘站上成本后，止损不低于约「成本 × 地板系数」。',
  floorRatio: '保本地板开启时，地板价 ≈ 成本 × 该系数。关闭保本地板时本项不生效。',
  ma5RequireDown: '锁定后：除「收盘 < MA5」外，是否还要求当日 MA5 低于前一交易日 MA5，才触发离场。',
} as const

const HelpTip = defineComponent({
  name: 'TrailingLockHelpTip',
  props: { text: { type: String, required: true } },
  setup(props) {
    return () =>
      h(
        NTooltip,
        { placement: 'top', style: { maxWidth: '320px' } },
        {
          trigger: () => h('span', { class: 'field-help-icon' }, '?'),
          default: () => props.text,
        },
      )
  },
})

const props = defineProps<{
  params: TrailingLockExitParams
}>()

const emit = defineEmits<{
  'update:params': [TrailingLockExitParams]
}>()

const isCustomized = computed(
  () =>
    props.params.floorRatio !== DEFAULTS.floorRatio ||
    props.params.ma5RequireDown !== DEFAULTS.ma5RequireDown,
)

function patch(partial: Partial<TrailingLockExitParams>) {
  emit('update:params', { ...props.params, ...partial })
}

function resetAdvanced() {
  patch({
    floorRatio: DEFAULTS.floorRatio,
    ma5RequireDown: DEFAULTS.ma5RequireDown,
  })
}
</script>

<style scoped>
.tl-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tl-advanced {
  margin-top: 4px;
  max-width: 420px;
}

:deep(.field-help-icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--ember-neutral, var(--color-text-muted));
  font-size: 10px;
  color: var(--ember-neutral, var(--color-text-muted));
  cursor: help;
  flex-shrink: 0;
}
</style>
