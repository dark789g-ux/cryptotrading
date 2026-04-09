---
name: harness
description: >
  任意仓库的 Agent 工程脚手架。自动生成简洁的 AGENTS.md 目录、结构化 docs/ 知识库
  （ARCHITECTURE、QUALITY、CONVENTIONS、COORDINATION、RESILIENCE），
  支持 agent 可读格式的自定义 linter（WHAT/FIX/REF），CI 强制检查，以及执行计划模板。
  支持 Rust、Go、TypeScript 和 Python。将 agent-motivator 恢复协议集成到
  docs/RESILIENCE.md（7 点检查清单、VBR 标准、失败模式库）。
  适用于为新仓库搭建 agent 优先开发环境、升级现有 AGENTS.md、
  或强制执行架构 lint 检查。包含 --audit 标志用于工具生命周期检查，
  以及 L1/L2/L3 渐进式上下文披露。
---

# harness — Agent 工程脚手架

为任意仓库实现 [OpenAI Codex 团队的 agent 优先工程脚手架模式](https://openai.com/index/harness-engineering/)：
简洁的 AGENTS.md 目录、结构化 docs/、带有 agent 可读错误信息的自定义 linter、
CI 强制检查、执行计划模板、文档维护。

验证参考：[Agent Tool Design Guidelines](https://github.com/bowen31337/agent-harness-skills/blob/main/docs/agent_tool_desig_guidelines.md)（2026-03-09）

## 适用场景
- 为新仓库搭建 agent 优先开发环境
- 将现有仓库的 AGENTS.md 升级为目录索引风格
- 为仓库添加架构 lint 强制检查
- 任何以 agent 为主要开发者的仓库

## 支持的语言
- **Rust**（Substrate pallets、cargo workspace）
- **Go**（internal/ 包结构）
- **TypeScript**（src/、npm）
- **Python**（pyproject.toml、uv/pytest）← 2026-03-09 新增

## 用法

```bash
SKILL_DIR="$HOME/.openclaw/workspace/skills/harness"

# 为仓库生成脚手架（语言自动检测：Rust/Go/TypeScript/Python）
uv run python "$SKILL_DIR/scripts/scaffold.py" --repo /path/to/repo

# 强制覆盖已有的 AGENTS.md
uv run python "$SKILL_DIR/scripts/scaffold.py" --repo /path/to/repo --force

# 审计脚手架新鲜度（工具生命周期检查，不写入任何文件）
uv run python "$SKILL_DIR/scripts/scaffold.py" --repo /path/to/repo --audit

# 本地运行 lint 检查
bash /path/to/repo/scripts/agent-lint.sh

# 检查文档新鲜度（查找 docs/ 中的过时引用）
uv run python "$SKILL_DIR/scripts/doc_garden.py" --repo /path/to/repo --dry-run

# 检查文档新鲜度并提交修复 PR
uv run python "$SKILL_DIR/scripts/doc_garden.py" --repo /path/to/repo --pr

# 为复杂任务生成执行计划
uv run python "$SKILL_DIR/scripts/plan.py" \
  --task "Add IBC timeout handling" \
  --repo /path/to/repo
```

## 生成的文件

| 文件 | 说明 |
|------|------|
| `AGENTS.md` | 约 100 行的目录，带有 L1/L2/L3 渐进式披露标记 |
| `docs/ARCHITECTURE.md` | 层次图 + 依赖规则（根据仓库结构自动生成） |
| `docs/QUALITY.md` | 覆盖率目标 + 安全不变量 |
| `docs/CONVENTIONS.md` | 命名规则（按语言区分） |
| `docs/COORDINATION.md` | 多 agent 任务归属 + 冲突解决规则 |
| `docs/RESILIENCE.md` | Agent 恢复协议、7 点检查清单、VBR 标准 ← 来自 agent-motivator |
| `docs/EXECUTION_PLAN_TEMPLATE.md` | 复杂任务的结构化计划格式 |
| `scripts/agent-lint.sh` | 带 agent 可读错误的自定义 linter（WHAT / FIX / REF） |
| `.github/workflows/agent-lint.yml` | 每次 PR 的 CI 检查门禁 |

## Lint 错误格式

`scripts/agent-lint.sh` 产生的每条 lint 错误均遵循以下格式：
```
LINT ERROR [<rule-id>]: <问题描述>
  WHAT: <为何这是一个问题>
  FIX:  <解决该问题的具体步骤>
  REF:  <应查阅哪份文档>
```

这意味着 agent 可以直接读取 lint 输出并修复问题，无需询问人类。

## Agent 设计检查清单（来自工具设计指南）

在发布任何工具或 skill 变更前，请验证：

- [ ] 该工具是否符合当前模型的实际能力？
- [ ] 在结果正确性关键的地方，是否对结构化输出进行了 schema 强制验证？
- [ ] 上下文是否采用渐进式加载（L1→L2→L3），而非一次性全部加载？
- [ ] 如有需要，是否支持多 agent 协作？（参见 COORDINATION.md）
- [ ] 是否衡量了模型亲和度（调用频率）而非仅关注输出质量？
- [ ] 工具总数是否在上限以内？（目标：每个 agent ≤ 20 个）
- [ ] 是否有随模型能力变化而重新审视该工具的计划？

## 渐进式披露层次

脚手架强制执行三层上下文纪律：

| 层级 | 位置 | 加载时机 |
|------|------|----------|
| L1 | `AGENTS.md` | 始终加载 —— 概览、命令、不变量 |
| L2 | `docs/` | 编码前加载 —— 架构、质量、规范 |
| L3 | 源文件 | 按需加载 —— 使用 grep/read 查阅特定文件 |

**规则：** 从 L1 开始。触碰代码前先拉取 L2。仅在需要时才拉取 L3。
切勿预加载全部三层 —— 这会挤占有效的工作上下文。

## 工具生命周期（--audit）

每季度运行 `--audit` 检查脚手架新鲜度：
- AGENTS.md 包含深度层级标记
- COORDINATION.md 已存在（多 agent 支持）
- Lint 脚本使用当前语言工具链
- Python：包含 ruff + pyright 检查
- AGENTS.md 少于 150 行

## 安全性

- **不会覆盖已有的 AGENTS.md**，除非使用 `--force` 标志
- 生成文档前先读取现有代码结构（不产生幻觉 API）
- 所有写入操作在提交前均可通过 `--dry-run` 模式预览

## 参考资料

- [OpenAI Codex harness engineering](https://openai.com/index/harness-engineering/)
- [Agent Tool Design Guidelines](https://github.com/bowen31337/agent-harness-skills/blob/main/docs/agent_tool_desig_guidelines.md)
- [ClawChain harness PR](https://github.com/clawinfra/claw-chain/pull/64)
- [EvoClaw harness PR](https://github.com/clawinfra/evoclaw/pull/27)
