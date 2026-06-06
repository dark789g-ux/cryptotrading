<!--
  TrainE2EFields — 已废弃（2026-06-06 close_adj 纯后复权改造）。
  E2E 模式随 train_e2e run_type 一同删除；训练 modal 改为消费已备 feature_set。
  保留此文件以防历史 import 断链，但不再渲染任何内容。
-->
<template>
  <div />
</template>

<script setup lang="ts">
/**
 * @deprecated 使用 FeatureSetSelect + QuantTrainTriggerModal 新流程。
 */

// 保留 E2EFormModel 类型导出，供可能仍引用它的现存代码平滑过渡。
export interface E2EFormModel {
  factor_version: string
  labelKey: string | null
  new_listing_min_days: number | null
  date_range: [number, number] | null
  model: string
  walk_forward: boolean
  seed: number | null
}
</script>
