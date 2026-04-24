# 规范：接口字段完整性（Interface Completeness）

## BUG 案例

**发生时间**：2026-04-18  
**报错**：
```
src/backtest/engine/data.service.ts:80:52 - error TS2339:
Property 'lookbackBuffer' does not exist on type 'BacktestConfig'.
```

**根因**：  
`data.service.ts` 中新增了对 `config.lookbackBuffer` 的读取，但未同步在以下两处声明：
1. `BacktestConfig` 接口定义（`models.ts`）
2. `DEFAULT_CONFIG` 常量（`models.ts`）

TypeScript 编译器在 `nest start` 时发现字段缺失，直接拒绝编译，后端无法启动。

---

## 规范

### 1. 接口、默认值、使用三处必须同步

每当在代码中**读取** Config / DTO / Options 对象的某个字段时，必须确认以下三处已同步：

| 步骤 | 检查点 | 文件位置 |
|------|--------|----------|
| ① | 接口 / 类型中已声明该字段 | `models.ts` / `*.dto.ts` / `*.entity.ts` |
| ② | 默认值对象中已赋初始值 | `DEFAULT_CONFIG` / 工厂函数 |
| ③ | 前端传参 / 数据库存储已包含该字段 | Controller / Entity / 前端表单 |

> 缺任意一处，编译报错或运行时 `undefined` 静默失效。

### 2. 新增字段的标准流程

```
models.ts 接口 → models.ts DEFAULT_CONFIG → 使用处（service/engine）→ DTO（若对外暴露）→ 前端表单（若需用户配置）
```

不得跳步，不得"先用再补"。

### 3. 字段命名与注释

- Config 接口中每个字段必须有行内注释说明语义和单位，例如：
  ```ts
  lookbackBuffer: number;   // 截取 maxBacktestBars 时额外保留的回溯缓冲根数
  ```
- 默认值旁注明推荐范围或来源，便于后续调参。

### 4. 本地验证命令

改动 `models.ts` 或任何 engine 文件后，在提交前执行：
```bash
cd apps/server && npx tsc --noEmit
```
零报错才算完成，禁止依赖 `nest start` 作为唯一编译验证。
