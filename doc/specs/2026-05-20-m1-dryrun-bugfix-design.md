# M1 Dry-Run Bug 修复包 · 设计

**日期**：2026-05-20
**适用范围**：`apps/quant-pipeline`（M1 因子库与 CLI）
**前置文档**：
- `doc/specs/2026-05-17-quant-model-training/m1-factor-library.md`
- `doc/specs/2026-05-17-quant-model-training/02-quant-pipeline.md`
- `TODO.md` §1.1（dry-run）

---

## 1. 背景

2026-05-20 按 [TODO.md](../../TODO.md) §1.1 执行 1 个月范围（20240601:20240630）dry-run 时暴露 4 个 M0/M1 实现 bug，导致全链路无法跑通：

| Bug | 位置 | 现象 |
|---|---|---|
| 1 | `cli.py` 未注册 `factors` 子命令 | `quant factors compute` → `No such command 'factors'` |
| 2 | `factors.daily_factors` 等三表声明了 `PARTITION BY RANGE` 但无任何子分区 | 首次 INSERT 触发 `CheckViolation: no partition of relation "daily_factors" found` |
| 3 | `factors/runner.py:_load_industry_pit` SQL 引用了 `raw.index_member` 不存在的列（`con_code` / `index_code`） | 所有 5 个 industry/mixed 类因子 `factor_compute_failed` |
| 4 | `factors/runner.py:_query_trade_dates` 不过滤 `exchange='SSE'` 且只读已 sync 的 `raw.trade_cal` 窗口 | SSE+SZSE 双计 → 重复；预热窗（fetch_start = target_start - max_pit_window）外查不到 → factor 大量短路返回空 |

dry-run 直接产物：134,700 行 raw 已落、53,266 行 `rsi_14` 数据（只 5 天有效）、`ml.quality_reports` 出现 1 critical + 1 warn 污染。

修复后需重跑 dry-run 并把 §1.1 验收门槛走绿。

## 2. 目标与非目标

**目标**：
1. 让 `uv run quant factors compute --version v1 --date-range YYYYMMDD:YYYYMMDD` 直接跑通且写入正确数据
2. 让 `factors.daily_factors / labels / feature_matrix` 按月分区可承载 2018-01 至 2030-12
3. 让 industry 类因子正常出值，与 price 类因子覆盖率一致
4. 让因子 PIT 预热窗不再依赖 `raw.trade_cal` 的同步范围
5. 加 PG 集成测覆盖上述 4 类场景，防止回归
6. 重跑 dry-run §1.1 五步全绿（critical=0）

**非目标**：
- 不实现 partition 自动扩展机制（2030 之后再讨论）
- 不重构 `factors/registry` 与 `features/builder` 的耦合
- 不补 `raw.trade_cal` 全量 sync 至 2018（既然 `daily_quote` 是 PIT 真值源，trade_cal 维持现有 sync 节奏）
- 不改 `sync/orchestrator._list_open_trade_dates`（它是前瞻性查询，已正确按 SSE 过滤）

## 3. 总体编排（6 commit）

```text
┌──────────────────────────────────────────────────────────────────┐
│  M1 dry-run bug 修复包                                            │
├──────────────────────────────────────────────────────────────────┤
│  c1  migration: factors 三表月度分区预建（2018-01 → 2030-12）   │
│      └─ 独立、可回滚、不依赖任何代码改动                          │
│                                                                  │
│  c2  factors/runner.py + features/runner.py: SQL 列名 & trade_dates│
│      ├─ _load_industry_pit 改用 im.l1_code（删除 index_classify J│OIN）
│      ├─ _query_trade_dates 改读 raw.daily_quote.trade_date       │
│      └─ features/runner.py 同款修正（同样 bug）                  │
│                                                                  │
│  c3  cli.py: 注册 factors compute 子命令                         │
│      └─ 对齐 sync raw / labels build / features build 的签名规约 │
│                                                                  │
│  c4  tests/integration/: PG 集成测两件套                         │
│      ├─ test_factors_runner_pg.py                                │
│      └─ test_partitions_migration_pg.py                          │
│                                                                  │
│  c5  TRUNCATE + 重跑 dry-run §1.1 + 在 TODO.md 标注验收           │
│      └─ ml.quality_reports critical 必须为 0                     │
│                                                                  │
│  c6  doc: 更新 TODO.md（删手工 partition 步骤）+ 02 spec 段       │
│                                                                  │
│  c7  bollinger_position_20d 用 np.nan 代 pd.NA（c5 暴露）         │
│  c8  orchestrator 按 l1_codes 分批同步 index_member（c5 暴露）    │
│      └─ 共同目标：让 c5 验收门槛全绿                              │
└──────────────────────────────────────────────────────────────────┘
```

