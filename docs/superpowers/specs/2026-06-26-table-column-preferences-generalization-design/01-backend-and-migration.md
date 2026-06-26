# 01 · 后端通用接口 + 数据迁移

> 上游：[index.md](./index.md) ｜ 下游：[02-frontend.md](./02-frontend.md)

## 1. 现状（后端，file:line 为证）

- 实体：`apps/server/src/entities/config/user-preference.entity.ts` → `user_preferences(id PK varchar, user_id varchar, key varchar, value jsonb, updated_at timestamptz)`，唯一约束 `uq_user_preferences_user_key (user_id, key)`，外键级联删除。
- 服务：`apps/server/src/preferences/preferences.service.ts`
  - `SymbolsViewColumnPreferences`（`:18-24`）写死 5 个 scope；`SYMBOLS_VIEW_PREFERENCES_KEY = 'symbols_view_columns'`（`:26`）。
  - 纯净化函数 `sanitizeScopeView`（`:32-44`，兼容老格式数组→`{table:[...],split:[]}`）、`sanitizeItems`（`:47-57`）。
  - `getSymbolsView` / `saveSymbolsView`（`:86-111`）：按 `(userId, key)` 单行读写，`newId()` 来自 `../auth/shared/auth.utils`。
- 控制器：`apps/server/src/preferences/preferences.controller.ts` → `CurrentUserParam as CurrentUser`（`:2`）、`type CurrentUserPayload = { id: string }`（`:5`）、`@Controller('preferences')`。
- 模块：`preferences.module.ts` 已 `TypeOrmModule.forFeature([UserPreferenceEntity])`，**无需新增注册**。
- 全局前缀 `/api`，`AuthGuard` 经 `APP_GUARD` 全局注册 → controller **禁止**再加 `@UseGuards`（见 `.claude/rules/nestjs.md`）。

## 2. 目标存储模型

```text
现状（单行大 JSON，scope 写死）:
  (u1, 'symbols_view_columns') → {crypto:{table,split}, aShares:{...}, ...×5}

目标（每表一行）:
  (u1, 'columns:aShares')         → {table:[...], split:[...]}
  (u1, 'columns:usStocks')        → {table:[...], split:[...]}
  (u1, 'columns:crypto')          → {table:[...], split:[...]}
  (u1, 'columns:aSharesIndex')    → {table:[...], split:[...]}
  (u1, 'columns:aSharesIndexSw')  → {table:[...], split:[...]}
  (u1, 'columns:watchlist')       → {table:[...], split:[]}   ← 单层，split 空
  (u1, 'columns:backtestMetrics') → {table:[...], split:[]}   ← 单层，split 空
```

- **表结构不变**（jsonb value 内容变化，非 schema 变更）。
- value 统一 `ScopeViewPreferences = { table: ColumnPreferenceItem[]; split: ColumnPreferenceItem[] }`；`ColumnPreferenceItem = { key: string; visible: boolean }`。

## 3. 接口设计

key 约定常量：`const COLUMN_PREFERENCE_KEY_PREFIX = 'columns:'`。

### tableId 白名单

通用接口**必须**有护栏，否则前端可写任意 key 污染表。后端维护合法集合（与前端 tableId 逐字一致）：

```ts
export const COLUMN_PREFERENCE_TABLE_IDS = [
  'aShares', 'usStocks', 'crypto', 'aSharesIndex', 'aSharesIndexSw',
  'watchlist', 'backtestMetrics',
] as const;
export type ColumnPreferenceTableId = (typeof COLUMN_PREFERENCE_TABLE_IDS)[number];
```

> 注：前 5 个 tableId 必须与旧 scope 名**逐字相同**（`aShares`/`usStocks`/`crypto`/`aSharesIndex`/`aSharesIndexSw`），迁移脚本拆出的 `columns:<scope>` 才能与前端对齐。

### Service（`preferences.service.ts`）

新增（保留 `ColumnPreferenceItem` / `ScopeViewPreferences` / `sanitizeScopeView` 复用，删除 `SymbolsViewColumnPreferences` / `sanitizeSymbolsView` / `EMPTY_SYMBOLS_VIEW_PREFERENCES` / `getSymbolsView` / `saveSymbolsView`）：

