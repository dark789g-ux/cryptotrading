# 06 测试矩阵 + 验收命令 + 手工 e2e

## 单测覆盖矩阵

### Python(`apps/quant-pipeline/tests/unit/`)

| 文件 | 新增 / 修改 case |
|---|---|
| `test_labels_strategy_aware.py` | `min_days = 0 / 30 / 60 / 90 / 250` 边界 case;非法值(-1 / 251 / "60" / 60.0)抛 ValueError |
| `test_labels_fallback.py`(D-1 缺口) | fwd_5d_ret + listing 过滤新股;min_days=0 不过滤 |
| `test_features_builder.py` | factor_ids 顺序不影响哈希;min_days 变化产生不同 ID;`resolve_feature_set_id` 命中老行 / 写新行 |
| `test_progress.py` | `make_scaled_callback` 三个 case:正常窗口缩放、超界 clamp、无效窗口抛 ValueError |
| `test_train_e2e_runner.py`(新) | params 校验 8 个非法 case;三步顺序;cancel 在 step 边界抛出;`_StepError` 包裹原异常 |

### Python 集成测(`apps/quant-pipeline/tests/integration/`,若存在)

```python
def test_train_e2e_end_to_end_small_window(pg_conn, fixture_small_universe):
    """跑 7 个交易日的小窗口端到端,verify 三张表都写入。"""
    fake_job_id = uuid4()
    params = dict(factor_version="v1", label_scheme="strategy-aware",
                  new_listing_min_days=30, date_range="20240601:20240607",
                  model="lgb-lambdarank", walk_forward=False, seed=42)
    result = run_train_e2e(fake_job_id, params, lambda p,m: None)

    assert result["feature_set_id"].startswith("fs_")

    # factors.labels 有行
    n_labels = pg_conn.execute(
        "SELECT COUNT(*) FROM factors.labels WHERE scheme='strategy-aware' "
        "AND trade_date BETWEEN '20240601' AND '20240607'"
    ).scalar()
    assert n_labels > 0

    # factors.feature_matrix 有行
    n_matrix = pg_conn.execute(
        "SELECT COUNT(*) FROM factors.feature_matrix "
        "WHERE feature_set_id = :fsid",
        dict(fsid=result["feature_set_id"])
    ).scalar()
    assert n_matrix > 0

    # ml.model_runs 有行
    n_runs = pg_conn.execute(
        "SELECT COUNT(*) FROM ml.model_runs WHERE feature_set_id = :fsid",
        dict(fsid=result["feature_set_id"])
    ).scalar()
    assert n_runs == 1


def test_train_e2e_min_days_change_produces_different_feature_set(pg_conn):
    """同 factor_version+scheme,min_days 不同 → 两个 feature_set_id。"""
    p_30 = dict(..., new_listing_min_days=30)
    p_60 = dict(..., new_listing_min_days=60)
    r_30 = run_train_e2e(uuid4(), p_30, lambda p,m: None)
    r_60 = run_train_e2e(uuid4(), p_60, lambda p,m: None)
    assert r_30["feature_set_id"] != r_60["feature_set_id"]
```

### Worker 编排单测(`test_train_e2e_runner.py`)

