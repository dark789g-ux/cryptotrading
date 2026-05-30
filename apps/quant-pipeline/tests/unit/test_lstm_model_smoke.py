"""lstm_model smoke 测试。

覆盖 spec 02 §4 / §5：
  - 合成 (B,L,N) + 三类标签，train_one_fold 跑 2 epoch；
  - 断言 loss 有限、logits 形状 (B,3)、state_dict 可保存/加载；
  - 类别逆频率权重正确（weight[c]=N_total/(3*N_c)）；
  - DEFAULT_LSTM_HYPERPARAMS 默认值对齐 spec 表。

torch 未安装时整体 importorskip 跳过；sequence_builder 测试不受影响。
"""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")  # 无 torch 环境跳过整个模块

from quant_pipeline.training import lstm_model as lm  # noqa: E402
from quant_pipeline.training.lstm_model import (  # noqa: E402
    DEFAULT_LSTM_HYPERPARAMS,
    DirectionLSTM,
    train_one_fold,
)


def _synth(n: int, L: int, N: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    X = rng.standard_normal((n, L, N)).astype(np.float32)
    # 三类标签按可分信号：用首特征均值切三档，保证三类都有样本
    sig = X[:, :, 0].mean(axis=1)
    q1, q2 = np.quantile(sig, [1 / 3, 2 / 3])
    y = np.where(sig <= q1, 0, np.where(sig <= q2, 1, 2)).astype(np.int64)
    return X, y


class TestDefaults:
    def test_default_hyperparams_match_spec(self) -> None:
        d = DEFAULT_LSTM_HYPERPARAMS
        assert d["lookback"] == 32
        assert d["hidden_size"] == 128
        assert d["num_layers"] == 2
        assert d["dropout"] == 0.2
        assert d["learning_rate"] == 1e-3
        assert d["epochs"] == 50
        assert d["batch_size"] == 512
        assert d["patience"] == 8
        assert d["seed"] == 42


class TestModelForward:
    def test_forward_shape(self) -> None:
        model = DirectionLSTM(input_size=4, hidden_size=8, num_layers=2, dropout=0.1)
        x = torch.randn(5, 6, 4)
        logits = model(x)
        assert logits.shape == (5, 3)
        assert torch.isfinite(logits).all()

    def test_single_layer_no_dropout_warning(self) -> None:
        # num_layers=1 时 LSTM 层间 dropout 应被置 0（不报 UserWarning）
        model = DirectionLSTM(input_size=3, hidden_size=4, num_layers=1, dropout=0.5)
        assert model.lstm.dropout == 0.0
        out = model(torch.randn(2, 3, 3))
        assert out.shape == (2, 3)


class TestClassWeights:
    def test_inverse_frequency_weights(self) -> None:
        # N_total=6: c0=3,c1=2,c2=1 → 6/(3*3)=0.6667, 6/(3*2)=1.0, 6/(3*1)=2.0
        y = np.array([0, 0, 0, 1, 1, 2], dtype=np.int64)
        w = lm._class_weights(y)
        np.testing.assert_allclose(w, [6 / 9, 6 / 6, 6 / 3], rtol=1e-6)

    def test_balanced_weights_near_one(self) -> None:
        # tercile 近似均衡 → 权重 ≈ 1
        y = np.array([0, 1, 2, 0, 1, 2], dtype=np.int64)
        w = lm._class_weights(y)
        np.testing.assert_allclose(w, [1.0, 1.0, 1.0], rtol=1e-6)

    def test_absent_class_weight_zero(self) -> None:
        # 某类缺席 → 权重 0（避免除零）
        y = np.array([0, 0, 1, 1], dtype=np.int64)
        w = lm._class_weights(y)
        assert w[2] == 0.0
        assert w[0] > 0 and w[1] > 0


class TestTrainOneFoldSmoke:
    def test_two_epoch_run(self) -> None:
        L, N = 6, 4
        X_tr, y_tr = _synth(48, L, N, seed=1)
        X_va, y_va = _synth(24, L, N, seed=2)
        hp = {
            "hidden_size": 8,
            "num_layers": 1,
            "dropout": 0.0,
            "epochs": 2,
            "batch_size": 16,
            "patience": 5,
            "learning_rate": 1e-2,
        }
        progress: list[tuple[int, int, float]] = []
        model, metrics = train_one_fold(
            X_tr, y_tr, X_va, y_va,
            hyperparams=hp, seed=42,
            progress_cb=lambda e, t, f: progress.append((e, t, f)),
        )
        # fold_metrics 至少含 accuracy / macro_f1，且有限
        assert "accuracy" in metrics and "macro_f1" in metrics
        assert np.isfinite(metrics["accuracy"])
        assert np.isfinite(metrics["macro_f1"])
        assert np.isfinite(metrics["val_loss"])
        assert 0.0 <= metrics["accuracy"] <= 1.0
        assert 0.0 <= metrics["macro_f1"] <= 1.0
        # progress 回调每 epoch 触发一次（最多 epochs 次）
        assert len(progress) >= 1
        assert all(t == 2 for _, t, _ in progress)

    def test_logits_finite_and_shape(self) -> None:
        L, N = 5, 3
        X_tr, y_tr = _synth(32, L, N, seed=3)
        X_va, y_va = _synth(16, L, N, seed=4)
        hp = {"hidden_size": 8, "num_layers": 1, "dropout": 0.0, "epochs": 2, "batch_size": 16}
        model, _ = train_one_fold(X_tr, y_tr, X_va, y_va, hyperparams=hp, seed=7)
        model.eval()
        with torch.no_grad():
            logits = model(torch.from_numpy(X_va))
        assert logits.shape == (16, 3)
        assert torch.isfinite(logits).all()

    def test_state_dict_save_load_roundtrip(self, tmp_path) -> None:
        L, N = 5, 3
        X_tr, y_tr = _synth(32, L, N, seed=5)
        X_va, y_va = _synth(16, L, N, seed=6)
        hp = {"hidden_size": 8, "num_layers": 1, "dropout": 0.0, "epochs": 2, "batch_size": 16}
        model, _ = train_one_fold(X_tr, y_tr, X_va, y_va, hyperparams=hp, seed=11)

        path = tmp_path / "model.pt"
        torch.save(model.state_dict(), str(path))

        reloaded = DirectionLSTM(input_size=N, hidden_size=8, num_layers=1, dropout=0.0)
        state = torch.load(str(path))
        reloaded.load_state_dict(state)

        x = torch.from_numpy(X_va)
        model.eval()
        reloaded.eval()
        with torch.no_grad():
            np.testing.assert_allclose(
                model(x).numpy(), reloaded(x).numpy(), rtol=1e-5, atol=1e-6
            )

    def test_empty_train_raises(self) -> None:
        X = np.empty((0, 5, 3), dtype=np.float32)
        y = np.empty((0,), dtype=np.int64)
        Xv, yv = _synth(4, 5, 3, seed=8)
        with pytest.raises(ValueError):
            train_one_fold(X, y, Xv, yv, hyperparams={"epochs": 1}, seed=0)

    def test_feature_dim_mismatch_raises(self) -> None:
        X_tr, y_tr = _synth(8, 5, 3, seed=9)
        X_va, y_va = _synth(4, 5, 4, seed=10)  # N 不一致
        with pytest.raises(ValueError):
            train_one_fold(X_tr, y_tr, X_va, y_va, hyperparams={"epochs": 1}, seed=0)