**回滚边界**：c1 失败 → 仅丢 migration；c2/c3 失败 → revert 单 commit；c4 失败 → 测试本身问题不阻塞主修复；c5 失败 → 暴露真实剩余 bug，跳回 c2。

## 4. c1 · Alembic migration 预建 468 个月度分区

**新文件**：`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260520_0001_factors_monthly_partitions.py`

```text
revision        20260520_0001
down_revision   20260517_0001
作用域          factors.daily_factors / factors.labels / factors.feature_matrix
分区粒度        月度（父表 PARTITION BY RANGE (trade_date) 已在 0001 migration 声明）
预建窗口        2018-01 → 2030-12 = 156 月 × 3 表 = 468 个子分区
命名规约        <parent>_y<YYYY>m<MM>     # 与 dry-run 第一轮手工建的 daily_factors_y2024m06 同名
范围语义        FOR VALUES FROM ('YYYYMM01') TO ('下月YYYYMM01')   # char(8) 字典序天然成立
```

**upgrade() 核心循环**（pseudo）：
```text
for table in ['daily_factors', 'labels', 'feature_matrix']:
    for year in range(2018, 2031):
        for month in range(1, 13):
            lo = f"{year}{month:02d}01"
            nxt_y, nxt_m = (year, month+1) if month < 12 else (year+1, 1)
            hi = f"{nxt_y}{nxt_m:02d}01"
            part = f"{table}_y{year}m{month:02d}"
            op.execute(
                f"CREATE TABLE IF NOT EXISTS factors.{part} "
                f"PARTITION OF factors.{table} "
                f"FOR VALUES FROM ('{lo}') TO ('{hi}')"
            )
```

`IF NOT EXISTS` 保证：① dry-run 第一轮手工建的 `daily_factors_y2024m06` 不冲突；② migration 自身幂等。

**downgrade()**：反向 `DROP TABLE IF EXISTS factors.<parent>_y<YYYY>m<MM>` 全部 468 个。父表由 `20260517_0001` 拆分管理，本 migration 不动父表。

**容量预估**：468 个空分区 ≈ 468 × 8KB ≈ 3.7MB pg_class 元数据。后续 `pg_inherits` 扫描成本可忽略。

**TRUNCATE 不在 migration 内**：clean-state 操作交给 c5 步骤，migration 保持纯 DDL。

**SQL 红线豁免说明**：本 migration 用 f-string 拼 `CREATE TABLE` 标识符与 `FROM ('YYYYMMDD') TO ('YYYYMMDD')` 字面量；所有插值（`part / lo / hi`）均由 migration 内常量 `range(2018, 2031) × range(1, 13)` 生成、**无任何外部输入**，不触发 CLAUDE.md "动态 SQL 构建禁止直接拼接前端字段名"的红线（该红线针对的是前端 / 用户输入路径）。

## 5. c2 · SQL 列名 & trade_dates 修正

### 5.1 `_load_industry_pit` 改写

位置：`apps/quant-pipeline/src/quant_pipeline/factors/runner.py:156-186` + `apps/quant-pipeline/src/quant_pipeline/features/runner.py:128` 两处同款修正。

