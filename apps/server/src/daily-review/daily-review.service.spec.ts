import { DailyReviewService } from './daily-review.service';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import type { ProgressEvent, Stage, StageTiming } from './daily-review.types';

// runPipeline 是 private 但通过 startGeneration 间接触发；这里直接用任意类型访问以聚焦阶段累积逻辑

describe('DailyReviewService.runPipeline stageTimings 累积', () => {
  const setup = (llmImpl: (snapshotJson: string, onProgress: (e: ProgressEvent) => void) => Promise<any>) => {
    const updates: any[] = [];
    const repo: any = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x) => ({ id: 'row-1', ...x })),
      save: jest.fn(async (r) => r),
      update: jest.fn(async (id, patch) => { updates.push({ id, patch }); return { affected: 1 }; }),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const ds: any = { query: jest.fn() };
    const builder: any = { buildSnapshot: jest.fn().mockResolvedValue({ generatedAt: '2026-05-12T00:00:00Z' }) };
    const llm: any = { generateArticle: jest.fn(llmImpl), modelName: 'test-model' };
    const gateway = new DailyReviewProgressGateway();
    const svc = new DailyReviewService(repo, ds, builder, llm, gateway);
    return { svc, repo, updates, gateway, llm };
  };

  const collectEvents = (gateway: DailyReviewProgressGateway, date: string): ProgressEvent[] => {
    const out: ProgressEvent[] = [];
    gateway.observe(date, true).subscribe((e) => out.push(e));
    return out;
  };

  it('正常完成：stageTimings 包含 validate/fetch/build/reasoning/writing/finalize 6 个阶段（按顺序）', async () => {
    const fullArticle = 'A'.repeat(3000);
    const { svc, updates, gateway } = setup(async (_json, onProgress) => {
      // 模拟 DeepSeek：先若干 reasoning_delta，再用 stage_done(reasoning)+stage(writing) 切换，再 content
      onProgress({ type: 'reasoning_delta', text: '思考', ts: Date.now() });
      await new Promise((r) => setTimeout(r, 1));
      const now = Date.now();
      onProgress({ type: 'stage_done', stage: 'reasoning', durationMs: 5, ts: now });
      onProgress({ type: 'stage', stage: 'writing', percent: 70, ts: now });
      onProgress({ type: 'content_delta', text: 'X', ts: Date.now() });
      onProgress({ type: 'usage', tokens: { prompt: 1, completion: 2, reasoning: 3, total: 6 }, ts: Date.now() });
      return { article: fullArticle, reasoning: '思考', tokenUsage: { prompt: 1, completion: 2, reasoning: 3, total: 6 } };
    });

    await (svc as any).runPipeline('row-1', '20260512');

    const finalUpdate = updates.find((u) => u.patch.status === 'completed');
    expect(finalUpdate).toBeDefined();
    const timings: StageTiming[] = finalUpdate.patch.stageTimings;
    expect(timings.map((t) => t.stage)).toEqual<Stage[]>([
      'validate', 'fetch', 'build', 'reasoning', 'writing', 'finalize',
    ]);
    // startedAt 应为 ISO UTC 字符串
    for (const t of timings) {
      expect(t.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }

    // gateway 末尾事件为 completed
    const events = collectEvents(gateway, '20260512');
    expect(events[events.length - 1].type).toBe('completed');
  });

  it('失败时仍把已收集的 reasoning 残段与 stageTimings 落库', async () => {
    const { svc, updates } = setup(async (_json, onProgress) => {
      onProgress({ type: 'reasoning_delta', text: '残段A', ts: Date.now() });
      onProgress({ type: 'reasoning_delta', text: '残段B', ts: Date.now() });
      throw new Error('llm timeout');
    });

    await (svc as any).runPipeline('row-1', '20260512');

    const failUpdate = updates.find((u) => u.patch.status === 'failed');
    expect(failUpdate).toBeDefined();
    expect(failUpdate.patch.errorMessage).toBe('llm timeout');
    expect(failUpdate.patch.reasoningContent).toBe('残段A残段B');
    // stageTimings 至少包含到 reasoning 阶段的累积（具体长度依实现而定，但必须为非空数组）
    expect(Array.isArray(failUpdate.patch.stageTimings)).toBe(true);
    expect(failUpdate.patch.stageTimings.length).toBeGreaterThan(0);
  });

  it('文章过短按失败处理，stageTimings 仍落库', async () => {
    const { svc, updates } = setup(async (_json, onProgress) => {
      const now = Date.now();
      onProgress({ type: 'stage_done', stage: 'reasoning', durationMs: 1, ts: now });
      onProgress({ type: 'stage', stage: 'writing', percent: 70, ts: now });
      return { article: 'tooShort', reasoning: 'r', tokenUsage: null };
    });

    await (svc as any).runPipeline('row-1', '20260512');
    const failUpdate = updates.find((u) => u.patch.status === 'failed');
    expect(failUpdate).toBeDefined();
    expect(failUpdate.patch.errorMessage).toMatch(/文章长度异常/);
    expect(Array.isArray(failUpdate.patch.stageTimings)).toBe(true);
  });
});
