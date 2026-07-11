<template>
  <RegimeBucketSection :quadrant="quadrant" :is-single-quadrant="isSingleQuadrant" />
  <template v-if="quadrant.action === 'trade'">
    <RegimeEntrySection :quadrant="quadrant" />
    <RegimeExitSection :quadrant="quadrant" />
  </template>
</template>

<script setup lang="ts">
import RegimeBucketSection from '@/components/regime/RegimeBucketSection.vue'
import RegimeEntrySection from '@/components/regime/RegimeEntrySection.vue'
import RegimeExitSection from '@/components/regime/RegimeExitSection.vue'
import type { QuadrantEntry } from '@/api/modules/strategy/regimeEngine'

defineProps<{
  quadrant: QuadrantEntry
  isSingleQuadrant: boolean
}>()
</script>
