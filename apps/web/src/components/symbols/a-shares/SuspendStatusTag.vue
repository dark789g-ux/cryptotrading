<template>
  <n-tooltip v-if="show" :disabled="!hasTooltip">
    <template #trigger>
      <n-tag size="small" type="warning" :bordered="false">{{ label }}</n-tag>
    </template>
    {{ tooltipText }}
  </n-tooltip>
</template>

<script setup lang="ts">
defineOptions({ name: 'SuspendStatusTag' })

import { computed } from 'vue'
import { NTag, NTooltip } from 'naive-ui'
import { buildSuspendTooltip, isSuspended } from './suspendDisplay'
import type { AShareSuspendStatus } from '@/api/modules/market/aShares'

const props = withDefaults(
  defineProps<{
    status?: AShareSuspendStatus
    sinceDate?: string | null
    timing?: string | null
    variant?: 'list' | 'toolbar'
  }>(),
  {
    status: 'none',
    sinceDate: null,
    timing: null,
    variant: 'list',
  },
)

const show = computed(() => isSuspended(props.status))

const label = computed(() => (props.variant === 'toolbar' ? '停牌中' : '停牌'))

const tooltipText = computed(() => buildSuspendTooltip(props.sinceDate, props.timing))

const hasTooltip = computed(() => tooltipText.value.length > 0)
</script>