```ts
const EMPTY_SCOPE_VIEW: ScopeViewPreferences = { table: [], split: [] };

async getTableColumns(userId: string, tableId: ColumnPreferenceTableId): Promise<ScopeViewPreferences> {
  const row = await this.repo.findOneBy({ userId, key: COLUMN_PREFERENCE_KEY_PREFIX + tableId });
  if (!row) return EMPTY_SCOPE_VIEW;
  return sanitizeScopeView(row.value);
}

async saveTableColumns(userId: string, tableId: ColumnPreferenceTableId, value: unknown): Promise<{ ok: true }> {
  const sanitized = sanitizeScopeView(value);
  const key = COLUMN_PREFERENCE_KEY_PREFIX + tableId;
  const existing = await this.repo.findOneBy({ userId, key });
  if (existing) { existing.value = sanitized; await this.repo.save(existing); return { ok: true }; }
  await this.repo.save(this.repo.create({ id: newId(), userId, key, value: sanitized }));
  return { ok: true };
}

function isValidTableId(x: string): x is ColumnPreferenceTableId {
  return (COLUMN_PREFERENCE_TABLE_IDS as readonly string[]).includes(x);
}
```

### Controller（`preferences.controller.ts`）

```ts
@Get('columns/:tableId')
getTableColumns(@CurrentUser() user: CurrentUserPayload, @Param('tableId') tableId: string) {
  if (!isValidTableId(tableId)) throw new BadRequestException(`unknown tableId: ${tableId}`);
  return this.preferencesService.getTableColumns(user.id, tableId);
}

@Put('columns/:tableId')
saveTableColumns(
  @CurrentUser() user: CurrentUserPayload,
  @Param('tableId') tableId: string,
  @Body() body: { table?: unknown; split?: unknown },
) {
  if (!isValidTableId(tableId)) throw new BadRequestException(`unknown tableId: ${tableId}`);
  return this.preferencesService.saveTableColumns(user.id, tableId, body);
}
```

- 删除旧 `@Get('symbols-view')` / `@Put('symbols-view')`。
- 白名单校验放 controller（早失败、400 清晰）；service 的 `tableId` 形参类型已收窄。

## 4. 数据迁移

### 迁移前置核对（data-integrity 硬规则）

迁移脚本假设现存 `symbols_view_columns` 的 value 中每个 scope 是 `{table, split}` **对象**（`saveSymbolsView` 存的是 sanitize 后对象，非扁平数组）。**执行前必须查一条真实样本确认形态**：

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
  "SELECT user_id, jsonb_typeof(value->'aShares') FROM user_preferences WHERE key='symbols_view_columns' LIMIT 5;"
```

若出现 `array`（极老数据），需在迁移 SQL 增加数组分支（直接把数组塞入 `table`，后端 `sanitizeScopeView` 读时兼容）；若全为 `object` 则按下方 SQL 即可。

### 迁移 SQL（`20260626XXXXXX-generalize-column-preferences.sql`）

```sql
-- 把 symbols_view_columns 单行大 JSON 的 5 个 scope 拆成 per-table 行 columns:<scope>
-- 幂等：确定性 id（colmig:<user>:<scope>）+ ON CONFLICT (user_id,key) DO NOTHING
-- 旧行保留不删，作回滚兜底
INSERT INTO user_preferences (id, user_id, key, value, updated_at)
SELECT
  'colmig:' || up.user_id || ':' || s.scope,
  up.user_id,
  'columns:' || s.scope,
  up.value -> s.scope,
  now()
FROM user_preferences up
CROSS JOIN (VALUES ('crypto'),('aShares'),('usStocks'),('aSharesIndex'),('aSharesIndexSw')) AS s(scope)
WHERE up.key = 'symbols_view_columns'
  AND up.value ? s.scope
  AND jsonb_typeof(up.value -> s.scope) = 'object'
ON CONFLICT (user_id, key) DO NOTHING;
```

### 回滚 SQL（`.down.sql`）

```sql
-- 只删迁移脚本插入的行（确定性 id 前缀），用户后续新存的 columns:* 行（id 为 newId）保留
DELETE FROM user_preferences WHERE id LIKE 'colmig:%';
```

### PS1 配套（`.sql` 同名 `.ps1` + `.down.ps1`）

```powershell
$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $PSScriptRoot '20260626XXXXXX-generalize-column-preferences.sql'
Get-Content -Raw -Encoding utf8 $sqlPath | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f -
```

### 迁移验证（跑后即查）

```sql
-- 拆出的行数应 = 有偏好的用户数 × 该用户实际拥有的 scope 数
SELECT key, count(*) FROM user_preferences WHERE key LIKE 'columns:%' GROUP BY key ORDER BY key;
-- 旧行仍在
SELECT count(*) FROM user_preferences WHERE key = 'symbols_view_columns';
```

> 时间戳 `20260626XXXXXX` 在实现时用实际生成的 14 位（参照 `migration/` 既有命名 `YYYYMMDDhhmmss`）。
