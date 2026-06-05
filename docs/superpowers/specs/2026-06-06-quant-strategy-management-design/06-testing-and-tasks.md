# 06 · 测试、任务切分与上线

← 返回 [index](./index.md) ｜ 上一篇 [05 前端](./05-frontend.md)

## 1. 测试计划

### 回归校验（最关键）
default_exit@v1 的规则 = 现写死规则，**输出必须逐行不变**：
- 已有单测 `tests/unit/test_labels_strategy_aware.py` /
  `test_labels_strategy_aware_max_hold.py` 须继续全绿（改造 ExitState/模拟器后）。
- 新增「default 等价」测：`build_exit_rules(default_exit.exit_rules)` 产出的规则链
  对一组固定输入，`simulate_exit` 结果与 `default_rules()` **逐行相等**（value/exit_reason/
  hold_days/exit_date 全等）。这是 default 零漂移（[01 §5](./01-architecture-and-scope.md#5-关键不变式)）的守门。
- ⚠ [[reference_factor_compute_hash]] 教训：改 close_adj/上游即使数学等价也可能浮点末位
  漂移；若有 sha256 锁输出的测试，验证后重新 freeze。

### Python 单测（新增）
- `build_exit_rules`：合法 5 种 type 实例化；空数组 / 未知 type / 无 max_hold / 多条同 type /
  params 越界 → raise ValueError。
- `TakeProfitRule`：high_adj 达/未达 target；成交价 = entry×(1+pct)。
- `TrailingStopRule`：peak 跟踪正确；close 跌破 peak×(1−pct) 触发；单调上涨不触发。
- `MABreakRule(period)`：period=5 与原 MA5BreakRule 逐行相等；period≠5 用对应 MA 窗口。
- 模拟器 peak/high 注入：构造含盘中新高的序列，验证 peak 单调不降、出场点正确。
- `base_scheme_codec`：default_exit@v1 → "strategy-aware"；其它 → "strategy-aware__id_ver"；
  缺 strategy_id/version → raise。
- `_load_strategy_definition`：命中返回 exit_rules；缺行 raise RuntimeError。
- `_validate_base_type_and_params`（train_e2e）：strategy_aware 接受 {strategy_id, strategy_version}、
  拒非法 id/version。

### NestJS 单测
- CreateStrategyDto：5 种 type params 范围 + 跨规则（非空 / 恰一条 max_hold / 同 type 至多一条）。
- service create/update（update 只改展示字段）；PK 冲突 409。
- labels 建 strategy_aware 标签：引用不存在/禁用策略 → 422。
- ⚠ `.claude/rules/database-sql.md`：mock QueryBuilder 单测验不出水合正确性 →
  列表/详情接口须真机/集成验证字段不丢。

### 迁移测试
- `alembic upgrade` 后查 `factors.strategy_definitions` 有 default_exit@v1、exit_rules 正确；
  `factors.label_definitions` 的 strategy_aware_default@v1 base_params 已改写。
- `downgrade` 对称还原。

## 2. 任务切分（按文件域隔离，供 subagent-driven-development）

```text
A. DB/Alembic   ── apps/quant-pipeline/.../migrations/versions/2026XXXX_0001_strategy_definitions.py
   建表 + 种子 default_exit@v1 + 改写 label 种子 base_params。无代码依赖，先行。

B. Python       ── apps/quant-pipeline/src/quant_pipeline/{strategy,labels,worker}/
   exit_rules.py(ExitState+2新规则+MABreakRule泛化+build_exit_rules+模拟器peak/high)、
   _common.apply_hfq(high_adj)、dir3_scheme.base_scheme_codec、
   labels/runner.py(SQL加high+_load_strategy_definition+compute_labels签名+entrypoint)、
   strategy_aware.py(LabelInputs.exit_rules+scheme入参)、
   train_e2e_runner.py(_validate+_step_labels接线) + 单测。

C. NestJS       ── apps/server/src/{entities/ml,modules/quant/strategies}/ + app.module 双注册
   实体 + CRUD + DTO + labels 校验接线 + shared-types。

D. 前端         ── apps/web/src/{views/quant,components/quant,api/modules,router,components/layout}/
   策略管理页 + ExitRulesEditor/ExitRuleRow + StrategyEditModal/Table +
   BaseTypeFields 改策略选择器 + api + 路由 + Sidebar。
```

### 依赖与并行
```text
A ──▶ B（B 的 _load_strategy_definition / 种子依赖表与 scheme 约定）
A ──▶ C（C 的实体依赖表）
C 的接口契约 ──▶ D（D 的策略选择器/列表依赖 C 路由）

并行性: A 先单独跑通 → B、C 可并行（Python vs TS，文件域不相交）→ D 待 C 接口契约定稿后做。
冲突管理靠文件域切分（A/B/C/D 目录互不相交），不用 git worktree。
```

## 3. 上线步骤

1. **Alembic**（[[project_alembic_drift]] 教训）：`alembic heads` / `current` 确认未脱节；
   `down_revision` 指向真 head；若 DB current 落后，先 `stamp` 对齐再 `upgrade`，
   否则重跑撞「已存在」。迁移随附 `docker exec` 可执行脚本（CLAUDE.md 规矩）。
2. **重启 server + worker**（CLAUDE.md：后端 `dev` 无 watch，新实体/路由须重启；
   Python worker 同理须重启加载新代码）。
3. 端到端冒烟（见 §4）。

## 4. 端到端验证（验收）

参照标签库 [[project_label_management]] 的真机闭环：
1. 前端建一个非 default 策略（如 `tight_exit@v1`：stop_loss 0.05 / ma_break 5 / max_hold 10）。
2. 建一个引用它的 strategy_aware 标签，触发 `train_e2e`。
3. 确认 `factors.labels` 出现 scheme `strategy-aware__tight_exit_v1` 的行、value 合理、
   `factors.label_definitions` 引用正确；job 走完 labels→features→train。
4. default_exit 标签训练仍产 scheme `strategy-aware` 行（回归）。
5. 验证命令：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`。

## 5. 验收标准

- [ ] 全部既有 strategy_aware 单测绿 + 新增单测绿；default 等价测逐行相等。
- [ ] `pnpm --filter @cryptotrading/server build` 绿；NestJS 单测绿。
- [ ] `pnpm --filter @cryptotrading/web type-check` + `lint:quant-lines` 绿。
- [ ] 迁移 up/down 对称；真机端到端 §4 跑通。
- [ ] 历史 scheme='strategy-aware' 数据未被破坏（无重算、PK 不变）。
