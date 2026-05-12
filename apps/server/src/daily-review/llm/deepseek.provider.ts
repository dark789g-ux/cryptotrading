import { Injectable } from '@nestjs/common';
import { OpenAiCompatLlmProvider } from './openai-compat-base.provider';

// DeepSeek 思考模式：thinking.enabled + reasoning_effort=high
@Injectable()
export class DeepseekLlmProvider extends OpenAiCompatLlmProvider {
  protected buildExtraBody(): Record<string, unknown> {
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    };
  }
}
