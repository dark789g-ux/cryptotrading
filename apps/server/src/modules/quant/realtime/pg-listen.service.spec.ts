import { EventEmitter } from 'events';
import { firstValueFrom, take, toArray } from 'rxjs';
import {
  ML_JOB_PROGRESS_CHANNEL,
  PG_LISTEN_BACKOFF_SCHEDULE_MS,
  PG_LISTEN_PAYLOAD_MAX_BYTES,
  PgListenService,
  type MlJobProgressEvent,
} from './pg-listen.service';

/**
 * pg.Client 的最小可控 mock：
 * - connect()/end() 异步立即 resolve；query 记录最后一条 SQL
 * - 通过 emitNotification(channel, payload) 触发 'notification' 事件
 * - 通过 emit('error', err) / emit('end') 模拟连接异常
 */
class FakePgClient extends EventEmitter {
  public lastQuery: string | null = null;
  public connectCalls = 0;
  public endCalls = 0;
  public ended = false;
  public connectImpl: () => Promise<void> = async () => {};

  async connect(): Promise<void> {
    this.connectCalls += 1;
    await this.connectImpl();
  }
  async query(sql: string): Promise<unknown> {
    this.lastQuery = sql;
    return { rows: [] };
  }
  async end(): Promise<void> {
    this.endCalls += 1;
    this.ended = true;
  }

  emitNotification(channel: string, payload: string): void {
    this.emit('notification', { channel, payload });
  }
}

function makeConfig(): { get: jest.Mock } {
  return {
    get: jest.fn((key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        DB_HOST: 'localhost',
        DB_PORT: 5432,
        DB_USER: 'u',
        DB_PASS: 'p',
        DB_NAME: 'd',
      };
      return key in map ? map[key] : def;
    }),
  };
}

