import { SYSTEM_PROMPT, buildUserPrompt } from './article-prompt';

describe('article-prompt SYSTEM_PROMPT 九段结构与硬约束', () => {
  it('包含九段标题关键字（按顺序覆盖）', () => {
    const keywords = [
      '先给结论',
      '大盘全景',
      '重点板块拆解',
      '潜力板块',
      '盘后/隔夜',
      '宏观与政策',
      '综合结论',
      '重点个股',
      '明日操作清单',
    ];
    for (const kw of keywords) {
      expect(SYSTEM_PROMPT).toContain(kw);
    }
  });

  it('包含板块数量硬性约束 3-5 个', () => {
    expect(SYSTEM_PROMPT).toMatch(/3-5\s*个/);
  });

  it('包含 4 时段操作表的精确时间字符串', () => {
    const slots = ['9:15-9:25', '9:30-10:00', '10:00-14:30', '14:45-15:00'];
    for (const s of slots) {
      expect(SYSTEM_PROMPT).toContain(s);
    }
  });

  it('包含 3 信号与 5 纪律的关键字', () => {
    expect(SYSTEM_PROMPT).toContain('量能阈值');
    expect(SYSTEM_PROMPT).toContain('龙头股阈值');
    expect(SYSTEM_PROMPT).toContain('指数关键位');
    expect(SYSTEM_PROMPT).toContain('不追高');
    expect(SYSTEM_PROMPT).toContain('止损');
    expect(SYSTEM_PROMPT).toContain('不逆势加仓');
    expect(SYSTEM_PROMPT).toContain('收盘前减仓');
  });

  it('包含降级提示「外部归因数据缺失」', () => {
    expect(SYSTEM_PROMPT).toContain('外部归因数据缺失');
  });

  it('保留原有核心约束：字数 / 二级标题 / 单位换算 / 禁止虚构 / 免责声明', () => {
    expect(SYSTEM_PROMPT).toMatch(/5000-8000/);
    expect(SYSTEM_PROMPT).toContain('## 二级标题');
    expect(SYSTEM_PROMPT).toContain('亿/万亿');
    expect(SYSTEM_PROMPT).toContain('禁止虚构');
    expect(SYSTEM_PROMPT).toContain('仅用于学习研究，不构成投资建议');
  });
});

describe('buildUserPrompt 降级与证据包注入', () => {
  const snapshot = { generatedAt: '2026-05-13T08:00:00Z', tradeDate: '20260513' };

  it('evidencePack === null 时，user prompt 包含外部归因数据缺失提示', () => {
    const out = buildUserPrompt(snapshot, null);
    expect(out).toContain('外部归因数据缺失');
    expect(out).toContain('降级规则');
  });

  it('evidencePack 为对象时，user prompt 附加 evidencePack JSON 段', () => {
    const pack = { hypotheses: [{ claim: 'test' }] };
    const out = buildUserPrompt(snapshot, pack);
    expect(out).toContain('evidencePack');
    expect(out).toContain('"claim": "test"');
    expect(out).not.toContain('外部归因数据缺失');
  });

  it('未传 evidencePack（undefined）时，不附加 evidence 段也不报缺失', () => {
    const out = buildUserPrompt(snapshot);
    expect(out).not.toContain('外部归因数据缺失');
    expect(out).not.toContain('evidencePack');
  });

  it('始终包含 snapshot JSON 与九段指令', () => {
    const out = buildUserPrompt(snapshot, null);
    expect(out).toContain('2026-05-13T08:00:00Z');
    expect(out).toContain('九段结构');
  });
});
