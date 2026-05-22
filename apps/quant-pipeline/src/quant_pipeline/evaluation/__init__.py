"""evaluation 模块（M3 实装）。

子模块：
- ranking_metrics：NDCG@K / IC / RankIC（共享）
- portfolio：扣成本组合评估，报单笔净收益均值/中位数（佣金 + 滑点）
- ab_compare：Purged Walk-Forward 三组对照 + 集成
- report_generator：报告 markdown 生成
- shap_explainer：M4
"""
