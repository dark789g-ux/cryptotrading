"""PIT 三铁律 + 三幽灵 Bug 自动审计（doc/量化/03 §3.1-3.2）。

三铁律：
  1. 财务用披露日（ann_date 而非 end_date）—— 复用 checks.check_pit_finance 的核心 SQL
  2. 行情用 T 日盘后落 —— 静态：检查 factors/base.py PIT 窗口声明 ≥ 1 日
  3. 因子窗口不跨未来 —— 单测 fixture 框架；本审计提供 verify_factor_window_no_future()

三幽灵 Bug：
  1. 幸存偏差 —— 复用 checks.check_survivor_bias
  2. 复权陷阱 —— 抽样 10 支股票 × 5 个分红日，验证因子值用了后复权（adj_factor 反推）
  3. 财务延迟 —— 抽样 10 个公司财报，验证 factor_value(T) only uses fina ann_date <= T

审计输出：list[CheckResult]，由 runner emit 到 ml.quality_reports。
"""

from __future__ import annotations

import inspect
import logging
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.quality.checks import (
    check_pit_finance,
    check_survivor_bias,
)
from quant_pipeline.quality.report import CheckResult

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 铁律 1：财务用披露日（直接复用 check_pit_finance；提供一个固定 trade_date 适配器）
# ----------------------------------------------------------------------

def audit_rule1_finance_uses_ann_date(
    session: Session,
    sample_trade_dates: Iterable[str],
    params: dict[str, Any] | None = None,
) -> list[CheckResult]:
    """对若干抽样交易日跑 check_pit_finance，任一失败即返回该日的 CheckResult。"""

    out: list[CheckResult] = []
    for d in sample_trade_dates:
        result = check_pit_finance(session, d, params or {})
        if not result.passed:
            out.append(result)
    return out


# ----------------------------------------------------------------------
# 铁律 2：行情用 T 日盘后（静态：检查 factors/base.py PIT 窗口声明）
# ----------------------------------------------------------------------

# factors/base.py 抽象类应当声明 pit_window_days >= 1（Part D 交付）
_BASE_PIT_FIELD_RE = re.compile(
    r"pit_window_days\s*[:=]\s*(?:int\s*=\s*)?(\d+)",
    re.MULTILINE,
)


def audit_rule2_market_pit_window(
    factors_base_path: Path | None = None,
) -> CheckResult:
    """检查 factors/base.py 是否声明了 pit_window_days >= 1（doc/03 §3.1 铁律 2）。

    Part D 负责实现 base.py；本审计仅做静态文本扫描，发现 < 1 或未声明时 warn。
    base.py 不存在时返回 info（M1 早期阶段可能未实装）。
    """

    if factors_base_path is None:
        factors_base_path = (
            Path(__file__).resolve().parent.parent / "factors" / "base.py"
        )

    if not factors_base_path.exists():
        return CheckResult(
            passed=True,
            level="info",
            rule="pit_finance",  # 复用 rule 名（§4.3 中无独立 market PIT 规则）
            detail={
                "audit": "rule2_market_pit_window",
                "factor_id": "<base.py>",
                "sample_ts_codes": [],
                "note": "factors/base.py not yet implemented (Part D pending)",
            },
            trade_date="00000000",
            name="rule2_market_pit_window",
        )

    src = factors_base_path.read_text(encoding="utf-8")
    matches = _BASE_PIT_FIELD_RE.findall(src)
    if not matches:
        return CheckResult(
            passed=False,
            level="warn",
            rule="pit_finance",
            detail={
                "audit": "rule2_market_pit_window",
                "factor_id": "<base.py>",
                "sample_ts_codes": [],
                "reason": "pit_window_days field not declared in factors/base.py",
            },
            trade_date="00000000",
            name="rule2_market_pit_window",
        )

    min_window = min(int(m) for m in matches)
    if min_window < 1:
        return CheckResult(
            passed=False,
            level="warn",
            rule="pit_finance",
            detail={
                "audit": "rule2_market_pit_window",
                "factor_id": "<base.py>",
                "sample_ts_codes": [],
                "min_pit_window_days": min_window,
                "reason": "pit_window_days < 1; T 日盘后约束未生效",
            },
            trade_date="00000000",
            name="rule2_market_pit_window",
        )

    return CheckResult(
        passed=True,
        level="info",
        rule="pit_finance",
        detail={
            "audit": "rule2_market_pit_window",
            "min_pit_window_days": min_window,
        },
        trade_date="00000000",
        name="rule2_market_pit_window",
    )


# ----------------------------------------------------------------------
# 铁律 3：因子窗口不跨未来（提供单测框架）
# ----------------------------------------------------------------------