```python
def test_validate_params_happy(): ...

@pytest.mark.parametrize("params,err_match", [
    ({}, "factor_version"),
    ({"factor_version":"v1"}, "label_scheme"),
    ({"factor_version":"v1","label_scheme":"unknown"}, "label_scheme"),
    ({"new_listing_min_days": -1}, "new_listing_min_days"),
    ({"new_listing_min_days": 251}, "new_listing_min_days"),
    ({"date_range":"2024-01-01:2024-12-31"}, "date_range"),
    ({"date_range":"20240601:20240501"}, "start <= end"),
    ({"model":"xgboost"}, "model"),
])
def test_validate_params_invalid(params, err_match):
    with pytest.raises(ValueError, match=err_match):
        _validate_params(_complete(params))


def test_run_train_e2e_calls_three_steps_in_order(mocker):
    mocker.patch("...compute_labels")
    mock_features = mocker.patch("...build_feature_matrix")
    mock_features.return_value = SimpleNamespace(feature_set_id="fs_abc",
                                                  factor_ids=(), matrix=None)
    mock_train = mocker.patch("...train_model",
                              return_value={"model_version": "mv_xxx"})

    cb_calls = []
    result = run_train_e2e(uuid4(), _happy_params(),
                           lambda p,m: cb_calls.append((p,m)))

    assert result["feature_set_id"] == "fs_abc"
    assert result["model_version"] == "mv_xxx"
    pcts = [p for p,_ in cb_calls]
    assert min(pcts) >= 0 and max(pcts) <= 100


def test_run_train_e2e_cancels_at_step_boundary(mocker):
    mocker.patch("...compute_labels")
    mocker.patch("...check_cancel_requested",
                 side_effect=[None, JobCancelled("user cancel"), None])
    with pytest.raises(JobCancelled):
        run_train_e2e(uuid4(), _happy_params(), lambda p,m: None)


def test_run_train_e2e_wraps_step_error(mocker):
    mocker.patch("...compute_labels")
    mocker.patch("...build_feature_matrix", side_effect=RuntimeError("kaboom"))
    with pytest.raises(_StepError) as exc:
        run_train_e2e(uuid4(), _happy_params(), lambda p,m: None)
    assert exc.value.step == "features"
    assert "kaboom" in str(exc.value)
```

### NestJS 单测

| 文件 | case |
|---|---|
| `create-job.dto.spec.ts` | 接受 `run_type='train_e2e'` + 完整 params;拒绝未知 run_type |

### 前端 vitest(`QuantTrainTriggerModal.spec.ts`)

```typescript
describe('train_e2e mode', () => {
  it('renders e2e fields by default when run_type=train', async () => {
    const wrapper = mount(QuantTrainTriggerModal, { props: { show: true } });
    await selectRunType(wrapper, 'train');
    expect(wrapper.findComponent(TrainE2EFields).exists()).toBe(true);
  });

  it('switches to existing-feature_set mode', async () => {
    const wrapper = mount(...);
    await wrapper.find('[data-test="mode-switch"]').trigger('click');
    expect(wrapper.findComponent(TrainE2EFields).exists()).toBe(false);
  });

  it('disables submit when factor_version is empty', async () => {
    const wrapper = mount(...);
    await selectE2EFields(wrapper, { factor_version: '' });
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeDefined();
  });

  it('buildParams produces train_e2e payload', async () => {
    const wrapper = mount(...);
    await fillE2EHappyPath(wrapper);
    expect(capturedRequest).toMatchObject({
      run_type: 'train_e2e',
      params: { factor_version: 'v1', label_scheme: 'strategy-aware',
                new_listing_min_days: 60, date_range: '20240601:20240630',
                model: 'lgb-lambdarank' },
    });
  });

  it('date range uses local midnight not UTC', () => {
    vi.setSystemTime(new Date(2026, 4, 9, 23, 59));
    const range: [number, number] = [
      new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()
    ];
    expect(formatDateRange(range)).toBe('20260509:20260511');
  });
});
```

## 验收命令(全部 0 退出才能交付)

```powershell
# Python
cd apps/quant-pipeline
uv run pytest tests/unit
uv run alembic check                  # schema diff 干净
uv run alembic upgrade head --sql     # 离线 SQL 审核

# NestJS
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/server exec jest

# 前端
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web test
pnpm --filter @cryptotrading/web lint:quant-lines

# 整体
pnpm build
```

## 手工 e2e 截图清单(PR 描述必含)

