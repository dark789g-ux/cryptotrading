"""DirectionLSTM 输入归一化层（缓解横截面 z-score 时序水平不可比）契约测试。

背景：feature_matrix 的特征是逐交易日横截面 z-score（每个 trade_date 截面内标准化）。
LSTM 把同一股票连续 L 天的横截面 z-score 堆成序列，每天截面 mean/std 不同，
时序水平不可比，削弱 LSTM 学时序形态的能力。

缓解方案（方案甲）：在 DirectionLSTM 输入处加 nn.LayerNorm(input_size)。
  - 纯模型内、权重随 state_dict 落盘 → 推理自动一致、无需存统计量、无泄漏；
  - LayerNorm 跨特征（最后一维 N）归一，稳定每个时间步内各特征尺度。

本测试覆盖可纯 torch / numpy 验证的契约：
  1. forward 形状 / 数值有限不退化；
  2. LayerNorm 接在 input_size 维（(B,L,N) 的最后一维）；
  3. state_dict 含 LayerNorm 仿射参数（weight/bias），保存/加载往返一致
     → 推理侧用同一 DirectionLSTM 构造 + load_state_dict 自动复现，无需额外统计量；
  4. meta.json 不需新增字段即可重建模型（归一化随权重落盘，非外部统计量）。

torch 未安装时整体 importorskip 跳过。
"""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")  # 无 torch 环境跳过整个模块

from quant_pipeline.training.lstm_model import DirectionLSTM  # noqa: E402


class TestInputLayerNorm:
    def test_has_input_norm_over_feature_dim(self) -> None:
        # 归一化层归一的是 input_size（特征维 N），不是 hidden / L
        model = DirectionLSTM(input_size=7, hidden_size=8, num_layers=1, dropout=0.0)
        assert hasattr(model, "input_norm"), "DirectionLSTM 应有输入归一化层 input_norm"
        # LayerNorm 的 normalized_shape 必须是 (input_size,)
        assert tuple(model.input_norm.normalized_shape) == (7,)

    def test_forward_shape_and_finite(self) -> None:
        model = DirectionLSTM(input_size=4, hidden_size=8, num_layers=2, dropout=0.1)
        model.eval()
        x = torch.randn(5, 6, 4)
        with torch.no_grad():
            logits = model(x)
        assert logits.shape == (5, 3)
        assert torch.isfinite(logits).all()

    def test_norm_stabilizes_scale_mismatch(self) -> None:
        """跨时间步量级差异巨大的输入，经 LayerNorm 后仍前向有限、不溢出。

        构造一条序列：第 0 步特征量级 ~1，最后一步量级 ~1000（模拟横截面
        z-score 在不同日 std 差异导致的水平漂移）。无输入归一时 LSTM 易被大尺度
        步主导 / 数值不稳；有 LayerNorm 时每步跨特征归一，输出应有限。
        """
        model = DirectionLSTM(input_size=3, hidden_size=8, num_layers=1, dropout=0.0)
        model.eval()
        x = torch.ones(2, 4, 3)
        x[:, -1, :] *= 1000.0  # 末步整体放大 1000 倍
        with torch.no_grad():
            logits = model(x)
        assert torch.isfinite(logits).all()

    def test_state_dict_contains_norm_affine_params(self) -> None:
        # LayerNorm 默认 elementwise_affine=True → state_dict 含 input_norm.weight/bias
        model = DirectionLSTM(input_size=5, hidden_size=8, num_layers=1, dropout=0.0)
        keys = set(model.state_dict().keys())
        assert "input_norm.weight" in keys
        assert "input_norm.bias" in keys

    def test_save_load_roundtrip_inference_consistency(self, tmp_path) -> None:
        """训练侧保存的 state_dict（含 LayerNorm 仿射参数），推理侧用同一构造
        + load_state_dict 重建后前向逐元素一致 —— 证明推理与训练用完全相同的
        归一化变换，无需 meta 存任何统计量。
        """
        rng = np.random.default_rng(0)
        x_np = rng.standard_normal((6, 5, 5)).astype(np.float32)

        trained = DirectionLSTM(input_size=5, hidden_size=8, num_layers=1, dropout=0.0)
        # 扰动 LayerNorm 仿射参数，确保不是恒等、往返必须命中这两个张量
        with torch.no_grad():
            trained.input_norm.weight.mul_(1.7)
            trained.input_norm.bias.add_(0.3)
        trained.eval()

        path = tmp_path / "model.pt"
        torch.save(trained.state_dict(), str(path))

        # 推理侧：仅凭结构超参（input_size 等，均在 meta.json）重建，无额外统计量
        reloaded = DirectionLSTM(input_size=5, hidden_size=8, num_layers=1, dropout=0.0)
        reloaded.load_state_dict(torch.load(str(path)))
        reloaded.eval()

        x = torch.from_numpy(x_np)
        with torch.no_grad():
            np.testing.assert_allclose(
                trained(x).numpy(), reloaded(x).numpy(), rtol=1e-5, atol=1e-6
            )
