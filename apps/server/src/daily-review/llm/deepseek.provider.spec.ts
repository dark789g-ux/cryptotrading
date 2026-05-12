import OpenAI from 'openai';
import { DeepseekLlmProvider } from './deepseek.provider';

describe('DeepseekLlmProvider', () => {
  it('buildExtraBody 返回 thinking enabled + reasoning_effort high', () => {
    const p = new DeepseekLlmProvider({} as unknown as OpenAI, 'deepseek-v4-pro');
    expect((p as any).buildExtraBody()).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('modelName 透传构造参数', () => {
    const p = new DeepseekLlmProvider({} as unknown as OpenAI, 'deepseek-v4-pro');
    expect(p.modelName).toBe('deepseek-v4-pro');
  });
});
