"""lstm_model —— 次日方向三分类 LSTM 模型 + 单 fold 训练循环。

实现设计 spec：
  docs/superpowers/specs/2026-05-30-lstm-quant-module-design/02-python-training.md §4 / §5

对外契约（T3 lstm_walk_forward / T4 inference 依赖，禁止改签名）：

    DEFAULT_LSTM_HYPERPARAMS: dict
        lookback=32, hidden_size=128, num_layers=2, dropout=0.2,
        learning_rate=1e-3, epochs=50, batch_size=512, patience=8, seed=42

    class DirectionLSTM(nn.Module):
        __init__(input_size, hidden_size=128, num_layers=2, dropout=0.2)
        forward(x: (B, L, N)) -> logits (B, 3)

    def train_one_fold(X_tr, y_tr, X_va, y_va, *, hyperparams, seed,
                       progress_cb=None) -> tuple[nn.Module, dict]

torch 在模块内部**延迟 import**（参考 inference/runner.py 对 lightgbm 的延迟 import），
不在包顶层 import——避免 worker 启动 / 不跑 LSTM 的进程强依赖 torch。
因此本模块 import 期不引 torch；类与训练函数在被调用时才触发 import。
"""

from __future__ import annotations

import logging
import random
from collections.abc import Callable
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


# ---- 超参默认值（单一真理源；spec 02 §4 默认值表）----
DEFAULT_LSTM_HYPERPARAMS: dict[str, Any] = {
    "lookback": 32,          # 序列窗口（交易日）
    "hidden_size": 128,      # LSTM 隐层维度
    "num_layers": 2,         # LSTM 层数
    "dropout": 0.2,          # 层间 dropout
    "learning_rate": 1e-3,   # Adam lr
    "epochs": 50,            # 最大 epoch（早停可提前）
    "batch_size": 512,       # mini-batch
    "patience": 8,           # 早停耐心（验证 macro-F1 无提升轮数）
    "seed": 42,              # 随机种子
}


# 模块级缓存：首次需要时构造 DirectionLSTM 子类，避免顶层 import torch
_DIRECTION_LSTM_CLASS: Any = None


def _build_direction_lstm_class() -> Any:
    """延迟构造并缓存 DirectionLSTM 类（依赖 torch.nn）。"""

    global _DIRECTION_LSTM_CLASS
    if _DIRECTION_LSTM_CLASS is not None:
        return _DIRECTION_LSTM_CLASS

    import torch
    from torch import nn

    class _DirectionLSTM(nn.Module):  # type: ignore[misc]  # 缺 torch stub，nn.Module 解析为 Any
        """次日方向三分类 LSTM。

        结构（spec 02 §4）：
            nn.LayerNorm(N) → nn.LSTM(batch_first=True) → 取末步 hidden
            → Dropout → Linear(hidden, 3)

        输入归一化层（input_norm）——已知张力的最小缓解（方案甲）：
          feature_matrix 的特征是「逐交易日横截面 z-score」（每个 trade_date 截面内
          标准化）。LSTM 把同一股票连续 L 天的横截面 z-score 堆成序列喂入；但每天
          截面 mean/std 不同，「昨天 z=1.5」与「今天 z=1.5」对应不同原始量级，
          **时序水平不可比**，削弱 LSTM 学时序形态的能力（设计层张力，非崩溃 bug）。

          在输入处加 nn.LayerNorm(input_size)：对每个时间步、跨 N 个特征做归一化，
          稳定每步内各特征的相对尺度，改善训练数值条件。它解决到什么程度——
          **诚实说明**：LayerNorm 是 per-timestep 跨特征归一，能稳定输入尺度、
          抑制个别日截面 std 异常导致的水平漂移，但**不直接「恢复跨日可比」**
          （绝对水平信息在 feature_matrix 做 z-score 时已丢失）。真正对症的修复
          需保留原始量级 / 截面 mean·std → 必须改 features/builder.build_feature_set_id
          的哈希契约 → 会让全部历史 feature_matrix 失效，**不可接受**（见
          docs/superpowers/specs/2026-05-30-lstm-quant-module-design/02-python-training.md §4
          「输入归一化与已知张力」）。故仅在模型内做此最小缓解。

          为何选模型内 LayerNorm 而非「序列级 per-feature 时序标准化」：
            · 零数据流改动、不碰 sequence_builder / 推理取数；
            · 仿射参数（weight/bias）随 state_dict 落盘，推理侧用同一 DirectionLSTM
              构造 + load_state_dict 自动复现 → 训练/推理变换**完全一致**，
              meta.json 无需新增任何统计量字段，**无训练→推理泄漏可能**；
            · 横截面 z-score 本身每日 mean≈0/std≈1，per-feature 全局时序标准化收益
              微弱却引入 meta 往返 / 防泄漏负担，不划算。
        """

        def __init__(
            self,
            input_size: int,
            hidden_size: int = 128,
            num_layers: int = 2,
            dropout: float = 0.2,
        ) -> None:
            super().__init__()
            self.input_size = int(input_size)
            self.hidden_size = int(hidden_size)
            self.num_layers = int(num_layers)
            # 输入归一化：归一最后一维（N=input_size），即 (B,L,N) 每个 (b,l) 切片
            # 跨特征归一。elementwise_affine=True（默认）→ weight/bias 随 state_dict
            # 落盘，推理零额外对齐、无泄漏。
            self.input_norm = nn.LayerNorm(self.input_size)
            # nn.LSTM 的层间 dropout 仅在 num_layers > 1 时生效；单层传 dropout>0
            # 会触发 PyTorch UserWarning，这里显式置 0 规避。
            lstm_dropout = float(dropout) if self.num_layers > 1 else 0.0
            self.lstm = nn.LSTM(
                input_size=self.input_size,
                hidden_size=self.hidden_size,
                num_layers=self.num_layers,
                batch_first=True,
                dropout=lstm_dropout,
            )
            self.dropout = nn.Dropout(float(dropout))
            self.head = nn.Linear(self.hidden_size, 3)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            # x: (B, L, N) → LayerNorm 跨最后一维 N → LSTM → 取末步 hidden
            x = self.input_norm(x)        # (B, L, N)，逐时间步跨特征归一
            out, _ = self.lstm(x)         # (B, L, H)
            last = out[:, -1, :]          # (B, H)；末步 hidden 作序列表征
            last = self.dropout(last)
            logits = self.head(last)      # (B, 3)
            return logits

    _DIRECTION_LSTM_CLASS = _DirectionLSTM
    return _DIRECTION_LSTM_CLASS


