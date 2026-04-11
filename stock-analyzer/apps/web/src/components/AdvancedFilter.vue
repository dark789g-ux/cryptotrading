<template>
  <el-dialog
    v-model="visible"
    title="高级筛选"
    width="500px"
    @close="handleClose"
  >
    <el-form :model="form" label-width="120px">
      <el-form-item label="技术指标">
        <el-select v-model="form.indicator" placeholder="选择指标">
          <el-option label="均线 (MA)" value="ma" />
          <el-option label="MACD" value="macd" />
          <el-option label="KDJ" value="kdj" />
          <el-option label="RSI" value="rsi" />
          <el-option label="布林带" value="boll" />
        </el-select>
      </el-form-item>

      <!-- MA 条件 -->
      <template v-if="form.indicator === 'ma'">
        <el-form-item label="短期均线">
          <el-select v-model="form.maShort">
            <el-option label="MA5" value="5" />
            <el-option label="MA10" value="10" />
          </el-select>
        </el-form-item>
        <el-form-item label="长期均线">
          <el-select v-model="form.maLong">
            <el-option label="MA20" value="20" />
            <el-option label="MA60" value="60" />
          </el-select>
        </el-form-item>
        <el-form-item label="条件">
          <el-select v-model="form.maCondition">
            <el-option label="金叉 (短期上穿长期)" value="cross_up" />
            <el-option label="死叉 (短期下穿长期)" value="cross_down" />
            <el-option label="短期在长期上方" value="above" />
            <el-option label="短期在长期下方" value="below" />
          </el-select>
        </el-form-item>
      </template>

      <!-- MACD 条件 -->
      <template v-if="form.indicator === 'macd'">
        <el-form-item label="条件">
          <el-select v-model="form.macdCondition">
            <el-option label="金叉 (DIF上穿DEA)" value="golden_cross" />
            <el-option label="死叉 (DIF下穿DEA)" value="death_cross" />
            <el-option label="DIF在零轴上方" value="above_zero" />
            <el-option label="DIF在零轴下方" value="below_zero" />
          </el-select>
        </el-form-item>
      </template>

      <!-- KDJ 条件 -->
      <template v-if="form.indicator === 'kdj'">
        <el-form-item label="条件">
          <el-select v-model="form.kdjCondition">
            <el-option label="金叉 (K上穿D)" value="golden_cross" />
            <el-option label="死叉 (K下穿D)" value="death_cross" />
            <el-option label="超买区 (K>80)" value="overbought" />
            <el-option label="超卖区 (K<20)" value="oversold" />
          </el-select>
        </el-form-item>
      </template>

      <!-- RSI 条件 -->
      <template v-if="form.indicator === 'rsi'">
        <el-form-item label="周期">
          <el-select v-model="form.rsiPeriod">
            <el-option label="RSI6" value="6" />
            <el-option label="RSI12" value="12" />
            <el-option label="RSI24" value="24" />
          </el-select>
        </el-form-item>
        <el-form-item label="比较">
          <el-select v-model="form.rsiCompare">
            <el-option label="大于" value="above" />
            <el-option label="小于" value="below" />
          </el-select>
        </el-form-item>
        <el-form-item label="数值">
          <el-input-number v-model="form.rsiValue" :min="0" :max="100" />
        </el-form-item>
      </template>

      <!-- 布林带条件 -->
      <template v-if="form.indicator === 'boll'">
        <el-form-item label="条件">
          <el-select v-model="form.bollCondition">
            <el-option label="触及上轨" value="touch_upper" />
            <el-option label="触及下轨" value="touch_lower" />
            <el-option label="突破上轨" value="break_upper" />
            <el-option label="突破下轨" value="break_lower" />
            <el-option label="布林带收窄" value="squeeze" />
          </el-select>
        </el-form-item>
      </template>

      <el-form-item label="筛选日期">
        <el-date-picker
          v-model="form.tradeDate"
          type="date"
          placeholder="默认最新交易日"
          value-format="YYYYMMDD"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" @click="handleConfirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm', value: any): void
}>()

const visible = ref(props.modelValue)

watch(() => props.modelValue, (val) => {
  visible.value = val
})

watch(visible, (val) => {
  emit('update:modelValue', val)
})

const form = ref({
  indicator: 'ma',
  maShort: '5',
  maLong: '20',
  maCondition: 'cross_up',
  macdCondition: 'golden_cross',
  kdjCondition: 'golden_cross',
  rsiPeriod: '6',
  rsiCompare: 'above',
  rsiValue: 70,
  bollCondition: 'touch_upper',
  tradeDate: '',
})

const handleClose = () => {
  visible.value = false
}

const handleConfirm = () => {
  const params: any = {
    indicator: form.value.indicator,
    tradeDate: form.value.tradeDate,
  }

  if (form.value.indicator === 'ma') {
    params.maShort = form.value.maShort
    params.maLong = form.value.maLong
    params.maCondition = form.value.maCondition
  } else if (form.value.indicator === 'macd') {
    params.macdCondition = form.value.macdCondition
  } else if (form.value.indicator === 'kdj') {
    params.kdjCondition = form.value.kdjCondition
  } else if (form.value.indicator === 'rsi') {
    params.rsiPeriod = form.value.rsiPeriod
    params.rsiCompare = form.value.rsiCompare
    params.rsiValue = form.value.rsiValue
  } else if (form.value.indicator === 'boll') {
    params.bollCondition = form.value.bollCondition
  }

  emit('confirm', params)
  visible.value = false
}
</script>
