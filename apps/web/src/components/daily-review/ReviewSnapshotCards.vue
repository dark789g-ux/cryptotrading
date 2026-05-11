<template>
  <div class="cards">
    <div class="row">
      <div v-for="ix in snapshot.indices" :key="ix.tsCode" class="card">
        <div class="card-name">{{ ix.name }}</div>
        <div class="card-value">{{ ix.close.toFixed(2) }}</div>
        <div :class="['card-chg', ix.pctChg >= 0 ? 'up' : 'down']">
          {{ ix.pctChg >= 0 ? '+' : '' }}{{ ix.pctChg.toFixed(2) }}%
        </div>
      </div>
    </div>
    <div class="row stats">
      <div class="card">涨家数 <strong>{{ snapshot.updownDist.up }}</strong></div>
      <div class="card">跌家数 <strong>{{ snapshot.updownDist.down }}</strong></div>
      <div class="card up">涨停 <strong>{{ snapshot.limitStats.upCount }}</strong></div>
      <div class="card down">跌停 <strong>{{ snapshot.limitStats.downCount }}</strong></div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ snapshot: any }>()
</script>

<style scoped>
.cards { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
.row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.card {
  background: var(--color-surface-elevated, #1e2028);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
}
.stats .card { text-align: center; font-size: 14px; color: var(--color-text-muted); }
.stats .card strong { font-size: 18px; font-weight: 600; display: block; margin-top: 4px; }
.card-name { font-size: 12px; color: var(--color-text-muted); }
.card-value { font-size: 20px; font-weight: 600; margin-top: 4px; }
.card-chg { font-size: 14px; margin-top: 2px; }
.card-chg.up, .stats .card.up strong { color: #e74c3c; }
.card-chg.down, .stats .card.down strong { color: #27ae60; }
</style>
