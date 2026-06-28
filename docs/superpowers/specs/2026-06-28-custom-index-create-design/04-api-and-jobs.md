# API 与 Jobs

## 模块位置

```text
apps/server/src/market-data/custom-index/
├─ custom-index.module.ts
├─ custom-index.controller.ts
├─ custom-index.service.ts
├─ custom-index-compute.service.ts   # 创建/触发 ml.jobs
├─ dto/
│   ├─ create-custom-index.dto.ts
│   ├─ update-custom-index.dto.ts
│   └─ custom-index-latest.dto.ts
└─ ...

apps/server/src/entities/custom-index/
├─ custom-index-definition.entity.ts
├─ custom-index-weight-version.entity.ts
├─ custom-index-member.entity.ts
├─ custom-index-daily-quote.entity.ts
└─ ...
```

全局 `AuthGuard` 生效；**所有接口**按 `req.user.id` 过滤，禁止跨用户访问。

### Wire 命名约定

| 方向 | 约定 | 示例 |
|------|------|------|
| 响应 JSON | camelCase（对齐 `IndexLatestRow`） | `tsCode`, `baseDate` |
| 写请求 body | snake_case | `index_type`, `base_date` |
| 读 query | 按端点对齐邻近 API | kline: `start_date`；amv: `startDate`（对齐 active-mv） |

---

## REST API

### 列表（行情表）

```
GET /api/custom-indices/latest
```

Query：`q`, `sort`, `order`, `page`, `pageSize`（对齐 `GET /api/indices/latest` 语义）

Response 行类型 `CustomIndexLatestRow`（camelCase wire）：

| 字段 | 说明 |
|------|------|
| `id` | UUID，K 线/编辑/删除用 |
| `tsCode` | `CUST.xxxx.U` |
| `name` | |
| `category` | 固定 `'custom'` |
| `tradeDate` | 最新交易日 |
| `close`, `pctChange`, `vol`, `amount` | 来自 latest quote |
| `count` | 当前 active 版本成分数 |
| `status` | `pending/computing/ready/failed` |
| `computeProgress` | 0–100 |
| `indexType` | `price/total_return` |
| `weightMethod` | 当前 active 版本方案 |
| `baseDate`, `basePoint` | 语义基期/基点 |
| `actualStartDate` | 实际序列起始日（ready 后） |
| `netAmount`, `netAmount5d`, ... | 来自 money_flow（ready 后） |

### 详情

```
GET /api/custom-indices/:id
```

返回完整定义 + 当前 active version 成分列表（含 weight）。

### 成分列表（PIT 或 active）

```
GET /api/custom-indices/:id/members?as_of_date=
```

- 默认：当前 active version 成分
- `as_of_date` 可选：PIT 查询指定交易日成员（K 线历史日跳转用）
- Response：`{ members: [{ conCode, name, weight }] }`

### 权重预览（Modal Step 3）

```
POST /api/custom-indices/preview-weights
```

Body：`{ weight_method, members: [{ con_code }], effective_date }`  
Response：`{ members: [{ con_code, name, weight }] }`（weight 0–1）

### 从外部指数导入成分（Modal Step 2）

```
GET /api/index-catalog/:tsCode/members
```

只读；返回该指数最新可用成分（优先 `index_weight` PIT 最新版，否则 `ths_member_stocks` / 申万映射）。**不**写入 watchlist。

### 创建

```
POST /api/custom-indices
```

Body：

```json
{
  "name": "我的白酒指数",
  "description": "",
  "index_type": "price",
  "base_date": "20200102",
  "base_point": 1000,
  "weight_method": "equal",
  "effective_date": "20200102",
  "members": [
    { "con_code": "600519.SH" },
    { "con_code": "000858.SZ" }
  ],
  "custom_weights": null
}
```

`weight_method=custom` 时 `members` 每项带 `weight`（0–1）。

**首版 `effective_date` 规则**：可等于 `base_date`（不必 ≥ 下一交易日）。

Response：`{ id, ts_code, job_id, status: 'pending' }`

服务端事务：insert definition + version + members → enqueue job → return。

### 更新

```
PATCH /api/custom-indices/:id
```

可改：`name`, `description`, `members`, `weight_method`, `custom_weights`, `effective_date`, `index_type`

**PATCH 分支**：

| 变更 | 行为 |
|------|------|
| 仅 `name` / `description` | 直接 UPDATE，**不**新建 version、**不** enqueue |
| 成分/权重/类型/`effective_date` 变化 | 新 weight version；**调仓**时 `effective_date` 须 ≥ 下一交易日；enqueue job |
| 与当前 version 比较无成分/权重变化 | 400 或 no-op（不 enqueue） |

若 `index_type` 变化 → `full_rebuild: true`。

### 删除

```
DELETE /api/custom-indices/:id
```

V1 **硬删** + 级联子表；若 job `running` 则先 cancel 再删。

### 重试计算

```
POST /api/custom-indices/:id/recompute
```

`status=failed` 或用户主动触发；enqueue 新 job。

### K 线

```
GET /api/custom-indices/:id/kline?start_date=&end_date=
```

Response 对齐 `IndexDailyKlineRow` → 前端 `KlineChartBar`（含 indicators join）。

### AMV

```
GET /api/custom-indices/:id/amv?startDate=&endDate=
```

Response 对齐 `activeMvApi` 行业 AMV 形态，供 K 线 Modal 0AMV 副图。

### 计算进度 SSE

```
POST /api/custom-indices/:id/sse-token
GET  /api/custom-indices/:id/stream?token=
```

- 校验：`definition.user_id === currentUser`
- 转发 `ml.jobs` NOTIFY 或轮询 `compute_progress` / `compute_stage`
- TTL 5 分钟，模式同 `quant-jobs-sse.controller.ts`

**不**对普通用户开放 `POST /api/quant/jobs`。

---

## ml.jobs 集成

### 新增 run_type

| 值 | 说明 |
|----|------|
| `custom_index_compute` | 自定义指数全量/增量计算 |

写入 `ml.jobs`：

```json
{
  "run_type": "custom_index_compute",
  "params": {
    "custom_index_id": "uuid",
    "user_id": "uuid",
    "full_rebuild": true
  },
  "priority": 200,
  "max_attempts": 2
}
```

### Worker 行为

1. `poll` 拾取 job
2. `UPDATE custom_index_definitions SET status='computing'`
3. 按 `./03-index-computation.md` 阶段执行 + `update_progress`
4. 成功 → `status='ready'`, `compute_progress=100`
5. 失败 → `status='failed'`, `last_error=...`

### 取消（V2，V1 不实现）

`POST /api/custom-indices/:id/cancel-compute` 留待后续；V1 computing 期间禁止 PATCH/删除以外操作，用户等待完成或失败后 recompute。

---

## 错误码

| HTTP | 场景 |
|------|------|
| 400 | 成分 < 2、权重总和 ≠ 1、调仓 effective_date 非未来交易日 |
| 404 | 非本人指数 |
| 409 | 正在 computing 时重复提交 PATCH/recompute |
| 422 | base_date 无交易日 |

---

## 与 index-daily 模块边界

- `GET /api/index-daily` **不**扩展支持 custom ts_code
- 自定义指数 K 线走 `/api/custom-indices/:id/kline`
- `ASharesIndexKlineModal` 内部分支：`category === 'custom'` → 调 custom API
