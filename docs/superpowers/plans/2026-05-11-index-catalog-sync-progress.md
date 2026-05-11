# 行业/概念目录同步进度展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `SyncView.vue` 中「行业/概念目录与成分股」卡片在同步期间实时展示进度（按 ts_code 粒度推进），并把进度展示对齐 `MoneyFlowSyncProgress.vue`。

**Architecture:** 后端 `IndexCatalogSyncService.syncMembers` 接受可选 `{ subject, phase, percentFrom, percentTo }` 参数，在循环内每完成一个 `ts_code` 发一次 progress 事件，percent 在区间内线性映射；前端新建 `IndexCatalogSyncProgress.vue`（与 `MoneyFlowSyncProgress.vue` 同构），替换 Card 4 内 inline 的进度/summary 块。

**Tech Stack:** NestJS 10 + RxJS Subject（后端）；Vue 3 + Naive UI + TypeScript（前端）；Jest（后端测试）。

**File map:**
- Modify `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts` — `syncMembers` 增加 progress 推送参数；`startSync` 调用点传入区间
- Modify `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts` — 新增 progress 粒度测试用例
- Create `apps/web/src/components/sync/IndexCatalogSyncProgress.vue` — 复用 mfsp 结构的展示组件
- Modify `apps/web/src/views/sync/SyncView.vue` — Card 4 替换 inline 进度块为新组件

---

## Task 1：后端 `syncMembers` 支持 per-ts_code progress 推送

**Files:**
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`
- Test: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`

- [ ] **Step 1：在 spec 中新增失败测试 —— 验证 `syncMembers` 在每个 ts_code 后发一次 progress 事件，percent 在区间内单调线性**

在 `describe('syncMembers', ...)` 块内追加以下用例（紧接 `目录中无指定 type 的 ts_code 时记 warn 并 success=0` 之后）：

```ts
it('传入 progress opts 时每个 ts_code 后发一次 progress 事件且 percent 单调映射', async () => {
  setupCatalogQuery(['A.TI', 'B.TI', 'C.TI', 'D.TI']);
  tushare.query.mockResolvedValue([
    { ts_code: 'X', con_code: '000001.SZ', con_name: 'X', is_new: 'Y' },
  ]);

  const events: MoneyFlowSyncEvent[] = [];
  const subject = new (await import('rxjs')).Subject<MoneyFlowSyncEvent>();
  subject.subscribe((e) => events.push(e));

  await service.syncMembers('I', {
    subject,
    phase: '同步行业成分股',
    percentFrom: 40,
    percentTo: 60,
  });

  const progress = events.filter((e) => e.type === 'progress');
  expect(progress).toHaveLength(4);
  expect(progress.map((e) => (e as { current: number }).current)).toEqual([1, 2, 3, 4]);
  expect(progress.map((e) => (e as { total: number }).total)).toEqual([4, 4, 4, 4]);

  const percents = progress.map((e) => (e as { percent: number }).percent);
  expect(percents[0]).toBeCloseTo(45, 5);
  expect(percents[1]).toBeCloseTo(50, 5);
  expect(percents[2]).toBeCloseTo(55, 5);
  expect(percents[3]).toBeCloseTo(60, 5);
  for (let i = 1; i < percents.length; i++) {
    expect(percents[i]).toBeGreaterThan(percents[i - 1]);
  }

  for (const e of progress) {
    expect((e as { phase: string }).phase).toBe('同步行业成分股');
  }
});

it('不传 opts 时不发 progress 事件（向后兼容）', async () => {
  setupCatalogQuery(['A.TI']);
  tushare.query.mockResolvedValue([
    { ts_code: 'X', con_code: '000001.SZ', con_name: 'X', is_new: 'Y' },
  ]);

  // 仅断言无异常；如果发了事件需要 subject，这里不传也不会触发
  const result = await service.syncMembers('I');
  expect(result.success).toBe(1);
});
```

- [ ] **Step 2：运行失败测试，确认失败**

Run: `pnpm --filter @cryptotrading/server test -- --testPathPattern=index-catalog-sync.service.spec`
Expected: 新增的 `传入 progress opts 时每个 ts_code 后发一次 progress 事件且 percent 单调映射` 失败（当前 `syncMembers` 仅接受 `_ctx?: SyncCtx`，调用方传 opts 会被忽略，progress 数组长度为 0）。

