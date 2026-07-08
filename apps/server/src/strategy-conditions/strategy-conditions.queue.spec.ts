/**
 * strategy-conditions.queue.spec.ts
 *
 * 单测：RunQueue 进程内信号量限流排队子系统——
 *  - acquire/release 基本计数（同一 userId 3 并发，第 4 排队）
 *  - 不同 userId 独立计数
 *  - drain FIFO 调度（release 后排队的按 createdAt ASC 取出执行）
 *  - onApplicationBootstrap recovery（孤儿 running 标 failed，queued 按并发上限启动）
 *
 * 全部依赖 mock，不连真 DB。
 */
import { RunQueue } from './strategy-conditions.queue';
import type { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import type { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

interface QueueMocks {
  queue: RunQueue;
  runRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  condRepo: {
    findOne: jest.Mock;
  };
  runner: {
    executeRun: jest.Mock;
  };
}

/**
 * 构造一个 RunQueue 实例及其所有 mock 依赖。
 * executeRun 默认返回 resolved promise 且不调用 onDone。
 */
function makeQueue(): QueueMocks {
  const runRepo = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    update: jest.fn(async () => undefined),
  };

  const condRepo = {
    findOne: jest.fn(async () => null),
  };

  const runner = {
    executeRun: jest.fn(async () => undefined),
  };

  const queue = new RunQueue(
    runRepo as any,
    condRepo as any,
    runner as any,
  );

  return { queue, runRepo, condRepo, runner };
}

function makeCondition(partial?: Partial<StrategyConditionEntity>): StrategyConditionEntity {
  return {
    id: 'cond-1',
    userId: 'user-1',
    name: '测试条件',
    targetType: 'a-share',
    conditions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    lastRunId: null,
    ...partial,
  } as StrategyConditionEntity;
}

function makeRun(partial?: Partial<StrategyConditionRunEntity>): StrategyConditionRunEntity {
  return {
    id: 'run-1',
    conditionId: 'cond-1',
    userId: 'user-1',
    status: 'queued',
    progressScanned: 0,
    progressTotal: 0,
    totalHits: 0,
    errorMessage: null,
    createdAt: new Date(),
    completedAt: null,
    ...partial,
  } as StrategyConditionRunEntity;
}

// ── 测试 1：acquire/release 基本计数 ──────────────────────────────────────

describe('RunQueue - acquire/release 基本计数', () => {
  it('同一 userId 前 3 次 acquire 返回 true，第 4 次 false', async () => {
    const { queue, runner } = makeQueue();
    const userId = 'user-1';
    const cond = makeCondition();

    // 默认 executeRun 不调用 onDone，不会自动 release
    const r1 = await queue.acquire(cond, 'run-1', userId);
    const r2 = await queue.acquire(cond, 'run-2', userId);
    const r3 = await queue.acquire(cond, 'run-3', userId);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);

    // 第 4 次 acquire 应返回 false（排队）
    const r4 = await queue.acquire(cond, 'run-4', userId);
    expect(r4).toBe(false);

    // 每次返回 true 时 executeRun 被调用，第 4 次没有
    expect(runner.executeRun).toHaveBeenCalledTimes(3);
  });

  it('release 后再 acquire 返回 true（名额腾出）', async () => {
    const { queue, runner, runRepo } = makeQueue();
    const userId = 'user-1';
    const cond = makeCondition();

    // 默认 executeRun 不调用 onDone
    await queue.acquire(cond, 'run-1', userId);
    await queue.acquire(cond, 'run-2', userId);
    await queue.acquire(cond, 'run-3', userId);

    // release 一个正在运行的 runId，腾出名额
    // drain 会查 queued run，findOne 返回 null，无额外调度
    await queue.release('run-1', userId, 'completed');

    // 再 acquire 一个新的，应返回 true（名额已腾出）
    const r5 = await queue.acquire(cond, 'run-5', userId);
    expect(r5).toBe(true);
  });

  it('acquire 返回 true 时 executeRun 被调用且参数正确', async () => {
    const { queue, runner } = makeQueue();
    const userId = 'user-1';
    const cond = makeCondition({ id: 'cond-abc' });

    const result = await queue.acquire(cond, 'run-x', userId);
    expect(result).toBe(true);
    expect(runner.executeRun).toHaveBeenCalledTimes(1);
    expect(runner.executeRun).toHaveBeenCalledWith(
      cond,
      'run-x',
      userId,
      expect.any(Function), // onDone 回调
    );
  });
});

