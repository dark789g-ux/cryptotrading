# Schema Contract + AST Lint 防线设计

## 背景

排查发现 13 个同类 bug：SQL 列名/表名与实际 schema 不一致，被 `except Exception` 静默吞掉返回空数据，导致幸存者偏差安全闸全部失效。详见 `2026-05-21-survivorship-bias-fix-design.md`。

需要两道防线根治：
1. **Schema 启动校验** — 启动时验证 DB schema 与代码期望一致
2. **AST lint** — 开发时检测代码中静默降级模式

## 防线 1：Schema 启动校验

### 文件

`apps/quant-pipeline/src/quant_pipeline/db/schema_contract.py`

### REQUIRED dict

声明 quant-pipeline 依赖的表和列（19 张表）：

```
┌─────────────────────────┬───────────────────────────────────────────┐
│ 表名                     │ 列名（不含 updated_at）                    │
├─────────────────────────┼───────────────────────────────────────────┤
│ raw.trade_cal           │ exchange, cal_date, is_open, pretrade_date│
│ raw.index_classify      │ src, index_code, industry_code,           │
│                         │ industry_name, parent_code, level         │
│ raw.index_member        │ ts_code, l3_code, in_date, out_date,      │
│                         │ l1_code, l1_name, l2_code, l2_name,       │
│                         │ l3_name, name, is_new                     │
│ raw.daily_quote         │ ts_code, trade_date, open, high, low,     │
│                         │ close, vol, amount                        │
│ raw.adj_factor          │ ts_code, trade_date, adj_factor           │
│ raw.daily_basic         │ ts_code, trade_date, turnover_rate,       │
│                         │ total_mv                                  │
│ raw.daily_indicator     │ ts_code, trade_date                       │
│ raw.stk_limit           │ ts_code, trade_date, pre_close,           │
│                         │ up_limit, down_limit                      │
│ raw.suspend_d           │ ts_code, trade_date, suspend_type,        │
│                         │ suspend_timing                            │
│ raw.fina_indicator      │ ts_code, end_date, ann_date, indicators,  │
│                         │ update_flag                               │
│ public.a_share_symbols  │ ts_code, list_date, delist_date           │
│ factors.daily_factors   │ trade_date, ts_code, factor_id,           │
│                         │ factor_version, value                     │
│ factors.labels          │ trade_date, ts_code, scheme, value,       │
│                         │ exit_reason, hold_days                    │
│ factors.feature_sets    │ feature_set_id, factor_version, scheme,   │
│                         │ factor_ids                                │
│ factors.feature_matrix  │ trade_date, ts_code, feature_set_id,      │
│                         │ features, label                           │
│ ml.jobs                 │ id, run_type, params, status, progress,   │
│                         │ stage, priority, attempts, max_attempts,  │
│                         │ cancel_requested, error_text,             │
│                         │ blocked_reason, parent_job_id,            │
│                         │ heartbeat_at, started_at, finished_at,    │
│                         │ created_at, created_by                    │
│ ml.model_runs           │ id, job_id, model_version,                │
│                         │ feature_set_id, hyperparams, oos_metrics, │
│                         │ artifact_uri, report_uri, shap_uri        │
│ ml.scores_daily         │ trade_date, ts_code, model_version,       │
│                         │ score, rank_in_day                        │
│ ml.quality_reports      │ trade_date, level, rule, detail           │
└─────────────────────────┴───────────────────────────────────────────┘
```

### validate_schema(session) 函数

```python
def validate_schema(session) -> None:
    """校验 DB schema 与 REQUIRED 契约一致。失败则 raise RuntimeError。"""
    rows = session.execute(text("""
        SELECT table_schema || '.' || table_name AS tbl, column_name
        FROM information_schema.columns
        WHERE table_schema IN ('raw', 'public', 'factors', 'ml')
    """)).fetchall()

    actual: dict[str, set[str]] = defaultdict(set)
    for tbl, col in rows:
        actual[tbl].add(col)

    missing = []
    for table, required_cols in REQUIRED.items():
        if table not in actual:
            missing.append(f"  缺失表: {table}")
            continue
        for col in required_cols:
            if col not in actual[table]:
                missing.append(f"  缺失列: {table}.{col}")

    if missing:
        raise RuntimeError("Schema 契约校验失败:\n" + "\n".join(missing))
```

