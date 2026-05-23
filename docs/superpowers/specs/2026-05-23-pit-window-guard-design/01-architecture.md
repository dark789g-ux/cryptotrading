# 01. 总体架构

## 核心思路

把 `min_trade_days`（因子所需最少交易日数）作为元数据**单一权威**——Python 子类声明 + DB 同步，三层防护合围。

## 整体结构图

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        因子契约层（声明）                             │
│                                                                      │
│   Python 子类: @register(min_trade_days=21) class Momentum20d ...    │
│            ↕  registry.load_from_db 双向校验，不一致 → fail-fast     │
│   DB: factor_definitions.min_trade_days = 21                         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  (元数据被以下三处消费)
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       ▼                          ▼                          ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐
│ 第 1 层          │    │ 第 2 层          │    │ 第 3 层              │
│ 前置阻断         │    │ 启动校验         │    │ 运行时护门            │
│ (写入时)         │    │ (worker boot)    │    │ (每 trade_date)      │
├──────────────────┤    ├──────────────────┤    ├──────────────────────┤
│ 前端:            │    │ pit_audit:       │    │ runner:              │
│  Modal 实时提示  │    │  对所有 factor   │    │  取数后查 trade_cal  │
│  不足禁用保存    │    │  校验            │    │  实测交易日数         │
│                  │    │   pit_window     │    │                      │
│ 后端:            │    │     >= min×2.0   │    │  if 实测 < min:     │
│  service.update  │    │  失败 → 拒启动   │    │   warn + 扩×2 重试   │
│  跨字段校验      │    │                  │    │   仍不足 → skip      │
│  不足返 400      │    │ registry:        │    │                      │
│                  │    │  DB ↔ Python    │    │  warning 聚合进      │
│ DB:              │    │  漂移 → 拒启动   │    │  ml.jobs.warnings    │
│  CHECK 约束兜底  │    │                  │    │  SSE 推送前端可见     │
└──────────────────┘    └──────────────────┘    └──────────────────────┘
```

## 数据流：一次因子计算的全路径

```text
用户在 Modal 改 pit_window_days=30 (factor=momentum_20d, min=21)
   │
   │  required = ceil(21 × 2.0) = 42
   │
   │  windowValid = (30 >= 42) = false
   ▼
[前端] Modal 显示 "需 21 交易日，pit_window_days >= 42"
       保存按钮置灰
   │
   │ (用户改成 50)
   ▼
[前端] PATCH /api/quant/factors/momentum_20d
   │
   ▼
[后端] factors.service.update
       finalPitWindow=50, minTradeDays=21, required=42
       50 >= 42 ✓ → 写库
   │
   ▼
[DB]   factor_definitions.pit_window_days = 50
       CHECK 约束 (pit_window_days >= min_trade_days × 2) 通过
   │
   ▼ (worker 重启)
[Python] registry.load_from_db
         _meta_cache[momentum_20d] = { pit_window_days: 50, min_trade_days: 21, ... }
         双向校验: Momentum20d 类声明 min_trade_days=21 == DB.21 ✓
   │
   ▼ (pit_audit startup check)
[Python] audit_pit_window_covers_min_trade_days
         50 >= ceil(21 × 2.0)=42 ✓
   │
   ▼ (CLI 触发 factors run --trade-dates=20260206)
[Runner] for trade_date='20260206':  (春节后)
         sub = df_window[20260206 - 50天 : 20260206]
         actual_td = count_trade_days_in_window('20251218', '20260206') = 28
         28 >= 21 ✓ → 正常计算
         series = momentum.compute(sub, '20260206')
         write_non_nan_to_db(series)
   │
   ▼ (假设遇到极端长假 actual_td=19，触发护门)
[Runner] warn("factor_window_short", actual=19, need=21)
         sub_retry = df_window[20260206 - 100天 : 20260206]  (×2 扩窗)
         actual_td_retry = 38
         38 >= 21 ✓ → 用 sub_retry 计算
         job.warnings.append({factor: momentum_20d, type: factor_window_short})
   │
   ▼
[SSE]    progress 推送时带 warnings_summary={factor_window_short: 1}
   │
   ▼
[前端]   QuantJobs 详情页警告区显示该条
```

## 关键不变量

1. **DB.`min_trade_days` 必须等于 Python 子类装饰器声明值** —— 启动期校验，漂移直接拒启动
2. **DB.`pit_window_days >= ceil(min_trade_days × 2.0)`** —— DB CHECK 约束 + 后端 service 校验 + 前端 Modal 校验，三处守护
3. **运行时实测窗口内交易日数 `>= min_trade_days`** —— 不足则扩窗 × 2 重试，仍不足则 skip 该因子当天
4. **`min_trade_days` 是契约不可改** —— UI 无编辑入口，修改它必须通过子类声明 + migration

## 影响域

| 层级 | 改动量 |
|---|---|
| DB schema | 2 个新 migration：factor_definitions 加 min_trade_days 列 + 跨字段 CHECK；ml.jobs 加 warnings JSONB 列 |
| Python factors | 基类 + 16 子类各 +1 行；registry +30 行；runner +50 行；新增 constants.py / data_access.py |
| NestJS server | service 跨字段校验 +15 行；factor_definition entity +1 字段；ml-job entity +1 字段；jobs controller / service 暴露 warnings |
| Vue web | FactorEditModal 实时校验 +30 行；api type +2 字段（min_trade_days + warnings）；QuantJobs 详情页 warnings 折叠区 |
| 测试 | ~10 个测试文件改 / 新（单测 + 集成 + 后端 + 前端 + 新 trade_cal_not_synced 集成测试） |

详见 [05-migration-and-tests.md §5.5](./05-migration-and-tests.md#55-改动文件清单评估实施量)。