def __getattr__(name: str) -> Any:
    """模块级延迟属性：访问 DirectionLSTM 时才触发 torch import。

    让 `from quant_pipeline.training.lstm_model import DirectionLSTM` 可用，
    同时保持模块 import 期不引 torch。
    """

    if name == "DirectionLSTM":
        return _build_direction_lstm_class()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _set_seed(seed: int) -> None:
    """固定 torch / numpy / random 随机种子，保证 fold 可复现。"""

    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _class_weights(y: np.ndarray) -> np.ndarray:
    """逆频率类别权重（spec 02 §5）：weight[c] = N_total / (3 * N_c)。

    某类在训练集缺席（N_c == 0）时权重置 0（CrossEntropyLoss 不会有该类样本，
    权重 0 不影响梯度，且避免除零 / inf）。tercile 近似均衡 → 权重 ≈ 1。
    """

    n_total = int(y.shape[0])
    weights = np.zeros(3, dtype=np.float64)
    for c in range(3):
        n_c = int(np.sum(y == c))
        weights[c] = (n_total / (3.0 * n_c)) if n_c > 0 else 0.0
    return weights


def _macro_f1_and_acc(y_true: np.ndarray, y_pred: np.ndarray) -> tuple[float, float]:
    """三分类 macro-F1 与 accuracy（不依赖 sklearn，纯 numpy）。

    macro-F1：对 {0,1,2} 三类各算 F1 取算术均值；某类在 y_true/y_pred 中
    完全缺席时该类 F1 记 0（与 sklearn macro 默认 zero_division=0 一致）。
    """

    if y_true.shape[0] == 0:
        return 0.0, 0.0
    acc = float(np.mean(y_true == y_pred))
    f1s: list[float] = []
    for c in range(3):
        tp = int(np.sum((y_pred == c) & (y_true == c)))
        fp = int(np.sum((y_pred == c) & (y_true != c)))
        fn = int(np.sum((y_pred != c) & (y_true == c)))
        denom = 2 * tp + fp + fn
        f1s.append((2.0 * tp / denom) if denom > 0 else 0.0)
    return float(np.mean(f1s)), acc


