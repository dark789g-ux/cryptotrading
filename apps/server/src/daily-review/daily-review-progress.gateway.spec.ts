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
