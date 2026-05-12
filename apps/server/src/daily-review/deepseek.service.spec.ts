import { DeepseekService } from './deepseek.service';
import type { ProgressEvent } from './daily-review.types';

// TODO: 需集成测试验证 DeepSeek 真实 reasoning_content 字段名（Mock 单测不验证第三方契约）

describe('DeepseekService.generateArticle', () => {
  it('reasoning_delta / content_delta / stage_done(reasoning) / stage(writing) / usage 事件序列正确', async () => {
    const fakeStream = (async function* () {
      yield { choices: [{ delta: { reasoning_content: '思考A' } }] };
      yield { choices: [{ delta: { reasoning_content: '思考B' } }] };
      yield { choices: [{ delta: { content: '正文A' } }] };
      yield { choices: [{ delta: { content: '正文B' } }] };
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 200, total_tokens: 350 },
      };
    })();

    const client = { chat: { completions: { create: jest.fn().mockResolvedValue(fakeStream) } } };
    const svc = new DeepseekService(client as any, { model: 'deepseek-test' });

    const events: ProgressEvent[] = [];
    const r = await svc.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', (e) => events.push(e));

    expect(r.article).toBe('正文A正文B');
    expect(r.reasoning).toBe('思考A思考B');
    expect(r.tokenUsage).toEqual({ prompt: 100, completion: 50, reasoning: 200, total: 350 });

    // 事件类型序列：reasoning x2 -> stage_done(reasoning) + stage(writing) -> content x2 -> usage
    expect(events.map((e) => e.type)).toEqual([
      'reasoning_delta',
      'reasoning_delta',
      'stage_done',
      'stage',
      'content_delta',
      'content_delta',
      'usage',
    ]);

    const stageDone = events[2] as Extract<ProgressEvent, { type: 'stage_done' }>;
    expect(stageDone.stage).toBe('reasoning');
    expect(stageDone.durationMs).toBeGreaterThanOrEqual(0);

    const writing = events[3] as Extract<ProgressEvent, { type: 'stage' }>;
    expect(writing.stage).toBe('writing');
    expect(writing.percent).toBe(70);

    const usage = events[6] as Extract<ProgressEvent, { type: 'usage' }>;
    expect(usage.tokens.total).toBe(350);
  });

  it('reasoning_delta 文本内容与 chunk 一一对应', async () => {
    const fakeStream = (async function* () {
      yield { choices: [{ delta: { reasoning_content: '甲' } }] };
      yield { choices: [{ delta: { reasoning_content: '乙' } }] };
      yield { choices: [{ delta: { content: 'X' } }] };
    })();
    const client = { chat: { completions: { create: jest.fn().mockResolvedValue(fakeStream) } } };
    const svc = new DeepseekService(client as any, { model: 'deepseek-test' });

    const reasoningTexts: string[] = [];
    await svc.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', (e) => {
      if (e.type === 'reasoning_delta') reasoningTexts.push(e.text);
    });
    expect(reasoningTexts).toEqual(['甲', '乙']);
  });

  it('extra_body 含 thinking enabled 且不传 temperature', async () => {
    const client = { chat: { completions: { create: jest.fn().mockResolvedValue((async function* () {})()) } } };
    const svc = new DeepseekService(client as any, { model: 'deepseek-test' });
    await svc.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', () => {});
    const callArgs = (client.chat.completions.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.stream).toBe(true);
    expect(callArgs.extra_body).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.top_p).toBeUndefined();
  });
});
