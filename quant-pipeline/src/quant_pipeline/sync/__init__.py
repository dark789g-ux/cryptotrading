"""sync 模块占位（M1 起实装）。

仅同步 01-pg-schema.md §5 划归 Python 的 raw 表：
stk_limit / suspend_d / index_classify / index_member / fina_indicator / trade_cal。

tushare_client.py 必须实现三种空数据 warn 分路径（CLAUDE.md + 04 §2）：
- data=None
- items=[]
- code≠0
每条路径都要 logger.warn(api_name, params) + INSERT INTO ml.quality_reports。
"""
