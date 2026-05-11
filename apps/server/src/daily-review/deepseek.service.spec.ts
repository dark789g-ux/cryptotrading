import { DeepseekService } from './deepseek.service';

describe('DeepseekService.generateArticle', () => {
  it('分别累加 reasoning_content 与 content', async () => {
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

    const events: any[] = [];
    const r = await svc.generateArticle('{"generatedAt":"2026-05-12T00:00:00Z"}', (e) => events.push(e));

    expect(r.article).toBe('正文A正文B');
    expect(r.reasoning).toBe('思考A思考B');
    expect(r.tokenUsage).toEqual({ prompt: 100, completion: 50, reasoning: 200, total: 350 });
    expect(events.map(e => e.stage)).toEqual(['reasoning', 'reasoning', 'writing', 'writing']);
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
