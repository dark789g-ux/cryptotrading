// TODO: 需集成测试验证 Mimo 真实 stream 中 delta.reasoning_content 字段名（mock 单测不验证第三方契约）
import { Injectable } from '@nestjs/common';
import { OpenAiCompatLlmProvider } from './openai-compat-base.provider';

// 小米 Mimo 思考模式：仅 thinking.enabled，不支持 reasoning_effort
@Injectable()
export class MimoLlmProvider extends OpenAiCompatLlmProvider {
  protected buildExtraBody(): Record<string, unknown> {
    return {
      thinking: { type: 'enabled' },
    };
  }
}
