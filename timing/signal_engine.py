# -*- coding: utf-8 -*-
"""
择时信号引擎 v2.0 — 0AMV 独立触发器（状态机）

重大架构变更：
- 0AMV 从"参与投票的因子"升级为"独立触发器"
- 其他 4 个 MA 因子从择时层移除，保留作为参考信息输出
- 状态机逻辑：触发翻转，中性保持上一日信号
"""

import os
import pandas as pd
from typing import List, Dict, Optional

from timing.factors.active_mv import ActiveMVFactor
from timing.factors.base import Signal
from timing.config import (
    OAMV_BULL_THRESHOLD,
    OAMV_BEAR_THRESHOLD,
    OAMV_BULL_CUM2_THRESHOLD,
    POSITION_MAP,
)

# 状态持久化文件（保存上一日信号）
_STATE_FILE = os.path.join(
    os.path.dirname(__file__),
    "0amv_calc", "data", "oamv_state.json"
)


class TimingSignal:
    """综合择时信号封装 - 0AMV 状态机"""

    def __init__(
        self,
        overall: str,
        oamv_signal: Signal,
        oamv_zdf: float,
        oamv_cum2: Optional[float],
        reference_factors: List[Signal] = None,
        state_changed: bool = False,
        trigger_detail: str = "",
    ):
        self.overall = overall          # 多头 / 空头
        self.oamv_signal = oamv_signal  # 0AMV 原始信号
        self.oamv_zdf = oamv_zdf        # 当日涨幅
        self.oamv_cum2 = oamv_cum2      # 2日累计
        self.reference_factors = reference_factors or []  # 其他因子（参考信息）
        self.state_changed = state_changed  # 今日是否翻转
        self.trigger_detail = trigger_detail  # 触发详情
        self.position_pct = POSITION_MAP.get(overall)

    def __repr__(self) -> str:
        action = "满仓/加杠杆" if self.overall == "多头" else "只卖不买/空仓"
        change_mark = " [翻转]" if self.state_changed else " [保持]"
        lines = [
            "========================================",
            f"  综合择时信号: {self.overall}{change_mark}",
            f"  触发详情: {self.trigger_detail}",
            f"  0AMV 当日涨幅: {self.oamv_zdf:+.2f}%",
            f"  0AMV 2日累计: {self.oamv_cum2:+.2f}%" if self.oamv_cum2 else "",
            f"  建议仓位: {self.position_pct * 100:.0f}% ({action})",
            "----------------------------------------",
            "  0AMV 因子详情:",
            f"    {self.oamv_signal}",
        ]
        if self.reference_factors:
            lines.append("  其他因子（参考信息，不参与择时）:")
            for s in self.reference_factors:
                lines.append(f"    {s}")
        lines.append("========================================")
        return "\n".join([l for l in lines if l])


def _load_last_state() -> str:
    """从文件加载上一日信号状态"""
    if os.path.exists(_STATE_FILE):
        try:
            import json
            with open(_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("signal", "空头")
        except Exception:
            pass
    return "空头"  # 默认空头


def _save_state(signal: str):
    """保存当前信号状态到文件"""
    import json
    os.makedirs(os.path.dirname(_STATE_FILE), exist_ok=True)
    with open(_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"signal": signal}, f)


class SignalEngine:
    """择时信号引擎 - 纯 0AMV 状态机"""

    def __init__(self, use_reference: bool = True, initial_state: str = None):
        """
        :param use_reference: 是否加载其他因子作为参考信息（不影响信号）
        :param initial_state: 初始状态，None 时从文件加载上一日状态
        """
        self.oamv_factor = ActiveMVFactor(weight=1.0)  # 权重已不重要
        self.use_reference = use_reference
        self._last_state = initial_state or _load_last_state()

    def run(self) -> TimingSignal:
        """
        执行 0AMV 因子，状态机判断
        """
        # 运行 0AMV 因子
        oamv_sig = self.oamv_factor.run()

        # 提取数据（从 detail 或重新加载 df）
        df = self.oamv_factor.load_data()
        oamv_zdf = 0.0
        oamv_cum2 = None
        if not df.empty and "oamv_zdf" in df.columns:
            oamv_zdf = df["oamv_zdf"].iloc[-1]
            if len(df) >= 2:
                oamv_cum2 = df["oamv_zdf"].iloc[-1] + df["oamv_zdf"].iloc[-2]

        # 状态机逻辑
        state_changed = False
        trigger_detail = ""
        new_state = self._last_state

        if oamv_sig.value == Signal.BULL:
            # 0AMV 触发多头（单日≥+2.5% 或 2日累计≥+2.8%）
            new_state = "多头"
            if self._last_state != "多头":
                state_changed = True
            trigger_detail = oamv_sig.detail
        elif oamv_sig.value == Signal.BEAR:
            # 0AMV 触发空头（单日≤-1.8%）
            new_state = "空头"
            if self._last_state != "空头":
                state_changed = True
            trigger_detail = oamv_sig.detail
        else:
            # 0AMV 中性 → 保持上一日信号（迟滞）
            new_state = self._last_state
            trigger_detail = f"0AMV 未触发（{oamv_zdf:+.2f}%），保持上一日信号：{self._last_state}"

        # 保存新状态
        self._last_state = new_state
        _save_state(new_state)

        # 参考因子（不影响信号）
        reference_factors = []
        if self.use_reference:
            try:
                from timing.factors import (
                    AvgPriceFactor, MarginFactor, TurnoverFactor, IndexTrendFactor
                )
                from timing.config import FACTOR_WEIGHTS
                ref_factors = [
                    AvgPriceFactor(weight=FACTOR_WEIGHTS["avg_price"]),
                    MarginFactor(weight=FACTOR_WEIGHTS["margin"]),
                    TurnoverFactor(weight=FACTOR_WEIGHTS["turnover"]),
                    IndexTrendFactor(weight=FACTOR_WEIGHTS["index_trend"]),
                ]
                for f in ref_factors:
                    try:
                        reference_factors.append(f.run())
                    except Exception:
                        pass
            except Exception:
                pass

        return TimingSignal(
            overall=new_state,
            oamv_signal=oamv_sig,
            oamv_zdf=oamv_zdf,
            oamv_cum2=oamv_cum2,
            reference_factors=reference_factors,
            state_changed=state_changed,
            trigger_detail=trigger_detail,
        )

    def run_verbose(self) -> Dict:
        """执行并返回结构化字典"""
        result = self.run()
        return {
            "signal": result.overall,
            "position_pct": result.position_pct,
            "state_changed": result.state_changed,
            "trigger_detail": result.trigger_detail,
            "oamv_zdf": result.oamv_zdf,
            "oamv_cum2": result.oamv_cum2,
            "oamv_factor": {
                "name": result.oamv_signal.name,
                "value": result.oamv_signal.value,
                "detail": result.oamv_signal.detail,
            },
            "reference_factors": [
                {
                    "name": s.name,
                    "value": s.value,
                    "detail": s.detail,
                }
                for s in result.reference_factors
            ],
            "can_trade": result.overall == "多头",
        }


# 兼容旧接口的快捷函数
def get_timing_signal(**kwargs) -> TimingSignal:
    """获取择时信号（对外统一入口）"""
    engine = SignalEngine(**kwargs)
    return engine.run()


def get_timing_dict(**kwargs) -> Dict:
    """获取择时信号字典（对外统一入口）"""
    engine = SignalEngine(**kwargs)
    return engine.run_verbose()
