"""_FWD_RET_HN_RE 正则分发测试。

验证 runner.py 中 _FWD_RET_HN_RE 正则对合法/非法 scheme 的匹配行为，
重点确认：
  - 变体后缀（__recheck 等）不污染 horizon group(1)（与 strategy-aware 对称）
  - 单下划线后缀不被误判为变体
  - 非数字 horizon 不匹配
"""

from __future__ import annotations

from quant_pipeline.labels.runner import _FWD_RET_HN_RE


class TestFwdRetHnRe:
    """_FWD_RET_HN_RE 正则行为断言。"""

    # ──────────────────────────────────────────────
    # 精确 scheme（无变体后缀）
    # ──────────────────────────────────────────────

    def test_exact_h1(self) -> None:
        """fwd_ret_h1 精确匹配，horizon=1。"""
        m = _FWD_RET_HN_RE.match("fwd_ret_h1")
        assert m is not None
        assert m.group(1) == "1"

    def test_exact_h12_multidigit(self) -> None:
        """fwd_ret_h12 多位数 horizon 匹配，horizon=12。"""
        m = _FWD_RET_HN_RE.match("fwd_ret_h12")
        assert m is not None
        assert m.group(1) == "12"

    # ──────────────────────────────────────────────
    # 变体后缀（__ 双下划线）
    # ──────────────────────────────────────────────

    def test_variant_recheck_horizon_not_polluted(self) -> None:
        """fwd_ret_h1__recheck 变体后缀：horizon group(1) 仍为 '1'，不被后缀污染。"""
        m = _FWD_RET_HN_RE.match("fwd_ret_h1__recheck")
        assert m is not None
        assert m.group(1) == "1"

    def test_variant_recheck_drv_horizon_not_polluted(self) -> None:
        """fwd_ret_h1__recheck_drv 长后缀：horizon group(1) 仍为 '1'。"""
        m = _FWD_RET_HN_RE.match("fwd_ret_h1__recheck_drv")
        assert m is not None
        assert m.group(1) == "1"

    def test_variant_h5_recheck(self) -> None:
        """fwd_ret_h5__recheck：horizon=5。"""
        m = _FWD_RET_HN_RE.match("fwd_ret_h5__recheck")
        assert m is not None
        assert m.group(1) == "5"

    # ──────────────────────────────────────────────
    # 不匹配情形
    # ──────────────────────────────────────────────

    def test_no_digit_suffix(self) -> None:
        """fwd_ret_h 无数字后缀 → 不匹配。"""
        assert _FWD_RET_HN_RE.match("fwd_ret_h") is None

    def test_non_digit_horizon(self) -> None:
        """fwd_ret_hX 非数字 horizon → 不匹配。"""
        assert _FWD_RET_HN_RE.match("fwd_ret_hX") is None

    def test_single_underscore_not_variant(self) -> None:
        """fwd_ret_h1_x 单下划线后缀不算变体 → 不匹配（须 '__' 双下划线）。"""
        assert _FWD_RET_HN_RE.match("fwd_ret_h1_x") is None

    def test_unrelated_scheme(self) -> None:
        """strategy-aware 无关串 → 不匹配。"""
        assert _FWD_RET_HN_RE.match("strategy-aware") is None

    def test_fwd_5d_ret_not_matched(self) -> None:
        """旧式 fwd_5d_ret → 不匹配（由 SCHEME_FWD_5D_RET 常量处理，非本正则）。"""
        assert _FWD_RET_HN_RE.match("fwd_5d_ret") is None
