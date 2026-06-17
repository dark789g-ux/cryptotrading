"""美股指数 AMV 同步编排器：遍历指数 → 取成分行情 → 算 AMV 写表。

run_type='us_index_amv_sync'（spec 04 §4）。镜像 us_index_orchestrator.run_us_index_sync：
- 逐 index_code：load_constituents → resolve_warmup_start（按交易行查 .NDX 表）→
  步骤1 逐 ticker 复用 sync_us_daily_for_ticker 灌 [fetch_start,end] → raw.us_daily_quote；
  步骤2 读 [fetch_start,end] Σ聚合 + .NDX 点位 + 套公式 → 裁热身/丢异常 → upsert AMV 表。
- 单成分失败逐个 except 记 errors，不中断整批；空/0 行 → failed_items(rule=us_daily_empty)。
- sync_us_daily_for_ticker 的 factor_empty(qfq 缺) 对 AMV **无关**，只 warn 不计失败；
  只有 empty_path(quote 空) 才是 AMV 失败。
- 某指数无可落库行（裁热身/过滤异常后空，或某窗口无 Σ）→ 记 errors（禁伪装成功）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from uuid import UUID

from quant_pipeline.sync.yahoo_client import YahooClient
from quant_pipeline.sync.us_daily import sync_us_daily_for_ticker
from quant_pipeline.sync.us_index_amv import (
    AmvComputeError,
    compute_and_write_amv,
    resolve_warmup_start,
)
from quant_pipeline.sync.us_index_constituent import load_constituents
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)

DEFAULT_INDEX_CODES: tuple[str, ...] = (".NDX",)


@dataclass
class UsIndexAmvFailedItem:
    index_code: str
    ticker: str | None
    api_name: str
    reason: str
    rule: str  # us_daily_empty


@dataclass
class UsIndexAmvOutcome:
    rows_total: int = 0          # 成分 quote 行（步骤1 累计 upsert 行数）
    amv_rows_total: int = 0      # AMV 行（步骤2 累计 upsert 行数）
    constituents_done: int = 0   # 取数成功的成分数（含 factor_empty 退化但 quote 有行）
    failed_items: list[UsIndexAmvFailedItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _parse_date_range(date_range: str) -> tuple[str, str]:
    if ":" not in date_range:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")
    start, end = date_range.split(":", 1)
    if len(start) != 8 or len(end) != 8 or not start.isdigit() or not end.isdigit():
        raise ValueError(f"date_range must be YYYYMMDD pair, got {date_range!r}")
    return start, end


def run_us_index_amv_sync(
    *,
    job_id: UUID | None,
    date_range: str,
    symbols: tuple[str, ...] | None = None,
    client: YahooClient | None = None,
    write_start: str | None = None,
) -> UsIndexAmvOutcome:
    """美股指数 AMV 同步入口。

    job_id=None → CLI 直跑（不写 ml.jobs）；否则回写进度。
    symbols=None → 缺省 ('.NDX',)（v1 硬编码，结构留多指数）。
    write_start（spec 04 约束B）：默认 None → 等于 date_range 的 start（行为不变）。
    AMV 的写窗口起点 = effective_write_start：warmup 从它往前推 150 交易行
    （resolve_warmup_start），AMV 行只写 trade_date >= effective_write_start。
    **成分行情仍按全史 [fetch_start,end] 抓取入 us_daily_quote**（spec §75），不传
    write_start——AMV 在全史上算指标（warmup 恒满），只裁 AMV 写窗口。
    """
    start, end = _parse_date_range(date_range)
    effective_write_start = write_start or start
    client = client or YahooClient()
    outcome = UsIndexAmvOutcome()

    index_codes = list(symbols) if symbols else list(DEFAULT_INDEX_CODES)
    total = len(index_codes)
    if job_id is not None:
        update_progress(job_id, 0, stage="start")

    for i, index_code in enumerate(index_codes):
        if job_id is not None and check_cancel_requested(job_id):
            raise JobCancelled

        tickers = load_constituents(index_code)
        if not tickers:
            msg = f"us_index_amv: 指数 {index_code} 无成分名单（先跑 us-index-constituent seed）"
            logger.warning(msg)
            outcome.errors.append(msg)
            outcome.failed_items.append(
                UsIndexAmvFailedItem(
                    index_code=index_code,
                    ticker=None,
                    api_name="us_index_constituent",
                    reason="no_constituents",
                    rule="us_daily_empty",
                )
            )
            continue

        # warmup 从写窗口起点往前推（resolve_warmup_start 按交易行查 .NDX 表）。
        fetch_start = resolve_warmup_start(index_code, effective_write_start)

        # ---- 步骤1：逐 ticker 取成分行情 [fetch_start, end] → raw.us_daily_quote ----
        if job_id is not None:
            update_progress(
                job_id,
                int(i * 100 / total),
                stage=f"us_index_amv:fetch:{index_code}",
            )
        n_tickers = len(tickers)
        for ti, ticker in enumerate(tickers):
            if job_id is not None and check_cancel_requested(job_id):
                raise JobCancelled
            try:
                rep = sync_us_daily_for_ticker(
                    ticker=ticker,
                    start_date=fetch_start,
                    end_date=end,
                    client=client,
                )
                outcome.rows_total += rep.quote_rows
                if rep.empty_path is not None:
                    # quote 空 → AMV 关心（成分当窗口无行情）。记 failed_items 不中断。
                    outcome.failed_items.append(
                        UsIndexAmvFailedItem(
                            index_code=index_code,
                            ticker=ticker,
                            api_name="yahoo_chart",
                            reason=rep.empty_path,
                            rule="us_daily_empty",
                        )
                    )
                else:
                    outcome.constituents_done += 1
                    # factor_empty(qfq 缺) 对 AMV 无关：只 warn，不计 AMV 失败（spec 04 §1）。
                    if rep.factor_empty:
                        logger.warning(
                            "us_index_amv_constituent_factor_empty",
                            extra={"index_code": index_code, "ticker": ticker},
                        )
            except JobCancelled:
                raise
            except Exception as exc:  # noqa: BLE001 — 单成分失败不中断整批, 但显式 errors
                logger.error(
                    "us_index_amv_constituent_failed",
                    extra={"index_code": index_code, "ticker": ticker, "err": str(exc)},
                )
                outcome.errors.append(f"{index_code}/{ticker}: {exc!r}")

            # 取数阶段进度：把本指数 [i, i+1) 区间按 ticker 进度推进（聚合阶段前给 ~0..90%）
            if job_id is not None and ((ti + 1) % 20 == 0 or (ti + 1) == n_tickers):
                frac = (i + (ti + 1) / n_tickers * 0.9) / total
                update_progress(
                    job_id,
                    min(99, int(frac * 100)),
                    stage=f"us_index_amv:fetch:{index_code}:{ti + 1}/{n_tickers}",
                )

        # ---- 步骤2：读 Σ聚合 + .NDX 点位 + 套公式 → 写 raw.us_index_amv_daily ----
        if job_id is not None:
            update_progress(
                job_id,
                min(99, int((i + 0.95) * 100 / total)),
                stage=f"us_index_amv:compute:{index_code}",
            )
        try:
            amv_rep = compute_and_write_amv(
                index_code=index_code,
                start=effective_write_start,
                end=end,
                fetch_start=fetch_start,
                tickers=tickers,
            )
            outcome.amv_rows_total += amv_rep.amv_rows
        except JobCancelled:
            raise
        except AmvComputeError as exc:
            # 无 Σ / 无可落库行 → 不写该指数 + 记 errors（禁伪装成功，data-integrity §5）
            outcome.errors.append(str(exc))
        except Exception as exc:  # noqa: BLE001 — 计算/写库失败不中断整批
            logger.error(
                "us_index_amv_compute_failed",
                extra={"index_code": index_code, "err": str(exc)},
            )
            outcome.errors.append(f"{index_code}: {exc!r}")

        if job_id is not None:
            update_progress(
                job_id, int((i + 1) * 100 / total), stage=f"us_index_amv:done:{index_code}"
            )

    if job_id is not None:
        update_progress(job_id, 100, stage="done")
    return outcome
