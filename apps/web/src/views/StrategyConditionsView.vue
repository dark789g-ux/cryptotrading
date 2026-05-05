<!-- apps/web/src/views/StrategyConditionsView.vue -->
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
import { useStrategyConditionsStore } from '../stores/strategyConditions';
import type { StrategyCondition } from '../api/modules/strategyConditions';
import AppModal from '../components/common/AppModal.vue';
import StrategyConditionBuilder from '../components/strategy-conditions/StrategyConditionBuilder.vue';

const message = useMessage()

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
    title: '创建时间',
    key: 'createdAt',
    render(row: StrategyCondition) {
      return new Date(row.createdAt).toLocaleString();
    },
  },
  {
    title: '操作',
    key: 'actions',
    render(row: StrategyCondition) {
      return h(NSpace, {}, {
        default: () => [
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
});
</script>

<style scoped>
.strategy-conditions-view {
  padding: 16px;
}
</style>
