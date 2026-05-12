import OpenAI from 'openai';
import { MimoLlmProvider } from './mimo.provider';

describe('MimoLlmProvider', () => {
  it('buildExtraBody 仅含 thinking enabled，不包含 reasoning_effort', () => {
    const p = new MimoLlmProvider({} as unknown as OpenAI, 'mimo-v2.5-pro');
    const extra = (p as any).buildExtraBody();
    expect(extra).toEqual({ thinking: { type: 'enabled' } });
    // 显式断言 Mimo 不支持 reasoning_effort，避免回归把它误加上
    expect(extra).not.toHaveProperty('reasoning_effort');
  });

  it('modelName 透传构造参数', () => {
    const p = new MimoLlmProvider({} as unknown as OpenAI, 'mimo-v2.5-pro');
    expect(p.modelName).toBe('mimo-v2.5-pro');
  });
});
