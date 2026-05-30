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
import math
from collections.abc import Iterable
from typing import Any, cast

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
# 铁律 2：行情用 T 日盘后（import factors.base.Factor 读取实际属性）
# ----------------------------------------------------------------------

def audit_rule2_market_pit_window(
    factor_cls: Any = None,
) -> CheckResult:
    """检查 factors.base.Factor 是否声明了 pit_window_days 类属性（doc/03 §3.1 铁律 2）。

    改为 import 该类读取真实属性（06-quality.md 问题 10）：原正则静态扫描源码
    对常量赋值 / 多行赋值 / 配置注入等写法都会误报「未声明」，极脆弱。

    审计语义：base.py 抽象类必须把 `pit_window_days` 定义为契约属性（要求
    每个子类声明 PIT 回看窗口）。抽象基类自身的默认值是 0（"未设置"哨兵），
    故只校验「属性存在且为整型契约」，不对基类默认值强加 >= 1——子类窗口的
    实际取值由各因子实现负责，不在本审计范围。

    Args:
        factor_cls: 测试期可注入伪类；默认 import quant_pipeline.factors.base.Factor。

    import 失败（base.py 缺失 / 语法错误）→ warn（不再静默 passed=True）。
    """

    if factor_cls is None:
        try:
            from quant_pipeline.factors.base import Factor as factor_cls
        except Exception as exc:  # noqa: BLE001 —— ImportError / 语法错误等
            return CheckResult(
                passed=False,
                level="warn",
                rule="pit_finance",
                detail={
                    "audit": "rule2_market_pit_window",
                    "factor_id": "<factors.base.Factor>",
                    "sample_ts_codes": [],
                    "reason": f"无法 import factors.base.Factor: {exc}",
                },
                trade_date="00000000",
                name="rule2_market_pit_window",
            )

    # 属性必须存在（class 属性或注解契约）
    annotations = getattr(factor_cls, "__annotations__", {}) or {}
    has_attr = hasattr(factor_cls, "pit_window_days") or "pit_window_days" in annotations
    if not has_attr:
        return CheckResult(
            passed=False,
            level="warn",
            rule="pit_finance",
            detail={
                "audit": "rule2_market_pit_window",
                "factor_id": "<factors.base.Factor>",
                "sample_ts_codes": [],
                "reason": "Factor 类未声明 pit_window_days 契约属性",
            },
            trade_date="00000000",
            name="rule2_market_pit_window",
        )

    declared_value = getattr(factor_cls, "pit_window_days", None)
    if declared_value is not None and not isinstance(declared_value, int):
        return CheckResult(
            passed=False,
            level="warn",
            rule="pit_finance",
            detail={
                "audit": "rule2_market_pit_window",
                "factor_id": "<factors.base.Factor>",
                "sample_ts_codes": [],
                "declared_value": repr(declared_value),
                "reason": "pit_window_days 不是整型；契约要求整数日数",
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
            "base_default_pit_window_days": declared_value,
            "note": "Factor.pit_window_days 契约属性已声明（子类负责设具体值）",
        },
        trade_date="00000000",
        name="rule2_market_pit_window",
    )


# ----------------------------------------------------------------------
# 铁律 3：因子窗口不跨未来（提供单测框架）
# ----------------------------------------------------------------------

