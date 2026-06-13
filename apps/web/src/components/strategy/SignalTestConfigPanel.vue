<template>
  <div class="signal-test-config-panel">
    <div class="field-group plan-name">
      <div class="field-label">方案名称</div>
      <div class="field-value">{{ test.name }}</div>
    </div>

    <n-tabs v-model:value="activeTab" type="line" animated display-directive="show:lazy">
      <n-tab-pane name="buy" tab="买入条件">
        <div v-if="test.buyConditions.length === 0" class="empty-hint">无买入条件</div>
        <div v-for="(c, i) in test.buyConditions" :key="i" class="condition-row">
          <span>{{ formatConditionItem(c, targetType) }}</span>
          <FieldHelpTip :field="c.field" />
        </div>
      </n-tab-pane>

      <n-tab-pane name="exit" tab="出场配置">
        <div class="field-group">
          <div class="field-label">出场模式</div>
          <div class="field-value">{{ exitModeText }}</div>
        </div>

        <template v-if="test.exitMode === 'fixed_n'">
          <div class="field-group">
            <div class="field-label">持有天数 N</div>
            <div class="field-value">{{ test.horizonN ?? '—' }}</div>
          </div>
        </template>

        <template v-else-if="test.exitMode === 'strategy'">
          <div class="subsection-label">卖出条件</div>
          <div v-if="!test.exitConditions?.length" class="empty-hint">无卖出条件</div>
          <div v-for="(c, i) in test.exitConditions" :key="i" class="condition-row">
            <span>{{ formatConditionItem(c, targetType) }}</span>
            <FieldHelpTip :field="c.field" />
          </div>
          <div class="field-group">
            <div class="field-label">最长持有天数兜底</div>
            <div class="field-value">{{ test.maxHold ?? '—' }}</div>
          </div>
        </template>

        <template v-else-if="test.exitMode === 'trailing_lock'">
          <div class="field-group">
            <div class="field-label">最长持有天数（可选，留空不封顶）</div>
            <div class="field-value">{{ test.maxHold == null ? '不封顶' : test.maxHold }}</div>
          </div>
        </template>

        <template v-else>
          <!-- phase_lock：两阶段锁定止损，3 参数（null=全默认 0.999/0.999/10） -->
          <div class="field-group">
            <div class="field-label">初始止损系数</div>
            <div class="field-value">{{ test.phaseLockParams?.initFactor ?? '0.999（默认）' }}</div>
          </div>
          <div class="field-group">
            <div class="field-label">锁定止损系数</div>
            <div class="field-value">{{ test.phaseLockParams?.lockFactor ?? '0.999（默认）' }}</div>
          </div>
          <div class="field-group">
            <div class="field-label">初始止损回看根数</div>
            <div class="field-value">{{ test.phaseLockParams?.lookback ?? '10（默认）' }}</div>
          </div>
        </template>
      </n-tab-pane>

      <n-tab-pane name="range" tab="统计区间">
        <div class="field-group">
          <div class="field-label">起止日期</div>
          <div class="field-value">{{ dateRangeText }}</div>
        </div>
      </n-tab-pane>

      <n-tab-pane name="universe" tab="标的池">
        <div class="field-group">
          <div class="field-label">标的范围</div>
          <div class="field-value">{{ universeTypeText }}</div>
        </div>
        <div v-if="test.universe.type === 'list'" class="field-group">
          <div class="field-label">标的列表</div>
          <n-input
            type="textarea"
            :value="tsCodesText"
            readonly
            :rows="4"
            class="ts-codes-textarea"
          />
        </div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NInput, NTabs, NTabPane } from 'naive-ui';
import type { SignalTest } from '../../api/modules/strategy/signalStats';
import { fmtTradeDate, exitModeText as exitModeTextLabel } from './signalStatsFormatters';
import { formatConditionItem } from '../strategy-conditions/conditionFieldMeta';
import FieldHelpTip from '../common/FieldHelpTip.vue';

interface Props {
  test: SignalTest;
}

const props = defineProps<Props>();

const activeTab = ref<'buy' | 'exit' | 'range' | 'universe'>('buy');

/** 信号前向统计当前仅支持 A 股 */
const targetType = 'a-share' as const;

// 出场模式描述标签统一收敛到 signalStatsFormatters，禁止此处硬编码副本
const exitModeText = computed(() => exitModeTextLabel(props.test.exitMode));

const dateRangeText = computed(
  () => `${fmtTradeDate(props.test.dateStart)} ~ ${fmtTradeDate(props.test.dateEnd)}`,
);

const universeTypeText = computed(() =>
  props.test.universe.type === 'all' ? '全市场 A 股' : '指定标的列表',
);

const tsCodesText = computed(() => (props.test.universe.tsCodes ?? []).join('\n'));
</script>

<style scoped>
.signal-test-config-panel {
  padding: 0;
}

.plan-name {
  margin-bottom: 12px;
}

.field-group {
  margin-bottom: 16px;
}

.field-label {
  margin-bottom: 6px;
  font-size: 14px;
  color: var(--n-text-color-2, #666);
}

.field-value {
  font-size: 14px;
  color: var(--n-text-color, #333);
}

.subsection-label {
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--n-text-color-3, #999);
}

.condition-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 12px;
  background: var(--n-color);
  border-radius: 4px;
  font-size: 14px;
}

.empty-hint {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--n-text-color-3, #999);
}

.ts-codes-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
