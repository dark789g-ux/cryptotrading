# 06 · 测试与验证

约束 1（增量 == 整段重算逐行一致）是头号验证项，必须真 DB；单测易 mock 掉物化判定，不能只信单测（prompt 第 86 行）。

## 正确性逐行比对（约束 1）

真 DB 集成测试，放 `apps/quant-pipeline/tests/integration/`（已有真 PG 集成测试惯例）：

```text
场景 A｜增量 vs 整段(labels):
  清空某 test scheme
  ① prepare A:B           → labels 快照1
  ② prepare A:C (C>B)     → labels 快照2  (增量: 只算 B+1..C)
  ③ 另一 scheme 一次性 prepare A:C (全量) → 基准
  断言: 快照2 与基准在 [A,C] 逐行逐值一致
        比 value / exit_reason / hold_days / 行集合(trade_date×ts_code)

场景 B｜feature_matrix: 同上, 比 features(jsonb) / label

场景 C｜缺口在中间:
  先 prepare A:B 和 D:E (留中间 B+1..D-1 空), 再 prepare A:E
  断言: 中间段被算且与全量一致, 两端不重算(行未变, 可比 xmax/更新计数或前后快照相等)

场景 D｜force_recompute:
  prepare A:C 后 prepare A:C --force, 结果与不 force 一致(幂等)
```

> 比对实现：`pytest` fixture 起真 PG（或复用现有 integration fixture），导出两边 DataFrame 排序后 `assert_frame_equal`。

## 单元测试（python，mock _load_*）

沿用现有 `monkeypatch` 替换 `_load_*` 的模式（`test_labels_runner.py`）。新增：

```text
gap_subranges / coverage 纯函数(无需 DB):
  - 缺口在中间 / 全重叠(空缺口→不算) / 全不重叠 / 相邻日合并成一段
  - coverage: 连续→1段 / 含空洞→多段 / 单日 / 空
labels 增量:
  - force=True → subranges=[(start,end)] 整段
  - 每缺口 end_padded = g1 后第30交易日 (mock trade_cal 验证)
  - 只写 [g0,g1], padding 区行不进 upsert
features 增量:
  - 零 padding(加载区间==缺口)
  - 缺口⊆labels 校验: labels 缺的天 → warn(features_missing_labels) + 跳过, 不进 upsert
_load_feature_matrix:
  - date_range 过滤生效; 缺 date_range → ValueError(fail-fast)
prepare 编排:
  - step1(labels) 在 step2(features) 之前; cancel 在步间生效
```

## server 单测（jest）
```text
create-job:
  - run_type=prepare 需 labelRef; 缺 labelRef → 400
  - run_type=train, date_range 越出 R_F → 400(带缺口提示)
  - run_type=train, date_range 落空洞 → 400
  - run_type=train, date_range ⊆ R_F → 通过
  - train_e2e 不再被接受
feature-sets API:
  - materialized=true 只返回有 feature_matrix 行的 fs
  - coverage 切段正确(含空洞); label_name 缺(NULL label_id)→回退 scheme
```
命令：`pnpm --filter @cryptotrading/server exec jest <pattern>`

## web 单测（vitest）
```text
isDateDisabled: 区间内/外/空洞/边界(首尾日)
两个 modal: 渲染 + 提交 payload 组装
切换 fs → date_range 重置联动
```
命令：`pnpm --filter @cryptotrading/web test`；另跑 `type-check` 与 `lint:quant-lines`。

## 真机端到端（约束 4 真机项）
```text
1. prepare 命名标签L + V + 2024 区间      → 记 labels/features 耗时 T1
2. prepare 同 L+V + 2023:2024 区间        → 耗时 T2
   断言: T2 显著 < 2*T1 (2024 不重算); 日志 skipped_dates≈2024交易日数, 可见
3. 真 DB 比对 2024 段: 与一次性 2023:2024 全量一致
4. 训练: 选已备 fs + date_range(2023:2024) → 出模型, 指标正常
5. 越界训练: date_range 含未备的 2022 → 前端 disable 选不出; 直接 POST → 后端 400
```

## 回归红线
```text
- python 单测全绿(基线 773) + 新增逻辑全覆盖
- 前端 type-check 通过 + lint:quant-lines(Vue≤500行) 通过
- 改 worker 后重启 + 删 __pycache__; 改 server 后重启(无 watch)
```

## observability（禁止静默截断）
- labels/features 增量每次 log：`skipped_dates`(数量) + `computed_subranges`(列表)。
- features 跳过缺 labels 的天：`logger.warn(apiName="features_missing_labels", scheme, dates)`。
- 训练越界：后端 400 错误体含"缺哪几段"。
