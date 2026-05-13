import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import type { ProgressEvent } from './daily-review.types';

describe('DailyReviewProgressGateway', () => {
  let gw: DailyReviewProgressGateway;

  beforeEach(() => {
    jest.useFakeTimers();
    gw = new DailyReviewProgressGateway();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const collect = (date: string, isAdmin: boolean): ProgressEvent[] => {
    const out: ProgressEvent[] = [];
    gw.observe(date, isAdmin).subscribe((e) => out.push(e));
    return out;
  };

  it('ReplaySubject 重放：晚到订阅者收到所有历史事件', () => {
    gw.emit('20260512', { type: 'stage', stage: 'validate', percent: 1, ts: 1 });
    gw.emit('20260512', { type: 'reasoning_delta', text: '思考A', ts: 2 });
    gw.emit('20260512', { type: 'stage', stage: 'reasoning', percent: 45, ts: 3 });

    const late = collect('20260512', true);
    expect(late).toHaveLength(3);
    expect(late[0].type).toBe('stage');
    expect(late[1].type).toBe('reasoning_delta');
  });

  it('非 admin 过滤 reasoning_delta 与 usage', () => {
    gw.emit('20260512', { type: 'stage', stage: 'validate', percent: 1, ts: 1 });
    gw.emit('20260512', { type: 'reasoning_delta', text: '思考', ts: 2 });
    gw.emit('20260512', { type: 'content_delta', text: '正文', ts: 3 });
    gw.emit('20260512', { type: 'usage', tokens: { prompt: 1, completion: 2, reasoning: 3, total: 6 }, ts: 4 });

    const user = collect('20260512', false);
    expect(user.map((e) => e.type)).toEqual(['stage', 'content_delta']);

    const admin = collect('20260512', true);
    expect(admin.map((e) => e.type)).toEqual(['stage', 'reasoning_delta', 'content_delta', 'usage']);
  });

  it('tool_call 事件：admin 收到原样事件，非 admin 被过滤（spec §8 admin-only）', () => {
    gw.emit('20260512', { type: 'stage', stage: 'investigate', percent: 30, ts: 1 });
    gw.emit('20260512', {
      type: 'tool_call',
      callIndex: 0,
      name: 'search_news',
      args: { query: 'DeepSeek 融资', recencyDays: 7 },
      durationMs: 1234,
      startedAt: '2026-05-13T01:23:45Z',
      ts: 2,
    });
    gw.emit('20260512', { type: 'content_delta', text: '正文', ts: 3 });

    const admin = collect('20260512', true);
    expect(admin.map((e) => e.type)).toEqual(['stage', 'tool_call', 'content_delta']);
    const adminToolCall = admin[1] as Extract<ProgressEvent, { type: 'tool_call' }>;
    expect(adminToolCall.name).toBe('search_news');
    expect(adminToolCall.args).toEqual({ query: 'DeepSeek 融资', recencyDays: 7 });
    expect(adminToolCall.callIndex).toBe(0);
    expect(adminToolCall.durationMs).toBe(1234);

    const user = collect('20260512', false);
    expect(user.map((e) => e.type)).toEqual(['stage', 'content_delta']);
  });

  it('tool_call 不影响 hasActive 状态（仅嵌在 investigate stage 内）', () => {
    gw.emit('20260512', { type: 'stage', stage: 'investigate', percent: 30, ts: 1 });
    expect(gw.hasActive('20260512')).toBe(true);
    gw.emit('20260512', {
      type: 'tool_call',
      callIndex: 0,
      name: 'lookup_stock',
      args: { tsCode: '601138.SH' },
      durationMs: 100,
      startedAt: '2026-05-13T01:23:45Z',
      ts: 2,
    });
    expect(gw.hasActive('20260512')).toBe(true);
    gw.emit('20260512', { type: 'completed', ts: 3 });
    expect(gw.hasActive('20260512')).toBe(false);
  });

  it('tool_call.args 序列化长度超阈值时截断，附 __truncated / __originalChars', () => {
    const bigQuery = 'x'.repeat(600);
    gw.emit('20260512', {
      type: 'tool_call',
      callIndex: 1,
      name: 'search_news',
      args: { query: bigQuery },
      durationMs: 50,
      startedAt: '2026-05-13T01:23:45Z',
      ts: 1,
    });

    const admin = collect('20260512', true);
    expect(admin).toHaveLength(1);
    const tc = admin[0] as Extract<ProgressEvent, { type: 'tool_call' }>;
    expect(tc.type).toBe('tool_call');
    // 原始字段保留
    expect(tc.name).toBe('search_news');
    expect(tc.callIndex).toBe(1);
    // args 已被截断
    const args = tc.args as { __truncated?: string; __originalChars?: number };
    expect(typeof args.__truncated).toBe('string');
    expect(args.__truncated!.length).toBe(500);
    expect(args.__originalChars).toBeGreaterThan(500);
  });

  it('tool_call.args 在阈值内时原样透传，不附加截断标记', () => {
    gw.emit('20260512', {
      type: 'tool_call',
      callIndex: 2,
      name: 'fetch_top_list',
      args: { mode: 'daily', tradeDate: '20260513' },
      durationMs: 80,
      startedAt: '2026-05-13T01:23:45Z',
      ts: 1,
    });

    const admin = collect('20260512', true);
    const tc = admin[0] as Extract<ProgressEvent, { type: 'tool_call' }>;
    expect(tc.args).toEqual({ mode: 'daily', tradeDate: '20260513' });
  });

  it('completed 后 hasActive 立刻返回 false（允许重新生成）', () => {
    gw.emit('20260512', { type: 'stage', stage: 'validate', percent: 1, ts: 1 });
    expect(gw.hasActive('20260512')).toBe(true);
    gw.emit('20260512', { type: 'completed', ts: 2 });
    expect(gw.hasActive('20260512')).toBe(false);
  });

  it('completed 后 60s 内仍可订阅；超时回收', () => {
    gw.emit('20260512', { type: 'stage', stage: 'validate', percent: 1, ts: 1 });
    gw.emit('20260512', { type: 'completed', ts: 2 });

    // 60s 内：仍可拿到完整历史
    const within = collect('20260512', true);
    expect(within.map((e) => e.type)).toEqual(['stage', 'completed']);

    // 推进 60s
    jest.advanceTimersByTime(60_000);

    // 超时回收后：新订阅者从一个全新的 subject 开始（无历史）
    const after = collect('20260512', true);
    expect(after).toEqual([]);
  });

  it('failed 同 completed 一样触发 60s 回收路径', () => {
    gw.emit('20260512', { type: 'stage', stage: 'validate', percent: 1, ts: 1 });
    gw.emit('20260512', { type: 'failed', error: 'boom', ts: 2 });
    expect(gw.hasActive('20260512')).toBe(false);

    const within = collect('20260512', true);
    expect(within.map((e) => e.type)).toEqual(['stage', 'failed']);

    jest.advanceTimersByTime(60_000);
    const after = collect('20260512', true);
    expect(after).toEqual([]);
  });
});
