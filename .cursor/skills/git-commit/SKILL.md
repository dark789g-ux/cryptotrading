---
name: git-commit
description: 用户输入"提交代码"时触发，Claude 根据当前 git 改动分析生成符合 Conventional Commits 规范的 message，经用户确认后完成提交。
---

## 目标

分析当前 git 改动，生成准确的 Conventional Commits message，经用户确认后完成提交。

## 步骤

### 1. 收集改动信息

并行执行：

```bash
git status --short
git diff HEAD
```

如果 `git diff HEAD` 为空（所有改动已暂存），改用：

```bash
git diff --cached
```

### 2. 分析改动，起草 commit message

根据 diff 内容推断：

- **type**：从下表选最贴切的一个
- **scope**（可选）：改动所在模块或文件夹，如 `auth`、`api`、`web`
- **description**：一句话说清楚"做了什么"，用祈使句，不超过 72 字符
- **body**（可选）：改动较多或原因不明显时补充说明

| type | 适用场景 |
|------|---------|
| feat | 新功能 |
| fix | bug 修复 |
| refactor | 重构（不改功能） |
| perf | 性能优化 |
| style | 格式调整（不影响逻辑） |
| test | 测试相关 |
| docs | 文档 |
| chore | 构建、依赖、配置 |
| build | 构建系统或外部依赖变更 |
| ci | CI/CD 配置 |

格式：

```
<type>[(scope)]: <description>

[body]
```

**写 description 的原则**：说结果，不说过程。"add user login endpoint" 好过 "modify user controller to handle login requests"。

### 3. 展示草稿，等待确认

把起草的 message 展示给用户，询问是否直接提交，或需要修改。**不要跳过这一步直接提交。**

### 4. 暂存改动文件

只暂存有实际改动的文件，不要用 `git add .`：

```bash
git add <file1> <file2> ...
```

文件列表从 `git status --short` 的输出中提取。

### 5. 运行 lint 检查

根据项目类型运行对应检查。此项目为 pnpm monorepo：

- 前端改动（`apps/web`）：`cd apps/web && pnpm exec vue-tsc --noEmit`
- 后端改动（`apps/server`）：`cd apps/server && pnpm exec tsc --noEmit`
- 两者都有则都跑

如果 lint 失败，**停下来**告知用户错误，不要继续提交。等用户修复后重新触发。

### 6. 提交

```bash
git commit -m "$(cat <<'EOF'
<最终 message>
EOF
)"
```

提交成功后告知用户，并提示如需 push 可手动执行 `git push`。

## 注意事项

- 不要自动 push
- 不要跳过用户确认直接提交
- scope 根据实际改动判断，不确定时省略
- description 用中文