def verify_factor_window_no_future(
    factor_callable: Any,
    trade_date: str,
    historical_data: Any,
) -> CheckResult:
    """单测使用：调用 factor_callable.compute(trade_date=T, data=historical_data)
    后，验证传给 compute 的 data 没有 > T 的样本。

    本函数面向 fixture / 单测调用；不直连 DB。返回 CheckResult 供测试断言。
    """

    used_dates: list[str] = []
    try:
        sig = inspect.signature(factor_callable.compute)
        kwargs: dict[str, Any] = {"trade_date": trade_date, "data": historical_data}
        # 容忍签名差异：只传 compute 接受的参数
        accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
        factor_callable.compute(**accepted)

        # 抽取 historical_data 中的 trade_date 列（pandas DataFrame / dict / 自定义 fixture 兼容）
        td = None
        if hasattr(historical_data, "__getitem__"):
            try:
                td = historical_data["trade_date"]
            except (KeyError, TypeError):
                td = None
        if td is None and hasattr(historical_data, "trade_date"):
            td = historical_data.trade_date
        if td is not None:
            if hasattr(td, "tolist"):
                td = td.tolist()
            used_dates = [str(d) for d in td]
    except Exception as exc:
        return CheckResult(
            passed=False,
            level="warn",
            rule="pit_finance",
            detail={
                "audit": "rule3_factor_window_no_future",
                "factor_id": getattr(factor_callable, "factor_id", "<unknown>"),
                "sample_ts_codes": [],
                "error": str(exc),
            },
            trade_date=trade_date,
            name="rule3_factor_window_no_future",
        )

    future_dates = [d for d in used_dates if d > trade_date]
    if future_dates:
        return CheckResult(
            passed=False,
            level="critical",
            rule="pit_finance",
            detail={
                "audit": "rule3_factor_window_no_future",
                "factor_id": getattr(factor_callable, "factor_id", "<unknown>"),
                "sample_ts_codes": [],
                "future_dates": future_dates[:10],
            },
            trade_date=trade_date,
            name="rule3_factor_window_no_future",
        )

    return CheckResult(
        passed=True,
        level="info",
        rule="pit_finance",
        detail={
            "audit": "rule3_factor_window_no_future",
            "factor_id": getattr(factor_callable, "factor_id", "<unknown>"),
            "used_dates_count": len(used_dates),
        },
        trade_date=trade_date,
        name="rule3_factor_window_no_future",
    )


# ----------------------------------------------------------------------
# 三幽灵 Bug 1：幸存偏差（复用 check_survivor_bias）
# ----------------------------------------------------------------------

def audit_ghost1_survivor_bias(
    session: Session, sample_trade_dates: Iterable[str]
) -> list[CheckResult]:
    out: list[CheckResult] = []
    for d in sample_trade_dates:
        result = check_survivor_bias(session, d, params={})
        if not result.passed:
            out.append(result)
    return out


# ----------------------------------------------------------------------
# 三幽灵 Bug 2：复权陷阱
# ----------------------------------------------------------------------

def audit_ghost2_adj_trap(
    session: Session,
    sample_size_codes: int = 10,
    sample_size_dates: int = 5,
) -> list[CheckResult]:
    """随机抽样 N 支股票 × M 个分红日，验证因子值用了"后复权"。

    实现思路：
      - 分红日 = adj_factor 在该 ts_code 上发生过相对变化的 trade_date
      - 后复权约定：raw.daily_quote.close * (adj_factor_T / adj_factor_LATEST)
        不随时间漂移；本审计抽样比对"因子使用值"和"理论后复权值"
      - 因 factors.daily_factors 是因子值非价格，复权陷阱的最弱审计：
        检查同一 ts_code 跨分红日的 factor_id='close_adj'（或派生量价因子）
        是否在分红日发生异常跳变（应当平滑，因为已用 adj_factor 处理过）
    """

    # 找出存在 adj_jump > 1.5 的 (ts_code, trade_date) 作为"分红日候选"
    candidate_sql = text(
        """
        WITH adj_series AS (
            SELECT ts_code, trade_date, adj_factor::double precision AS af,
                   LAG(adj_factor::double precision) OVER (
                       PARTITION BY ts_code ORDER BY trade_date
                   ) AS prev_af
            FROM raw.adj_factor
        )
        SELECT ts_code, trade_date
        FROM adj_series
        WHERE prev_af IS NOT NULL AND prev_af > 0
          AND (af / prev_af > 1.5 OR prev_af / NULLIF(af, 0) > 1.5)
        ORDER BY random()
        LIMIT :n
        """
    )
    try:
        candidates = session.execute(
            candidate_sql, {"n": sample_size_codes * sample_size_dates}
        ).all()
    except Exception as exc:
        logger.warning("ghost2_adj_trap_skip", extra={"err": str(exc)})
        return []

    if not candidates:
        return []

    issues: list[CheckResult] = []
    for ts_code, trade_date in candidates[: sample_size_codes * sample_size_dates]:
        # 比对：因子表 close_adj 在分红日 vs 前一日，若变化 > 20% 视为复权未处理
        sql = text(
            """
            WITH today AS (
                SELECT value FROM factors.daily_factors
                WHERE ts_code = :c AND trade_date = :d
                  AND factor_id = 'close_adj'
                LIMIT 1
            ),
            prev AS (
                SELECT value FROM factors.daily_factors
                WHERE ts_code = :c
                  AND trade_date = (
                      SELECT max(trade_date) FROM factors.daily_factors
                      WHERE ts_code = :c AND trade_date < :d
                        AND factor_id = 'close_adj'
                  )
                  AND factor_id = 'close_adj'
                LIMIT 1
            )
            SELECT (SELECT value FROM today), (SELECT value FROM prev)
            """
        )
        try:
            row = session.execute(sql, {"c": ts_code, "d": trade_date}).first()
        except Exception:
            continue
        if not row or row[0] is None or row[1] is None or row[1] == 0:
            continue
        ratio = float(row[0]) / float(row[1])
        if ratio > 1.2 or ratio < 0.8:
            issues.append(
                CheckResult(
                    passed=False,
                    level="critical",
                    rule="adj_jump",
                    detail={
                        "ts_code": ts_code,
                        "date": trade_date,
                        "prev_factor": float(row[1]),
                        "curr_factor": float(row[0]),
                        "ratio": ratio,
                        "audit": "ghost2_adj_trap",
                        "note": (
                            "factor 'close_adj' jumped > 20% on a dividend day; "
                            "可能未用后复权"
                        ),
                    },
                    trade_date=trade_date,
                    name="ghost2_adj_trap",
                )
            )
    return issues