1. **端到端模式 happy path**:Modal 端到端模式默认显示,提交一次 7 天窗口的 job,SSE 进度从 0%→30%→60%→100%
2. **三张表都写入**:SQL `SELECT COUNT(*)` 验证 `factors.labels` / `factors.feature_matrix` / `ml.model_runs` 三张表新增了行
3. **result_payload 含 feature_set_id**:`SELECT result_payload FROM ml.jobs WHERE id=...` 输出含 `feature_set_id`
4. **mode 切换**:切换到"使用现有 feature_set",老路径仍可提交
5. **min_days 变化 → 不同 feature_set_id**:同 `factor_version=v1 / label_scheme=strategy-aware`,先用 `min_days=30` 跑一次,再用 `min_days=60` 跑一次,SELECT 验证两行不同 feature_set_id
6. **cancel 在 step 边界响应**:端到端跑到 features 阶段时点 cancel,验证 job 状态变 cancelled,labels 已写的行保留
7. **错误带 step 名**:故意写错 `factor_version='nonexistent'`,验证 job 失败,`error_text` 首行带 `[step:features]` 前缀
8. **预查复用**:用同一组参数跑两次,验证第二次 feature_set 表行数**不增加**,feature_set_id 与第一次相同

## D-1 ~ D-24 决策确认清单(PR 描述附)

PR 描述里逐行确认 24 个决策:

```text
[x] D-1  fwd_5d_ret 加新股过滤
[x] D-2  单 run_type='train_e2e' 端到端流水线
[x] D-3  阈值在 labels 阶段生效
[x] D-4  factor_version / label_scheme / min_days / date_range 进 Modal
[x] D-5  单 job 集成,worker 占用接受 30 分钟+
[x] D-6  不实现断点续跑
[x] D-7  进度切片 0-30 / 30-60 / 60-100
[x] D-8  Modal mode switch 默认端到端
[x] D-9  optuna / seed_avg 不动
[x] D-10 factor_version 纯文本(无 GET /factor-versions)
[x] D-11 factors.feature_sets 加 new_listing_min_days 列
[x] D-12 feature_set_id 哈希并入 new_listing_min_days
[x] D-13 新增 ml.jobs.result_payload jsonb 列
[x] D-14 元信息写入 ml.model_runs.hyperparams
[x] D-15 migration 顺带加 train_e2e 到 CHECK
[x] D-16 feature_set_id 预查复用
[x] D-17 Modal 隐藏 neutralize_cols / robust_z
[x] D-18 error_text 首行 [step:<name>]
[x] D-19 预拆 TrainE2EFields.vue 子组件
[x] D-20 提交成功 toast 提示长任务排队
[x] D-21 HyperparamsPanel 缺字段不展示
[x] D-22 factor_ids 加入 feature_set_id 哈希
[x] D-23 train_model 显式加 extra_hyperparams kwarg
[x] D-24 单 PR 大一统
```

## 哈希示例对比(PR 描述附)

```text
旧哈希契约(预改造):
  payload = { factor_version: "v1", label_scheme: "strategy-aware",
              neutralize_cols: ["industry_l1","mv"], robust_z: true }
  → fs_a1b2c3d4e5f6

新哈希契约(本 PR):
  payload = { factor_version: "v1", label_scheme: "strategy-aware",
              new_listing_min_days: 60, neutralize_cols: ["industry_l1","mv"],
              robust_z: true, factor_ids: ["f1","f2",...] }
  → fs_x9y8z7w6v5u4

预查复用机制下,首次跑预改造数据后,新 e2e 提交 min_days=60 命中:
  实际写入老 ID(回退到 fs_a1b2c3d4e5f6),不产生新行
```

## 已知限制(PR 描述 Future Work 段)

- 单 worker 实例下,train_e2e 长任务(30+ 分钟)期间其他 pending 作业排队 —— **接受**(D-5)
- 不支持断点续跑 —— **接受**(D-6)
- `optuna` / `seed_avg` 仍需手动指定 `feature_set_id`,不能直接接 e2e 输出 —— **后续 spec 改进**
- migration CHECK 没修复 `monitor` 既有 bug —— **后续单独 PR**(D-15 边界)
- `GET /api/quant/factor-versions` 接口未实现,factor_version 纯文本 —— **后续可选优化**(D-10)