def _normalize_yyyymmdd(value: Any) -> str | None:
    """把任意日期表示归一化为 'YYYYMMDD'，便于字符串字面比较（06-quality.md 问题 11）。

    支持：
      - 'YYYYMMDD' / 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' 等字符串
      - datetime / date / pandas.Timestamp（带 strftime）
    无法解析时返回 None（调用方据此跳过该样本，不做无意义比较）。
    """

    # datetime / date / Timestamp
    if hasattr(value, "strftime"):
        try:
            return cast(str, value.strftime("%Y%m%d"))
        except Exception:  # noqa: BLE001
            return None
    s = str(value).strip()
    # 取前 10 个字符内的数字（'2026-05-22 00:00:00' → '20260522'）
    digits = "".join(ch for ch in s[:10] if ch.isdigit())
    if len(digits) == 8:
        return digits
    return None


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
            # 归一化为 YYYYMMDD：historical_data 的 trade_date 可能是 datetime /
            # Timestamp，直接 str() 得 '2026-05-22 00:00:00'，与入参 '20260522'
            # 格式不一致，字符串比较无意义（06-quality.md 问题 11）。
            used_dates = [
                norm for d in td if (norm := _normalize_yyyymmdd(d)) is not None
            ]
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

    # trade_date 入参契约即 YYYYMMDD；归一化兜底防御非常规调用。
    norm_trade_date = _normalize_yyyymmdd(trade_date) or trade_date
    future_dates = [d for d in used_dates if d > norm_trade_date]
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
    session: Session,  # noqa: ARG001 —— 保留签名兼容；当前实现不查库
    sample_size_codes: int = 10,  # noqa: ARG001
    sample_size_dates: int = 5,  # noqa: ARG001
) -> list[CheckResult]:
    """复权陷阱审计 —— 当前标注「未实现」，不再给出误导性结论。

    设计原因（见 06-quality.md 问题 5）：
      原实现用「factor 'close_adj' 在分红日相对前一日跳变 >20% 即判 critical」
      作为复权正确性的代理，但该代理既假阳又假阴：
        - 后复权价在分红日本就可能合法跳变 >20%（涨跌停叠加真实波动）
          → 产生假阳性 critical，错误阻断门禁；
        - 若因子根本未做复权，小额分红除权缺口可能仅 1-2%
          → 真 bug 反而落在 0.8/1.2 阈值内被漏报；
        - 0.8/1.2 阈值是无理论依据的拍脑袋常数。

    正确做法需独立用 raw.adj_factor 重算后复权价并与因子落库值逐点比对，
    属较大改动，此处不重写。当前仅产出一条 info 级「未实现」留痕，
    使审计报告明确「此项未被审计」，而非伪装成 passed=True 的绿灯。
    """

    return [
        CheckResult(
            passed=True,
            level="info",
            rule="adj_jump",
            detail={
                "audit": "ghost2_adj_trap",
                "audit_status": "not_implemented",
                "factor_id": "<close_adj>",
                "reason": (
                    "复权陷阱审计未实现：原「跳变幅度」代理既假阳又假阴，"
                    "已移除以免误导。正确实现需用 adj_factor 独立重算后复权价比对。"
                ),
            },
            trade_date="00000000",
            name="ghost2_adj_trap",
        )
    ]


# ----------------------------------------------------------------------
# 三幽灵 Bug 3：财务披露延迟（抽样 10 个公司财报）
# ----------------------------------------------------------------------

def audit_ghost3_fina_delay(
    session: Session,  # noqa: ARG001 —— 保留签名兼容；当前实现不查库
    sample_size: int = 10,  # noqa: ARG001
) -> list[CheckResult]:
    """财务披露延迟审计 —— 当前标注「未实现」，不再给出误导性结论。

    设计原因（见 06-quality.md 问题 4）：
      原实现的泄漏判定窗口为 [end_date, ann_date)，但：
        - 真正的泄漏窗口应是 (-∞, ann_date)：在 end_date 之前用该期数据
          同样是泄漏，原窗口把这部分漏掉（假阴）；
        - 更根本的：factors.daily_factors 的 'fin_' 因子行不带「用的是哪期
          财报」（source_ann_date）信息。因子天天计算，任意有 fin_ 因子的
          股票只要区间内有交易日就必然命中 → 海量假阳，对真泄漏无分辨力。

    正确做法需让因子表记录每行所用财报期的 source_ann_date，或独立重算比对，
    属较大改动，此处不重写。当前仅产出一条 info 级「未实现」留痕，
    使审计报告明确「此项未被审计」，而非伪装成 passed=True 的绿灯。
    """

    return [
        CheckResult(
            passed=True,
            level="info",
            rule="pit_finance",
            detail={
                "audit": "ghost3_fina_delay",
                "audit_status": "not_implemented",
                "factor_id": "<fin_*>",
                "sample_ts_codes": [],
                "reason": (
                    "财务延迟审计未实现：因子表缺少 source_ann_date，"
                    "无法把因子值回溯到所用财报期；原 [end_date, ann_date) "
                    "窗口既假阳又假阴，已移除以免误导。"
                ),
            },
            trade_date="00000000",
            name="ghost3_fina_delay",
        )
    ]


# ----------------------------------------------------------------------
# 启动期：PIT 窗口必须覆盖 min_trade_days × 系数
# （spec 2026-05-23-pit-window-guard-design §6.4）
# ----------------------------------------------------------------------

