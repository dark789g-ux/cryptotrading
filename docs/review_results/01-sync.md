# Code Review：`sync/` 数据同步子系统

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/sync/`
> 涉及文件：`_upsert.py` `tushare_client.py` `orchestrator.py` `trade_cal.py` `fina_indicator.py` `index_classify.py` `index_member.py` `stk_limit.py`
> 使用方式：新会话打开本文，逐条核实后再修复。

## 🔴 严重

### 1. `_upsert.py:79` — `upsert_rows` 假设所有 row 字典 key 与 `rows[0]` 一致，但绑定时未校验
`all_cols = list(rows[0].keys())` 只取首行的列，后续 `session.execute(sql, rows)` 把全部 rows 作为 executemany 参数。若任一行缺少 `rows[0]` 中的某列（或多出列），SQLAlchemy 会因缺绑定参数报错或静默错位。当前 6 个 sync 文件的 rows 都由固定 key 的列表推导生成，**暂时安全**，但这是隐式契约且无防御。
**建议**：断言每行 `set(r.keys()) == set(all_cols)`，否则 raise。

### 2. `tushare_client.py:148-152` — 无日期语义的接口用今日 UTC 日期伪造 `quality_reports.trade_date`
当 `params` 不含任何日期键时（如 `index_classify`/`index_member_all`），`td` 退化为 `datetime.now(UTC)`。`index_classify` 完全无日期参数，于是每次空数据都以「今天」写入 `ml.quality_reports.trade_date`，让质检看板把「行业分类拉空」错误归因到运行当天，且 A 股 UTC 当日 vs 北京时区日可能差 1 天。
**建议**：对无日期语义的接口，`trade_date` 用固定哨兵值（如 `'00000000'`），而非伪造真实日期。

### 3. `tushare_client.py:160-165` — `query` 兜底路径在重试循环里无条件吞掉 `AttributeError`
当 `getattr(pro, api_name)` 返回 `None` 时走 `pro.query(api_name, ...)`。若 `pro` 对象本身没有 `query` 方法（测试 mock 或 tushare 版本差异），`AttributeError` 会被第 168 行 `except Exception` 当作普通 API 失败重试 3 次，最终伪装成 `code_nonzero` 空数据路径——真实原因是客户端代码 bug，不是数据为空。
**建议**：在循环外预先解析 method，method 不可用直接 raise，而非进入空数据路径。

## 🟡 中等

### 4. `trade_cal.py:88` / `index_classify.py:84-93` — `is not None` 判断漏掉 NaN
`df.to_dict(orient="records")` 后 pandas 缺失值是 `float('nan')` 而非 `None`。`nan is not None` 为 `True`，于是 `str(nan)` 得到字符串 `"nan"` 写进 `pretrade_date`/`industry_code` 等列。对比：`index_member._s`（用 `v != v` 判 NaN）、`fina_indicator._jsonable` 处理正确。
**建议**：统一复用 `v != v` 的 NaN 检测，提到 `_upsert.py` 做公共工具。

### 5. `trade_cal.py:90` — `int(r["is_open"])` 对 NaN 会抛异常使整张表 fetch 失败
若 TuShare 某行 `is_open` 缺失，`int(None)`→`TypeError`、`int(nan)`→`ValueError`，异常冒泡到 orchestrator 第 270 行被吞进 `errors`，整个交易所的交易日历同步失败。`is_open` 是核心字段，后续所有按交易日循环的表都依赖它。
**建议**：对 `is_open` 缺失的行显式 warn + drop，或视为致命数据缺陷单独处理。

### 6. `stk_limit.py:78-84` — `_to_float` 把 `float('nan')` 原样返回，NaN 入数值列
`_to_float(nan)` 走 `float(v)` 成功返回 `nan`。`pre_close`/`up_limit`/`down_limit` 是数值列，NaN 入 PG `numeric` 列行为依赖 driver。
**建议**：`_to_float` 内 `if v != v: return None`。

### 7. `orchestrator.py:213` — `index_member` 兜底单次全量调用会被 2000 行上限静默截断
`_list_l1_codes_from_classify()` 返回空时退化为 `sync_index_member(client=client)` 单次全量。注释明说 `index_member_all` 单次 2000 行上限、全 A 远超。这条兜底路径会拿到截断数据但不报失败。
**建议**：兜底路径拿到数据后若行数命中已知上限阈值，记 `failed_item` 标 `index_member_truncated_suspect`。

### 8. `orchestrator.py:230` — `stk_limit`/`suspend_d` 按交易日循环时无中间进度
`_progress` 只在每张表完成后调一次。`stk_limit` 同步 6 年（约 1400 个交易日）期间进度条卡死不动。`_check_cancel()` 在循环内有，但 `update_progress` 没有。
**建议**：按交易日循环内每 N 天刷一次子进度。

### 9. `fina_indicator.py:123-145` — 与 `_upsert.upsert_rows` 重复实现 INSERT...ON CONFLICT
因为 `indicators` 需要 `CAST(... AS jsonb)` 而手写了一份 SQL。
**建议**：给 `upsert_rows` 增加可选参数 `jsonb_cols: Sequence[str]`，对指定列生成 `CAST(:col AS jsonb)` 占位符，消除重复。

### 10. `orchestrator.py:255-262` — `fina_indicator` 按 ts_code 串行循环，无批量优化且无子进度
每只股票单独 `fetch`（每次 ≥0.15s 限频），全 A 5000+ 只 → 至少 12 分钟纯等待。文档注释提到 7000 积分可用 `fina_indicator_vip` 横截面接口。
**建议**：至少补子进度，M2 切 VIP。

## 🟢 建议

- **11.** `tushare_client.py:112-116` 限频 `_last_call_ts` 实例字段无锁，非线程安全。当前单线程使用无问题，建议 docstring 标注。
- **12.** `tushare_client.py:192` `df is None and last_exc is None` 的 `data_null` 路径疑似不可达死代码。确认 tushare 是否真会返回 None，否则删除或加注释。
- **13.** `orchestrator.py:84,114,129` + `fina_indicator.py:129` — `from sqlalchemy import text` 在函数内重复 import，应提到模块顶部。
- **14.** `index_classify.py:11` docstring 说「7 个组合」，`DEFAULT_COMBOS` 只有 6 个，注释陈旧。
- **15.** `_upsert.py:42` `drop_duplicates(keep="last")` 裸依赖 TuShare 返回行序，对 `fina_indicator` 修正公告场景可能保留旧数据。建议若有 `update_flag`/`ann_date` 则按其排序后去重。

## 总评

整体设计扎实——三种空数据路径分流、failedItems 透出、PK 去重、PIT 字段入 PK 都按 CLAUDE.md 硬约束落实到位。主要风险集中在 **pandas NaN 未被一致归一为 `None`**（`trade_cal`/`index_classify`/`stk_limit` 三处会写入 `"nan"` 或数值 `NaN`），以及**几条「兜底/退化」路径会让截断或残缺数据静默通过**，需收口为显式失败项。
