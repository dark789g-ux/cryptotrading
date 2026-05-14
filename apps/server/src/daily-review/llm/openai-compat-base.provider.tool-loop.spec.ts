import OpenAI from 'openai';
import { OpenAiCompatLlmProvider } from './openai-compat-base.provider';
import type { ProgressEvent, ToolCallLog } from '../types/daily-review.types';
import type { ToolSchema } from './llm-provider.interface';

// 测试用最小子类（与 openai-compat-base.provider.spec.ts 中的 TestProvider 同构，但作用域独立）
class TestProvider extends OpenAiCompatLlmProvider {
  protected buildExtraBody(): Record<string, unknown> {
    return {};
  }
}

const TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'search_news',
      description: 'fake search',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
];

/** 用 jest.fn 构造按调用顺序返回不同响应的 client */
function mkClient(responses: any[]) {
  const create = jest.fn();
  responses.forEach((r) => create.mockResolvedValueOnce(r));
  return {
    create,
    client: { chat: { completions: { create } } } as unknown as OpenAI,
  };
}

function toolCallMsg(id: string, name: string, argsObj: Record<string, unknown>): any {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(argsObj) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function finalMsg(content: string): any {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
  };
}

describe('OpenAiCompatLlmProvider.runToolLoop', () => {
  it('正常 3 次工具调用后自然结束 + evidencePack 解析正确 + token 累加 + tool_call 事件回放', async () => {
    const evidence = {
      done: true,
      evidencePack: {
        hypotheses: [
          {
            claim: 'DeepSeek 概念融资催化',
            supportingFacts: [
              { type: 'news', source: 'cls', summary: 'x', url: 'https://x', publishedAt: '2026-05-13T01:00:00Z' },
            ],
            relevantSectors: ['DeepSeek'],
            relevantStocks: ['601138.SH'],
          },
        ],
      },
    };
    const { create, client } = mkClient([
      toolCallMsg('c1', 'search_news', { query: 'DeepSeek 融资' }),
      toolCallMsg('c2', 'search_news', { query: '工信部新政' }),
      toolCallMsg('c3', 'search_news', { query: '美光 HBM' }),
      finalMsg(JSON.stringify(evidence)),
    ]);

    const dispatchTool = jest.fn(async (idx: number, name: string, a: Record<string, unknown>) => ({
      result: { idx, name, a, ok: true },
      durationMs: 12,
    }));

    const events: ProgressEvent[] = [];
    const p = new TestProvider(client, 'test-model');
    const r = await p.runToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: TOOLS,
      maxToolCalls: 8,
      maxTokens: 1000,
      dispatchTool,
      onProgress: (e) => events.push(e),
    });

    // 4 次 chat 调用（3 次 tool_call 响应 + 1 次最终）
    expect(create).toHaveBeenCalledTimes(4);
    // dispatchTool 被调 3 次，callIndex 0/1/2 递增
    expect(dispatchTool).toHaveBeenCalledTimes(3);
    const callIndexes = dispatchTool.mock.calls.map((c) => c[0]);
    expect(callIndexes).toEqual([0, 1, 2]);

    // toolCallLog 字段齐全
    expect(r.toolCallLog).toHaveLength(3);
    r.toolCallLog.forEach((log: ToolCallLog, i) => {
      expect(log.callIndex).toBe(i);
      expect(log.name).toBe('search_news');
      expect(log.durationMs).toBe(12);
      expect(typeof log.startedAt).toBe('string');
      // UTC 墙钟字符串（CLAUDE.md 时间规范），不应含本地 TZ 偏移
      expect(log.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(log.error).toBeUndefined();
    });

    // tool_call 事件 3 次
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(3);

    // token 累加：3 * (10/5/15) + 1 * (20/30/50)
    expect(r.tokenUsage).toEqual({ promptTokens: 50, completionTokens: 45, totalTokens: 95 });

    // evidencePack 解析正确
    expect(r.evidencePack).not.toBeNull();
    expect(r.evidencePack!.hypotheses).toHaveLength(1);
    expect(r.evidencePack!.hypotheses[0].relevantStocks).toEqual(['601138.SH']);
    expect(r.evidencePack!.rawText).toBeUndefined();

    // 工具结果以 role='tool' 消息塞回 messages（通过最终一轮请求体验证）
    const lastCallBody = create.mock.calls[create.mock.calls.length - 1][0];
    const toolMessages = (lastCallBody.messages as Array<{ role: string; tool_call_id?: string }>).filter(
      (m) => m.role === 'tool',
    );
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('触发 maxToolCalls 上限后强制收口：追加 user 提示并多一轮拿最终消息', async () => {
    // maxToolCalls=2 → 允许 2 次 dispatch；第 3 次响应仍是 tool_call 时不 dispatch，
    // 反而追加强制收口 user message，再发一次拿最终
    const evidence = {
      evidencePack: { hypotheses: [{ claim: 'c', supportingFacts: [], relevantSectors: [], relevantStocks: [] }] },
    };
    const { create, client } = mkClient([
      toolCallMsg('c1', 'search_news', { q: 1 }),
      toolCallMsg('c2', 'search_news', { q: 2 }),
      toolCallMsg('c3', 'search_news', { q: 3 }), // 此轮不应被 dispatch
      finalMsg(JSON.stringify(evidence)),
    ]);
    const dispatchTool = jest.fn(async () => ({ result: { ok: 1 }, durationMs: 1 }));

    const p = new TestProvider(client, 'test-model');
    const r = await p.runToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: TOOLS,
      maxToolCalls: 2,
      maxTokens: 500,
      dispatchTool,
    });

    // 总共 4 次 chat：2 次正常工具轮 + 1 次"已达上限"轮 + 1 次强制收口轮
    expect(create).toHaveBeenCalledTimes(4);
    // dispatchTool 只在前两轮触发，共 2 次
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(r.toolCallLog).toHaveLength(2);

    // 第 4 次 chat 请求体的 messages 末尾应有强制收口 user message
    const fourthBody = create.mock.calls[3][0];
    const collected = fourthBody.messages as Array<{ role: string; content: any }>;
    // 倒数第 2 条是上一轮的 assistant tool_call 响应，倒数第 1 条才是强制收口的 user 提示
    const lastUser = [...collected].reverse().find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
    expect(lastUser!.content).toContain('已达工具调用预算上限');

    // evidencePack 解析成功
    expect(r.evidencePack).not.toBeNull();
    expect(r.evidencePack!.hypotheses).toHaveLength(1);
  });

  it('最终消息 JSON 解析失败 → rawText fallback', async () => {
    const { client } = mkClient([
      toolCallMsg('c1', 'search_news', { q: 1 }),
      finalMsg('这不是 JSON 哎，纯文本兜底。'),
    ]);
    const dispatchTool = jest.fn(async () => ({ result: { ok: true }, durationMs: 3 }));

    const p = new TestProvider(client, 'test-model');
    const r = await p.runToolLoop({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: TOOLS,
      maxToolCalls: 5,
      maxTokens: 200,
      dispatchTool,
    });

    expect(r.evidencePack).not.toBeNull();
    expect(r.evidencePack!.hypotheses).toEqual([]);
    expect(r.evidencePack!.rawText).toBe('这不是 JSON 哎，纯文本兜底。');
  });
});
