# 07 风险登记 + 上线前自检 + 回滚预案

## 风险登记

### R-1 feature_set_id 哈希契约升级 → 历史推理路径

**风险**:历史 `ml.model_runs` 行的 `feature_set_id` 是按老哈希算法算的(不含 `new_listing_min_days` / `factor_ids`)。改造后,如果对老模型做推理,推理 pipeline 用模型行里的 `feature_set_id` 反查 `factors.feature_sets`,然后用反查到的配置(含回填的 `new_listing_min_days=60`)重算当天特征。问题:

- 老模型训练时**实际**用的 `new_listing_min_days` 可能不是 60(因为老 fwd_5d_ret 完全没做过滤,等价于 `min_days=0`)
- 但回填把这些行都设为 60
- 推理时按 60 重算特征 → 与训练口径不一致 → 模型预测漂移

**对策**:
1. 仅对 `strategy-aware` scheme 的老 model_runs 启用推理(它本来就用 60 默认)
2. fwd_5d_ret scheme 的老 model_runs **不再用于推理**,或重训
3. 本 PR 不主动改推理逻辑(PROMPT §七:"不要碰 inference/runner.py 的过滤逻辑")
4. **运维侧动作**:上线前 SELECT 所有 fwd_5d_ret 训练的 model_runs,人工评估是否标记 deprecated

**严重度**:中 —— 若线上无 fwd_5d_ret 模型在推理,实际无影响。

### R-2 `neutralize_cols / robust_z` 假设破坏

**风险**:D-17 假设所有 feature_sets 行用的 `neutralize_cols=['industry_l1','mv'] + robust_z=true` 默认值。如果历史有异值:

- 唯一索引不含这两列 → 预查可能误命中(返回一个 `neutralize_cols` 不同的老行)
- 新 e2e 跑会**复用一个语义错误的老 feature_set_id**,后续 train 拿到的 feature_matrix 与预期不符

**对策**:**上线前自检 SQL**(必跑):
```sql
SELECT neutralize_cols, robust_z, COUNT(*)
  FROM factors.feature_sets GROUP BY 1,2;
```
- distinct = 1 → 安全,继续上线
- distinct > 1 → **暂停上线**,改方案:把这两列也加进唯一索引,builder 端去除 D-17 隐藏(暂时让 e2e Modal 也暴露这两个高级参数 / 或先做数据治理)

**严重度**:高(若触发)/ 低(若历史确实齐一)

### R-3 唯一索引建立失败(已有重复逻辑元组)

**风险**:CREATE UNIQUE INDEX 在已有重复 (factor_version, scheme, min_days, md5(factor_ids)) 组合时会失败,整个 migration 回滚。

**对策**:**上线前自检 SQL**(必跑):
```sql
SELECT factor_version, scheme, md5(array_to_string(factor_ids,',')), COUNT(*)
  FROM factors.feature_sets GROUP BY 1,2,3 HAVING COUNT(*)>1;
```
- 0 行 → 安全
- 有行 → 人工合并/标记 deprecated 重复行,再上线

**严重度**:中(可预防)

### R-4 长任务占用阻塞其它作业

**风险**:单实例 worker 抢到一个 30+ 分钟的 train_e2e job 后,后续 pending 作业全部排队。运维若发起紧急同步作业可能延迟。

**对策**:
- Modal 提交后 toast 提示(D-20)
- 后续可加 worker 池(多实例)或独立的"低优先级慢通道"(本 PR 不做)

**严重度**:中,运维上可接受

### R-5 train_e2e 中间步骤失败后,部分数据残留

**风险**:labels 跑完、features 跑到一半挂了 → factors.labels 已写,factors.feature_matrix 部分写。用户重提:
- labels 步会再跑一次(upsert 幂等,但浪费时间)
- features 步从头再来(`feature_set_id` 同样,upsert 覆盖)
- train 步用全量 feature_matrix

**对策**:upsert 幂等保证最终一致;**不实现断点续跑**(D-6)。
**评估**:可接受,设计已显式排除自动续跑。

**严重度**:低

### R-6 Modal 行数接近 500 上限

**风险**:改造后估 ~340 行,后续 M4 加 monitoring/AB 对比触发会再加字段,可能超 500。

