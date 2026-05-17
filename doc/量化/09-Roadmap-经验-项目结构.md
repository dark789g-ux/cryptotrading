# 09 Roadmap、关键经验、项目结构

↩ [返回索引](00-index.md)

---

## 9.1 90 天落地 Roadmap

| 周次 | 阶段 | 产出 |
|---|---|---|
| W1-2 | 数据基建 | TuShare P0 接口对接 + 5 年回填 + PIT 库 schema |
| W3 | 因子库 1 | 量价类 15 因子开发 + 单测 + PIT 测试 |
| W4 | 因子库 2 | 财务类 10 因子 + 资金流类 8 因子 |
| W5 | 因子库 3 | 行业/概念派生因子 + 中性化版本 |
| W6 | 标签 + EDA | 标签生成（含污染过滤）+ 因子健康度报告 |
| W7 | Baseline | 桶分 Logistic 模型 + walk-forward 评估 |
| W8 | LightGBM v1 | LambdaRank 模型 + Optuna 调参 |
| W9 | 评估 | 三层指标 + 成本敏感性 + 容量分析 + 对照实验 |
| W10 | 部署管线 | 模型序列化 + 推理服务 + 监控指标 |
| W11 | 灰度 | 模拟盘并行 1 个月 |
| W12 | 复盘 | 入库主策略 + 文档归档 |

---

## 9.2 关键经验三条

1. **80% 时间在数据 / 标签**，20% 在模型。LightGBM 训练 5 分钟，调参 1 天，但数据准备和因子计算可能 1 个月。
2. **NDCG@5 提升 5% ≈ OOS 年化 +1-3%**。A 股 OOS 衰减约 50%，所以训练集要有显著优势才上线。
3. **比模型重要的是迭代频率**。能每周自动重训 + A/B + 灰度的团队，长期一定打过"半年训一次大模型"的团队——量化是工程问题。

---

## 9.3 数据落 PG，按 schema 分层

```
PostgreSQL (crypto-postgres 容器)
├─ schema: raw        ← 源头层（TuShare 原样镜像，每接口一张表，永不修改）
│   ├─ ts_stock_basic
│   ├─ ts_trade_cal
│   ├─ ts_daily               (按月分区)
│   ├─ ts_daily_basic         (按月分区)
│   ├─ ts_adj_factor          (按月分区)
│   ├─ ts_stk_limit           (按月分区)
│   ├─ ts_suspend_d
│   ├─ ts_index_classify
│   ├─ ts_index_member_all
│   ├─ ts_fina_indicator      (P1)
│   ├─ ts_moneyflow_dc        (P1)
│   ├─ ts_top_list            (P1)
│   ├─ ts_kpl_list            (P1)
│   └─ ts_ths_member          (P1)
│
├─ schema: factors    ← 计算层（按 factor_version 隔离，可共存多版本）
│   ├─ factor_panel           主键 (symbol, trade_date, factor_version)
│   ├─ factor_panel_neu       行业中性化版本
│   └─ factor_meta            因子定义 + 健康度元数据
│
└─ schema: ml         ← 训练层
    ├─ labels                 forward return + rank label
    ├─ training_set           join 后的训练宽表
    ├─ inference_input        每日推理输入快照
    └─ scores_daily           每日推理输出
```

---

## 9.4 应用代码结构（子项目 `apps/quant-pipeline/`）

```
apps/quant-pipeline/
├─ src/
│   ├─ sync/                  # TuShare → raw schema 同步
│   │   ├─ daily-sync          P0：日线/基本面/复权因子/涨跌停
│   │   ├─ basic-sync          P0：股票基础/交易日历/行业分类
│   │   ├─ fina-sync           P1：财务三表 + 业绩预告/快报
│   │   ├─ moneyflow-sync      P1：东财/同花顺资金流
│   │   ├─ event-sync          P1：龙虎榜 / 涨停板 / 概念板块
│   │   └─ rate-limiter         统一限频（500-800 次/分钟）
│   │
│   ├─ factors/               # 因子函数（一文件一因子）
│   │   ├─ wave-rise-pct
│   │   ├─ wave-rise-time-centroid
│   │   ├─ short-long-ma-ratio
│   │   ├─ industry-momentum
│   │   ├─ alpha-vs-industry
│   │   └─ ...                 共 41 + 派生
│   │
│   ├─ pipeline/
│   │   ├─ feature-eng/        横截面归一化 / 行业中性化 / 缩尾
│   │   ├─ label-gen/          forward return + 污染过滤 + rank label
│   │   └─ cv/                 PurgedWalkForward + Embargo
│   │
│   ├─ training/
│   │   ├─ train/              主训练入口(LambdaRank)
│   │   ├─ tune/               Optuna 调参
│   │   └─ evaluate/           三层评估（IC / 组合 / 成本后）
│   │
│   └─ inference/
│       ├─ serve/              每日推理 → 写回 ml.scores_daily
│       └─ monitor/            漂移监控（PSI / 滚动 IC / SHAP 重要性）
│
├─ models/                    # 文件系统（训练产出落盘，受 git-lfs 管理）
│   ├─ v1/
│   │   ├─ model.txt
│   │   ├─ feature_meta.json
│   │   └─ eval_report.html
│   └─ v2/
│
├─ migrations/                # PG schema 迁移脚本（synchronize: false）
│   ├─ V001__raw_schema.sql
│   ├─ V002__raw_partition_2024.sql
│   ├─ V003__factors_schema.sql
│   └─ V004__ml_schema.sql
│
└─ notebooks/
    └─ factor_research.ipynb   # 因子健康度探索
```

---

## 9.5 与主项目（apps/server）的关系

- **共用** PG 实例（`crypto-postgres` 容器），不同 schema 隔离
- **独立部署**：`apps/quant-pipeline/` 与 NestJS workspace 同仓但不共享 pnpm 包管理，单独 Python 项目（LightGBM 生态在 Python，跨语言不实用）
- **数据契约**：apps/server 如需展示选股结果，直接读 `ml.scores_daily` 表
- **认证**：apps/quant-pipeline 用独立 PG 角色 + 只读 `ml.scores_daily` 给后端

---

↩ [返回索引](00-index.md) | 上一篇：[08 反模式集合](08-反模式集合.md) | 下一篇：[10 术语表](10-术语表.md)
