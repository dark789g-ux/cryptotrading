# 指数成分股一键导入 Watchlist 设计文档

**日期**：2026-05-06  
**状态**：已批准，待实现

---

## 用户故事

用户希望基于某个指数（如沪深300），快速为标的打上标签，以便在 A 股标的页面中筛选和追踪该指数的成分股。

---

## 背景与现状

- **现有标签机制**：项目中没有独立的"标签"实体。Watchlist（自选股列表）在前端界面被复用为"标签"，A 股筛选面板已支持多 watchlist 过滤。
- **现有 watchlist 结构**：`watchlists` + `watchlist_items` 两张表，`watchlist_items.symbol` 存储 A 股 ts_code。
- **指数成分现状**：项目中仅有 `a_share_symbols.is_hs` 字段（标识沪港深互通），无指数成分股的同步链路。
- **数据来源**：Tushare Pro 已集成，提供 `index_member` 接口返回当前指数成分股列表。

---

## 方案决策

| 维度 | 决策 |
|------|------|
| 标签复用机制 | 复用现有 watchlist，不建独立标签体系 |
| 数据来源 | Tushare `index_member` 实时拉取 |
| 本地缓存 | 不缓存，每次实时请求 |
| 覆盖策略 | 全量覆盖（清空旧成员 → 写入新成员） |
| 操作入口 | Watchlist 管理面板的操作菜单 |
| 确认方式 | 简要确认弹窗（展示当前成员数，确认后执行） |

---

## 功能范围

### 本次实现（In Scope）

1. 后端新增 `POST /watchlists/:id/import-from-index` 接口
2. 前端 Watchlist 管理面板新增"从指数导入成员"操作项
3. 预置 5 个常用 A 股指数（沪深300、上证50、中证500、中证1000、上证180）
4. 确认对话框展示当前 watchlist 成员数及覆盖警示

### 不在范围（Out of Scope）

- 指数成分本地缓存或定时自动更新
- 差量预览（新增/移除成员列表）
- 自定义输入指数代码
- 加密标的指数导入

---

## 后端设计

### 接口

```
POST /watchlists/:id/import-from-index
Authorization: Bearer <token>
Content-Type: application/json

Body:
{
  "indexCode": "399300.SZ"
}

Response 200:
{
  "imported": 300,
  "replaced": 250
}

Response 400:
{
  "message": "未找到该指数成分数据"
}
```

### 预置指数白名单

| 显示名 | Tushare ts_code |
|--------|----------------|
| 沪深300 | 399300.SZ |
| 上证50 | 000016.SH |
| 中证500 | 000905.SH |
| 中证1000 | 000852.SH |
| 上证180 | 000010.SH |

后端维护此白名单，未在名单内的 `indexCode` 一律返回 400（防止任意 Tushare 接口调用）。

### WatchlistsService.importFromIndex 逻辑

```
1. 校验 indexCode 在白名单内
2. 校验 watchlist 存在且属于当前用户
3. 调用 Tushare HTTP 接口 index_member（ts_code=indexCode, fields=con_code）
4. 若返回为空 → 抛出 400「未找到该指数成分数据」
5. 事务内：
   a. DELETE FROM watchlist_items WHERE watchlist_id = :id
   b. 批量 INSERT watchlist_items（watchlist_id, symbol=con_code, display_order=0）
6. 返回 { imported: 新成员数, replaced: 旧成员数 }
```

### Tushare index_member 接口说明

- 接口名：`index_member`
- 主要参数：`index_code`（指数代码）
- 返回字段：`con_code`（成分股 ts_code）、`con_name` 等
- 分页：一次性返回全部成分（通常 ≤ 1000 支）

---

## 前端设计

### 操作入口

在 A 股页面 Watchlist 管理面板（或现有 watchlist 操作下拉菜单）中，每个 watchlist 条目增加菜单项：

- 图标：`i-mdi-arrow-down-circle-outline`
- 文案：**从指数导入成员**

### 确认对话框（AppModal）

**标题**：从指数导入成员

**内容**：
- 指数选择下拉（`n-select`，预置5个指数，必填）
- 提示文案（动态）：

  > 将从 Tushare 拉取 **{指数名称}** 最新成分股，并**覆盖** `{watchlist.name}` 现有的 **{currentMemberCount} 条成员**。此操作不可撤销。

**底部按钮**（放在 `#actions` slot）：
- 取消（secondary）
- 确认导入（primary，danger 样式，loading 状态）

### 交互状态

| 状态 | 表现 |
|------|------|
| 加载中 | 确认按钮显示 loading，禁止重复点击 |
| 成功 | 关闭弹窗，toast「已导入 {N} 支 {指数名} 成分股」，刷新 watchlist 列表 |
| Tushare 失败 | toast error「获取指数成分失败，请稍后重试」，watchlist 不变 |
| 指数代码无效 | toast error「未找到该指数成分数据」|

### API 调用封装（`api/modules/watchlists.ts`）

```typescript
importFromIndex(watchlistId: string, indexCode: string): Promise<{ imported: number; replaced: number }>
```

---

## 数据库变更

**无 Schema 变更**。数据写入现有 `watchlist_items` 表，字段兼容现有结构。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| indexCode 不在白名单 | 后端 400，前端 toast 错误 |
| Tushare 返回空成分 | 后端 400，前端 toast 错误 |
| Tushare 网络/限速错误 | 后端捕获，返回 500，前端 toast「获取失败，请稍后重试」；旧数据不动 |
| watchlist 不属于当前用户 | 后端 403 |
| 数据库事务失败 | 事务回滚，返回 500，旧数据不变 |

---

## 文件变更清单

### 后端

| 文件 | 变更类型 |
|------|----------|
| `apps/server/src/catalog/watchlists/watchlists.controller.ts` | 新增路由 `POST /:id/import-from-index` |
| `apps/server/src/catalog/watchlists/watchlists.service.ts` | 新增方法 `importFromIndex` |
| `apps/server/src/catalog/watchlists/dto/import-from-index.dto.ts` | 新建，含 `indexCode` 验证 |
| `apps/server/src/catalog/watchlists/watchlists.constants.ts`（新建或内嵌） | 指数白名单常量 |

### 前端

| 文件 | 变更类型 |
|------|----------|
| `apps/web/src/api/modules/watchlists.ts` | 新增 `importFromIndex` 方法 |
| `apps/web/src/components/watchlist/ImportFromIndexModal.vue`（新建） | 指数导入对话框组件 |
| 调用 `ImportFromIndexModal` 的 Watchlist 管理组件 | 新增菜单项及弹窗调用 |

> 调用入口组件路径待确认（取决于现有 watchlist 管理 UI 位置）。

---

## 验收标准

1. 在 Watchlist 管理面板选择"从指数导入成员"，弹出含指数选择的确认对话框
2. 选择沪深300并确认后，该 watchlist 成员被替换为当前沪深300全部成分股（约300支）
3. 替换成功后，toast 显示导入数量，A 股筛选面板用该 watchlist 筛选可正常工作
4. Tushare 调用失败时，watchlist 原始数据不变，前端展示错误提示
5. 确认过程中重复点击"确认"按钮无效（防重复提交）