```text
-- 旧（列名错，全部 industry 因子 0 输出）
SELECT :t, im.con_code AS ts_code, im.index_code AS industry_l1
FROM raw.index_member im
JOIN raw.index_classify ic ON ic.index_code = im.index_code
WHERE ic.level = 'L1' AND im.in_date <= :t
  AND (im.out_date IS NULL OR im.out_date > :t)

-- 新（im.l1_code 已由 sync 摊平到行级，无需 JOIN）
SELECT :t AS trade_date, im.ts_code, im.l1_code AS industry_l1
FROM raw.index_member im
WHERE im.l1_code IS NOT NULL
  AND im.in_date <= :t
  AND (im.out_date IS NULL OR im.out_date > :t)
```

**理由**：`sync/index_member.py:45-57` 已经把 `(l1_code, l1_name, l2_code, l2_name, l3_code, l3_name)` 同行落库。`l1_code` 即"申万一级行业代码"，形如 `801010.SI` ~ `801980.SI`（申万一级 31 个一级行业的标准代码格式）。再 JOIN `index_classify` 是冗余且口径分裂的风险。`l1_code IS NOT NULL` 兜底过滤非分类样本。

### 5.2 `_query_trade_dates` 改源头

位置：`apps/quant-pipeline/src/quant_pipeline/factors/runner.py:63-86` + `features/runner.py` 同款。

```text
-- 旧（依赖 raw.trade_cal 覆盖；同时 SSE+SZSE 双计导致重复）
SELECT cal_date FROM raw.trade_cal
WHERE cal_date >= :start AND cal_date <= :end AND is_open = 1
ORDER BY cal_date

-- 新（daily_quote 自身就是 "当天有报价" 的事实依据，PIT 安全）
SELECT DISTINCT trade_date FROM raw.daily_quote
WHERE trade_date >= :start AND trade_date <= :end
ORDER BY trade_date
```

**docstring 文档化**（函数注释）：
> trade_cal 仅服务于前瞻性查询（次日是否开市）；历史 PIT 计算的真值来自 `raw.daily_quote.trade_date`——与每日 OHLC 同表，强 PIT 安全。本函数不再依赖 trade_cal 的同步覆盖范围。**行为变更**：若某日全市场零成交（极端情形，如纪念日全停盘），`daily_quote` 不含该日，本函数也自然剔除该日；与"trade_cal.is_open=1 但无任何报价"的差异场景在本逻辑下表现为"该日跳过"，与 PIT 真值一致。

### 5.3 orchestrator `_list_open_trade_dates` 不改

服务于 sync 阶段 stk_limit / suspend_d 的前瞻日历循环，已正确 `WHERE exchange='SSE'`。无 bug，不动。

### 5.4 回归风险

| 改动 | 风险 | 缓解 |
|---|---|---|
| `im.l1_code` 直读 | sync 写入的 l1_code 异常会被即时暴露 | c4 集成测断言"任一日期 industry_pit 非空" |
| `daily_quote.trade_date` 取代 trade_cal | 若 daily_quote 漏行而 trade_cal 标 is_open，新逻辑会少算一天 | c4 集成测对 dry-run 窗内交易日数做断言（应为 19） |

## 6. c3 · `factors compute` CLI

**位置**：`apps/quant-pipeline/src/quant_pipeline/cli.py`，紧邻已有 `labels_app` / `features_app` 注册处。

```text
factors_app = typer.Typer(help="因子计算子命令（M1 Part C）。读 raw.* → 写 factors.daily_factors。")
app.add_typer(factors_app, name="factors")

@factors_app.command("compute")
def factors_compute(
    version: str    = typer.Option(..., "--version",    help="factor_version，如 v1"),
    date_range: str = typer.Option(..., "--date-range", help="YYYYMMDD:YYYYMMDD"),
    factor_ids: str = typer.Option("",  "--factor-ids", help="逗号分隔；留空 = 全部 v1 因子"),
) -> None:
    setup_logging()
    from quant_pipeline.factors.runner import run_factors

    ids = tuple(s.strip() for s in factor_ids.split(",") if s.strip()) or None
    out = run_factors(
        factor_version=version,
        date_range=date_range,
        factor_ids=ids,
        job_id=None,    # CLI 直跑，不写 ml.jobs
    )
    typer.echo(
        f"factors compute v={version} {date_range}: "
        f"trade_dates={out['trade_dates']} factors={out['factors']} "
        f"rows_upserted={out['rows_upserted']}"
    )
```

