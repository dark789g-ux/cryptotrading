# Remove Backend Column Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底消灭"前后端双列注册表"架构，让后端变为纯透明存储，前端 `normalizeScopePreferences` 成为列偏好归一化的唯一事实来源，使今后新增列时不再需要同步修改后端。

**Architecture:** 后端 `saveSymbolsView` 只做轻量 JSON 结构校验（必须是 `{ key: string, visible: boolean }[]`），原样存入数据库；`getSymbolsView` 原样返回存储数据，新用户无记录时返回空数组。前端 `normalizeScopePreferences` 已具备完整的归一化能力（追加缺失列、剔除已删除列、强制 locked 列可见），无需任何修改。

**Tech Stack:** NestJS 10, TypeScript, Jest（后端单测）

---

## 背景与动机

### 现状（有害）

```
保存路径：前端偏好 → PUT /preferences/symbols-view → 后端 normalizeScopeColumns(input, REGISTRY)
                                                              ↑
                                                  只保留 REGISTRY 中存在的 key
                                                  ──────────────────────────────
                                                  tags、buySignal 不在 REGISTRY
                                                  → 被静默丢弃 → 顺序损坏
```

### 目标（安全）

```
保存路径：前端偏好 → PUT /preferences/symbols-view → 后端只校验结构合法性 → 原样入库
读取路径：GET /preferences/symbols-view → 原样返回 → 前端 normalizeScopePreferences(defs, raw)
                                                              ↑
                                              追加缺失列、剔除已删除列、强制 locked 可见
                                              ──────────────────────────────────────────
                                              前端 defs 是唯一事实来源，永不脱节
```

### 为何后端注册表不必要

| 后端注册表当前职责 | 实际情况 |
|---|---|
| 过滤未知列 key（防注入） | key 来自前端代码，非用户自由输入；无安全价值 |
| 强制 locked 列 visible=true | 前端 `normalizeScopePreferences` 已做同样处理（`def.locked ? true : ...`） |
| 追加缺失列到末尾 | 前端 `normalizeScopePreferences` 已做同样处理 |

三项职责前端均已覆盖，后端注册表是纯粹的维护负担。

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `apps/server/src/preferences/preferences.service.ts` | **大幅修改** | 删除 `SYMBOLS_VIEW_COLUMN_REGISTRY`、`normalizeScopeColumns`、`normalizeSymbolsView`；简化 save/get |
| `apps/server/src/preferences/preferences.service.spec.ts` | **重写测试** | 更新为匹配新行为的测试 |
| `apps/web/src/composables/symbols/useSymbolColumnPreferences.ts` | **不变** | 前端逻辑已完整，无需修改 |
| `apps/web/src/components/symbols/a-shares/aSharesColumns.ts` | **不变** | 前端列定义已完整，无需修改 |

---

## Task 1：简化后端 PreferencesService

**Files:**
- Modify: `apps/server/src/preferences/preferences.service.ts`

### 目标行为

- `getSymbolsView`：返回原始存储数据；新用户无记录时返回 `{ crypto: [], aShares: [] }`
- `saveSymbolsView`：对每个 scope 做轻量结构校验（过滤非法项），原样存入；不再重排列顺序、不再丢弃未知 key

### 轻量校验规则

一个合法的 `ColumnPreferenceItem` 必须满足：
- 是对象（非 null）
- `key` 是非空字符串
- `visible` 是布尔值

不满足的项直接丢弃（防止脏数据入库）。**不再检查 key 是否在已知列表中。**

- [ ] **Step 1：将 `preferences.service.ts` 替换为以下内容**

