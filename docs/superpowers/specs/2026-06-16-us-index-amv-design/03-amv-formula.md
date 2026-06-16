# 03 · AMV 公式 Python 移植规范

> 新建 `apps/quant-pipeline/src/quant_pipeline/sync/us_index_amv_formula.py`，**逐式照抄**
> [amv-formula.ts](apps/server/src/market-data/active-mv/amv-formula.ts)（A 股行业 / 概念 / 个股 AMV
> 公共纯函数，已通篇核验）。所有函数纯函数、无副作用、可单测。

## 关键纠正：`tdSma` 是通达信递归 SMA，Python 侧不存在

[amv-formula.ts:20-38](apps/server/src/market-data/active-mv/amv-formula.ts:20)：
`tdSma(X,N,M) = (M*X + (N-M)*prev)/N`，M=1,N=10 → `Y = (X + 9*prev)/10`，**递归**，首值以第一个有效值
为种子，无效值（NaN/None）落 NaN 且不推进种子。

`us_indicators.py` 只有简单窗口均值 `_sma`/`_strict_sma`（[us_indicators.py:55-74]），**不是** `tdSma`，
**不可复用** —— 必须新写。Phase 1 误用简单均线，正式实现纠正为 `tdSma`。

`tdEma(X,N) = (2*X + (N-1)*prev)/(N+1)`（[amv-formula.ts:44-62]）。`us_indicators.py:47-52` 的 `_ema`
（`k=2/(N+1)` 种子 `values[0]`）与之**代数等价**，但**无 NaN-skip 语义**；为口径精确，`tdEma` 也照 TS 新写
（统一处理 NaN-skip），不复用 `_ema`（仅作旁证）。

## 移植清单（逐式）

| Python 函数 | TS 来源 | 公式要点 |
|---|---|---|
| `td_sma(values, n=10, m=1)` | tdSma | `(m*x+(n-m)*prev)/n`；NaN→NaN 不推种子 |
| `td_ema(values, n)` | tdEma | `(2x+(n-1)*prev)/(n+1)`；NaN→NaN 不推种子 |
| `calc_macd(values, fast=12, slow=26, signal=9)` | calcMacd | `dif=ema(f)-ema(s)`；`dea=ema(dif,sig)`；`macd=2*(dif-dea)` |
| `ma5(values)` | ma5 | 5 窗简单均，不足取已有有效均，全 NaN→NaN |
| `calc_amv_series(volume, open, high, low, close)` | calcAmvSeries | 见下 |
| `calc_zdf(amv_close)` | calcZdf | i=0→None；`!(prev>0)`（prev≤0 或 prev=NaN）→None；`isNaN(cur)`→None；否则 `(cur-prev)/prev*100`（两段独立判定，对齐 [amv-formula.ts:193]） |
| `calc_signal(dif, macd_bar)` | calcSignal | dif>0&macd>0→1；dif<0&macd<0→-1；含边界 / NaN→0 |

### `calc_amv_series` 移植（[amv-formula.ts:130-178]）

```text
v1   = td_sma(volume, 10, 1)
ref1 = [NaN] + close[:-1]            # REF(close, 1)
v3   = ma5(ref1)                     # MA5(REF(close,1))
MULT = 0.1
逐 i：
  v3i<=0           → 四价 NaN, invalid[i]=True   # 停牌/脏数据
  c=(v1i*close[i])/v3i*MULT
  c<=0 或 NaN      → 四价 NaN, invalid[i]=True
  否则 amv_{o,h,l,c}=(v1i*{o,h,l,c})/v3i*MULT, invalid[i]=False
```

返回 `amv_open/high/low/close`（list[float]，NaN 表无效）+ `invalid`（list[bool]）。

### 异常处置

镜像 industry：异常日**丢弃不落库**。

- `v3≤0` 或 `amv_close≤0`/NaN → 当日 `invalid=True`。**落库阶段直接丢弃该交易日、不写表**
  （逐字镜像 [industry-amv.service.ts:438-441](apps/server/src/market-data/active-mv/industry-amv.service.ts:438)
  `if (amv.invalid[i]) continue` / `if (!(c>0)||isNaN(c)) continue`）。
- 即：`us_index_amv_daily` 里**只有非异常日**，每行 `amv_close` 非空（与
  [07](./07-testing-and-verification.md) §5 完整性断言一致）。
- 指数级 `.NDX` 价恒 >0、Σ成交额恒 >0 → `invalid` 基本不触发，但**守卫 + continue-skip 必须保留**（口径一致 + 防脏数据）。
- 某指数裁热身 + 过滤异常后**无可落库行** → 记 errors + failedItems（禁伪装成功，镜像 industry-amv.service.ts:468-473）。

## 美股口径差异

（vs A 股行业 AMV；核心是 **US 不 ×1000**，源码必须显式注释防误抄）


| 点 | A 股行业 AMV | 美股指数 AMV |
|---|---|---|
| volume 入参 | `raw.daily_quote.amount × 1000`（千元→元） | `Σ(close×volume)` **已是 USD，不 ×1000** |
| 价格侧 | `ths_index_daily_quotes` 指数点位 | `raw.us_index_daily(.NDX)` 点位 |
| 乘数 | 0.1 | 0.1（一致） |
| /1e6 | 无 | 无（一致） |

> ⚠️ `us_index_amv.py` 调 `calc_amv_series` 前**不得**对 `Σ(close×volume)` 再 ×1000；
> 源码处加注释「US amount 已是美元，A 股的 ×1000 是千元换算，勿照抄」。

## Parity 测试（金标准 fixture）

`07-testing-and-verification.md` 详列。核心：
- 准备一组确定性输入（volume + OHLC，含 NaN/边界用例），在 **TS amv-formula.ts** 上跑出期望输出，
  checked-in 为 golden fixture（JSON）。
- **可独立对拍的函数**（amv-formula.ts 中 `export` 的 6 个）：`tdSma`/`tdEma`/`calcMacd`/`calcSignal`/
  `calcZdf`/`calcAmvSeries`。pytest 喂同一输入给对应 Python 函数，逐元素 `pytest.approx(rel=1e-9)`。
- ⚠️ `ma5`（[amv-formula.ts:108]）是**模块私有、未 export**，外部 TS 驱动脚本 import 不到 → **不单列
  golden**，改为**通过 `calc_amv_series` 端到端覆盖**（其内部用 ma5 算 v3，parity 一致即证 ma5 正确）。
  **不**为此给 A 股 `amv-formula.ts` 加 export（一个 US 功能不动 A 股源）。
- 这是「AMV 公式与 A 股一致性对拍」的硬证据，杜绝两语言口径漂移。
