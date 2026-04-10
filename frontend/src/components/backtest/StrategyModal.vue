<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>新建回测策略</h3>
        <button class="modal-close" @click="$emit('close')"><X :size="18" /></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">策略名称</label>
          <input class="form-input" v-model="form.name" placeholder="自动生成，可编辑" />
        </div>
        <div class="form-group">
          <label class="form-label">策略类型</label>
          <select class="form-select" v-model="form.type">
            <option v-for="t in strategyTypes" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>

        <div class="section-title">通用参数</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">初始资金 (USDT)</label>
            <input class="form-input" type="number" v-model.number="form.params.initial_capital" min="100" />
            <span v-if="errors.initial_capital" class="err">{{ errors.initial_capital }}</span>
          </div>
          <div class="form-group">
            <label class="form-label">单仓比例 (%)</label>
            <input class="form-input" type="number" v-model.number="posRatioPct" min="1" max="100" step="1" />
            <span v-if="errors.position_ratio" class="err">{{ errors.position_ratio }}</span>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">最大持仓数</label>
            <input class="form-input" type="number" v-model.number="form.params.max_positions" min="1" />
          </div>
          <div class="form-group">
            <label class="form-label">时间框架</label>
            <select class="form-select" v-model="form.params.timeframe">
              <option value="1h">1 小时</option>
              <option value="4h">4 小时</option>
              <option value="1d">日线</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">起始日期 <span class="required">*</span></label>
            <input class="form-input" type="date" v-model="form.params.date_start" />
            <span v-if="errors.date_start" class="err">{{ errors.date_start }}</span>
          </div>
          <div class="form-group">
            <label class="form-label">结束日期 <span class="required">*</span></label>
            <input class="form-input" type="date" v-model="form.params.date_end" />
            <span v-if="errors.date_end" class="err">{{ errors.date_end }}</span>
          </div>
        </div>

        <!-- MA+KDJ 专属参数 -->
        <template v-if="form.type === 'ma_kdj'">
          <div class="section-title">MA+KDJ 参数</div>
          <div class="form-group">
            <label class="form-label">MA 周期（逗号分隔）</label>
            <input class="form-input" v-model="maPeriodStr" placeholder="30,60,120,240" />
            <span v-if="errors.ma_periods" class="err">{{ errors.ma_periods }}</span>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">KDJ J 阈值</label>
              <input class="form-input" type="number" v-model.number="form.params.kdj_j_max" step="0.1" />
            </div>
            <div class="form-group">
              <label class="form-label">KDJ K 阈值</label>
              <input class="form-input" type="number" v-model.number="form.params.kdj_k_max" />
            </div>
            <div class="form-group">
              <label class="form-label">KDJ D 阈值</label>
              <input class="form-input" type="number" v-model.number="form.params.kdj_d_max" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">止损系数</label>
              <input class="form-input" type="number" v-model.number="form.params.stop_loss_factor" step="0.01" min="0.5" max="2" />
            </div>
            <div class="form-group">
              <label class="form-label">最小盈亏比</label>
              <input class="form-input" type="number" v-model.number="form.params.min_risk_reward_ratio" step="0.5" min="0" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">冷却小时数</label>
              <input class="form-input" type="number" v-model.number="form.params.cooldown_hours" min="0" />
            </div>
            <div class="form-group">
              <label class="form-label">连续亏损冷却阈值</label>
              <input class="form-input" type="number" v-model.number="form.params.consecutive_losses_threshold" min="1" />
            </div>
          </div>
          <div class="form-group toggle-group">
            <label class="form-label">阶段止盈</label>
            <input type="checkbox" v-model="form.params.enable_partial_profit" />
            <span class="toggle-hint">{{ form.params.enable_partial_profit ? '启用' : '禁用' }}</span>
          </div>
        </template>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" @click="onSubmit">创建策略</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { X } from 'lucide-vue-next'

const props = defineProps({ strategyTypes: Array })
const emit = defineEmits(['close', 'created'])

const today = new Date().toISOString().slice(0, 10)
const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)

const form = ref({
  name: '',
  type: 'ma_kdj',
  params: {
    initial_capital: 1000000,
    position_ratio: 0.40,
    max_positions: 2,
    timeframe: '1h',
    date_start: oneYearAgo,
    date_end: today,
    ma_periods: [30, 60, 120, 240],
    kdj_j_max: 0.0,
    kdj_k_max: 200.0,
    kdj_d_max: 200.0,
    stop_loss_factor: 1.0,
    enable_partial_profit: false,
    max_init_loss: 0.01,
    min_risk_reward_ratio: 4.0,
    cooldown_hours: 2,
    consecutive_losses_threshold: 2,
    base_cooldown_candles: 1,
    max_cooldown_candles: 10000,
    consecutive_losses_reduce_on_profit: 2,
    warmup_bars: 240,
    max_backtest_bars: 10000,
    lookback_buffer: 50,
    min_open_cash: 100,
  }
})

const posRatioPct = computed({
  get: () => Math.round(form.value.params.position_ratio * 100),
  set: (v) => { form.value.params.position_ratio = v / 100 }
})

const maPeriodStr = computed({
  get: () => form.value.params.ma_periods.join(','),
  set: (v) => {
    const arr = v.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0)
    form.value.params.ma_periods = arr
  }
})

const errors = ref({})

function validate() {
  const e = {}
  if (!form.value.params.initial_capital || form.value.params.initial_capital < 100)
    e.initial_capital = '初始资金需 ≥ 100'
  if (form.value.params.position_ratio <= 0 || form.value.params.position_ratio > 1)
    e.position_ratio = '仓位比例需在 1%~100%'
  if (!form.value.params.date_start) e.date_start = '请选择起始日期'
  if (!form.value.params.date_end) e.date_end = '请选择结束日期'
  if (form.value.params.date_start && form.value.params.date_end &&
      form.value.params.date_start >= form.value.params.date_end)
    e.date_end = '结束日期须晚于起始日期'
  if (form.value.type === 'ma_kdj') {
    if (!form.value.params.ma_periods.length) e.ma_periods = '至少填写一个 MA 周期'
  }
  errors.value = e
  return Object.keys(e).length === 0
}

function onSubmit() {
  if (!validate()) return
  emit('created', {
    name: form.value.name,
    type: form.value.type,
    params: { ...form.value.params }
  })
}
</script>

<style scoped>
.section-title {
  font-size: .8rem; font-weight: 600; color: var(--color-text-secondary);
  text-transform: uppercase; letter-spacing: .05em;
  margin: 16px 0 10px; padding-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
}
.required { color: var(--color-danger); }
.err { font-size: .78rem; color: var(--color-danger); display: block; margin-top: 2px; }
.toggle-group { display: flex; align-items: center; gap: 8px; }
.toggle-group input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; }
.toggle-hint { font-size: .82rem; color: var(--color-text-secondary); }
</style>