def train_one_fold(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_va: np.ndarray,
    y_va: np.ndarray,
    *,
    hyperparams: dict[str, Any] | None,
    seed: int,
    progress_cb: Callable[[int, int, float], None] | None = None,
) -> tuple[Any, dict[str, Any]]:
    """单 fold 训练循环（spec 02 §4）。

    流程：
      - 固定随机种子（torch / numpy / random）；
      - DataLoader(batch_size, shuffle=True)；
      - Adam(lr) + CrossEntropyLoss(weight=训练集逆频率类别权重)；
      - 按 epoch 训练，验证集 macro-F1 早停（patience 轮无提升停止）；
      - 返回 (best_model, fold_metrics)。

    Args:
        X_tr / X_va: (N, L, Nfeat) float32 序列。
        y_tr / y_va: (N,) int64 类别 0/1/2。
        hyperparams: 覆盖 DEFAULT_LSTM_HYPERPARAMS 的字段；None 则全用默认。
        seed: 随机种子（与 DEFAULT_LSTM_HYPERPARAMS['seed'] 解耦，调用方显式传）。
        progress_cb: 可选回调 (epoch, total_epochs, val_macro_f1)，每 epoch 末调用。

    Returns:
        (best_model: nn.Module, fold_metrics: dict)；
        fold_metrics 至少含 accuracy / macro_f1（验证集最优 epoch 的指标），
        另含 best_epoch / epochs_run / val_loss。

    Raises:
        ValueError: 输入形状不一致 / 为空。
    """

    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset

    hp: dict[str, Any] = dict(DEFAULT_LSTM_HYPERPARAMS)
    if hyperparams:
        hp.update(hyperparams)

    X_tr = np.asarray(X_tr, dtype=np.float32)
    X_va = np.asarray(X_va, dtype=np.float32)
    y_tr = np.asarray(y_tr, dtype=np.int64)
    y_va = np.asarray(y_va, dtype=np.int64)

    if X_tr.ndim != 3 or X_va.ndim != 3:
        raise ValueError(
            f"X 必须是 (N,L,Nfeat) 3 维，got X_tr.ndim={X_tr.ndim} X_va.ndim={X_va.ndim}"
        )
    if X_tr.shape[0] != y_tr.shape[0]:
        raise ValueError(f"len(X_tr)={X_tr.shape[0]} != len(y_tr)={y_tr.shape[0]}")
    if X_va.shape[0] != y_va.shape[0]:
        raise ValueError(f"len(X_va)={X_va.shape[0]} != len(y_va)={y_va.shape[0]}")
    if X_tr.shape[0] == 0:
        raise ValueError("训练集为空，无法训练 LSTM fold")
    if X_tr.shape[2] != X_va.shape[2]:
        raise ValueError(
            f"训练/验证特征维不一致：{X_tr.shape[2]} != {X_va.shape[2]}"
        )

    _set_seed(int(seed))

    input_size = int(X_tr.shape[2])
    lstm_cls = _build_direction_lstm_class()
    device = torch.device("cpu")
    model = lstm_cls(
        input_size=input_size,
        hidden_size=int(hp["hidden_size"]),
        num_layers=int(hp["num_layers"]),
        dropout=float(hp["dropout"]),
    ).to(device)

    # 逆频率类别权重 → CrossEntropyLoss
    weights = _class_weights(y_tr)
    weight_t = torch.tensor(weights, dtype=torch.float32, device=device)
    criterion = nn.CrossEntropyLoss(weight=weight_t)
    optimizer = torch.optim.Adam(model.parameters(), lr=float(hp["learning_rate"]))

    # DataLoader：种子化的 generator 让 shuffle 可复现
    gen = torch.Generator()
    gen.manual_seed(int(seed))
    train_ds = TensorDataset(
        torch.from_numpy(X_tr), torch.from_numpy(y_tr)
    )
    batch_size = int(hp["batch_size"])
    train_loader = DataLoader(
        train_ds, batch_size=batch_size, shuffle=True, generator=gen
    )

    X_va_t = torch.from_numpy(X_va).to(device)
    y_va_t = torch.from_numpy(y_va).to(device)

    epochs = int(hp["epochs"])
    patience = int(hp["patience"])

    best_f1 = -1.0
    best_state: dict[str, Any] | None = None
    best_metrics: dict[str, Any] = {"accuracy": 0.0, "macro_f1": 0.0}
    best_epoch = 0
    no_improve = 0

    for epoch in range(1, epochs + 1):
        model.train()
        for xb, yb in train_loader:
            xb = xb.to(device)
            yb = yb.to(device)
            optimizer.zero_grad()
            logits = model(xb)
            loss = criterion(logits, yb)
            loss.backward()
            optimizer.step()

        # ---- 验证集评估 ----
        model.eval()
        with torch.no_grad():
            val_logits = model(X_va_t)
            val_loss = float(criterion(val_logits, y_va_t).item())
            val_pred = torch.argmax(val_logits, dim=1).cpu().numpy()
        val_true = y_va
        macro_f1, acc = _macro_f1_and_acc(val_true, val_pred)

        if progress_cb is not None:
            progress_cb(epoch, epochs, macro_f1)

        if macro_f1 > best_f1:
            best_f1 = macro_f1
            best_epoch = epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            best_metrics = {
                "accuracy": acc,
                "macro_f1": macro_f1,
                "val_loss": val_loss,
            }
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= patience:
                logger.info(
                    "lstm_early_stop",
                    extra={"epoch": epoch, "best_epoch": best_epoch, "best_macro_f1": best_f1},
                )
                break

    # 恢复验证集最优权重
    if best_state is not None:
        model.load_state_dict(best_state)

    fold_metrics: dict[str, Any] = {
        "accuracy": float(best_metrics.get("accuracy", 0.0)),
        "macro_f1": float(best_metrics.get("macro_f1", 0.0)),
        "val_loss": float(best_metrics.get("val_loss", float("nan"))),
        "best_epoch": int(best_epoch),
        "epochs_run": int(min(epoch, epochs)),
    }
    return model, fold_metrics


__all__ = [
    "DEFAULT_LSTM_HYPERPARAMS",
    "DirectionLSTM",  # noqa: F822  # 经模块级 __getattr__（PEP 562）动态导出，非静态符号
    "train_one_fold",
]