```typescript
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { newId } from '../auth/auth.utils';
import { UserPreferenceEntity } from '../entities/user-preference.entity';

export interface ColumnPreferenceItem {
  key: string;
  visible: boolean;
}

export interface SymbolsViewColumnPreferences {
  crypto: ColumnPreferenceItem[];
  aShares: ColumnPreferenceItem[];
}

export const SYMBOLS_VIEW_PREFERENCES_KEY = 'symbols_view_columns';

/** 只校验基本结构合法性，不校验 key 是否在已知列表中。 */
function sanitizeScopeColumns(input: unknown): ColumnPreferenceItem[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (item): item is ColumnPreferenceItem =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).key === 'string' &&
      (item as Record<string, unknown>).key !== '' &&
      typeof (item as Record<string, unknown>).visible === 'boolean',
  );
}

function sanitizeSymbolsView(value: unknown): SymbolsViewColumnPreferences {
  const input =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    crypto: sanitizeScopeColumns(input.crypto),
    aShares: sanitizeScopeColumns(input.aShares),
  };
}

const EMPTY_SYMBOLS_VIEW_PREFERENCES: SymbolsViewColumnPreferences = {
  crypto: [],
  aShares: [],
};

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(UserPreferenceEntity)
    private readonly repo: Repository<UserPreferenceEntity>,
  ) {}

  async getSymbolsView(userId: string): Promise<SymbolsViewColumnPreferences> {
    const row = await this.repo.findOneBy({ userId, key: SYMBOLS_VIEW_PREFERENCES_KEY });
    if (!row) return EMPTY_SYMBOLS_VIEW_PREFERENCES;
    return sanitizeSymbolsView(row.value);
  }

  async saveSymbolsView(userId: string, value: unknown): Promise<{ ok: true }> {
    const sanitized = sanitizeSymbolsView(value);
    const existing = await this.repo.findOneBy({ userId, key: SYMBOLS_VIEW_PREFERENCES_KEY });
    if (existing) {
      existing.value = sanitized;
      await this.repo.save(existing);
      return { ok: true };
    }

    await this.repo.save(
      this.repo.create({
        id: newId(),
        userId,
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: sanitized,
      }),
    );

    return { ok: true };
  }
}
```

- [ ] **Step 2：确认 `normalizeSymbolsView` 的唯一导出消费方**

检查项目中是否有其他文件 import 了 `normalizeSymbolsView` 或 `DEFAULT_SYMBOLS_VIEW_COLUMNS`：

```powershell
cd c:\codes\cryptotrading
rg "normalizeSymbolsView|DEFAULT_SYMBOLS_VIEW_COLUMNS|SYMBOLS_VIEW_COLUMN_REGISTRY" --type ts
```

预期输出：只有 `preferences.service.ts` 和 `preferences.service.spec.ts`（spec 文件在下一个 Task 更新）。若有其他引用，需一并处理。

---

## Task 2：更新后端单测

**Files:**
- Modify: `apps/server/src/preferences/preferences.service.spec.ts`

新测试的核心行为验证：
1. 新用户返回空 arrays（不是硬编码默认列）
2. 保存时 **完整保留** 包含未知 key 的列顺序
3. 保存时 malformed items（缺 key / 缺 visible）被过滤
4. 读取时原样返回存储内容

- [ ] **Step 1：将 spec 文件替换为以下内容**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreferenceEntity } from '../entities/user-preference.entity';
import {
  PreferencesService,
  SYMBOLS_VIEW_PREFERENCES_KEY,
} from './preferences.service';