### 注入点

`worker/loop.py` 的 `run_worker_loop()` 开头，创建 Dispatcher 之前：

```python
def run_worker_loop():
    settings = Settings()
    # ── schema 契约校验 ──
    from quant_pipeline.db import session_scope
    from quant_pipeline.db.schema_contract import validate_schema
    with session_scope() as session:
        validate_schema(session)
    # ── 原有逻辑 ──
    dispatcher = Dispatcher(...)
    ...
```

---

## 防线 2：AST Lint 禁止静默降级

### 文件

`apps/quant-pipeline/tools/lint_no_silent_degradation.py`

### 检测逻辑

```
对每个 .py 文件：
  1. ast.parse → AST 树
  2. ast.walk 查找所有 ExceptHandler 节点
  3. 对每个 ExceptHandler：
     a. 向上找 parent FunctionDef → 函数名
     b. 取 body 最后一条语句
     c. 判断 return 空值：
        - return [] / {} / set()
        - return None / 裸 return
        - return pd.DataFrame(columns=...)
     d. 白名单匹配 → 跳过；否则报告
```

### 返回空值检测（保守策略）

```python
def _returns_empty(node: ast.stmt) -> bool:
    """判断 return 语句是否返回空值/空容器。"""
    if not isinstance(node, ast.Return):
        return False
    val = node.value
    # 裸 return / return None
    if val is None:
        return True
    if isinstance(val, ast.Constant) and val.value is None:
        return True
    # return [] / return {}
    if isinstance(val, (ast.List, ast.Dict)) and len(val.elts) == 0:
        return True
    # return set()
    if isinstance(val, ast.Call) and isinstance(val.func, ast.Name) and val.func.id == "set" and len(val.args) == 0:
        return True
    # return pd.DataFrame(columns=...) / return DataFrame(columns=...)
    if isinstance(val, ast.Call) and _is_dataframe_call(val):
        return True
    return False

def _is_dataframe_call(call_node: ast.Call) -> bool:
    """识别 pd.DataFrame(columns=...) 或 DataFrame(columns=...)。"""
    func = call_node.func
    name = None
    if isinstance(func, ast.Attribute) and func.attr == "DataFrame":
        name = func.value.id if isinstance(func.value, ast.Name) else None
    elif isinstance(func, ast.Name) and func.id == "DataFrame":
        name = "DataFrame"
    if name not in ("pd", "DataFrame"):
        return False
    # 检查有 columns 关键字参数
    return any(kw.arg == "columns" for kw in call_node.keywords)
```

### 白名单

`_WHITELIST: set[tuple[str, str]]` — （文件路径子串, 函数名）

| 文件路径关键词 | 函数名 | 原因 |
|---|---|---|
| `worker/loop.py` | `run_worker_loop` | 主循环不应退出 |
| `worker/dispatcher.py` | `dispatch` | 兜底写 error_text |
| `sync/orchestrator.py` | `run_sync_tables` | 单表失败不中断后续 |
| `factors/runner.py` | `run_factors` | 单因子失败跳过 |
| `quality/runner.py` | `run_quality` | 非 strict 模式设计如此 |
| `quality/checks_row.py` | `check_duplicate_pk` | 表可能不存在 |
| `quality/checks_value.py` | `check_null_violation` | 单列检查跳过 |
| `quality/pit_audit.py` | `run_ghost2_sample` | 采样审计单样本失败 |
| `quality/pit_audit.py` | `run_ghost3_sample` | 采样审计单样本失败 |
| `inference/runner.py` | `run_inference` | post-infer 非关键 |
| `evaluation/shap_explainer.py` | `explain` | SHAP 非关键 |
| `evaluation/shap_explainer.py` | `_write_fallback_report` | SHAP fallback |
| `evaluation/ab_compare.py` | `_run_single_fold` | 进度回调非关键 |
| `training/walk_forward_runner.py` | `_generate_report` | 报告生成非关键 |
| `training/runner.py` | `_run_shap_post_train` | SHAP 后处理非关键 |
| `training/tuning.py` | `_optuna_progress_callback` | 进度更新非关键 |
| `training/seed_averaging.py` | `run_seed_averaging` | 子任务创建/进度非关键 |