**显式不做**：
- 不加 `--force`：与 `sync raw` 对齐，纯 idempotent upsert
- 不加 `--job-id`：spec 02 §3 约定 CLI 直跑不写 `ml.jobs`，job_id 路径由 worker dispatcher 走
- 不加 `--dry-run`：因子幂等，无副作用残留

## 7. c4 · PG 集成测两件套

**目录**：`apps/quant-pipeline/tests/integration/`（仅有 `__init__.py`，本次首次落实际用例）

**共享 fixture**（新建 `conftest.py`）：
```text
@pytest.fixture(scope="session")
def pg_session():
    # 复用 quant_pipeline.db.engine.session_scope
    # 无法 connect crypto-postgres → pytest.skip("requires docker crypto-postgres")
```

### 7.1 `test_factors_runner_pg.py`

| 用例 | 断言 |
|---|---|
| `test_load_industry_pit_returns_l1_code` | `_load_industry_pit('20240601','20240630')` → DF 非空、index 含 `('20240603','000001.SZ')`、列 `industry_l1` 形如 `801xxx.SI` 申万一级前缀，无 NaN |
| `test_query_trade_dates_no_duplicates_no_calendar_dep` | `_query_trade_dates('20240601','20240630')` → 返回 19 项，全唯一；**前置 `TRUNCATE raw.trade_cal` 不影响结果** |
| `test_query_trade_dates_skips_zero_quote_day` | 临时把 `raw.daily_quote` 中 `20240605` 全部行 BACKUP+DELETE，断言新 `_query_trade_dates('20240601','20240630')` 不含 `'20240605'` 且总数 = 18；测试结束后恢复（fixture 自动 rollback） |
| `test_run_factors_smoke_2day_window` | `run_factors(factor_version='v1', date_range='20240627:20240628')` → `rows_upserted > 5000 * 5`；当日 `daily_factors` 去重 ts_code 数 ≈ `daily_quote` 当日股票数 |

### 7.2 `test_partitions_migration_pg.py`

| 用例 | 断言 |
|---|---|
| `test_migration_creates_468_partitions` | `pg_inherits` 子分区：`daily_factors / labels / feature_matrix` 各 **严格 == 156**，命名 match `<table>_y\d{4}m\d{2}`。注：后续 migration 追加分区时必须同步更新本断言常量 |
| `test_partition_bounds_consistent` | 抽样 5 个分区（含 `daily_factors_y2024m06`）→ `pg_get_expr(relpartbound, oid)` 输出"月初到下月初" |
| `test_idempotent_rerun` | 手工再次 `op.execute` migration upgrade 主体 → 不抛错；分区行数不变 |

### 7.3 数据假设

- `raw.daily_quote` 已有 2024-06 数据（dry-run 第一轮已落，raw 在 c5 不清空）
- `raw.index_member` 已有 2024-06 有效行（dry-run §1.1 已 sync）
- 本机已 `docker compose up crypto-postgres`；CI 环境需先起 docker

### 7.4 运行

```text
cd apps/quant-pipeline
uv run --extra dev pytest tests/integration/ -v
```

## 8. c5 · 重跑 dry-run §1.1 + 验收门槛

### 步骤

```text
# step 0：清零 factors / ml 业务表（不动 raw.*）
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
  TRUNCATE factors.daily_factors, factors.labels, factors.feature_matrix,
           ml.quality_reports RESTART IDENTITY CASCADE;
"

# step 1：跑 c1 migration（建 468 分区）
cd apps/quant-pipeline
uv run alembic upgrade head

# step 2：raw 已就绪，不重跑 sync

# step 3：新 CLI 跑 factors compute
uv run quant factors compute --version v1 --date-range 20240601:20240630

# step 4：quality check + pit-audit
uv run quant quality check --date 20240628 --strict
uv run quant quality pit-audit

# step 5：核对 ml.quality_reports
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
  SELECT level, rule, count(*) FROM ml.quality_reports
  GROUP BY level, rule ORDER BY level, rule;
"
```