- [ ] **Step 3：修改 `syncMembers` 签名并在循环内发 progress**

打开 `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`，将 `syncMembers` 方法签名替换为：

```ts
async syncMembers(
  type: 'I' | 'N',
  opts?: {
    subject: Subject<MoneyFlowSyncEvent>;
    phase: string;
    percentFrom: number;
    percentTo: number;
  },
): Promise<MoneyFlowSyncResult> {
  const errors: string[] = [];

  const rows = await this.catalogRepo
    .createQueryBuilder('c')
    .select('c.ts_code', 'tsCode')
    .where('c.type = :type', { type })
    .getRawMany<{ tsCode: string }>();
  const tsCodes = rows.map((r) => r.tsCode).filter(Boolean);

  if (!tsCodes.length) {
    this.logger.warn(`syncMembers(type=${type}): ths_index_catalog 中无对应记录，请先同步目录`);
    return { success: 0, skipped: 0, errors };
  }

  let success = 0;
  for (let i = 0; i < tsCodes.length; i++) {
    const tsCode = tsCodes[i];
    try {
      const memberRows = (await this.tushareClient.query(
        'ths_member',
        { ts_code: tsCode },
        MEMBER_FIELDS,
      )) as RawRow[];

      if (!memberRows.length) {
        this.logger.warn(`ths_member(${tsCode}) 返回空数据`);
      } else {
        const entities = memberRows.map((r) => this.memberRepo.create({
          tsCode: asString(r.ts_code),
          conCode: asString(r.con_code),
          conName: asString(r.con_name) || null,
          isNew: asString(r.is_new) || null,
        }));
        const deduped = deduplicateBy(entities, ['tsCode', 'conCode']);

        await this.dataSource.transaction(async (manager) => {
          await manager.delete(ThsMemberStockEntity, { tsCode });
          const chunkSize = 1000;
          for (let j = 0; j < deduped.length; j += chunkSize) {
            await manager.upsert(
              ThsMemberStockEntity,
              deduped.slice(j, j + chunkSize),
              ['tsCode', 'conCode'],
            );
          }
        });
        success += 1;
      }
    } catch (e: unknown) {
      const msg = `ths_member(${tsCode}) 失败: ${e instanceof Error ? e.message : String(e)}`;
      this.logger.error(msg, e instanceof Error ? e.stack : undefined);
      errors.push(`[${tsCode}] ${msg}`);
    }

    if (opts) {
      const done = i + 1;
      const percent =
        opts.percentFrom + (opts.percentTo - opts.percentFrom) * (done / tsCodes.length);
      opts.subject.next({
        type: 'progress',
        phase: opts.phase,
        current: done,
        total: tsCodes.length,
        percent,
        message: `${tsCode}（成功 ${success} / 失败 ${errors.length}）`,
      });
    }
  }

  return { success, skipped: 0, errors };
}
```

> 注意：原实现中"返回空数据 → continue"会跳过 `success += 1`；新实现保留同样语义（空数据不计入 success），但**仍**会发 progress 事件，以保证进度推进可见。

- [ ] **Step 4：运行测试，确认通过**

Run: `pnpm --filter @cryptotrading/server test -- --testPathPattern=index-catalog-sync.service.spec`
Expected: 全部用例通过（含原有 `某个 ts_code 调用失败时记 errors 但继续后续`、`某个 ts_code 返回空数据时记 warn 跳过`，以及两个新增用例）。

- [ ] **Step 5：提交**

```bash
git add apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts
git commit -m "feat(index-catalog): syncMembers 支持 per-ts_code 进度推送"
```

---

## Task 2：`startSync` 调用 `syncMembers` 时传入 progress 区间

