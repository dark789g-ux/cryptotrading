---
name: tushare-sync-dev
description: 在新建或修改 Tushare 数据同步代码之前必须使用此技能。当用户提及新增 Tushare 接口同步、修改已有同步逻辑、调试 Tushare API 返回为空、添加新数据指标、修改 sync service、调用 tushare 接口、实现 A 股/资金流/指数/行情 等数据拉取时，立即触发。禁止在未查阅文档的情况下直接写 Tushare 相关代码。
---

# Tushare 同步开发规范

## 核心原则

**接口名称、参数名称、字段名称必须以官方文档为准，禁止凭猜测、变量名、历史代码或邻近接口类推。**

---

## 第一步：在接口列表中定位目标接口

读取 `references/数据接口.md`，在接口列表中找到目标接口行，获取：
- **接口名**（第一列，如 `moneyflow_ind_ths`）
- **在线文档链接**（第一列的超链接）

> 如果不确定接口名，在列表中按分类浏览，选出最匹配的候选接口（可能有多个），再逐一核查在线文档。

---

## 第二步：阅读在线文档（必须完成）

用 `WebFetch` 工具访问该接口的在线文档链接（形如 `https://tushare.pro/wctapi/documents/xxx.md`），确认：

| 要确认的项 | 说明 |
|----------|------|
| 接口名 | 与文档标题/示例完全一致 |
| 必填入参 | 哪些参数是 required |
| 选填入参 | 哪些参数有默认值或可选 |
| 输出字段 | 实际返回的列名（不是猜的） |
| 所需积分 | 确认当前 7000 积分是否满足 |
| 单次返回上限 | 是否需要分页/循环拉取 |
| 数据更新时间 | 每日几点之后可取到当日数据 |

**如果文档无法访问，必须告知用户并暂停实现，不得继续编码。**

---

## 第三步：与现有实现对比

在开始编码前，检查以下内容：

1. **是否已有同类 sync service** — 搜索 `apps/server/src/market-data/` 目录，找到同模块已有的同步实现作为模式参考。
2. **Entity 字段与文档输出字段是否一致** — 尤其注意字段重命名（Tushare 返回 `ts_code`，存储可能叫 `stockCode`）。
3. **trade_date 格式** — Tushare 返回 `YYYYMMDD` 字符串，严禁 `new Date(tradeDate)`，必须先插入分隔符。

---

## 第四步：实现规范

### API 调用模板

```typescript
const result = await this.tushareService.callApi('<接口名>', {
  // 入参严格按照文档，字段名一字不差
  trade_date: tradeDate,
  // ...
});

if (!result?.data?.items?.length) {
  this.logger.warn('[<接口名>] 返回空数据', { tradeDate });
  return [];
}
```

**禁止 `.catch(() => [])` 静默吞错**——错误必须在 `errors` 字段透出，并打印接口名和错误信息。

### Upsert 去重

```typescript
// 按冲突键去重，防止 PostgreSQL ON CONFLICT 同批次两行冲突报错
const seen = new Map<string, EntityType>();
for (const item of entities) {
  const key = `${item.field1}_${item.field2}`;
  if (seen.has(key)) {
    this.logger.warn('[<接口名>] 发现重复行', { key });
  }
  seen.set(key, item);
}
await this.repo.upsert([...seen.values()], ['field1', 'field2']);
```

### 日志规范

- 同步开始/结束：`logger.log`
- 外部 API 返回空：`logger.warn`（附带请求参数）
- 跳过未知字段：`logger.warn`
- 业务异常/API 调用失败：`logger.error`（附带 `err.stack`）

---

## 快速参考：常用接口分类

`references/数据接口.md` 按分类组织，常见分类速查：

| 分类 | 典型接口 |
|------|---------|
| 股票基础数据 | `stock_basic`, `trade_cal`, `daily_basic` |
| 股票行情 | `daily`, `weekly`, `monthly`, `stk_mins` |
| 资金流向 | `moneyflow`, `moneyflow_ind_ths`, `moneyflow_ind_dc`, `moneyflow_hsgt` |
| 指数 | `index_daily`, `index_basic`, `sw_daily`, `ci_daily` |
| 财务数据 | `income`, `balancesheet`, `cashflow`, `fina_indicator` |
| ETF | `fund_daily`, `etf_basic` |
| 龙虎榜/打板 | `limit_list_d`, `top_list`, `ths_daily` |

---

## 完成核查清单

在提交代码前，逐项确认：

- [ ] 接口名已与在线文档核对，拼写完全一致
- [ ] 入参字段名来自文档（不是猜的）
- [ ] 输出字段与 Entity 属性的映射已验证
- [ ] 外部 API 返回空时有 `logger.warn`
- [ ] upsert 前已按冲突键去重
- [ ] trade_date 处理使用了正确的日期转换（非 `new Date(tradeDate)`）
- [ ] 无 `.catch(() => [])` 静默吞错
- [ ] 代码中无 `// TODO: 查文档确认` 的未兑现注释
