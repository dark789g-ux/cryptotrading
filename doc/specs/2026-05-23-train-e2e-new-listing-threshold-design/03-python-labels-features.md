# 03 Python 后端:labels + features + 预查复用

## labels 层

### `labels/strategy_aware.py`

```python
NEW_LISTING_MIN_DAYS = 60   # 保留作为默认常量

@dataclass
class LabelInputs:
    daily_quotes: pd.DataFrame
    stk_limit: pd.DataFrame | None = None
    suspend_d: pd.DataFrame | None = None
    delist: pd.DataFrame | None = None
    listing: pd.DataFrame | None = None
    entries: pd.DataFrame | None = None
    end: str | None = None
    new_listing_min_days: int | None = None   # ← 新增,None 表示走默认 60


def compute_strategy_aware_labels(inputs: LabelInputs) -> pd.DataFrame:
    ...
    # None → 默认 60;0 是合法值表示不过滤
    min_days = (
        inputs.new_listing_min_days
        if inputs.new_listing_min_days is not None
        else NEW_LISTING_MIN_DAYS
    )
    _validate_min_days(min_days)
    cand = filter_new_listing(
        cand,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates_sorted,
        min_days=min_days,
        entry_col="buy_date",
    )
    ...


def _validate_min_days(v: int) -> None:
    if not isinstance(v, int) or v < 0 or v > 250:
        raise ValueError(f"new_listing_min_days must be int in [0,250], got {v!r}")
```

**关键陷阱**:
- 不能 `if min_days:`(0 会被判 falsy);用 `is None`
- `_validate_min_days` 抛 ValueError,由 worker 顶层捕获并标记 job=failed

### `labels/fallback.py`(D-1 缺口补齐)

当前 `compute_fwd_5d_ret` 未做新股过滤,改造:

```python
from quant_pipeline.labels.strategy_aware import (
    NEW_LISTING_MIN_DAYS,
    filter_new_listing,
    _validate_min_days,
)

@dataclass
class FallbackInputs:
    daily_quotes: pd.DataFrame
    listing: pd.DataFrame | None = None              # ← 新增:用于新股过滤
    new_listing_min_days: int | None = None          # ← 新增


def compute_fwd_5d_ret(inputs: FallbackInputs) -> pd.DataFrame:
    df = ...                              # 现有 keep 掩码构建

    # 新增:新股过滤,锚列是 trade_date(SubAgent 实测的锚列)
    if inputs.listing is not None:
        min_days = (
            inputs.new_listing_min_days
            if inputs.new_listing_min_days is not None
            else NEW_LISTING_MIN_DAYS
        )
        _validate_min_days(min_days)
        if min_days > 0:                  # 0 即不过滤,显式短路
            list_date_map = dict(zip(inputs.listing["ts_code"], inputs.listing["list_date"]))
            trade_dates_sorted = sorted(df["trade_date"].unique().tolist())
            df = filter_new_listing(
                df,
                list_date_map=list_date_map,
                trade_dates_sorted=trade_dates_sorted,
                min_days=min_days,
                entry_col="trade_date",   # ← 实测锚列(非 PROMPT 所写的 signal_date)
            )
    ...
```

**注意**:
- `if min_days > 0` 显式短路,避免 `min_days=0` 时白跑一遍 filter_new_listing
- `listing` 为 None 时跳过过滤(向后兼容老调用方,不强制传 listing)

### `labels/runner.py`

```python
def compute_labels(
    *,
    scheme: str,
    date_range: str,
    new_listing_min_days: int | None = None,   # ← 新增 kwarg
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> int:
    ...
    if scheme == "strategy-aware":
        inputs = LabelInputs(..., new_listing_min_days=new_listing_min_days)
        df = compute_strategy_aware_labels(inputs)
    elif scheme == "fwd_5d_ret":
        listing = _load_listing(conn)                                # ← 新增加载
        inputs = FallbackInputs(..., listing=listing,
                                new_listing_min_days=new_listing_min_days)
        df = compute_fwd_5d_ret(inputs)
    ...


# dispatcher 入口
def runner_entrypoint(job):
    params = job.params
    return compute_labels(
        scheme=params["scheme"],
        date_range=params["date_range"],
        new_listing_min_days=params.get("new_listing_min_days"),   # 可为 None
        job_id=job.id,
        progress_callback=...,
    )
```

