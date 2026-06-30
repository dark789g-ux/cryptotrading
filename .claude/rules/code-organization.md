# 代码组织

## quant 目录 500 行限制由 CI 强制

`apps/web/src/views/quant/**` 与 `apps/web/src/components/quant/**` 的「单文件 ≤500 行」由 `lint:quant-lines` 在 CI 强制；规则本身（含「不要为压行数把代码写平」）见 `CLAUDE.md` 核心规范。
