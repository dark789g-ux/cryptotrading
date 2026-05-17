"""TuShare 限频客户端 + 三种空数据 warn 双写。

约束（CLAUDE.md 第三方 API 规范 + 04-error-quality-testing.md §1-2）：
1. 接口名 / 参数名严格按 TuShare 官方文档（doc/量化/06、doc/tushare_info.md），
   禁止凭变量名 / 注释 / 历史代码推断
2. **三种空数据情形必须分路径** logger.warn + 写 ml.quality_reports：
   - data_null:    pro_api 返回 None / Exception
   - items_empty:  返回 DataFrame.empty == True（0 行）
   - code_nonzero: TuShare 本身在异常时会抛 Exception，本客户端把抛错视为 code_nonzero
   每条路径 rule 名 `<api_name>_empty`，detail.empty_path 区分
3. 限频：7000 积分用户上限 500-800 次/分钟（doc/量化/06 §6.7）；
   实操按 0.15 秒间隔 ≈ 400 次/分钟留余量
4. 重试：最多 3 次，指数退避 0.5s / 1s / 2s（与 doc/tushare_info.md 一致）
5. 单测必须 mock pro_api，验证三条空路径都触发 warn_with_quality_report
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pandas as pd

from quant_pipeline.config.settings import get_settings
from quant_pipeline.worker.progress import warn_with_quality_report

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# Empty path 枚举（与 ml.quality_reports.detail.empty_path 一致）
# ----------------------------------------------------------------------

EMPTY_PATH_DATA_NULL = "data_null"
EMPTY_PATH_ITEMS_EMPTY = "items_empty"
EMPTY_PATH_CODE_NONZERO = "code_nonzero"


@dataclass(frozen=True)
class FetchResult:
    """TuShare 接口调用结果。

    df:
      - 非空 DataFrame → 正常数据
      - 空 DataFrame → 空数据（已 warn）
    empty_path:
      - None 表示有数据
      - 三种枚举之一表示哪条空路径触发
    """

    df: pd.DataFrame
    empty_path: str | None
    api_name: str
    params: dict[str, Any]


class TushareClient:
    """限频 + retry + 三种空 warn 双写的 TuShare 客户端。

    用法：
        client = TushareClient()
        result = client.fetch("trade_cal", exchange="SSE", start_date="20200101")
        if result.empty_path is None:
            for row in result.df.itertuples(): ...
        else:
            # 已经记 warn + ml.quality_reports；上层把它放进 failedItems
            pass
    """

    def __init__(
        self,
        *,
        token: str | None = None,
        min_interval_seconds: float = 0.15,
        max_retries: int = 3,
        pro_api_factory: Callable[[str], Any] | None = None,
    ) -> None:
        self._min_interval = float(min_interval_seconds)
        self._max_retries = int(max_retries)
        self._last_call_ts: float = 0.0
        # 允许测试注入 pro_api 工厂；生产时用 tushare.pro_api
        self._pro_api_factory = pro_api_factory
        self._pro: Any | None = None
        # token 优先级：构造参数 > 环境变量 > settings
        if token is not None:
            self._token = token
        else:
            self._token = os.getenv("TUSHARE_TOKEN") or get_settings().tushare_token

    # ------------------------------------------------------------------
    # pro_api 懒加载（避免单测必须装 tushare 真实库）
    # ------------------------------------------------------------------
    def _get_pro(self) -> Any:
        if self._pro is not None:
            return self._pro
        if self._pro_api_factory is not None:
            self._pro = self._pro_api_factory(self._token)
            return self._pro
        # 生产路径：从 tushare 包加载
        import tushare as ts  # 延迟 import；测试可不依赖真实包

        self._pro = ts.pro_api(self._token)
        return self._pro

    # ------------------------------------------------------------------
    # 限频
    # ------------------------------------------------------------------
    def _rate_limit_sleep(self) -> None:
        elapsed = time.monotonic() - self._last_call_ts
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_call_ts = time.monotonic()

    # ------------------------------------------------------------------
    # 主入口：fetch
    # ------------------------------------------------------------------
    def fetch(
        self,
        api_name: str,
        *,
        trade_date_for_quality: str | None = None,
        **params: Any,
    ) -> FetchResult:
        """调用 TuShare 接口；三种空数据情形分路径 warn 双写。

        参数：
          api_name: TuShare 接口名（严格按官方文档：trade_cal / stk_limit /
            suspend_d / index_classify / index_member_all / fina_indicator）
          trade_date_for_quality: 用于 ml.quality_reports.trade_date 列；
            若 params 含 trade_date / cal_date / ann_date 之一则可省略，
            否则强制传（避免 quality_reports 主键全 NULL）
          **params: 透传给 pro_api(api_name, **params)；参数名一字不差
        """

        # quality_reports.trade_date 推断
        td = (
            trade_date_for_quality
            or params.get("trade_date")
            or params.get("cal_date")
            or params.get("ann_date")
            or params.get("end_date")
            or params.get("start_date")
        )
        if not td or len(td) != 8 or not td.isdigit():
            # 退化：用今日 UTC 日期（YYYYMMDD），让 quality_reports 仍可写
            from datetime import UTC, datetime

            td = datetime.now(UTC).strftime("%Y%m%d")

        # ------------- retry + 限频 -------------
        last_exc: Exception | None = None
        df: pd.DataFrame | None = None
        for attempt in range(1, self._max_retries + 1):
            self._rate_limit_sleep()
            try:
                pro = self._get_pro()
                method = getattr(pro, api_name, None)
                if method is None:
                    # 用 query 兜底（doc/tushare_info.md 示例：pro.query(api_name, ...)）
                    method = pro.query
                    df = method(api_name, **params)
                else:
                    df = method(**params)
            except Exception as exc:  # noqa: BLE001 —— retry 视情况记 warn
                last_exc = exc
                logger.warning(
                    "tushare_call_exception",
                    extra={
                        "api_name": api_name,
                        "attempt": attempt,
                        "err": str(exc),
                        "params": params,
                    },
                )
                if attempt < self._max_retries:
                    time.sleep(0.5 * (2 ** (attempt - 1)))
                    continue
                # 已耗尽重试 → code_nonzero 路径
                df = None
                break
            else:
                last_exc = None
                break

        # ------------- 三种空数据路径分别 warn 双写 -------------

        # 路径 1：data_null —— pro_api 返回 None（极少见，但 tushare 偶发）
        if df is None and last_exc is None:
            warn_with_quality_report(
                rule=f"{api_name}_empty",
                trade_date=td,
                detail={
                    "api_name": api_name,
                    "params": _sanitize_params(params),
                    "empty_path": EMPTY_PATH_DATA_NULL,
                },
            )
            return FetchResult(
                df=pd.DataFrame(),
                empty_path=EMPTY_PATH_DATA_NULL,
                api_name=api_name,
                params=dict(params),
            )

        # 路径 2：code_nonzero —— retry 耗尽抛出异常
        if df is None and last_exc is not None:
            warn_with_quality_report(
                rule=f"{api_name}_empty",
                trade_date=td,
                detail={
                    "api_name": api_name,
                    "params": _sanitize_params(params),
                    "empty_path": EMPTY_PATH_CODE_NONZERO,
                    "error": str(last_exc),
                },
            )
            return FetchResult(
                df=pd.DataFrame(),
                empty_path=EMPTY_PATH_CODE_NONZERO,
                api_name=api_name,
                params=dict(params),
            )

        # 路径 3：items_empty —— 返回 0 行
        assert df is not None
        if df.empty:
            warn_with_quality_report(
                rule=f"{api_name}_empty",
                trade_date=td,
                detail={
                    "api_name": api_name,
                    "params": _sanitize_params(params),
                    "empty_path": EMPTY_PATH_ITEMS_EMPTY,
                },
            )
            return FetchResult(
                df=df,
                empty_path=EMPTY_PATH_ITEMS_EMPTY,
                api_name=api_name,
                params=dict(params),
            )

        # 正常返回
        return FetchResult(df=df, empty_path=None, api_name=api_name, params=dict(params))


def _sanitize_params(params: dict[str, Any]) -> dict[str, Any]:
    """仅保留可序列化原始类型，避免 jsonb 落库失败。"""

    out: dict[str, Any] = {}
    for k, v in params.items():
        if v is None or isinstance(v, str | int | float | bool):
            out[k] = v
        else:
            out[k] = str(v)
    return out
