# 择时模块 — 0AMV 独立触发器

> 基于活跃市值（0AMV）的状态机择时系统，用于 A 股市场多空判断。

---

## 一、核心原理

### 1.1 信号源：活跃市值 0AMV

0AMV（活跃市值）是衡量市场成交活跃度的核心指标，由 Bilibili 学习版算法演化而来：

```
OAMVC = SMA(成交额(元) / 1,000,000) × (收盘价 / 前收5日MA) × 0.1 × 拟合系数
```

**数据来源**：
- 中证 A 股指数 **930903.CSI**（tushare `index_daily`）
- `amount` 字段单位：千元（公式中需 ×1000 转元）
- 拟合系数 **0.87**（通过真实 0AMV 数据校准）

### 1.2 通达信 SMA 递推

**不**使用 pandas `ewm()`，严格手写递推：

```
SMA_t = (X_t + (N - 1) × SMA_{t-1}) / N    # 其中 N=10, M=1
EMA_t = (2 × X_t + (N - 1) × EMA_{t-1}) / (N + 1)  # 其中 N=12
```

### 1.3 状态机信号规则

| 条件 | 信号 |
|---|---|
| 单日涨幅 ≥ **+2.5%** | 翻转为 **多头** |
| 2日累计涨幅 ≥ **+2.8%** | 翻转为 **多头**（备份条件） |
| 单日跌幅 ≤ **-1.8%** | 翻转为 **空头** |
| 未触发任何阈值 | **保持上一日信号**（迟滞） |

**设计理念**：0AMV 是领先拐点指标，比 MA 系统提前 1-3 天反应。

---

## 二、目录结构

```
timing/
├── README.md                     # 本文档
├── __init__.py
├── config.py                     # 配置参数
├── signal_engine.py              # 择时信号引擎（0AMV 状态机）
├── run_timing.py                 # 一键运行入口
├── data_fetcher.py               # 通用数据获取
├── data_fetcher_0amv.py          # 0AMV 专用 API 获取
├── factors/                      # 因子模块
│   ├── __init__.py
│   ├── base.py                   # 因子基类
│   ├── active_mv.py              # 0AMV 因子（核心）
│   ├── avg_price.py              # A股平均股价（退出层参考）
│   ├── margin.py                 # 融资余额（退出层参考）
│   ├── turnover.py               # 两市成交额（退出层参考）
│   └── index_trend.py            # 指数趋势（退出层参考）
└── 0amv_calc/                    # 0AMV 计算模块
    ├── 0amv_formula.py           # 核心递推计算
    ├── run_0amv.py               # 一键计算 0AMV
    ├── analyze_turns.py          # 转折点分析工具
    ├── calibrate_real.py         # 真实数据校准工具
    ├── test_0amv_real.txt        # 真实 0AMV 样本数据
    └── data/
        ├── 930903_daily.csv      # 原始指数数据（tushare 缓存）
        ├── 0amv_result.csv      # 计算结果（含 OAMVC、涨幅、生命线）
        ├── phase4_backtest.csv   # 5因子回测详细结果
        └── real_0amv_parsed.csv  # API 真实 0AMV 数据
```

---

## 三、核心文件说明

### 3.1 `timing/signal_engine.py`

**纯 0AMV 状态机引擎**（v2.0）。

```python
from timing.signal_engine import get_timing_signal

signal = get_timing_signal()
print(signal.overall)      # "多头" 或 "空头"
print(signal.position_pct)  # 建议仓位（多头=100%，空头=0%）
```

状态持久化：`timing/0amv_calc/data/oamv_state.json` 保存上一日信号。

### 3.2 `timing/factors/active_mv.py`

**0AMV 因子模块**。

- 优先从本地 `0amv_calc/data/0amv_result.csv` 读取
- fallback 到 `stock.svip886.com/api/indexes` API
- 支持 +2.5% 单日阈值 + 2日累计备份（+2.8%）

### 3.3 `timing/0amv_calc/0amv_formula.py`

**核心计算脚本**。基于 930903.CSI 严格复现通达信递推公式：

```bash
cd timing/0amv_calc
python run_0amv.py
```

输出 `data/0amv_result.csv`（含 OAMVC、OAMVZDF、OAMVSMX 等列）。