describe('PgListenService', () => {
  let clients: FakePgClient[] = [];
  let svc: PgListenService;

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    const config = makeConfig() as any;
    svc = new PgListenService(config);
    svc._setClientFactory(() => {
      const c = new FakePgClient();
      clients.push(c);
      return c as any;
    });
  });

  afterEach(async () => {
    // 用 fake timer 时 onModuleDestroy 需要确保 setTimeout cleanup 不挂起
    await svc.onModuleDestroy().catch(() => {});
    jest.useRealTimers();
  });

  it('onModuleInit 建立连接并 LISTEN ml_job_progress', async () => {
    await svc.onModuleInit();
    expect(clients.length).toBe(1);
    expect(clients[0].connectCalls).toBe(1);
    expect(clients[0].lastQuery).toBe(`LISTEN ${ML_JOB_PROGRESS_CHANNEL}`);
  });

  it('收到合法 NOTIFY payload → 通过 Subject 广播', async () => {
    await svc.onModuleInit();
    const evtP = firstValueFrom(svc.events$().pipe(take(1)));
    const payload = JSON.stringify({
      job_id: '11111111-2222-3333-4444-555555555555',
      progress: 42,
      stage: 'training',
    });
    clients[0].emitNotification(ML_JOB_PROGRESS_CHANNEL, payload);
    const evt = (await evtP) as MlJobProgressEvent;
    expect(evt).toEqual({
      job_id: '11111111-2222-3333-4444-555555555555',
      progress: 42,
      stage: 'training',
    });
  });

  it('payload > 1KB 直接 drop 并 warn，Subject 不发事件', async () => {
    await svc.onModuleInit();
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
    const seen: MlJobProgressEvent[] = [];
    const sub = svc.events$().subscribe((e) => seen.push(e));
    // 构造一条 > 1KB 的字符串（即使是合法 JSON shape，长度超限也必须 drop）
    const big = JSON.stringify({
      job_id: '11111111-2222-3333-4444-555555555555',
      progress: 1,
      stage: 'a'.repeat(PG_LISTEN_PAYLOAD_MAX_BYTES + 16),
    });
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(PG_LISTEN_PAYLOAD_MAX_BYTES);
    clients[0].emitNotification(ML_JOB_PROGRESS_CHANNEL, big);
    sub.unsubscribe();
    expect(seen.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('payload_too_large'),
    );
  });

  it('payload schema 不合法（job_id 非 uuid / progress 越界 / stage 缺失）均 drop', async () => {
    await svc.onModuleInit();
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
    const seen: MlJobProgressEvent[] = [];
    const sub = svc.events$().subscribe((e) => seen.push(e));

    // bad uuid
    clients[0].emitNotification(
      ML_JOB_PROGRESS_CHANNEL,
      JSON.stringify({ job_id: 'not-a-uuid', progress: 1, stage: 'x' }),
    );
    // progress 越界
    clients[0].emitNotification(
      ML_JOB_PROGRESS_CHANNEL,
      JSON.stringify({
        job_id: '11111111-2222-3333-4444-555555555555',
        progress: 150,
        stage: 'x',
      }),
    );
    // 缺 stage
    clients[0].emitNotification(
      ML_JOB_PROGRESS_CHANNEL,
      JSON.stringify({
        job_id: '11111111-2222-3333-4444-555555555555',
        progress: 1,
      }),
    );
    // 非 JSON
    clients[0].emitNotification(ML_JOB_PROGRESS_CHANNEL, 'not-json{');
    // 非对象
    clients[0].emitNotification(ML_JOB_PROGRESS_CHANNEL, '[1,2,3]');

    sub.unsubscribe();
    expect(seen.length).toBe(0);
    expect(warnSpy.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('invalid_job_id'),
        expect.stringContaining('invalid_progress'),
        expect.stringContaining('invalid_stage'),
        expect.stringContaining('invalid_json'),
        expect.stringContaining('payload_not_object'),
      ]),
    );
  });

  it('其它 channel 的 NOTIFY 不被处理', async () => {
    await svc.onModuleInit();
    const seen: MlJobProgressEvent[] = [];
    const sub = svc.events$().subscribe((e) => seen.push(e));
    clients[0].emitNotification(
      'some_other_channel',
      JSON.stringify({
        job_id: '11111111-2222-3333-4444-555555555555',
        progress: 50,
        stage: 'x',
      }),
    );
    sub.unsubscribe();
    expect(seen.length).toBe(0);
  });

  it('连接 error → 按指数退避调度重连，并重新 LISTEN', async () => {
    await svc.onModuleInit();
    expect(svc._getBackoffIndex()).toBe(0);
    expect(clients.length).toBe(1);

    // 模拟连接断开
    clients[0].emit('error', new Error('boom'));
    // 第一次退避 = 5s
    expect(svc._getBackoffIndex()).toBe(1);

    // 推进 5s，应当建立第二条连接
    await jest.advanceTimersByTimeAsync(PG_LISTEN_BACKOFF_SCHEDULE_MS[0]);
    expect(clients.length).toBe(2);
    expect(clients[1].lastQuery).toBe(`LISTEN ${ML_JOB_PROGRESS_CHANNEL}`);
    // 重连成功后 backoff 重置
    expect(svc._getBackoffIndex()).toBe(0);
  });

  it('重连失败时 backoff 继续上升直至 max 60s', async () => {
    await svc.onModuleInit();
    // 让后续所有 connect 都抛错
    svc._setClientFactory(() => {
      const c = new FakePgClient();
      c.connectImpl = async () => {
        throw new Error('connect refused');
      };
      clients.push(c);
      return c as any;
    });

    // 触发首次断开
    clients[0].emit('end');
    expect(svc._getBackoffIndex()).toBe(1);

    // 推进每个退避档位，验证 index 上升直到 max（length-1）
    for (let i = 0; i < PG_LISTEN_BACKOFF_SCHEDULE_MS.length + 2; i += 1) {
      const delay = PG_LISTEN_BACKOFF_SCHEDULE_MS[
        Math.min(i, PG_LISTEN_BACKOFF_SCHEDULE_MS.length - 1)
      ];
      await jest.advanceTimersByTimeAsync(delay);
    }
    expect(svc._getBackoffIndex()).toBe(
      PG_LISTEN_BACKOFF_SCHEDULE_MS.length - 1,
    );
  });

  it('onModuleDestroy 优雅关闭 client 并停止重连', async () => {
    await svc.onModuleInit();
    await svc.onModuleDestroy();
    expect(clients[0].endCalls).toBe(1);
    // 销毁后断连不再重连
    clients[0].emit('error', new Error('after destroy'));
    await jest.advanceTimersByTimeAsync(60_000);
    // clients 数量保持不变（不会建第二个）
    expect(clients.length).toBe(1);
  });
});