describe('PreferencesService', () => {
  let service: PreferencesService;
  let repo: jest.Mocked<Repository<UserPreferenceEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferencesService,
        {
          provide: getRepositoryToken(UserPreferenceEntity),
          useValue: {
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(PreferencesService);
    repo = module.get(getRepositoryToken(UserPreferenceEntity));
  });

  describe('getSymbolsView', () => {
    it('returns empty arrays when no preference exists', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual({
        crypto: [],
        aShares: [],
      });
    });

    it('returns stored data as-is', async () => {
      const stored = {
        crypto: [{ key: 'close', visible: false }],
        aShares: [
          { key: 'name', visible: true },
          { key: 'buySignal', visible: true },   // 前端动态列，后端不应过滤
          { key: 'actions', visible: true },
        ],
      };
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: stored,
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual(stored);
    });
  });

  describe('saveSymbolsView', () => {
    it('preserves unknown column keys and their order', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      // 包含前端动态列（tags、buySignal），顺序由用户自定义
      const input = {
        crypto: [],
        aShares: [
          { key: 'tsCode', visible: true },
          { key: 'name', visible: true },
          { key: 'tags', visible: true },
          { key: 'buySignal', visible: false },
          { key: 'actions', visible: true },   // 用户把 actions 移到最后
        ],
      };

      await service.saveSymbolsView('user-1', input);

      // 应原样存入，顺序不变，所有 key 均保留
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: input,
        }),
      );
    });

    it('filters out malformed items (missing key or visible)', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveSymbolsView('user-1', {
        crypto: [],
        aShares: [
          { key: 'name', visible: true },          // 合法
          { key: '', visible: true },               // key 为空 → 过滤
          { visible: true },                        // 缺 key → 过滤
          { key: 'actions' },                       // 缺 visible → 过滤
          null,                                     // null → 过滤
          { key: 'tsCode', visible: false },        // 合法
        ],
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: {
            crypto: [],
            aShares: [
              { key: 'name', visible: true },
              { key: 'tsCode', visible: false },
            ],
          },
        }),
      );
    });

    it('updates existing preference record', async () => {
      const existing = {
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: { crypto: [], aShares: [] },
      } as UserPreferenceEntity;
      repo.findOneBy.mockResolvedValueOnce(existing);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const newValue = {
        crypto: [{ key: 'close', visible: false }],
        aShares: [{ key: 'tsCode', visible: true }],
      };

      await service.saveSymbolsView('user-1', newValue);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: newValue }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2：运行测试，确认全部通过**

```powershell
cd c:\codes\cryptotrading\apps\server
npx jest preferences.service.spec --no-coverage
```

预期输出：
```
Tests: 5 passed, 5 total
```

- [ ] **Step 3：提交**

```bash
git add apps/server/src/preferences/preferences.service.ts
git add apps/server/src/preferences/preferences.service.spec.ts
git commit -m "refactor(preferences): remove backend column registry, make save/get transparent

Backend no longer maintains a column key allowlist. saveSymbolsView now stores
the full preference array as-is (only filtering structurally invalid items).
getSymbolsView returns raw stored data or empty arrays for new users.

Frontend normalizeScopePreferences is the single source of truth for column
normalization: appending missing columns, dropping removed columns, and
enforcing locked column visibility. This eliminates the dual-registry bug where
adding new frontend columns (e.g. tags, buySignal) would be silently discarded
during save, corrupting the user's saved column order."
```

---

## Task 3：回归验证（手动）

- [ ] **Step 1：启动开发服务器，打开 A 股数据界面**

```powershell
# 后端
cd c:\codes\cryptotrading\apps\server ; npm run start:dev

# 前端（另一个终端）
cd c:\codes\cryptotrading\apps\web ; npm run dev
```

- [ ] **Step 2：在列设置抽屉中将"操作"移到最后，点击保存**

观察：保存成功提示出现。

- [ ] **Step 3：刷新页面，重新打开列设置抽屉**

观察：**"操作"仍然在最后一列**，`tags` 和 `buySignal` 的位置也与保存时一致。

- [ ] **Step 4：查数据库，确认存储内容包含所有列且顺序正确**

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT value FROM user_preferences WHERE key = 'symbols_view_columns' LIMIT 1;"
```

观察：`aShares` 数组末尾是 `{"key":"actions","visible":true}`，`tags` 和 `buySignal` 均存在于数组中。

---

## 自检

### Spec 覆盖

| 需求 | 覆盖任务 |
|---|---|
| 后端不再丢弃未知列 key | Task 1（删除注册表，改用 `sanitizeScopeColumns`） |
| 保存顺序完整保留 | Task 1（原样存入）+ Task 2（"preserves unknown column keys"测试） |
| malformed 数据仍被过滤（基本防御） | Task 1（key/visible 结构校验）+ Task 2（"filters malformed"测试） |
| 新用户空偏好正常工作 | Task 2（"returns empty arrays"测试）；前端已有 fallback |
| 不引入前端改动 | 前端 `normalizeScopePreferences` 无需变动，已覆盖所有归一化逻辑 |

### 与当前 hotfix 的关系

当前 hotfix（在后端注册表中补充 `tags`、`buySignal`）已修复眼前的 bug，可先上线。本计划是结构性优化，独立实施，完成后可同时撤销 hotfix 中新增的两行（因为注册表将被整体删除）。
