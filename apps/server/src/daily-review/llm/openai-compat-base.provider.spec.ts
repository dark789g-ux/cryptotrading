import OpenAI from 'openai';
import { OpenAiCompatLlmProvider } from './openai-compat-base.provider';
import type { ProgressEvent } from '../daily-review.types';

// 测试基类共享逻辑：在测试文件内部声明最小子类，避免依赖任何已废弃的 provider 实现
class TestProvider extends OpenAiCompatLlmProvider {
  constructor(
    client: OpenAI,
    model: string,
    private readonly _extra: Record<string, unknown> = {},
  ) {
    super(client, model);
  }
  protected buildExtraBody(): Record<string, unknown> {
    return this._extra;
  }
}

describe('OpenAiCompatLlmProvider (via TestProvider)', () => {
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
    const p = new TestProvider(client as unknown as OpenAI, 'test-model');

    const events: ProgressEvent[] = [];
    const r = await p.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', (e) => events.push(e));

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
    const p = new TestProvider(client as unknown as OpenAI, 'test-model');

    const reasoningTexts: string[] = [];
    await p.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', (e) => {
      if (e.type === 'reasoning_delta') reasoningTexts.push(e.text);
    });
    expect(reasoningTexts).toEqual(['甲', '乙']);
  });

  it('extra_body 透传 buildExtraBody 返回值，且不传 temperature / top_p', async () => {
    const client = {
      chat: { completions: { create: jest.fn().mockResolvedValue((async function* () {})()) } },
    };
    const p = new TestProvider(client as unknown as OpenAI, 'test-model', { thinking: { type: 'enabled' } });
    await p.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', () => {});
    const callArgs = (client.chat.completions.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.stream).toBe(true);
    expect(callArgs.extra_body).toEqual({ thinking: { type: 'enabled' } });
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.top_p).toBeUndefined();
  });

  it('无 usage 时 tokenUsage 返回 null 且不推 usage 事件', async () => {
    const fakeStream = (async function* () {
      yield { choices: [{ delta: { reasoning_content: '想' } }] };
      yield { choices: [{ delta: { content: '写' } }] };
      // 末尾 chunk 不含 usage 字段
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })();
    const client = { chat: { completions: { create: jest.fn().mockResolvedValue(fakeStream) } } };
    const p = new TestProvider(client as unknown as OpenAI, 'test-model');

    const events: ProgressEvent[] = [];
    const r = await p.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', (e) => events.push(e));

    expect(r.tokenUsage).toBeNull();
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});