### 验收门槛（全绿才算通过）

| 门槛 | 期望值 |
|---|---|
| `factors compute` 输出 | `trade_dates=19`（daily_quote distinct，无 SSE/SZSE 双计）；`factors=16`；`rows_upserted ≥ 1.4M`（粗算 19×16×5300 ≈ 1.61M，留 ~13% 余量覆盖 industry 5 因子按 95% 覆盖率折算 + 停牌 ~2% + 新上市 ~1%） |
| 20240628 当日 `daily_factors` 股票数 vs `daily_quote` 同日 | ±5% |
| 16 个 factor_id 全部有当日 ≥ 5000 行 | 是 |
| 5 个 industry 类因子的 `industry_l1` 非空率（窗口内任一日抽样） | ≥ 95%——避免"早年 l1_code NULL 导致 industry 因子集体空跑"被验收门槛遗漏 |
| `quality check --strict` 退出码 | 0（不再 BLOCKED） |
| `ml.quality_reports` | `critical = 0`；warn 仅允许已知 pit_finance stub 一条 |
| `pg_inherits` 子分区数 | 父表 3 张各严格 156 |
| `uv run --extra dev pytest tests/integration/ -v` | 全绿 |

## 9. c6 · 文档收尾

1. **TODO.md**
   - 删除 §1.1 临时"手工建分区"说明（已由 c1 接管）
   - §1.1 验收清单末插入本轮 dry-run 完成日期 + commit hash 引用
   - §1.2 全量回填不再需要分区准备步骤

2. **apps/quant-pipeline/README.md**
   - "CLI 入口"段补 `quant factors compute --version v1 --date-range ...`

3. **doc/specs/2026-05-17-quant-model-training/02-quant-pipeline.md**
   - "因子运行依赖"段：明确 `_query_trade_dates` 改用 `raw.daily_quote`
   - 注明 "trade_cal 仅服务于次日是否开市等前瞻查询"

4. **CLAUDE.md** 不动
   - 现有"数据完整性 & 第三方 API"章节已覆盖本轮 bug 根因（mock 不验契约 / 0 行需 failedItems）
   - 新增 PG 集成测样例即等于落地

## 9.5 c7 · 修 bollinger_position_20d NAType bug（c5 暴露）

**位置**：`apps/quant-pipeline/src/quant_pipeline/factors/price/bollinger_position_20d.py:44`

**根因**：用 `pd.NA` 做 0 分母占位，使 series 变成 nullable dtype；下游 `runner._upsert_daily_factors` 走 `float(value)` 时 `float(pd.NA)` 抛 `TypeError: float() argument must be a string or a real number, not 'NAType'`。c5 实测在 20240606 / 20240607 全市场 skip → 丢 ~10K 行。

