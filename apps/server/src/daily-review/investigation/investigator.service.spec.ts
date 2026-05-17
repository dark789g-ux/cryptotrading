import { ConfigService } from '@nestjs/config';
import { InvestigatorService } from './investigator.service';
import type { LlmProvider, RunToolLoopArgs, RunToolLoopResult } from '../llm/llm-provider.interface';
import type { EvidencePack, ProgressEvent, SnapshotPayload } from '../types/daily-review.types';

// 最小化的 SnapshotPayload；只用到 generatedAt 字段
const FAKE_SNAPSHOT = { generatedAt: '2026-05-13T08:00:00Z' } as unknown as SnapshotPayload;

const mkConfig = (overrides: Record<string, string | number> = {}): ConfigService => {
  const data: Record<string, string | number | undefined> = {
    DAILY_REVIEW_TOOL_BUDGET: 8,
    DAILY_REVIEW_INVESTIGATOR_TIMEOUT_MS: 300_000,
    ...overrides,
  };
  return {
    get: jest.fn((k: string) => data[k]),
  } as unknown as ConfigService;
};

const mkTools = () => ({
  getSchemas: jest.fn().mockReturnValue([]),
  dispatch: jest.fn().mockResolvedValue({ result: null, durationMs: 0 }),
});

describe('InvestigatorService.investigate', () => {
  it('runToolLoop 正常返回时透传 evidencePack/toolCallLog/tokenUsage', async () => {
    const evidencePack: EvidencePack = {
      hypotheses: [
        {
          claim: '半导体板块强势',
          supportingFacts: [{ type: 'moneyflow', summary: '资金净流入 12 亿' }],
          relevantSectors: ['半导体'],
          relevantStocks: ['000725.SZ'],
        },
      ],
      yesterdayVerification: null,
    };
    const runResult: RunToolLoopResult = {
      evidencePack,
      toolCallLog: [
        {
          callIndex: 0,
          name: 'search_news',
          args: { query: 'DeepSeek' },
          result: { hits: [] },
          durationMs: 123,
          startedAt: '2026-05-13T08:00:00.000Z',
        },
      ],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
    const llm: LlmProvider = {
      modelName: 'test',
      generateArticle: jest.fn() as any,
      runToolLoop: jest.fn(async (_args: RunToolLoopArgs) => runResult),
    };
    const tools = mkTools();
    const svc = new InvestigatorService(llm, tools as any, mkConfig());

    const events: ProgressEvent[] = [];
    const r = await svc.investigate(FAKE_SNAPSHOT, (e) => events.push(e));

    expect(r).not.toBeNull();
    expect(r!.evidencePack).toBe(evidencePack);
    expect(r!.toolCallLog).toHaveLength(1);
    expect(r!.tokenUsage.totalTokens).toBe(150);
    // 正常路径不应发降级 stage 事件
    expect(events.find((e) => e.type === 'stage' && (e as any).message?.startsWith?.('investigator_degraded'))).toBeUndefined();

    // runToolLoop 收到约定的参数（含 maxToolCalls=8、maxTokens=12000）
    const callArg = (llm.runToolLoop as jest.Mock).mock.calls[0][0] as RunToolLoopArgs;
    expect(callArg.maxToolCalls).toBe(8);
    expect(callArg.maxTokens).toBe(12_000);
    expect(typeof callArg.dispatchTool).toBe('function');
  });

  it('runToolLoop 超时（不在时限内 resolve）时返回 null 并发降级事件', async () => {
    const llm: LlmProvider = {
      modelName: 'test',
      generateArticle: jest.fn() as any,
      // 永远不 resolve；超时分支会胜出
      runToolLoop: jest.fn(() => new Promise(() => undefined) as Promise<RunToolLoopResult>),
    };
    const tools = mkTools();
    // 把超时调到 10ms，让用例跑得飞快
    const svc = new InvestigatorService(
      llm,
      tools as any,
      mkConfig({ DAILY_REVIEW_INVESTIGATOR_TIMEOUT_MS: 10 }),
    );

    const events: ProgressEvent[] = [];
    const r = await svc.investigate(FAKE_SNAPSHOT, (e) => events.push(e));

    expect(r).toBeNull();
    const degradedEvent = events.find(
      (e) => e.type === 'stage' && (e as any).message?.startsWith?.('investigator_degraded'),
    );
    expect(degradedEvent).toBeDefined();
  });

  it('runToolLoop 抛异常时返回 null，且异常不向上抛', async () => {
    const llm: LlmProvider = {
      modelName: 'test',
      generateArticle: jest.fn() as any,
      runToolLoop: jest.fn(async () => {
        throw new Error('llm down');
      }),
    };
    const tools = mkTools();
    const svc = new InvestigatorService(llm, tools as any, mkConfig());

    const events: ProgressEvent[] = [];
    await expect(svc.investigate(FAKE_SNAPSHOT, (e) => events.push(e))).resolves.toBeNull();
    const degradedEvent = events.find(
      (e) => e.type === 'stage' && (e as any).message?.includes?.('investigator_degraded'),
    );
    expect(degradedEvent).toBeDefined();
  });
});