## features 层 + 预查复用

### `features/builder.py` 哈希契约升级

```python
import hashlib, json

DEFAULT_NEUTRALIZE_COLS = ("industry_l1", "mv")
DEFAULT_ROBUST_Z = True

def build_feature_set_id(
    factor_version: str,
    label_scheme: str,
    *,
    new_listing_min_days: int,                                 # ← 必填,与 schema 对齐
    neutralize_cols: tuple[str, ...] = DEFAULT_NEUTRALIZE_COLS,
    robust_z: bool = DEFAULT_ROBUST_Z,
    factor_ids: tuple[str, ...] = (),                          # ← 新增,D-22
) -> str:
    payload = {
        "factor_version": factor_version,
        "label_scheme": label_scheme,
        "new_listing_min_days": int(new_listing_min_days),     # 强类型,防 60 vs '60'
        "neutralize_cols": sorted(neutralize_cols),
        "robust_z": bool(robust_z),
        "factor_ids": sorted(factor_ids),                      # 排序稳定
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return "fs_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
```

### 预查复用机制(D-16)

```python
def resolve_feature_set_id(
    conn,
    *,
    factor_version: str,
    label_scheme: str,
    new_listing_min_days: int,
    factor_ids: tuple[str, ...],
    neutralize_cols: tuple[str, ...] = DEFAULT_NEUTRALIZE_COLS,
    robust_z: bool = DEFAULT_ROBUST_Z,
) -> tuple[str, bool]:
    """
    返回 (feature_set_id, is_reused)。

    预查复用机制:
      1. 计算新哈希(含 new_listing_min_days, factor_ids)
      2. SELECT 同逻辑元组是否已有行(唯一索引保兜底)
         - 命中 → 复用老 ID(避免哈希契约升级导致的语义重复)
         - 未命中 → 用新哈希 ID,后续 upsert
    """
    new_id = build_feature_set_id(
        factor_version=factor_version,
        label_scheme=label_scheme,
        new_listing_min_days=new_listing_min_days,
        neutralize_cols=neutralize_cols,
        robust_z=robust_z,
        factor_ids=factor_ids,
    )
    factor_ids_md5 = hashlib.md5(
        ",".join(sorted(factor_ids)).encode("utf-8")
    ).hexdigest()

    row = conn.execute("""
        SELECT feature_set_id FROM factors.feature_sets
         WHERE factor_version = :fv
           AND scheme = :sc
           AND new_listing_min_days = :nd
           AND md5(array_to_string(factor_ids, ',')) = :fmd5
    """, dict(fv=factor_version, sc=label_scheme, nd=new_listing_min_days,
              fmd5=factor_ids_md5)).fetchone()

    if row:
        return row[0], True
    return new_id, False
```

**与 DB 唯一索引的契约**:
- 索引表达式:`md5(array_to_string(factor_ids, ','))`
- builder 端排序:`sorted(factor_ids)` 后 `",".join(...)`
- **必须保证**:DB 写入前 builder 也对 factor_ids 排序后写入,否则索引的 md5 与 builder 算的 md5 不一致 → 预查永远不命中

### `features/runner.py`

```python
def build_feature_matrix(
    *,
    factor_version: str,
    label_scheme: str,
    date_range: str,
    new_listing_min_days: int,                  # ← 新增必填
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> FeatureMatrixBundle:
    ...
    factor_ids = tuple(sorted(_load_factor_ids(conn, factor_version)))  # ← 排序!

    fsid, reused = resolve_feature_set_id(
        conn,
        factor_version=factor_version,
        label_scheme=label_scheme,
        new_listing_min_days=new_listing_min_days,
        factor_ids=factor_ids,
    )

    # upsert feature_sets 行(reused 时是 no-op)
    conn.execute("""
        INSERT INTO factors.feature_sets
            (feature_set_id, factor_version, scheme, factor_ids, new_listing_min_days)
        VALUES (:fsid, :fv, :sc, :fids, :nd)
        ON CONFLICT (feature_set_id) DO NOTHING
    """, dict(fsid=fsid, fv=factor_version, sc=label_scheme,
              fids=list(factor_ids), nd=new_listing_min_days))

    matrix = _compute_matrix(conn, factor_ids, date_range, ...)
    _upsert_feature_matrix(conn, matrix, fsid)

    return FeatureMatrixBundle(feature_set_id=fsid, factor_ids=factor_ids, matrix=matrix)
```

