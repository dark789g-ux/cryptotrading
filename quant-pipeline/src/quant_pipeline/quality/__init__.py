"""quality 模块（M1 Part E）。

包含：
- checks.py：八项数据质量校验（doc/量化/03 §3.3 + 01-pg-schema §4.3）
- pit_audit.py：PIT 三铁律审计 + 三幽灵 Bug 检测（doc/量化/03 §3.1-3.2）
- report.py：CheckResult → ml.quality_reports 写入助手
- runner.py：CLI / worker 入口

训练前 / 推理前必检在此模块（04-error-quality-testing.md §2）。
"""

from quant_pipeline.quality.report import CheckResult

__all__ = ["CheckResult"]
