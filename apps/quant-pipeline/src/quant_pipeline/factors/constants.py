"""因子运行时常量。

集中定义，避免 magic number 散落到 runner / pit_audit / registry 多处。
"""

PIT_WINDOW_COEFFICIENT: float = 2.0
"""pit_window_days 必须 >= ceil(min_trade_days × 该系数)。

系数 = 2.0（原经验值 1.6 提高到 2.0）：
  - 1.6 仅覆盖周末 + 短假期（五一、中秋）
  - 2.0 额外覆盖春节 / 国庆 7 天连休 + 周末叠加

修改该常量需同步：
  1. apps/server/migrations 加新 migration 调整 CHECK 约束
  2. apps/server/src/modules/quant/factors/factors.service.ts 同步系数
  3. apps/web/src/components/quant/FactorEditModal.vue 同步系数
  4. 跑回归测试，确保现有 16 个因子的 pit_window_days 仍满足新系数
"""

RETRY_WINDOW_MULTIPLIER: int = 2
"""运行时窗口不足时，扩窗 × 该倍率重试一次。"""