## 历史 feature_set_id 兼容矩阵

| 场景 | 老 ID 哈希算法 | 新 ID 哈希算法 | 预查行为 |
|---|---|---|---|
| 老 row(`min_days` 回填 60,factor_ids 未在哈希) | 不含 min_days、不含 factor_ids | 含两者 | 命中(三元组匹配)→ 复用老 ID |
| 老 row 但 factor_ids 与新跑不同 | 不含 factor_ids | 含 factor_ids | 不命中 → 写新行 |
| 老 row 但 neutralize_cols/robust_z 非 default | — | 假设强 default,不在索引内 | 误命中风险(详见 07) |

## 单测覆盖

`apps/quant-pipeline/tests/unit/` 下三个文件新增/修改:

### `test_labels_strategy_aware.py`

```python
@pytest.mark.parametrize("min_days", [0, 30, 60, 90, 250])
def test_strategy_aware_min_days_param(min_days, sample_inputs):
    inputs = LabelInputs(**sample_inputs, new_listing_min_days=min_days)
    df = compute_strategy_aware_labels(inputs)
    # min_days=0 → 不过滤;min_days=250 → 几乎全过滤

def test_strategy_aware_min_days_invalid():
    for bad in [-1, 251, "60", 60.0]:
        with pytest.raises(ValueError, match="new_listing_min_days"):
            compute_strategy_aware_labels(LabelInputs(..., new_listing_min_days=bad))
```

### `test_labels_fallback.py`(D-1 缺口测试)

```python
def test_fwd_5d_ret_filters_new_listing(fixture_with_new_stock_in_first_60d):
    df = compute_fwd_5d_ret(FallbackInputs(..., listing=listing_df,
                                           new_listing_min_days=60))
    assert not df["ts_code"].eq("301234.SZ").any()    # 新股已过滤

def test_fwd_5d_ret_min_days_zero_skips_filter(...):
    df = compute_fwd_5d_ret(FallbackInputs(..., listing=listing_df,
                                           new_listing_min_days=0))
    assert df["ts_code"].eq("301234.SZ").any()        # 新股保留
```

### `test_features_builder.py`

```python
def test_build_feature_set_id_stable_across_factor_id_order():
    a = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60,
                              factor_ids=("f1","f2"))
    b = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60,
                              factor_ids=("f2","f1"))
    assert a == b

def test_build_feature_set_id_differs_by_min_days():
    a = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=30,
                              factor_ids=("f1",))
    b = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60,
                              factor_ids=("f1",))
    assert a != b

def test_resolve_feature_set_id_reuses_old_id(pg_conn):
    pg_conn.execute("""
        INSERT INTO factors.feature_sets
            (feature_set_id, factor_version, scheme, factor_ids, new_listing_min_days)
        VALUES ('fs_legacy', 'v1', 'strategy-aware', ARRAY['f1'], 60)
    """)
    fsid, reused = resolve_feature_set_id(
        pg_conn, factor_version="v1", label_scheme="strategy-aware",
        new_listing_min_days=60, factor_ids=("f1",))
    assert (fsid, reused) == ("fs_legacy", True)

def test_resolve_feature_set_id_writes_new_when_no_match(pg_conn):
    fsid, reused = resolve_feature_set_id(
        pg_conn, factor_version="v1", label_scheme="strategy-aware",
        new_listing_min_days=30, factor_ids=("f_new",))
    assert reused is False
    assert fsid.startswith("fs_")
```
