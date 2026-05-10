<!-- apps/web/src/components/money-flow/FlowTrendModal.vue -->
<template>
  <AppModal
    :show="visible"
    :title="`${entityName} — 详情`"
    width="min(720px, 92vw)"
    @update:show="$emit('update:visible', $event)"
  >
    <n-tabs v-model:value="activeTab" type="line" animated>
      <n-tab-pane name="trend" tab="趋势">
        <div class="trend-modal-body">
          <FlowDateControl
            :hide-mode-toggle="false"
            default-mode="range"
            :default-range-days="30"
            @change="onDateChange"
          />
          <FlowTrendChart :rows="chartRows" />
        </div>
      </n-tab-pane>

      <n-tab-pane v-if="showMembersTab" name="members" tab="成分股">
        <div class="members-body">
          <n-spin :show="membersLoading">
            <n-data-table
              :columns="memberColumns"
              :data="memberRows"
              :max-height="400"
              size="small"
              :pagination="{ pageSize: 50 }"
            />
            <div v-if="!membersLoading && !memberRows.length" class="empty-state">
              暂无成分股数据，请先同步资金流数据。
            </div>
          </n-spin>
        </div>
      </n-tab-pane>
    </n-tabs>

    <template #actions>
      <n-button @click="$emit('update:visible', false)">关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'FlowTrendModal' })

import { h, ref, watch } from 'vue'
import { NButton, NDataTable, NSpin, NTabPane, NTabs } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendChart from './FlowTrendChart.vue'
import { moneyFlowApi, type MoneyFlowMemberRow, type MoneyFlowQueryParams } from '@/api/modules/moneyFlow'
import type { BarChartRow } from './money-flow.types'

const props = withDefaults(defineProps<{
  visible: boolean
  tsCode: string
  entityName: string
  fetchFn: (params: MoneyFlowQueryParams) => Promise<BarChartRow[]>
  showMembersTab?: boolean
}>(), {
  showMembersTab: false,
})

defineEmits<{
  'update:visible': [value: boolean]
}>()

const activeTab = ref('trend')
const chartRows = ref<BarChartRow[]>([])
const loading = ref(false)
let skipNextEmit = false

// 成分股相关
const memberRows = ref<MoneyFlowMemberRow[]>([])
const membersLoading = ref(false)
let membersLoaded = false

const memberColumns: DataTableColumns<MoneyFlowMemberRow> = [
  {
    title: '#',
    key: 'index',
    width: 50,
    render: (_row, index) => h('span', {}, String(index + 1)),
  },
  { title: '代码', key: 'conCode', width: 120 },
  { title: '名称', key: 'conName', width: 150 },
]

async function loadLatest() {
  loading.value = true
  try {
    const data = await props.fetchFn({ ts_code: props.tsCode, limit: 30 })
    chartRows.value = [...data].reverse()
  } catch {
    chartRows.value = []
  } finally {
    loading.value = false
  }
}

async function loadByDate(params: MoneyFlowQueryParams) {
  loading.value = true
  try {
    chartRows.value = await props.fetchFn({ ...params, ts_code: props.tsCode })
  } catch {
    chartRows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  if (skipNextEmit) {
    skipNextEmit = false
    return
  }
  loadByDate(params)
}

async function loadMembers() {
  if (membersLoaded) return
  membersLoading.value = true
  try {
    memberRows.value = await moneyFlowApi.getMembers(props.tsCode)
    membersLoaded = true
  } catch {
    memberRows.value = []
  } finally {
    membersLoading.value = false
  }
}

watch(() => props.visible, (v) => {
  if (v) {
    chartRows.value = []
    memberRows.value = []
    membersLoaded = false
    activeTab.value = 'trend'
    skipNextEmit = true
    loadLatest()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'members' && props.showMembersTab) {
    loadMembers()
  }
})
</script>

<style scoped>
.trend-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.members-body {
  min-height: 200px;
}
.empty-state {
  color: var(--color-text-muted);
  text-align: center;
  padding: 40px;
}
</style>