**Files:**
- Modify: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts:185-193`
- Test: `apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`

- [ ] **Step 1：在 spec `describe('startSync', ...)` 中新增失败测试 —— 验证 Stage 3/4 在循环内发出 progress 事件**

紧接现有 `正常流程：发出 progress + done，summary 含五个字段` 之后追加：

```ts
it('Stage 3/4 通过 syncMembers 在 [40,60]/[60,80] 区间内逐 ts_code 推 progress', async () => {
  jest.spyOn(service, 'syncCatalog')
    .mockResolvedValueOnce({ success: 2, skipped: 0, errors: [] })
    .mockResolvedValueOnce({ success: 3, skipped: 0, errors: [] });

  jest.spyOn(service, 'syncMembers').mockImplementation(async (
    _type,
    opts?: {
      subject: { next: (e: MoneyFlowSyncEvent) => void };
      phase: string;
      percentFrom: number;
      percentTo: number;
    },
  ) => {
    if (opts) {
      const total = 4;
      for (let i = 1; i <= total; i++) {
        const percent =
          opts.percentFrom + (opts.percentTo - opts.percentFrom) * (i / total);
        opts.subject.next({
          type: 'progress',
          phase: opts.phase,
          current: i,
          total,
          percent,
          message: `mock-${i}`,
        });
      }
    }
    return { success: 4, skipped: 0, errors: [] };
  });
  jest.spyOn(service, 'cleanupOrphans')
    .mockResolvedValue({ success: 0, skipped: 0, errors: [] });

  const events = await collect(service.startSync());

  const stage3 = events.filter(
    (e) => e.type === 'progress' && (e as { phase: string }).phase === '同步行业成分股',
  );
  const stage4 = events.filter(
    (e) => e.type === 'progress' && (e as { phase: string }).phase === '同步概念成分股',
  );

  // 至少含 4 条来自 syncMembers 内部循环的事件（不计 startSync 自身发的"开始"占位）
  expect(stage3.length).toBeGreaterThanOrEqual(4);
  expect(stage4.length).toBeGreaterThanOrEqual(4);

  for (const e of stage3) {
    const p = (e as { percent: number }).percent;
    expect(p).toBeGreaterThanOrEqual(40);
    expect(p).toBeLessThanOrEqual(60);
  }
  for (const e of stage4) {
    const p = (e as { percent: number }).percent;
    expect(p).toBeGreaterThanOrEqual(60);
    expect(p).toBeLessThanOrEqual(80);
  }

  // syncMembers 被调用时收到了 opts
  const memberCalls = (service.syncMembers as jest.Mock).mock.calls;
  expect(memberCalls[0][1]).toMatchObject({ phase: '同步行业成分股', percentFrom: 40, percentTo: 60 });
  expect(memberCalls[1][1]).toMatchObject({ phase: '同步概念成分股', percentFrom: 60, percentTo: 80 });
});
```

- [ ] **Step 2：运行失败测试**

Run: `pnpm --filter @cryptotrading/server test -- --testPathPattern=index-catalog-sync.service.spec -t "Stage 3/4"`
Expected: 失败 —— `memberCalls[0][1]` 当前为 `undefined`（startSync 未传 opts）。

- [ ] **Step 3：修改 `startSync` 的 Stage 3/4 调用**

定位 `apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts` 中 `startSync` 内 Stage 3/4 区块，替换为：

```ts
// Stage 3: 行业成分股
subject.next({ type: 'progress', phase: '同步行业成分股', current: 0, total: 1, percent: 40, message: '开始' });
summary.industryMembers = await this.syncMembers('I', {
  subject,
  phase: '同步行业成分股',
  percentFrom: 40,
  percentTo: 60,
});