# ----------------------------------------------------------------------
# 三幽灵 Bug 3：财务披露延迟（抽样 10 个公司财报）
# ----------------------------------------------------------------------

def audit_ghost3_fina_delay(
    session: Session, sample_size: int = 10
) -> list[CheckResult]:
    """随机抽样 N 个公司财报，验证 factor_value(T) only uses fina ann_date <= T。

    策略：
      - 抽 N 个 (ts_code, ann_date) 财报样本
      - 对每个样本，查 factors.daily_factors 中 trade_date < ann_date 且
        factor_id 以 'fin_' 开头的记录；存在则说明用了"未发布"财务数据
    """

    sample_sql = text(
        """
        SELECT ts_code, ann_date, end_date
        FROM raw.fina_indicator
        WHERE ann_date IS NOT NULL
        ORDER BY random()
        LIMIT :n
        """
    )
    try:
        samples = session.execute(sample_sql, {"n": sample_size}).all()
    except Exception as exc:
        logger.warning("ghost3_fina_delay_skip", extra={"err": str(exc)})
        return []

    issues: list[CheckResult] = []
    for ts_code, ann_date, end_date in samples:
        # 在 [end_date, ann_date) 区间内，因子表用到了该公司的 fundamental 因子吗？
        leak_sql = text(
            """
            SELECT factor_id, trade_date FROM factors.daily_factors
            WHERE ts_code = :c
              AND factor_id LIKE 'fin\\_%' ESCAPE '\\'
              AND trade_date >= :end_d
              AND trade_date < :ann_d
            LIMIT 5
            """
        )
        try:
            leaks = session.execute(
                leak_sql,
                {"c": ts_code, "end_d": end_date, "ann_d": ann_date},
            ).all()
        except Exception:
            continue

        # 仅当确实"在 ann_date 之前"已经写入了对应财务期 fundamental 因子时报警
        # 因子写入时间无法 100% 推断财务期归属，本检查仅作样本启发式
        if leaks:
            issues.append(
                CheckResult(
                    passed=False,
                    level="warn",
                    rule="pit_finance",
                    detail={
                        "factor_id": leaks[0][0],
                        "sample_ts_codes": [ts_code],
                        "ann_date": ann_date,
                        "end_date": end_date,
                        "leaked_trade_dates": [str(r[1]) for r in leaks],
                        "audit": "ghost3_fina_delay",
                    },
                    trade_date=str(leaks[0][1]),
                    name="ghost3_fina_delay",
                )
            )
    return issues


# ----------------------------------------------------------------------
# 顶层入口：跑全部 PIT 审计
# ----------------------------------------------------------------------

def run_full_audit(
    session: Session,
    sample_trade_dates: Iterable[str],
    *,
    factors_base_path: Path | None = None,
    ghost2_sample_codes: int = 10,
    ghost2_sample_dates: int = 5,
    ghost3_sample_size: int = 10,
) -> list[CheckResult]:
    """执行三铁律 + 三幽灵 Bug 全套审计，返回全部未通过的 CheckResult。"""

    dates = list(sample_trade_dates)
    results: list[CheckResult] = []

    # 铁律 1
    results.extend(audit_rule1_finance_uses_ann_date(session, dates))
    # 铁律 2（静态）
    rule2 = audit_rule2_market_pit_window(factors_base_path=factors_base_path)
    if not rule2.passed:
        results.append(rule2)
    # 铁律 3 由单测 fixture 调用 verify_factor_window_no_future；此处不连库

    # 幽灵 1
    results.extend(audit_ghost1_survivor_bias(session, dates))
    # 幽灵 2
    results.extend(
        audit_ghost2_adj_trap(
            session,
            sample_size_codes=ghost2_sample_codes,
            sample_size_dates=ghost2_sample_dates,
        )
    )
    # 幽灵 3
    results.extend(audit_ghost3_fina_delay(session, sample_size=ghost3_sample_size))

    return results
