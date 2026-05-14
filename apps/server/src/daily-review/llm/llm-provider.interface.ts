import type { EvidencePack, ProgressEvent, ToolCallLog, TokenUsage } from '../types/daily-review.types';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

// OpenAI tool-use 协议下发用 schema
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface RunToolLoopArgs {
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSchema[];
  maxToolCalls: number;
  maxTokens: number;
  /**
   * 由调用方决定如何 dispatch 工具，返回工具执行结果 + 耗时；
   * error 非空时表示工具内部失败（仍会作为 role='tool' 消息塞回 messages，让 LLM 自行绕开）
   */
  dispatchTool: (
    callIndex: number,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ result: unknown; durationMs: number; error?: string }>;
  onProgress?: (e: ProgressEvent) => void;
}

export interface RunToolLoopResult {
  evidencePack: EvidencePack | null;
  toolCallLog: ToolCallLog[];
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface LlmProvider {
  readonly modelName: string;
  /**
   * Stage2 Writer：生成 5000-8000 字复盘文章。
   * @param snapshotJson  当日 snapshot 的 JSON 字符串
   * @param onProgress    进度事件回调
   * @param evidencePack  可选的 Stage1 证据包；
   *                      - 传 `undefined`：旧行为，不带 evidence 段；
   *                      - 传 `null`：显式告诉 Writer「外部归因数据缺失」走降级写作（spec § 5.4 / § 6.2）；
   *                      - 传对象：将其 stringify 后嵌入 user prompt。
   */
  generateArticle(
    snapshotJson: string,
    onProgress: (e: ProgressEvent) => void,
    evidencePack?: EvidencePack | null,
  ): Promise<{ article: string; reasoning: string; tokenUsage: TokenUsage | null }>;
  runToolLoop(args: RunToolLoopArgs): Promise<RunToolLoopResult>;
}