// ── 测试 2：不同 userId 独立计数 ───────────────────────────────────────────

describe('RunQueue - 不同 userId 独立计数', () => {
  it('user1 占满 3 个，user2 不受影响仍可 acquire', async () => {
    const { queue, runner } = makeQueue();
    const cond = makeCondition();

    // user1 占满 3 个
    const u1r1 = await queue.acquire(cond, 'u1-run-1', 'user-1');
    const u1r2 = await queue.acquire(cond, 'u1-run-2', 'user-1');
    const u1r3 = await queue.acquire(cond, 'u1-run-3', 'user-1');
    expect([u1r1, u1r2, u1r3]).toEqual([true, true, true]);

    // user1 第 4 个应 false
    const u1r4 = await queue.acquire(cond, 'u1-run-4', 'user-1');
    expect(u1r4).toBe(false);

    // user2 不受影响，可以 acquire
    const u2r1 = await queue.acquire(cond, 'u2-run-1', 'user-2');
    expect(u2r1).toBe(true);

    // 总共 4 次 executeRun（user1 的 3 个 + user2 的 1 个）
    expect(runner.executeRun).toHaveBeenCalledTimes(4);
  });
});

// ── 测试 3：drain FIFO 调度 ─────────────────────────────────────────────────

describe('RunQueue - drain FIFO 调度', () => {
  it('release 后 drain 触发，queued run 被调度执行', async () => {
    const { queue, runner, runRepo, condRepo } = makeQueue();
    const userId = 'user-1';
    const cond = makeCondition({ id: 'cond-1' });

    // 默认 executeRun 不调用 onDone
    // user1 acquire 4 次：前 3 立即执行，第 4 排队
    const r1 = await queue.acquire(cond, 'run-1', userId);
    const r2 = await queue.acquire(cond, 'run-2', userId);
    const r3 = await queue.acquire(cond, 'run-3', userId);
    const r4 = await queue.acquire(cond, 'run-4', userId);
    expect([r1, r2, r3, r4]).toEqual([true, true, true, false]);

    // 清空之前的调用记录
    runner.executeRun.mockClear();

    // drain 时 findOne 应返回 queued 的 run（run-4），condRepo 返回对应 condition
    const queuedRun = makeRun({ id: 'run-4', conditionId: 'cond-1', userId, status: 'queued' });
    runRepo.findOne.mockResolvedValue(queuedRun);
    condRepo.findOne.mockResolvedValue(cond);

    // drain 被调度的 executeRun 也不调用 onDone，避免连锁 release
    runner.executeRun.mockResolvedValue(undefined);

    // release run-1 后，drain 触发，应调度 run-4
    await queue.release('run-1', userId, 'completed');

    // drain 应查到 run-4 并调度执行
    expect(runRepo.findOne).toHaveBeenCalledWith({
      where: { userId, status: 'queued' },
      order: { createdAt: 'ASC' },
    });
    expect(condRepo.findOne).toHaveBeenCalledWith({ where: { id: 'cond-1' } });
    expect(runner.executeRun).toHaveBeenCalledWith(
      cond,
      'run-4',
      userId,
      expect.any(Function),
    );
  });

  it('多个 queued run 依次 drain 直到达到并发上限', async () => {
    const { queue, runner, runRepo, condRepo } = makeQueue();
    const userId = 'user-1';
    const cond = makeCondition({ id: 'cond-1' });

    // 默认 executeRun 不调用 onDone
    // acquire 3 个立即执行，2 个排队
    await queue.acquire(cond, 'run-1', userId);
    await queue.acquire(cond, 'run-2', userId);
    await queue.acquire(cond, 'run-3', userId);
    await queue.acquire(cond, 'run-4', userId);
    await queue.acquire(cond, 'run-5', userId);

    // 清空调用记录
    runner.executeRun.mockClear();

    const queuedRun4 = makeRun({ id: 'run-4', conditionId: 'cond-1', userId, status: 'queued' });
    const queuedRun5 = makeRun({ id: 'run-5', conditionId: 'cond-1', userId, status: 'queued' });

    // runRepo.findOne 按顺序返回 run-4、run-5、null
    runRepo.findOne
      .mockResolvedValueOnce(queuedRun4)
      .mockResolvedValueOnce(queuedRun5)
      .mockResolvedValueOnce(null);
    condRepo.findOne.mockResolvedValue(cond);

    // drain 被调度的 executeRun 也不调用 onDone
    runner.executeRun.mockResolvedValue(undefined);

    // release run-1 后，running=2，drain 启动 run-4（running=3），循环 break
    // 只有 1 个位置空出，所以只调度 1 个
    await queue.release('run-1', userId, 'completed');

    expect(runner.executeRun).toHaveBeenCalledWith(cond, 'run-4', userId, expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledTimes(1);
  });
});

// ── 测试 4：onApplicationBootstrap recovery ────────────────────────────────

describe('RunQueue - onApplicationBootstrap recovery', () => {
  it('孤儿 running 全标 failed，queued 按并发上限启动', async () => {
    const { queue, runner, runRepo, condRepo } = makeQueue();

    const cond = makeCondition({ id: 'cond-1' });
    const now = Date.now();

    // 构造 DB 残留状态
    const orphanRunningOld = makeRun({
      id: 'orphan-old',
      conditionId: 'cond-1',
      userId: 'user-1',
      status: 'running',
      createdAt: new Date(now - 31 * 60 * 1000), // 31 分钟前，超时
    });
    const orphanRunningRecent = makeRun({
      id: 'orphan-recent',
      conditionId: 'cond-1',
      userId: 'user-1',
      status: 'running',
      createdAt: new Date(now - 5 * 60 * 1000), // 5 分钟前，未超时但仍是孤儿
    });
    const queuedRun1 = makeRun({
      id: 'queued-1',
      conditionId: 'cond-1',
      userId: 'user-1',
      status: 'queued',
      createdAt: new Date(now - 10 * 60 * 1000),
    });
    const queuedRun2 = makeRun({
      id: 'queued-2',
      conditionId: 'cond-1',
      userId: 'user-1',
      status: 'queued',
      createdAt: new Date(now - 8 * 60 * 1000),
    });

    // runRepo.find 分两次调用：第一次查 running，第二次查 queued
    runRepo.find
      .mockResolvedValueOnce([orphanRunningOld, orphanRunningRecent]) // status='running'
      .mockResolvedValueOnce([queuedRun1, queuedRun2]); // status='queued'

    // condRepo.findOne 返回 condition
    condRepo.findOne.mockResolvedValue(cond);

    // recovery 的 executeRun 不调用 onDone，避免连锁 release
    runner.executeRun.mockResolvedValue(undefined);

    await queue.onApplicationBootstrap();

    // 两个孤儿 running 都应被标 failed
    expect(runRepo.update).toHaveBeenCalledWith('orphan-old', {
      status: 'failed',
      errorMessage: '进程重启检测到孤儿任务（超时）',
      completedAt: expect.any(Date),
    });
    expect(runRepo.update).toHaveBeenCalledWith('orphan-recent', {
      status: 'failed',
      errorMessage: '进程重启检测到未完成任务',
      completedAt: expect.any(Date),
    });

    // 两个 queued 都应被启动（2 < MAX_CONCURRENT_PER_USER=3）
    expect(runner.executeRun).toHaveBeenCalledWith(cond, 'queued-1', 'user-1', expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledWith(cond, 'queued-2', 'user-1', expect.any(Function));
  });

  it('queued 超过并发上限时：前 N 个启动，其余保持 queued', async () => {
    const { queue, runner, runRepo, condRepo } = makeQueue();

    const cond = makeCondition({ id: 'cond-1' });

    // 5 个 queued（无 running 孤儿）
    const queuedRuns = [1, 2, 3, 4, 5].map(i =>
      makeRun({
        id: `queued-${i}`,
        conditionId: 'cond-1',
        userId: 'user-1',
        status: 'queued',
        createdAt: new Date(Date.now() - (6 - i) * 60 * 1000),
      }),
    );

    runRepo.find
      .mockResolvedValueOnce([]) // 无 running
      .mockResolvedValueOnce(queuedRuns); // 5 个 queued

    condRepo.findOne.mockResolvedValue(cond);

    // recovery 的 executeRun 不调用 onDone
    runner.executeRun.mockResolvedValue(undefined);

    await queue.onApplicationBootstrap();

    // 只有前 3 个 queued 应被启动
    expect(runner.executeRun).toHaveBeenCalledWith(cond, 'queued-1', 'user-1', expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledWith(cond, 'queued-2', 'user-1', expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledWith(cond, 'queued-3', 'user-1', expect.any(Function));
    expect(runner.executeRun).not.toHaveBeenCalledWith(cond, 'queued-4', 'user-1', expect.any(Function));
    expect(runner.executeRun).not.toHaveBeenCalledWith(cond, 'queued-5', 'user-1', expect.any(Function));
  });

  it('recovery 中 queued 对应的 condition 不存在时标 failed', async () => {
    const { queue, runner, runRepo, condRepo } = makeQueue();

    const queuedRun = makeRun({
      id: 'queued-1',
      conditionId: 'cond-missing',
      userId: 'user-1',
      status: 'queued',
    });

    runRepo.find
      .mockResolvedValueOnce([]) // 无 running
      .mockResolvedValueOnce([queuedRun]); // 1 个 queued

    // condition 不存在
    condRepo.findOne.mockResolvedValue(null);

    await queue.onApplicationBootstrap();

    // queued run 应被标 failed
    expect(runRepo.update).toHaveBeenCalledWith('queued-1', {
      status: 'failed',
      errorMessage: '关联的条件不存在',
      completedAt: expect.any(Date),
    });

    // 不应启动 executeRun
    expect(runner.executeRun).not.toHaveBeenCalled();
  });

  it('不同 userId 的 queued 独立恢复', async () => {
    const { queue, runner, runRepo, condRepo } = makeQueue();

    const cond1 = makeCondition({ id: 'cond-1' });
    const cond2 = makeCondition({ id: 'cond-2' });

    // user-1: 2 个 queued，user-2: 4 个 queued
    const user1Queued = [1, 2].map(i =>
      makeRun({ id: `u1-q${i}`, conditionId: 'cond-1', userId: 'user-1', status: 'queued' }),
    );
    const user2Queued = [1, 2, 3, 4].map(i =>
      makeRun({ id: `u2-q${i}`, conditionId: 'cond-2', userId: 'user-2', status: 'queued' }),
    );

    runRepo.find
      .mockResolvedValueOnce([]) // 无 running
      .mockResolvedValueOnce([...user1Queued, ...user2Queued]); // 全部 queued

    // condRepo 按 conditionId 分派
    condRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where.id === 'cond-1') return cond1;
      if (where.id === 'cond-2') return cond2;
      return null;
    });

    // recovery 的 executeRun 不调用 onDone
    runner.executeRun.mockResolvedValue(undefined);

    await queue.onApplicationBootstrap();

    // user-1: 2 个 queued，全部启动（2 < 3）
    expect(runner.executeRun).toHaveBeenCalledWith(cond1, 'u1-q1', 'user-1', expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledWith(cond1, 'u1-q2', 'user-1', expect.any(Function));

    // user-2: 4 个 queued，前 3 个启动，第 4 个保持 queued
    expect(runner.executeRun).toHaveBeenCalledWith(cond2, 'u2-q1', 'user-2', expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledWith(cond2, 'u2-q2', 'user-2', expect.any(Function));
    expect(runner.executeRun).toHaveBeenCalledWith(cond2, 'u2-q3', 'user-2', expect.any(Function));
    expect(runner.executeRun).not.toHaveBeenCalledWith(cond2, 'u2-q4', 'user-2', expect.any(Function));
  });
});