### 注册

`apps/quant-pipeline/pyproject.toml` 的 `[project.scripts]` 加：

```toml
lint-no-silent-degradation = "tools.lint_no_silent_degradation:main"
```

调用：`uv run lint-no-silent-degradation src/`

---

## 两道防线的协作

```
┌──────────────────────────────────────────────────────────────┐
│                    防线协作示意                                │
│                                                              │
│  开发时（CI / 手动）                                          │
│  ┌──────────────────────────────────┐                        │
│  │ AST lint                         │                        │
│  │ "代码中没有 except 块静默返回空值"  │                        │
│  └──────────────┬───────────────────┘                        │
│                 │ 代码合入前                                   │
│                 ▼                                             │
│  运行时（Worker 启动）                                         │
│  ┌──────────────────────────────────┐                        │
│  │ Schema contract                  │                        │
│  │ "DB 中的表/列与代码期望一致"       │                        │
│  └──────────────┬───────────────────┘                        │
│                 │ 校验通过                                     │
│                 ▼                                             │
│  ┌──────────────────────────────────┐                        │
│  │ Worker 主循环                     │                        │
│  │ 正常处理 jobs                     │                        │
│  └──────────────────────────────────┘                        │
│                                                              │
│  防线 1 防 "DB 变了代码没跟上"                                  │
│  防线 2 防 "代码错了但被 except 吞掉"                           │
│  两者互补，消除静默降级掩盖契约不一致的根因                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 关键约束

- 文件 UTF-8，中文注释
- Schema 校验只在 worker 启动时跑一次，不影响运行时性能
- 校验失败必须 fail-fast（raise），不能 warning 降级
- AST lint 用 Python 标准库 `ast`，不引入额外依赖
- 纯静态分析，不需要运行代码
- 检测 false positive 时宁可漏报不要误报（保守策略）
- `updated_at` 列不纳入 REQUIRED dict（元数据列，每张表都有，非业务查询依赖）

---

## 测试方案

### Schema contract 测试

- 正向测试：mock `information_schema` 返回完整 schema → `validate_schema` 不抛异常
- 缺失表测试：mock 缺少 `raw.suspend_d` → 抛 RuntimeError，消息包含 `raw.suspend_d`
- 缺失列测试：mock `raw.suspend_d` 缺少 `trade_date` → 抛 RuntimeError，消息包含 `raw.suspend_d.trade_date`
- 多项缺失测试：同时缺多个 → 一次性报告所有缺失项

### AST lint 测试

- 正向测试：`except Exception: return []` 在白名单函数中 → 不报告
- 违规测试：`except Exception: return []` 在非白名单函数中 → 报告
- 边界测试：
  - `except Exception: logger.error(...); return []` → 报告（最后一条是 return 空值）
  - `except Exception: logger.error(...); return [1, 2]` → 不报告（非空返回）
  - `except KeyError: return []` → 报告（任何 except 类型都检测）
  - `except Exception: return pd.DataFrame(columns=["a"])` → 报告
  - `except Exception: x = 1; return []` → 报告（中间有赋值也检测）

---

## 文件清单

| 文件 | 动作 |
|---|---|
| `apps/quant-pipeline/src/quant_pipeline/db/schema_contract.py` | 新建 |
| `apps/quant-pipeline/tools/lint_no_silent_degradation.py` | 新建 |
| `apps/quant-pipeline/src/quant_pipeline/worker/loop.py` | 修改（注入校验调用） |
| `apps/quant-pipeline/pyproject.toml` | 修改（加 script） |
| `apps/quant-pipeline/tests/unit/test_schema_contract.py` | 新建 |
| `apps/quant-pipeline/tests/unit/test_lint_no_silent_degradation.py` | 新建 |