**修复**：将 `pd.NA` 换成 `np.nan`。series 保持 `float64` dtype，divide-by-0 自然产生 inf/nan，runner 已有 `np.isnan(value)` 检查（[runner.py:376](../../apps/quant-pipeline/src/quant_pipeline/factors/runner.py#L376)）。

```text
-import pandas as pd
+import numpy as np
+import pandas as pd
...
-denom = (upper - lower).replace(0, pd.NA)
+denom = (upper - lower).replace(0, np.nan)
```

**验证**：c5 重跑后 `bollinger_position_20d` 应 19 天全命中、~5300 行/日。

## 9.6 c8 · 修 index_member sync 覆盖率（c5 暴露）

**位置**：`apps/quant-pipeline/src/quant_pipeline/sync/orchestrator.py:172-174`（调用方）+ `sync/index_member.py`（实现已经支持 l1_codes 循环）

**根因**：orchestrator 调用 `sync_index_member(client=client)` 不传 `l1_codes`，单次 fetch 受 TuShare `index_member_all` 默认行数上限（实测 3000 行截断），只取到 31 个 L1 行业的部分成份股（3000 distinct ts_code vs 全 A 5300 股）。导致：
- `_load_industry_pit` 命中率 ~52%（缺主板外的 BJ/创业板/科创板新股、ST 等）
- `quality check` 的 `survivor_bias` rule 抓到 35 个 ts_code 不在 baseline → BLOCKED

**修复**：让 orchestrator 先从 `raw.index_classify` 取 `level='L1' AND src='SW2021'` 的 31 个 L1 code 列表，再传入 `sync_index_member(l1_codes=...)`，按 L1 分批 fetch。

```text
# orchestrator.py 改动伪码
elif table == "index_member":
    # 先确保 index_classify 已就绪（已在前一步执行）
    l1_codes = _list_l1_codes_from_classify()   # SELECT DISTINCT index_code FROM raw.index_classify WHERE level='L1' AND src='SW2021'
    reports = sync_index_member(client=client, l1_codes=l1_codes or None)
    _collect_reports("index_member", reports, outcome)
```

`l1_codes or None` 兜底：若 `raw.index_classify` 为空（前置步骤失败），退化为单次全量调用（向后兼容现状）。

**验证**：c5 重跑后 `raw.index_member` 应有 ≥ 5000 distinct ts_code，`industry_l1` 非空率 ≥ 95%，`survivor_bias` rule 不再触发 critical。

**重跑 c5 步骤补充**（c8 落地后）：
```text
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "TRUNCATE raw.index_member"
uv run quant sync raw --date-range 20240601:20240630 --tables index_classify,index_member
# 然后 truncate factors/ml + 重跑 factors compute + quality check
```

## 10. YAGNI 明确不做

- partition 自动扩展机制（2030 之后再说）
- factors/registry 与 features/builder 解耦
- trade_cal 全量 sync 至 2018
- `factors compute --force` / `--dry-run` / `--job-id` 等扩展旗标

## 11. 风险与开放问题

| 风险 | 预案 |
|---|---|
| `daily_quote.trade_date` 在某历史日漏行 → 新 `_query_trade_dates` 少算一日 | c4 测对 2024-06 断言 19 个交易日 + 负向用例 `test_query_trade_dates_skips_zero_quote_day` |
| sync 写入的 `l1_code` 在历史某段为 NULL（早年 TuShare 接口） → industry 因子退化 | dry-run 阶段：`WHERE l1_code IS NOT NULL` 兜底 + c4 测在 2024-06 范围内确认非空率 ≥ 95%。**全量回填（§1.2）前**：必须先单独跑 `SELECT min(in_date), count(*) FILTER (WHERE l1_code IS NULL) / count(*)::float FROM raw.index_member` 验证早期覆盖率；若早期年份 l1_code NULL 率 > 10%，需要先补 `sync index_member` 或重新评估行业归属来源（如改用 `tushare.industry_member` 等更稳定接口） |
| 468 个分区导致 `pg_class` / `pg_inherits` 查询缓慢 | 监控 `EXPLAIN ANALYZE` 单查询 < 100ms；超时则评估"按季度而非按月" |
| migration 在生产环境耗时过长 | 本地测算：468 × `CREATE TABLE` ≈ 5-10 秒 |

## 12. 参考

- [TODO.md](../../TODO.md) §1.1
- [apps/quant-pipeline/src/quant_pipeline/factors/runner.py](../../apps/quant-pipeline/src/quant_pipeline/factors/runner.py)
- [apps/quant-pipeline/src/quant_pipeline/cli.py](../../apps/quant-pipeline/src/quant_pipeline/cli.py)
- [apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260517_0001_factors_ml_initial.py](../../apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260517_0001_factors_ml_initial.py)
- [apps/quant-pipeline/src/quant_pipeline/sync/index_member.py](../../apps/quant-pipeline/src/quant_pipeline/sync/index_member.py)
- [CLAUDE.md](../../CLAUDE.md) §硬约束
