#Naive UI 日期/时间组件的初值与格式约束

- n-date-picker 的 formatted-value 必须满足以下之一：null、或严格匹配 value-format 的字符串。空字符串 '' 或格式不匹配会在 setup 阶段抛 Invalid time value。
- 任何 form 默认值里，表示"未选中"的日期/时间字段一律用 null，不用 ''。
- 从后端/历史数据加载时，必须归一化：按当前 value-format（通常与 timeframe 等联动）把值补齐或截断，不要假设存储格式与展示格式一致。
- 同理适用于 n-time-picker、n-input-number（非法值用 null）。