/**
 * strategy-conditions.service.spec.ts
 *
 * 单测：create/update 保存前的 validateConditions 兜底校验——
 * 自定义 KDJ（参数≠9/3/3）在「比较指标」（compareMode='field'）模式下，
 * 比较对象 compareField 必须也是 KDJ 字段，否则抛 BadRequestException 且不落库。
 * 使用 mock Repository / DataSource / Runner，不连真 DB。
 */
import { BadRequestException } from '@nestjs/common';
import { StrategyConditionsService } from './strategy-conditions.service';
import { CreateStrategyConditionDto, StrategyConditionItemDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';

const USER_ID = 'user-1';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

function makeRepo(findOneEntity?: Record<string, unknown>) {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => ({ id: 'new-id', ...(e as object) })),
    findOne: jest.fn(async () => findOneEntity ?? null),
    find: jest.fn(async () => []),
    update: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    createQueryBuilder: jest.fn(),
  };
}

function makeRunner() {
  return { executeRun: jest.fn(async () => undefined) };
}

function makeQueue() {
  return { acquire: jest.fn(async () => true) };
}

function makeService(opts: { updateTargetEntity?: Record<string, unknown> } = {}) {
  const repo = makeRepo(opts.updateTargetEntity);
  const runRepo = makeRepo();
  const hitRepo = makeRepo();
  const dataSource = { query: jest.fn(async () => []) };
  const runner = makeRunner();
  const queue = makeQueue();
  const svc = new StrategyConditionsService(
    repo as any,
    runRepo as any,
    hitRepo as any,
    dataSource as any,
    runner as any,
    queue as any,
  );
  return { svc, repo, runRepo, hitRepo, dataSource, runner, queue };
}

const CUSTOM_KDJ = { n: 6, m1: 2, m2: 2 };

function createDto(conditions: StrategyConditionItemDto[]): CreateStrategyConditionDto {
  return { name: '方案A', targetType: 'a-share', conditions };
}

// ── create 校验 ────────────────────────────────────────────────────────────

describe('StrategyConditionsService - create validateConditions', () => {
  it('自定义 KDJ + compareMode=field + compareField 非 KDJ → 400 且不 save', async () => {
    const { svc, repo } = makeService();
    const dto = createDto([
      {
        field: 'kdj_j',
        operator: 'gt',
        compareMode: 'field',
        compareField: 'close_ma60_ratio',
        kdjParams: CUSTOM_KDJ,
      },
    ]);
    await expect(svc.create(USER_ID, dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('自定义 KDJ + compareMode=field + compareField 为 KDJ（kdj_d）→ 通过并 save', async () => {
    const { svc, repo } = makeService();
    const dto = createDto([
      {
        field: 'kdj_j',
        operator: 'gt',
        compareMode: 'field',
        compareField: 'kdj_d',
        kdjParams: CUSTOM_KDJ,
      },
    ]);
    await expect(svc.create(USER_ID, dto)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });

  it('自定义 KDJ + compareMode=value（用 value 比较）→ 通过', async () => {
    const { svc, repo } = makeService();
    const dto = createDto([
      {
        field: 'kdj_j',
        operator: 'lt',
        compareMode: 'value',
        value: 0,
        kdjParams: CUSTOM_KDJ,
      },
    ]);
    await expect(svc.create(USER_ID, dto)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });

  it('默认参数（无 kdjParams）+ compareField 非 KDJ → 通过（不受限制）', async () => {
    const { svc, repo } = makeService();
    const dto = createDto([
      {
        field: 'kdj_j',
        operator: 'gt',
        compareMode: 'field',
        compareField: 'close_ma60_ratio',
      },
    ]);
    await expect(svc.create(USER_ID, dto)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });

  it('默认参数 9/3/3（显式 kdjParams 等于默认）+ compareField 非 KDJ → 通过', async () => {
    const { svc, repo } = makeService();
    const dto = createDto([
      {
        field: 'kdj_j',
        operator: 'gt',
        compareMode: 'field',
        compareField: 'close_ma60_ratio',
        kdjParams: { n: 9, m1: 3, m2: 3 },
      },
    ]);
    await expect(svc.create(USER_ID, dto)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });
});

// ── update 校验 ────────────────────────────────────────────────────────────

describe('StrategyConditionsService - update validateConditions', () => {
  it('update 一条 invalid（自定义 KDJ + field 模式 + 非 KDJ 比较对象）→ 400 且不 save', async () => {
    const { svc, repo } = makeService({
      updateTargetEntity: { id: 'c1', userId: USER_ID, name: '旧', conditions: [] },
    });
    const dto: UpdateStrategyConditionDto = {
      conditions: [
        {
          field: 'kdj_j',
          operator: 'gt',
          compareMode: 'field',
          compareField: 'close_ma60_ratio',
          kdjParams: CUSTOM_KDJ,
        },
      ],
    };
    await expect(svc.update('c1', USER_ID, dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('update 不带 conditions（部分更新）→ 不校验，通过并 save', async () => {
    const { svc, repo } = makeService({
      updateTargetEntity: { id: 'c1', userId: USER_ID, name: '旧', conditions: [] },
    });
    const dto: UpdateStrategyConditionDto = { name: '改名' };
    await expect(svc.update('c1', USER_ID, dto)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });

  it('update 合法 conditions（自定义 KDJ + KDJ 比较对象）→ 通过并 save', async () => {
    const { svc, repo } = makeService({
      updateTargetEntity: { id: 'c1', userId: USER_ID, name: '旧', conditions: [] },
    });
    const dto: UpdateStrategyConditionDto = {
      conditions: [
        {
          field: 'kdj_j',
          operator: 'gt',
          compareMode: 'field',
          compareField: 'kdj_k',
          kdjParams: CUSTOM_KDJ,
        },
      ],
    };
    await expect(svc.update('c1', USER_ID, dto)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });
});