// Stage 4: 概念成分股
subject.next({ type: 'progress', phase: '同步概念成分股', current: 0, total: 1, percent: 60, message: '开始' });
summary.conceptMembers = await this.syncMembers('N', {
  subject,
  phase: '同步概念成分股',
  percentFrom: 60,
  percentTo: 80,
});
```

> 删除原有 `current: 1, total: 1, percent: 60/80, message: '成功 ...'` 的收尾事件 —— 循环最后一轮已把 percent 推到 60/80。Stage 5 起始事件仍由原代码 `subject.next({ phase: '清理孤儿成分股', percent: 80, ... })` 接管。

- [ ] **Step 4：运行测试**

Run: `pnpm --filter @cryptotrading/server test -- --testPathPattern=index-catalog-sync.service.spec`
Expected: 所有用例通过。

- [ ] **Step 5：提交**

```bash
git add apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts
git commit -m "feat(index-catalog): startSync 将 [40,60]/[60,80] 区间下发到 syncMembers"
```

---

## Task 3：新建前端展示组件 `IndexCatalogSyncProgress.vue`

**Files:**
- Create: `apps/web/src/components/sync/IndexCatalogSyncProgress.vue`

- [ ] **Step 1：创建文件，写入完整实现（与 `MoneyFlowSyncProgress.vue` 同构，summaryRows 改为 5 项）**

```vue
<template>
  <div v-if="visible" class="icsp-panel">
    <div class="icsp-head">
      <span>{{ headLabel }}</span>
      <span>{{ Math.round(sse.percent.value) }}%</span>
    </div>
    <n-progress
      type="line"
      :percentage="Math.round(sse.percent.value)"
      :status="progressStatus"
      indicator-placement="inside"
    />
    <div class="icsp-meta">
      <span>{{ countLabel }}</span>
      <span>{{ sse.message.value }}</span>
    </div>

    <div v-if="finished" class="icsp-summary">
      <div class="icsp-summary-row">
        <span v-for="item in summaryRows" :key="item.label" class="icsp-summary-item">
          {{ item.label }}：写入 {{ item.success }} / 失败 {{ item.failed }}
        </span>
      </div>
      <n-collapse v-if="finished.errors.length" class="icsp-errors">
        <n-collapse-item :title="`失败明细（${finished.errors.length} 条）`" name="errors">
          <ul class="icsp-error-list">
            <li v-for="(e, idx) in finished.errors.slice(0, 10)" :key="idx">
              [{{ e.phase }}] {{ e.error }}
            </li>
            <li v-if="finished.errors.length > 10" class="icsp-error-more">
              还有 {{ finished.errors.length - 10 }} 条…
            </li>
          </ul>
        </n-collapse-item>
      </n-collapse>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem, NProgress } from 'naive-ui'
import type { IndexCatalogSyncSummary } from '@cryptotrading/shared-types'
import type { useSSE } from '@/composables/hooks/useSSE'

const props = defineProps<{
  visible: boolean
  sse: ReturnType<typeof useSSE>
  finished: { summary: IndexCatalogSyncSummary; errors: Array<{ phase: string; error: string }> } | null
}>()

const headLabel = computed(() => {
  if (props.finished) return '同步完成'
  return props.sse.phase.value || '准备中'
})

const progressStatus = computed(() => {
  if (props.sse.status.value === 'error') return 'error'
  if (props.finished) return 'success'
  return 'default'
})

const countLabel = computed(() => {
  const c = props.sse.current.value
  const t = props.sse.total.value
  if (!t) return ''
  return `${c} / ${t}`
})

const summaryRows = computed(() => {
  if (!props.finished) return []
  const labels: Array<[keyof IndexCatalogSyncSummary, string]> = [
    ['industryCatalog', '行业目录'],
    ['conceptCatalog', '概念目录'],
    ['industryMembers', '行业成员'],
    ['conceptMembers', '概念成员'],
    ['cleanup', '清理'],
  ]
  return labels.map(([key, label]) => {
    const r = props.finished!.summary[key]
    return {
      label,
      success: r?.success ?? 0,
      failed: r?.errors.length ?? 0,
    }
  })
})
</script>

<style scoped>
.icsp-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
.icsp-head, .icsp-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-text-secondary); font-size: 12px; }
.icsp-head { color: var(--color-text); font-weight: 700; }
.icsp-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icsp-summary { margin-top: 4px; padding-top: 10px; border-top: 1px dashed var(--color-border); display: flex; flex-direction: column; gap: 8px; }
.icsp-summary-row { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--color-text); }
.icsp-summary-item { padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--color-primary) 8%, var(--color-surface)); }
.icsp-errors { margin-top: 4px; }
.icsp-error-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--color-text-secondary); line-height: 1.6; }
.icsp-error-more { color: var(--color-text-tertiary); font-style: italic; list-style: none; padding-left: 0; }
</style>
```

- [ ] **Step 2：运行 vue-tsc 验证类型**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 通过。若提示 `IndexCatalogSyncSummary` 未从 `@cryptotrading/shared-types` 导出，先在 `packages/shared-types` 中确认导出 —— 当前 `useIndexCatalogSync.ts` 已经从该包 import `IndexCatalogSyncSummary`，应已存在；如不存在则在该包补 `export type { IndexCatalogSyncSummary }`。

- [ ] **Step 3：提交**

```bash
git add apps/web/src/components/sync/IndexCatalogSyncProgress.vue
git commit -m "feat(web/index-catalog): 新增 IndexCatalogSyncProgress 展示组件"
```

---

## Task 4：`SyncView.vue` Card 4 替换 inline 进度块为新组件

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.vue:152-182,328-340`