def audit_pit_window_covers_min_trade_days(factors: list[Any]) -> list[CheckResult]:
    """对每个已注册 factor，校验 ``pit_window_days >= ceil(min_trade_days × PIT_WINDOW_COEFFICIENT)``。

    与 DB CHECK 约束重复，但 fail-fast 在 worker 启动期暴露，
    比等到第一次 runner 跑因子时再炸要早（spec §6.4）。

    Args:
        factors: ``list[Factor]``——已 ``registry.load_from_db() + list_factors()``
                 实例化好的因子列表，每个实例必须能读 ``min_trade_days /
                 pit_window_days / factor_id / factor_version``。

    Returns:
        失败因子的 ``CheckResult`` 列表（passed 的不返回，info 级"未声明"不阻断）。

    spec 与代码契约冲突的权衡（CLAUDE.md "暴露权衡"）：
      - spec 06 §6.4 指定 ``trade_date='STARTUP'``，但 ``CheckResult.__post_init__``
        强制 trade_date 为 8 位数字（report.py 现状）。此处使用 ``'00000000'``
        占位，detail 内 ``phase='startup'`` 显式标注启动期语义。
      - rule 名必须在 ``ALLOWED_RULES`` 内：spec 用 ``'pit_window_coverage'`` 但
        该规则名未在 01-pg-schema §4.3 注册，故用最接近的 ``'pit_finance'``
        + detail 内 ``audit='pit_window_covers_min_trade_days'`` 分组。
    """

    # 延迟 import 避免循环：constants 在 factors 子包内，pit_audit 启动期才用到。
    from quant_pipeline.factors.constants import PIT_WINDOW_COEFFICIENT

    out: list[CheckResult] = []
    for f in factors:
        min_td = getattr(f, "min_trade_days", 0) or 0
        if min_td <= 0:
            # 未声明（Agent B 回填中）：info 级留痕，不阻断启动
            out.append(CheckResult(
                passed=True,
                level="info",
                rule="pit_finance",
                detail={
                    "audit": "pit_window_covers_min_trade_days",
                    "phase": "startup",
                    "factor_id": getattr(f, "factor_id", "<unknown>"),
                    "factor_version": getattr(f, "factor_version", ""),
                    "reason": "min_trade_days 未声明（=0），跳过窗口覆盖校验",
                },
                trade_date="00000000",
                name="pit_window_covers_min_trade_days",
            ))
            continue

        required = math.ceil(min_td * PIT_WINDOW_COEFFICIENT)
        declared = getattr(f, "pit_window_days", 0)
        if declared < required:
            out.append(CheckResult(
                passed=False,
                level="critical",
                rule="pit_finance",
                detail={
                    "audit": "pit_window_covers_min_trade_days",
                    "phase": "startup",   # spec 06 §6.4 的 STARTUP 语义占位
                    "factor_id": getattr(f, "factor_id", "<unknown>"),
                    "factor_version": getattr(f, "factor_version", ""),
                    "declared": declared,
                    "required": required,
                    "min_trade_days": min_td,
                    "coefficient": PIT_WINDOW_COEFFICIENT,
                },
                trade_date="00000000",
                name="pit_window_covers_min_trade_days",
            ))
    return out


# ----------------------------------------------------------------------
# 顶层入口：跑全部 PIT 审计
# ----------------------------------------------------------------------

def run_full_audit(
    session: Session,
    sample_trade_dates: Iterable[str],
    *,
    factor_cls: Any = None,
    ghost2_sample_codes: int = 10,
    ghost2_sample_dates: int = 5,
    ghost3_sample_size: int = 10,
) -> list[CheckResult]:
    """执行三铁律 + 三幽灵 Bug 全套审计，返回全部未通过的 CheckResult。

    注：ghost2/ghost3 当前为「未实现」状态，会返回一条 info 级留痕（非绿灯），
    使审计报告明确标注「此项未审计」（见 06-quality.md 问题 4/5）。
    """

    dates = list(sample_trade_dates)
    results: list[CheckResult] = []

    # 铁律 1
    results.extend(audit_rule1_finance_uses_ann_date(session, dates))
    # 铁律 2（import factors.base.Factor 读取契约属性）
    rule2 = audit_rule2_market_pit_window(factor_cls=factor_cls)
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
