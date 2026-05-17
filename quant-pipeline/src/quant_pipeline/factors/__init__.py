"""factors 模块（M1 起实装）。

子模块：
    base.py        Factor 抽象类
    registry.py    全局注册表 + @register 装饰器
    runner.py      调度器（compute(date_range) → factors.daily_factors）
    price/         量价因子（10 个，本轮交付）
    industry/      行业派生因子（5 个，本轮交付）
    fundamental/   财务因子（占位；后续轮次）

导入本包时自动加载所有内置因子，使 `list_factors()` 立即可用。
"""

from quant_pipeline.factors.registry import import_all_factors

# 触发装饰器副作用，把内置因子登记到 registry
import_all_factors()
