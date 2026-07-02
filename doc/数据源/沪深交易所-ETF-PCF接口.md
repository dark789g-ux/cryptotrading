# 沪深交易所 ETF PCF 接口

> 已实测验证（2026-06 通过 Kimi WebBridge + curl），非记忆。

## 上交所 — JSONP 接口

### URL
```
GET https://query.sse.com.cn/commonQuery.do
```

### 请求参数

| 参数 | 值 | 说明 |
|------|-----|------|
| jsonCallBack | 任意非空字符串（如 `jsonpCallback`） | JSONP 回调名 |
| isPagination | false | 禁用分页 |
| FUNDID2 | 6 位基金代码（如 `510020`） | 基金 ID |
| sqlId | 见下方两个 ID | 查询模板 ID |
| _ | 当前时间戳（毫秒） | 防缓存 |

### 必要 Headers
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Referer: https://www.sse.com.cn/
```

### 两个 sqlId

| sqlId | 用途 |
|-------|------|
| `COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C` | PCF 清单头（基金名称/管理人/申赎单位/IOPV 等） |
| `COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C` | PCF 成分股明细（代码/名称/数量/替代标志/溢价率） |

### 返回格式
```
jsonpCallback({"pageHelp":{...}, "result":[{...}]})
```
JSONP 回调包裹 → 去外层回调名 → `JSON.parse()` → `result` 数组。

### 字段映射（清单头 result）

| SSE 字段 | 统一列 |
|----------|--------|
| FUND_NAME | fundName |
| FUND_COMP_NAME | manager |
| ETF_TYPE | fundType |
| CREATION_REDEMPTION_UNIT | creationUnit |
| MAX_CASH_RATIO | maxCashRatio |
| PUBLISH_IOPV | publishIopv |
| CREATION_PREMIUM_RATE | premiumRate |
| REDEMPTION_DISCOUNT_RATE | discountRate |

### 字段映射（成分股 result）

| SSE 字段 | 统一列 |
|----------|--------|
| INSTRUMENT_ID | conCode（6 位代码，需加 .SH 后缀） |
| INSTRUMENT_NAME | conName |
| QUANTITY | quantity |
| SUBSTITUTION_FLAG | substFlag |
| CREATION_PREMIUM_RATE | premiumRate |
| REDEMPTION_DISCOUNT_RATE | discountRate |

---

## 深交所 — XML 接口

### URL
```
GET https://reportdocs.static.szse.cn/files/text/ETFDown/pcf_{6位代码}_{8位日期}.xml
```
例：`pcf_159919_20260630.xml`

### 必要 Headers
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
```

### 返回格式
UTF-8 XML，根命名空间 `xmlns=http://ts.szse.cn/Fund`。

```xml
<PCFFile>
  <SecurityID>159919</SecurityID>
  <TradingDay>20260630</TradingDay>
  <Symbol>沪深300ETF嘉实</Symbol>
  <FundManagementCompany>嘉实基金</FundManagementCompany>
  <CreationRedemptionUnit>1000000</CreationRedemptionUnit>
  <MaxCashRatio>0.5</MaxCashRatio>
  <Publish>Y</Publish>
  <UnderlyingSecurityID>399300</UnderlyingSecurityID>
  <UnderlyingSymbol>沪深300</UnderlyingSymbol>
  <Components>
    <Component>
      <UnderlyingSecurityID>600030</UnderlyingSecurityID>
      <UnderlyingSymbol>中信证券</UnderlyingSymbol>
      <ComponentShare>7400</ComponentShare>
      <SubstituteFlag>Y</SubstituteFlag>
      <PremiumRatio>33.1</PremiumRatio>
      <DiscountRatio>32.5</DiscountRatio>
    </Component>
    <!-- ... -->
  </Components>
</PCFFile>
```

### XML 解析依赖
- `fast-xml-parser`（npm 包，已加入 `@cryptotrading/server` 依赖）

### 字段映射

| XML 标签 | 统一列 |
|----------|--------|
| Symbol | fundName |
| FundManagementCompany | manager |
| CreationRedemptionUnit | creationUnit |
| MaxCashRatio | maxCashRatio |
| Publish | publishIopv（Y→true） |
| UnderlyingSecurityID | indexCode（清单头）/ conCode（成分股） |
| UnderlyingSymbol | conName |
| ComponentShare | quantity |
| SubstituteFlag | substFlag |
| PremiumRatio | premiumRate |
| DiscountRatio | discountRate |

注意：深交所成分股 con_code 无交易所后缀（纯 6 位），代码层按规则推断（60/68→.SH，00/30→.SZ）。

---

## 统一字段映射（两所归一落 raw.etf_pcf）

| 统一列 | 上交所 JSON | 深交所 XML |
|--------|------------|-----------|
| ts_code / trade_date | TRADE_CODE / TRADING_DAY | SecurityID + .SZ / TradingDay |
| fund_name / manager | FUND_NAME / FUND_COMP_NAME | Symbol / FundManagementCompany |
| fund_type / index_code | ETF_TYPE / — | —（按规则推断）/ UnderlyingSecurityID |
| creation_unit | CREATION_REDEMPTION_UNIT | CreationRedemptionUnit |
| max_cash_ratio / publish_iopv | MAX_CASH_RATIO / PUBLISH_IOPV | MaxCashRatio / Publish |
| con_code / con_name | INSTRUMENT_ID / INSTRUMENT_NAME | UnderlyingSecurityID / UnderlyingSymbol |
| quantity | QUANTITY | ComponentShare |
| subst_flag | SUBSTITUTION_FLAG | SubstituteFlag |
| premium / discount_rate | CREATION_PREMIUM_RATE / REDEMPTION_DISCOUNT_RATE | PremiumRatio / DiscountRatio |

---

## 限频策略

- 交易所接口敏感，HTTP 间隔 ≥ **0.4s**（项目常量 `ETF_FETCH_INTERVAL_MS = 450`）。
- 上交所：每只 ETF 2 次请求（清单头 + 成分股）。
- 深交所：每只 ETF 1 次请求。
- 全市场约：700 SH × 2 + 700 SZ × 1 ≈ 2100 次请求/次同步，0.45s ≈ 15 分钟。
- 仅一键同步触发，无自动定时/盘中轮询。
- 单只失败不中断，进 `failedItems`；retry 3 次（`runWithRetry`，退避 [1000ms, 2000ms]）。

---

## 验证方式

| 源 | 测试标的 | 验证 |
|----|---------|------|
| 上交所 | 510020（超大盘 ETF） | JSONP 解析、清单头 + 成分股字段归一 |
| 深交所 | 159919（沪深300ETF嘉实） | XML 解析、字段归一、Publish→boolean |
| 空 URL | 404 ETF（无效代码） | 三路径 warn（HTTP 非 200 / 空 body / 空 result） |

---

## 变更风险

1. **上交所 sqlId 变更**：通用查询框架比 HTML 稳定，但仍可能被后台模板更新。空数据写 `quality_reports` 监控。
2. **深交所 XML 路径变更**：`reportdocs.static.szse.cn/files/text/ETFDown/` 路径相对稳定。
3. **字段增删**：新增字段不会中断现有解析；缺失字段返回 null。