**对策**:本 PR 已预拆 `TrainE2EFields.vue` 子组件(D-19),把 e2e 字段块抽离。M4 时若再有大改可继续拆 `TrainExistingFields.vue` 等。

**严重度**:低

### R-7 dispatcher CHECK 约束既有 bug 未修(`monitor` 缺)

**风险**:本 PR 不动 `monitor`(D-15)。若未来有人触发 `_runner_monitor`,DB CHECK 会拒绝插入。

**对策**:本 PR 不修;开 issue 单独跟踪。
**评估**:`monitor` 是 M4 还未启用的路径,实际不会被触发。

**严重度**:低

### R-8 `train_model` 函数签名扩展破坏老调用

**风险**:D-23 给 `train_model` 加 `extra_hyperparams` kwarg。如果有别的调用方(老 `train` runner / CLI / 测试)不传,行为应保持不变。

**对策**:`extra_hyperparams=None` 时 `(extra_hyperparams or {})` 退化为空 dict,merge 后等价于不加任何字段。已加单测覆盖。

**严重度**:低(可控)

## 上线前自检 checklist

```text
[ ] 1. uv run pytest tests/unit                     # Python 单测全过
[ ] 2. pnpm --filter @cryptotrading/server exec jest # NestJS 单测全过
[ ] 3. pnpm --filter @cryptotrading/web test         # 前端 vitest 全过
[ ] 4. pnpm --filter @cryptotrading/web lint:quant-lines  # Vue 行数 ≤ 500
[ ] 5. pnpm --filter @cryptotrading/web type-check   # 前端类型检查
[ ] 6. uv run alembic check && uv run alembic upgrade head --sql
[ ] 7. 自检 SQL 1(neutralize_cols/robust_z distinct = 1)
[ ] 8. 自检 SQL 2(逻辑元组无重复)
[ ] 9. 自检 SQL 3(老 model_runs 中 fwd_5d_ret 数量,评估推理影响)
[ ] 10. pnpm build                                   # 整体构建
```

## 回滚预案

### 场景 A:migration 已部署,代码部署失败

- DB 状态:`factors.feature_sets.new_listing_min_days` 列已加(回填 60),`ml.jobs.result_payload` 列已加,CHECK 已扩展
- 代码状态:老版本 worker / NestJS / 前端
- **影响**:
  - 老 Python 代码不读 `new_listing_min_days` 列 → 无影响
  - 老 NestJS 代码看到新的 `train_e2e` CHECK 值 → 无影响(只是 CHECK 比代码宽,不会拒绝合法值)
  - 老前端不发 `train_e2e` 请求 → 无影响
- **结论**:DB 单独前置部署安全,可以先 migrate 再发代码

### 场景 B:代码已部署,发现严重 bug

- **优先选项**:`git revert` 整个 PR + 重新部署
- DB 不回滚(`feature_sets.new_listing_min_days` 列保留,字段值 60 视为默认)
- 老 train_e2e 已入队的 pending job 需手工 `UPDATE ml.jobs SET status='cancelled' WHERE run_type='train_e2e' AND status='pending'`
- 已完成的 train_e2e job 留在 DB,模型可继续推理

### 场景 C:migration 跑到一半失败

- alembic 事务保证整个 migration 原子回滚 → DB 恢复到 pre-migration 状态
- 排查失败原因(多半是 R-2 / R-3 自检 SQL 没跑过),处理脏数据后重试

### 场景 D:发现哈希预查复用机制有 bug,误命中老 feature_set

- 立即在 dispatcher 短路 `_runner_train_e2e`(改 `_ROUTES` 移除 train_e2e 键,触发"unknown run_type"错误,job 标 failed)
- 受影响的 model_runs 通过 `result_payload->>'feature_set_id'` 找回,人工评估是否 deprecated
- 修复 builder.resolve_feature_set_id,补单测,重新发布

## Future Work(后续 spec 改进)

1. 多 worker 实例 / 慢通道分离(消除 R-4)
2. 断点续跑(从 labels 完成的 job 继续 features)
3. `GET /api/quant/factor-versions` 接口实现 + 前端下拉提示
4. optuna / seed_avg 支持基于 e2e 输出
5. 修复 `monitor` CHECK 约束(R-7)
6. 推理路径对 fwd_5d_ret 历史 model_runs 的兼容策略(R-1)