- [ ] **Step 1：替换 Card 4 模板内 inline 进度/summary 块**

打开 `apps/web/src/views/sync/SyncView.vue`，将第 152-182 行（`<div class="data-source-body">` 块内的"进度区 / summary 区 / 准备中提示"三段）整体替换为：

```vue
              <div class="data-source-body">
                <IndexCatalogSyncProgress
                  :visible="indexCatalogProgressVisible"
                  :sse="indexCatalogSse"
                  :finished="indexCatalogFinished"
                />

                <div v-if="!indexCatalogProgressVisible && !indexCatalogFinished" class="source-note">
                  点击按钮开始同步行业/概念目录及成分股数据。
                </div>
              </div>
```

- [ ] **Step 2：在 `<script setup>` 中新增 import**

在 `import { useIndexCatalogSync } ...` 行**之前**追加：

```ts
import IndexCatalogSyncProgress from '../../components/sync/IndexCatalogSyncProgress.vue'
```

- [ ] **Step 3：移除模板内不再使用的 `n-progress` 直接引用（如有）**

检查 `import { ... } from 'naive-ui'` 行：`NProgress` 仍被加密货币卡片 `<template #extra>` 内的 `<n-progress>` 使用，**保留**，不要删除。仅确认无其他孤立引用。

- [ ] **Step 4：运行 vue-tsc + 构建验证**

Run: `pnpm --filter @cryptotrading/web typecheck`
Expected: 通过。

- [ ] **Step 5：本地启动 web 跑一次行业/概念目录同步，肉眼验证**

Run: `pnpm --filter @cryptotrading/web dev`，浏览器打开数据同步页，点击 Card 4「开始同步」。

Expected:
- 进度条不再卡在 40% / 60%，而是在 Stage 3/4 期间平滑推进
- 进度条上方左侧依次显示 phase（`同步行业目录` → `同步概念目录` → `同步行业成分股` → `同步概念成分股` → `清理孤儿成分股`），右侧显示百分比
- 进度条下方显示 `current / total`（如 `38 / 105`）和 message（如 `885566.TI（成功 38 / 失败 0）`）
- 完成后显示 5 项 summary chip（行业目录/概念目录/行业成员/概念成员/清理）
- 如有失败项，"失败明细"折叠面板可展开

若 UI 无法本地验证，在 PR 描述中明示「未做浏览器实测，仅通过类型/单测验证」。

- [ ] **Step 6：提交**

```bash
git add apps/web/src/views/sync/SyncView.vue
git commit -m "feat(web/sync): Card 4 改用 IndexCatalogSyncProgress 展示进度"
```

---

## 自审

1. **Spec 覆盖**
   - 后端 `syncMembers` 增加可选 progress 推送参数 → Task 1
   - `startSync` 调用 Stage 3/4 传入 `[40,60]/[60,80]` 区间 → Task 2
   - Stage 1/2/5 保持现状 → Task 2 仅改 Stage 3/4
   - 新建 `IndexCatalogSyncProgress.vue`（head/progress/meta/summary/errors collapse） → Task 3
   - `SyncView.vue` Card 4 替换 inline 块、保留「准备中」提示 → Task 4
   - 后端单测覆盖 progress 事件数、percent 单调、区间正确性 → Task 1 / Task 2 用例
   - 前端组件快照测试 → spec 列为可选；本计划用 Task 4 Step 5 的肉眼验证替代（前端项目此前模式即如此），不阻塞合入

2. **占位符扫描**：无 TBD/TODO 残留。所有 code block 完整可粘贴。

3. **类型一致性**：
   - `syncMembers` 第二参数名统一为 `opts`，字段 `subject / phase / percentFrom / percentTo` 在 Task 1 / Task 2 / Task 2 测试中拼写完全一致
   - 前端组件 prop 名 `visible / sse / finished` 在 Task 3 / Task 4 一致
   - `summaryRows` 的 5 个 key 与 `IndexCatalogSyncSummary` 字段对齐：`industryCatalog / conceptCatalog / industryMembers / conceptMembers / cleanup`（见 service.ts 中 `PHASE_LABEL_MAP` / `summary.industryCatalog = ...`）

4. **范围**：单一卡片改动，端到端，无需拆分。
