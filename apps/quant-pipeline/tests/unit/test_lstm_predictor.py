"""inference.lstm_predictor + runner LSTM 分派 单测（M3 LSTM 接入 · T4）。

覆盖 spec 03-inference.md 的验收点：
  · meta.algorithm=='lstm' → predict_one_day 分派到 predict_one_day_lstm；
    老模型无 algorithm 字段 → 兜底走 lgb（断言分派正确，mock 两条预测函数）；
  · score = P(涨) − P(跌) 计算正确（给定 logits 断言 score 符号 / 数值）；
  · 窗口不足 L 天的票 → score=NaN + 显式 inference_missing_feature_codes warn
    （禁止 pad 假序列伪装"全覆盖"）。

重的前向 / torch 相关用例 pytest.importorskip("torch")；分派用例用 monkeypatch
绕开真实模型加载，不依赖 torch。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.inference import lstm_predictor as lp
from quant_pipeline.inference import runner as runner_mod

# ----------------------------------------------------------------------
# Mock Session：分别响应 trade_date 列表（scalars）/ 窗口长表（mappings）/
# daily_quote 行数（scalars）。按 SQL 文本特征路由。
# ----------------------------------------------------------------------


class _Scalars:
    def __init__(self, values: list[Any]) -> None:
        self._values = values

    def all(self) -> list[Any]:
        return list(self._values)


class _Mappings:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def all(self) -> list[dict[str, Any]]:
        return list(self._rows)


class _Result:
    def __init__(self, *, scalars: list[Any] | None = None,
                 mappings: list[dict[str, Any]] | None = None) -> None:
        self._scalars = scalars or []
        self._mappings = mappings or []

    def scalars(self) -> _Scalars:
        return _Scalars(self._scalars)

    def mappings(self) -> _Mappings:
        return _Mappings(self._mappings)


class _MockSession:
    """按 SQL 文本路由返回结果。

    - 含 'DISTINCT trade_date'  → 窗口交易日（scalars）
    - 含 'features'            → 窗口长表（mappings）
    - 含 'raw.daily_quote'     → 当日全部 ts_code（scalars）
    """

    def __init__(
        self,
        *,
        window_dates: list[str],
        panel_rows: list[dict[str, Any]],
        all_codes: list[str],
    ) -> None:
        self._window_dates = window_dates
        self._panel_rows = panel_rows
        self._all_codes = all_codes

    def execute(self, statement: Any, params: Any = None) -> _Result:
        sql = str(statement)
        if "DISTINCT trade_date" in sql:
            return _Result(scalars=list(self._window_dates))
        if "raw.daily_quote" in sql:
            return _Result(scalars=list(self._all_codes))
        if "features" in sql:
            return _Result(mappings=list(self._panel_rows))
        raise AssertionError(f"unexpected SQL routed: {sql[:80]!r}")


def _make_panel_rows(
    codes: list[str], dates: list[str], feature_cols: list[str],
    *, value: float = 0.5,
) -> list[dict[str, Any]]:
    """构造 feature_matrix 窗口长表行（每个 (code,date) 一行，features 全填 value）。"""

    rows: list[dict[str, Any]] = []
    for c in codes:
        for d in dates:
            rows.append(
                {
                    "ts_code": c,
                    "trade_date": d,
                    "features": {fc: value for fc in feature_cols},
                }
            )
    return rows


def _write_meta(tmp_path: Path, meta: dict[str, Any]) -> Path:
    """落一份 meta.json + 占位 model.pt，返回 model.pt 路径。"""

    d = tmp_path / str(uuid4())
    d.mkdir()
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (d / "model.pt").write_bytes(b"\x00")  # 占位；分派用例不真正 load
    return d / "model.pt"


# ----------------------------------------------------------------------
# 分派：predict_one_day 按 meta.algorithm 分派（spec 03 §2）
# ----------------------------------------------------------------------


def _patch_model_run(monkeypatch: pytest.MonkeyPatch, model_path: Path) -> None:
    monkeypatch.setattr(
        runner_mod,
        "_load_model_run",
        lambda session, **kw: {
            "id": uuid4(),
            "model_version": "mv",
            "feature_set_id": "fs",
            "artifact_uri": "./artifacts/whatever/model.pt",
        },
    )
    monkeypatch.setattr(
        runner_mod, "_resolve_artifact_local_path", lambda _uri: model_path
    )


def test_dispatch_algorithm_lstm_routes_to_lstm_predictor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """meta.algorithm=='lstm' → predict_one_day 调 predict_one_day_lstm，不走 lgb。"""

    model_path = _write_meta(tmp_path, {"algorithm": "lstm"})
    _patch_model_run(monkeypatch, model_path)

    called: dict[str, Any] = {}

    def _fake_lstm(model_version: str, trade_date: str, session: Any) -> pd.DataFrame:
        called["args"] = (model_version, trade_date)
        return pd.DataFrame(
            {"ts_code": ["A"], "score": [0.1], "rank_in_day": [1]}
        )

    # 分派点在 runner.predict_one_day 内部 import lstm_predictor.predict_one_day_lstm；
    # monkeypatch lstm_predictor 模块属性即可拦截。
    monkeypatch.setattr(lp, "predict_one_day_lstm", _fake_lstm)

    # lgb 路径若被误调会 import lightgbm + booster，这里用哨兵确保它没被走到
    def _explode_lgb(*a: Any, **k: Any) -> Any:
        raise AssertionError("不应走 lgb 路径")

    monkeypatch.setattr(runner_mod, "_load_daily_feature_section", _explode_lgb)

    df = runner_mod.predict_one_day("mv", "20260517", session=None)  # type: ignore[arg-type]
    assert called["args"] == ("mv", "20260517")
    assert list(df["ts_code"]) == ["A"]


def test_dispatch_legacy_no_algorithm_field_routes_to_lgb(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """老模型 meta.json 无 algorithm 字段 → 兜底走 lgb（不调 predict_one_day_lstm）。"""

    feature_cols = ["f0", "f1"]
    model_path = _write_meta(tmp_path, {"feature_columns_order": feature_cols})
    _patch_model_run(monkeypatch, model_path)

    # lstm 路径若被误调 → 失败
    monkeypatch.setattr(
        lp,
        "predict_one_day_lstm",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("不应走 lstm 路径")),
    )

    # 桩 lgb 的 booster + 截面读取，断言确实走到 lgb 分支
    class _FakeBooster:
        def feature_name(self) -> list[str]:
            return feature_cols

        def predict(self, X: np.ndarray) -> np.ndarray:
            return np.arange(X.shape[0], dtype=float)

    import sys
    import types

    fake_lgb = types.ModuleType("lightgbm")
    fake_lgb.Booster = lambda model_file=None: _FakeBooster()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "lightgbm", fake_lgb)

    monkeypatch.setattr(
        runner_mod,
        "_load_daily_feature_section",
        lambda session, fs, td, cols: pd.DataFrame(
            {
                "ts_code": ["S0", "S1", "S2"],
                **{c: [0.0, 1.0, 2.0] for c in cols},
            }
        ),
    )
    monkeypatch.setattr(runner_mod, "_load_all_ts_codes", lambda s, td: [])

    df = runner_mod.predict_one_day("mv", "20260517", session=None)  # type: ignore[arg-type]
    assert list(df.columns) >= ["ts_code", "score", "rank_in_day"]
    assert len(df) == 3


# ----------------------------------------------------------------------
# score = P(涨) − P(跌)（spec 03 §3）
# ----------------------------------------------------------------------


def test_forward_scores_up_minus_down() -> None:
    """给定 logits，score = softmax[up] − softmax[down]，class_order=[down,flat,up]。"""

    pytest.importorskip("torch")
    import torch

    class _StubModel:
        """固定返回预设 logits，验证 softmax 差值。"""

        def __init__(self, logits: np.ndarray) -> None:
            self._logits = torch.tensor(logits, dtype=torch.float32)

        def __call__(self, x: Any) -> Any:
            return self._logits

    # 两个样本：
    #  样本0 logits=[0,0,2] → up 概率最高 → score > 0
    #  样本1 logits=[2,0,0] → down 概率最高 → score < 0
    logits = np.array([[0.0, 0.0, 2.0], [2.0, 0.0, 0.0]], dtype=np.float32)
    model = _StubModel(logits)
    X = np.zeros((2, 4, 3), dtype=np.float32)  # 占位，StubModel 忽略

    scores = lp._forward_scores(model, X, ["down", "flat", "up"])

    # 手算期望
    p = torch.softmax(torch.tensor(logits), dim=1).numpy()
    expected = p[:, 2] - p[:, 0]
    assert np.allclose(scores, expected)
    assert scores[0] > 0  # 看多
    assert scores[1] < 0  # 看空


def test_forward_scores_respects_class_order_permutation() -> None:
    """class_order 非默认顺序时，仍按 'up'/'down' 名字定位概率列。"""

    pytest.importorskip("torch")
    import torch

    class _StubModel:
        def __init__(self, logits: np.ndarray) -> None:
            self._logits = torch.tensor(logits, dtype=torch.float32)

        def __call__(self, x: Any) -> Any:
            return self._logits

    # class_order=[up, down, flat] → up=idx0, down=idx1
    logits = np.array([[3.0, 0.0, 0.0]], dtype=np.float32)  # up logit 最大
    scores = lp._forward_scores(_StubModel(logits), np.zeros((1, 2, 2), np.float32),
                                ["up", "down", "flat"])
    p = torch.softmax(torch.tensor(logits), dim=1).numpy()
    assert np.allclose(scores, p[:, 0] - p[:, 1])
    assert scores[0] > 0


# ----------------------------------------------------------------------
# 窗口不足的票 → score=NaN + missing warn（spec 03 §4/§5）
# ----------------------------------------------------------------------


def test_insufficient_window_codes_get_nan_and_warn(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """有票窗口内交易日数 < L → 无法构造序列 → score=NaN + inference_missing_feature_codes warn。

    构造：lookback=3，窗口 3 个交易日；
      - 票 FULL.SZ 三天齐全 → 可预测；
      - 票 SHORT.SZ 只有 2 天 → 序列不足 → 进 missing，score=NaN。
    raw.daily_quote 含两票 → missing 必须被补 NaN 行 + warn。
    """

    pytest.importorskip("torch")

    feature_cols = ["f0", "f1"]
    lookback = 3
    window_dates = ["20260513", "20260514", "20260515"]
    target_date = "20260515"

    panel_rows = _make_panel_rows(["FULL.SZ"], window_dates, feature_cols)
    panel_rows += _make_panel_rows(
        ["SHORT.SZ"], window_dates[1:], feature_cols  # 只有 2 天
    )

    session = _MockSession(
        window_dates=window_dates,
        panel_rows=panel_rows,
        all_codes=["FULL.SZ", "SHORT.SZ"],
    )

    meta = {
        "algorithm": "lstm",
        "lookback": lookback,
        "input_size": len(feature_cols),
        "hidden_size": 8,
        "num_layers": 1,
        "dropout": 0.0,
        "feature_cols": feature_cols,
        "class_order": ["down", "flat", "up"],
    }
    model_path = _write_meta(tmp_path, meta)

    # predict_one_day_lstm 内部 `from ...runner import _load_model_run, ...`，
    # 名字绑定到 runner 模块属性 → 必须 patch runner_mod，而非 lp。
    monkeypatch.setattr(
        runner_mod,
        "_load_model_run",
        lambda session, **kw: {
            "id": uuid4(),
            "model_version": "mv",
            "feature_set_id": "fs",
            "artifact_uri": "./artifacts/x/model.pt",
        },
    )
    monkeypatch.setattr(runner_mod, "_resolve_artifact_local_path", lambda _u: model_path)

    # 用真实 DirectionLSTM 还原（随机初始化的 state_dict），避免造 model.pt：
    # 直接 patch _build_model 返回一个新初始化模型，前向出真实概率。
    import torch  # noqa: F401

    from quant_pipeline.training.lstm_model import DirectionLSTM

    def _fake_build_model(meta_: dict[str, Any], mp: Path, input_size: int) -> Any:
        m = DirectionLSTM(input_size=input_size, hidden_size=8, num_layers=1, dropout=0.0)
        m.eval()
        return m

    monkeypatch.setattr(lp, "_build_model", _fake_build_model)

    with caplog.at_level(logging.WARNING):
        out = lp.predict_one_day_lstm("mv", target_date, session)  # type: ignore[arg-type]

    by_code = dict(zip(out["ts_code"], out["score"], strict=False))
    assert "FULL.SZ" in by_code and not np.isnan(by_code["FULL.SZ"])  # 可预测
    assert "SHORT.SZ" in by_code and np.isnan(by_code["SHORT.SZ"])    # 窗口不足 → NaN
    # 两票都在输出（凑齐行数）
    assert set(by_code) == {"FULL.SZ", "SHORT.SZ"}
    # rank_in_day 存在且 NaN 票排末尾
    rank_by_code = dict(zip(out["ts_code"], out["rank_in_day"], strict=False))
    assert rank_by_code["FULL.SZ"] == 1
    assert rank_by_code["SHORT.SZ"] == 2
    # 显式 warn 暴露覆盖缺口
    assert any(
        "inference_missing_feature_codes" in r.message for r in caplog.records
    )


def test_empty_section_raises_value_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """目标日不在窗口交易日内（当日截面为空）→ ValueError（确凿缺口，spec 03 §4）。"""

    feature_cols = ["f0"]
    meta = {
        "algorithm": "lstm",
        "lookback": 2,
        "input_size": 1,
        "feature_cols": feature_cols,
        "class_order": ["down", "flat", "up"],
    }
    model_path = _write_meta(tmp_path, meta)

    # 窗口只回到更早的交易日，目标日 20260515 不在其中
    session = _MockSession(
        window_dates=["20260512", "20260513"],
        panel_rows=[],
        all_codes=["A.SZ"],
    )
    monkeypatch.setattr(
        runner_mod,
        "_load_model_run",
        lambda session, **kw: {
            "id": uuid4(),
            "model_version": "mv",
            "feature_set_id": "fs",
            "artifact_uri": "./artifacts/x/model.pt",
        },
    )
    monkeypatch.setattr(runner_mod, "_resolve_artifact_local_path", lambda _u: model_path)

    with pytest.raises(ValueError, match="当日为空"):
        lp.predict_one_day_lstm("mv", "20260515", session)  # type: ignore[arg-type]
