import { EventEmitter } from 'events';
import { ForbiddenException } from '@nestjs/common';
import { firstValueFrom, take, toArray } from 'rxjs';
import {
  CustomIndexSseController,
  type CustomIndexSseMessageEvent,
} from './custom-index-sse.controller';

const INDEX_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'user-1';

function makeReq(opts: {
  customIndexId?: string;
  userId?: string | null;
} = {}): EventEmitter & {
  sseTokenPayload?: { custom_index_id: string; user_id: string };
} {
  const r = new EventEmitter() as EventEmitter & {
    sseTokenPayload?: { custom_index_id: string; user_id: string };
  };
  const userId = opts.userId === undefined ? USER_ID : opts.userId;
  if (userId !== null) {
    r.sseTokenPayload = {
      custom_index_id: opts.customIndexId ?? INDEX_ID,
      user_id: userId,
    };
  }
  return r;
}

function makeSnapshot(over: Partial<{
  status: string;
  progress: number;
  stage: string | null;
  last_error: string | null;
}> = {}) {
  return {
    custom_index_id: INDEX_ID,
    status: 'computing',
    progress: 50,
    stage: 'quotes',
    last_error: null,
    ...over,
  };
}

describe('CustomIndexSseController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeSetup(
    getComputeSnapshot: jest.Mock = jest.fn(async () => makeSnapshot()),
  ) {
    const service = { getComputeSnapshot };
    const controller = new CustomIndexSseController(service as never);
    const req = makeReq() as unknown as { on: (e: string, cb: () => void) => void };
    return { controller, service, getComputeSnapshot, req };
  }

  async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('建连瞬间立即推一条快照', async () => {
    const snap = makeSnapshot({ progress: 15, stage: 'sync_quotes' });
    const { controller, getComputeSnapshot, req } = makeSetup(
      jest.fn(async () => snap),
    );
    const obs = controller.stream(INDEX_ID, req as never);
    const events = await firstValueFrom(obs.pipe(take(1), toArray()));
    await flushAsync();
    expect(getComputeSnapshot).toHaveBeenCalledWith(USER_ID, INDEX_ID);
    expect(events[0].data).toMatchObject({
      status: 'computing',
      progress: 15,
      stage: 'sync_quotes',
    });
  });

  it('status=ready 时发 complete 后关流', async () => {
    const ready = makeSnapshot({ status: 'ready', progress: 100, stage: 'finalize' });
    const { controller, req } = makeSetup(jest.fn(async () => ready));
    const obs = controller.stream(INDEX_ID, req as never);
    const collected: CustomIndexSseMessageEvent[] = [];
    const completed = jest.fn();
    const sub = obs.subscribe({
      next: (e) => collected.push(e),
      complete: completed,
    });
    await flushAsync();
    await flushAsync();
    sub.unsubscribe();
    expect(collected.find((e) => e.type === 'complete')).toBeTruthy();
    expect(completed).toHaveBeenCalled();
  });

  it('status=failed 时发 complete 后关流', async () => {
    const failed = makeSnapshot({
      status: 'failed',
      progress: null as unknown as number,
      stage: null,
      last_error: 'boom',
    });
    const { controller, req } = makeSetup(jest.fn(async () => failed));
    const obs = controller.stream(INDEX_ID, req as never);
    const collected: CustomIndexSseMessageEvent[] = [];
    const completed = jest.fn();
    const sub = obs.subscribe({
      next: (e) => collected.push(e),
      complete: completed,
    });
    await flushAsync();
    await flushAsync();
    sub.unsubscribe();
    expect(collected.find((e) => e.type === 'complete')).toBeTruthy();
    expect(completed).toHaveBeenCalled();
  });

  it('轮询间隔内 status 变为 ready 后关流', async () => {
    const computing = makeSnapshot({ status: 'computing', progress: 80 });
    const ready = makeSnapshot({ status: 'ready', progress: 100, stage: 'finalize' });
    const getComputeSnapshot = jest
      .fn()
      .mockResolvedValueOnce(computing)
      .mockResolvedValueOnce(ready);
    const { controller, req } = makeSetup(getComputeSnapshot);
    const obs = controller.stream(INDEX_ID, req as never);
    const collected: CustomIndexSseMessageEvent[] = [];
    const completed = jest.fn();
    const sub = obs.subscribe({
      next: (e) => collected.push(e),
      complete: completed,
    });
    await flushAsync();
    jest.advanceTimersByTime(1000);
    await flushAsync();
    await flushAsync();
    sub.unsubscribe();
    expect(getComputeSnapshot).toHaveBeenCalledTimes(2);
    expect(collected.find((e) => e.type === 'complete')).toBeTruthy();
    expect(completed).toHaveBeenCalled();
  });

  it('token custom_index_id 与 path :id 不匹配 → ForbiddenException', () => {
    const { controller } = makeSetup();
    const req = makeReq({ customIndexId: 'other-id' }) as never;
    expect(() => controller.stream(INDEX_ID, req)).toThrow(ForbiddenException);
  });

  it('客户端断开 → teardown 后不再轮询', async () => {
    const getComputeSnapshot = jest.fn(async () => makeSnapshot());
    const { controller, req } = makeSetup(getComputeSnapshot);
    const obs = controller.stream(INDEX_ID, req as never);
    const sub = obs.subscribe();
    await flushAsync();
    expect(getComputeSnapshot).toHaveBeenCalledTimes(1);
    (req as unknown as EventEmitter).emit('close');
    await flushAsync();
    jest.advanceTimersByTime(3000);
    await flushAsync();
    sub.unsubscribe();
    expect(getComputeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('getComputeSnapshot 失败时不向 subscriber 推送（流保持打开）', async () => {
    const getComputeSnapshot = jest.fn(async () => {
      throw new Error('db down');
    });
    const { controller, req } = makeSetup(getComputeSnapshot);
    const obs = controller.stream(INDEX_ID, req as never);
    const collected: CustomIndexSseMessageEvent[] = [];
    const sub = obs.subscribe((e) => collected.push(e));
    await flushAsync();
    jest.advanceTimersByTime(2000);
    await flushAsync();
    sub.unsubscribe();
    expect(getComputeSnapshot).toHaveBeenCalled();
    expect(collected).toHaveLength(0);
  });
});