### 3.4 `timing/run_timing.py`

**一键运行入口**。

```bash
cd timing
python run_timing.py
```

输出今日择时信号、0AMV 数据、参考因子状态。

---

## 四、使用方法

### 4.1 获取今日择时信号

```bash
cd C:\Users\Haoxuan\Desktop\KDJ_quant\timing
python run_timing.py
```

输出示例：
```
========================================
  综合择时信号: 多头 [保持]
  触发详情: 0AMV 未触发（+0.94%），保持上一日信号：多头
  0AMV 当日涨幅: +0.94%
  0AMV 2日累计: +1.62%
  建议仓位: 100% (满仓/加杠杆)
----------------------------------------
  0AMV 因子详情:
    [活跃市值(0AMV)] NEUTRAL | 计算0AMV=249,217 涨 +0.94% (未触发阈值)
  其他因子（参考信息，不参与择时）:
    [A股平均股价] ...
    ...
========================================
```

### 4.2 重新计算 0AMV

当 930903 数据更新后，重新计算：

```bash
cd timing/0amv_calc
python run_0amv.py
```

### 4.3 校准拟合系数

当积累更多真实 0AMV 数据后，可重新校准：

```bash
cd timing/0amv_calc
python calibrate_real.py
```

---

## 五、每日自动跟踪

### 5.1 机制

1. **本地计算**：每日收盘后拉取 930903.CSI 数据，执行 `run_0amv.py` 更新 `0amv_result.csv`
2. **API 校验**：同时从 `https://stock.svip886.com/api/indexes` 拉取真实 0AMV
3. **差异预警**：两者差异 > 2% 时提示检查

### 5.2 数据来源

| 数据 | 来源 | 频率 |
|---|---|---|
| 930903.CSI | tushare `index_daily` | 每日收盘后 |
| 真实 0AMV | stock.svip886.com/api/indexes | 实时 |
| 融资余额 | tushare `market_margin` | 每日收盘后 |
| 上证指数 | tushare `index_daily` | 每日收盘后 |

---

## 六、配置参数

```python
# timing/config.py

# 0AMV 阈值
OAMV_BULL_THRESHOLD = 2.5          # 空转多单日阈值
OAMV_BEAR_THRESHOLD = -1.8          # 多转空单日阈值
OAMV_BULL_CUM2_THRESHOLD = 2.8      # 空转多2日累计备份阈值

# 权重（因子已从择时投票移除，权重仅用于参考信息展示）
FACTOR_WEIGHTS = {
    "avg_price": 1.0,
    "margin": 1.0,
    "turnover": 0.8,
    "index_trend": 1.0,
    "active_mv": 1.5,  # 独立触发器，权重不影响信号
}

# 仓位映射
POSITION_MAP = {
    "多头": 1.0,    # 满仓/加杠杆
    "空头": 0.0,    # 只卖不买/空仓
}
```

---

## 七、验证结果

| 维度 | 旧 5 因子投票 | 新 0AMV 状态机 |
|---|---|---|
| 转折点命中率 | 7/14 (50.0%) | **14/14 (100%)** |
| 区间命中率 | 234/307 (76.2%) | **309/320 (96.6%)** |
| 空转多区间 | 92/128 (71.9%) | **137/141 (97.2%)** |

---

## 八、注意事项

1. **Python 模块名不能以数字开头**：`0amv_formula.py` 只能被 `importlib.util` 动态加载
2. **SMA 递推不能混用 pandas**：必须用通达信风格递推，不能用 `.ewm()` 默认参数
3. **amount 单位换算**：tushare 返回千元，公式中需 ×1000 转元
4. **状态持久化**：`oamv_state.json` 记录上一日信号，删除后首次运行默认空头

---

## 九、后续扩展

- **退出层设计**：4 个 MA 因子从择时移除后，可用于第 4 步（持仓退出时机判断）
- **更大范围回测**：积累更多真实 0AMV 数据后，可扩展回测至更长时间段
- **多指数验证**：可尝试用 880003 或其他指数替换 930903 对比效果

---

*文档版本：v2.0 | 0AMV 独立触发器架构 | 更新日期：2026-05-09*
