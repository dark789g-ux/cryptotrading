<!-- apps/web/src/views/strategy/StrategyConditionsView.vue -->
<template>
  <div class="strategy-conditions-view">
    <n-card title="策略条件管理">
      <template #header-extra>
        <n-button type="primary" @click="showBuilder = true">
          <template #icon><n-icon><add-icon /></n-icon></template>
          新建条件组
        </n-button>
      </template>

      <n-data-table
        :columns="columns"
        :data="store.conditions"
        :loading="store.loading"
        :bordered="false"
      />
    </n-card>

    <AppModal
      v-model:show="showBuilder"
      :title="editingId ? '编辑条件组' : '新建条件组'"
      :header-icon="ConstructOutline"
      :description="editingId ? '修改条件组的规则配置' : '定义新的策略条件组，支持多指标组合筛选'"
      width="min(800px, 92vw)"
      :mask-closable="false"
    >
      <StrategyConditionBuilder
        ref="builderRef"
        :edit-id="editingId"
        :initial-data="editingData"
        @save="handleSave"
      />
      <template #actions>
        <n-button @click="showBuilder = false">取消</n-button>
        <n-button type="primary" @click="handleBuilderSave">保存</n-button>
      </template>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import { NCard, NButton, NIcon, NDataTable, NTag, NSpace, NPopconfirm, useMessage } from 'naive-ui';
import { Add as AddIcon, Construct as ConstructOutline, Create as EditIcon, Trash as TrashIcon } from '@vicons/ionicons5';
import { useRouter } from 'vue-router';
import { useStrategyConditionsStore } from '../../stores/strategyConditions';
import type { StrategyCondition } from '../../api/modules/strategy/strategyConditions';
import AppModal from '../../components/common/AppModal.vue';
import StrategyConditionBuilder from '../../components/strategy-conditions/StrategyConditionBuilder.vue';
import { formatUTCDateTime } from '../../components/symbols/a-shares/aSharesFormatters';

const message = useMessage()
const router = useRouter()

const store = useStrategyConditionsStore();
const showBuilder = ref(false);
const editingId = ref<string | undefined>();
const builderRef = ref<InstanceType<typeof StrategyConditionBuilder> | null>(null);

const editingData = computed(() => {
  if (!editingId.value) return undefined;
  const condition = store.conditions.find(c => c.id === editingId.value);
  return condition
    ? {
        name: condition.name,
        targetType: condition.targetType,
        conditions: condition.conditions,
      }
    : undefined;
});

function handleViewResults(row: StrategyCondition) {
  router.push({ path: '/symbols', query: { strategyId: row.id } });
}

const columns = [
  {
    title: '名称',
    key: 'name',
  },
  {
    title: '目标类型',
    key: 'targetType',
    render(row: StrategyCondition) {
      return h(NTag, { type: row.targetType === 'a-share' ? 'info' : 'warning' }, {
        default: () => row.targetType === 'a-share' ? 'A 股' : '加密货币',
      });
    },
  },
  {
    title: '条件数',
    key: 'conditions',
    render(row: StrategyCondition) {
      return row.conditions.length;
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render(row: StrategyCondition) {
      const status = store.runStatuses.get(row.id);
      if (!status || status.freshness === 'never') {
        return h(NTag, { type: 'default', size: 'small' }, { default: () => '未运行' });
      }
      if (status.freshness === 'running') {
        return h(NTag, { type: 'info', size: 'small' }, { default: () => '运行中' });
      }
      if (status.freshness === 'failed') {
        return h(NTag, { type: 'error', size: 'small' }, { default: () => '失败' });
      }
      if (status.freshness === 'fresh') {
        return h(NTag, { type: 'success', size: 'small' }, { default: () => '最新' });
      }
      return h(NTag, { type: 'warning', size: 'small' }, { default: () => '过期' });
    },
  },
  {
    title: '最新运行时间',
    key: 'lastRun',
    width: 160,
    align: 'left' as const,
    render(row: StrategyCondition) {
      const lr = row.lastRun;
      if (!lr) {
        return h('span', { style: { color: '#999' } }, '—');
      }
      if (lr.status === 'running') {
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#666' } }, [
          h('span', {
            class: 'last-run-pulse',
            style: {
              display: 'inline-block',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: '#2080f0',
            },
          }),
          `${formatUTCDateTime(lr.startedAt)} · 运行中`,
        ]);
      }
      if (lr.status === 'failed') {
        const ts = lr.completedAt ?? lr.startedAt;
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#d03050' } }, [
          formatUTCDateTime(ts),
          h(NTag, { type: 'error', size: 'small', round: true }, { default: () => '失败' }),
        ]);
      }
      // success / completed / 其它已结束状态
      if (lr.completedAt) {
        return formatUTCDateTime(lr.completedAt);
      }
      return formatUTCDateTime(lr.startedAt);
    },
  },
  {
    title: '创建时间',
    key: 'createdAt',
    render(row: StrategyCondition) {
      return formatUTCDateTime(row.createdAt);
    },
  },
  {
    title: '操作',
    key: 'actions',
    render(row: StrategyCondition) {
      const isRunning = store.runningId === row.id;
      const progress = store.runProgress.get(row.id);
      const status = store.runStatuses.get(row.id);

      return h(NSpace, { vertical: true, size: 2 }, {
        default: () => [
          h(NSpace, { size: 4 }, {
            default: () => [
              h(NButton, {
                size: 'small',
                type: 'primary',
                loading: isRunning,
                disabled: isRunning,
                onClick: () => store.startRun(row.id),
              }, {
                default: () => isRunning ? '运行中' : '运行',
              }),
              h(NButton, {
                size: 'small',
                onClick: () => {
                  editingId.value = row.id;
                  showBuilder.value = true;
                },
              }, {
                icon: () => h(NIcon, null, { default: () => h(EditIcon) }),
                default: () => '编辑',
              }),
              h(NPopconfirm, {
                onPositiveClick: () => store.deleteCondition(row.id),
              }, {
                trigger: () => h(NButton, {
                  size: 'small',
                  type: 'error',
                }, {
                  icon: () => h(NIcon, null, { default: () => h(TrashIcon) }),
                  default: () => '删除',
                }),
                default: () => '确定删除该条件组？',
              }),
            ],
          }),
          isRunning && progress
            ? h('div', { style: { fontSize: '12px', color: '#666' } },
                `扫描 ${progress.progressScanned}/${progress.progressTotal}`)
            : null,
          !isRunning && status && (status.freshness === 'fresh' || status.freshness === 'stale') && status.totalHits > 0
            ? h(NButton, {
                size: 'tiny',
                text: true,
                type: 'info',
                onClick: () => handleViewResults(row),
              }, {
                default: () => `查看 ${status.totalHits} 个命中结果`,
              })
            : null,
        ],
      });
    },
  },
];

async function handleSave(data: { name: string; targetType: 'crypto' | 'a-share'; conditions: any[] }) {
  try {
    if (editingId.value) {
      await store.updateCondition(editingId.value, data);
    } else {
      await store.createCondition(data);
    }
    showBuilder.value = false;
    editingId.value = undefined;
    message.success('保存成功');
  } catch (error) {
    message.error('保存失败');
  }
}

function handleBuilderSave() {
  builderRef.value?.submit();
}

onMounted(() => {
  store.fetchConditions();
  store.fetchLastRunStatus();
});
</script>

<style scoped>
.strategy-conditions-view {
  padding: 16px;
}

:deep(.last-run-pulse) {
  animation: last-run-pulse 1.2s ease-in-out infinite;
}

@keyframes last-run-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
