---
name: folder-organizer
description: 仅手动调用（/folder-organizer），请勿自动触发。
---

## 目标

将指定目录的**直接子项**（文件 + 子目录）按功能/语义归组，整理后直接子项总数 ≤ 10。

---

## 不可移动的文件（保护列表）

无论如何，以下文件**必须留在根目录**，不得移动：

- 入口文件：`index.*`、`main.*`、`app.*`
- 配置文件：`.env`、`.env.*`、`*.config.*`、`tsconfig.*`、`jest.config.*`、`babel.config.*`、`vite.config.*`
- 包管理：`package.json`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`requirements.txt`、`Pipfile`、`pyproject.toml`、`setup.py`
- 构建相关：`Makefile`、`Dockerfile`、`docker-compose.*`
- 隐藏项：所有以 `.` 开头的文件或目录

---

## 工作流

### 第一步：读取并理解目录内容

列出目标目录的所有**直接子项**（不递归深入）：
- 对于**文件**：读取内容，理解其功能和所属领域
- 对于**已有子目录**：扫描其顶层内容，理解该目录的职责
- 识别文件类型、命名规律、功能主题

### 第二步：设计分组方案

目标是让最终直接子项数量 ≤ 10。设计时遵循以下原则：

- 保护列表中的文件原地不动，计入 ≤ 10 的限额
- 已有子目录可以被重命名，或合并进新目录（把其内容移入新目录）
- 新目录命名：英文、小写、用连字符，语义清晰（如 `api-handlers`、`data-models`、`utils`）
- 优先少而宽泛的分组，而非多而细碎的分组——过度细分会让目录同样难以浏览
- 若原本已经 ≤ 10 项，告知用户并询问是否仍要整理

**以清晰格式展示方案**，例如：

```
整理方案（整理后直接子项：X 个）

📁 新建 api-handlers/
   ← route-user.ts    （HTTP 路由：用户相关）
   ← route-order.ts   （HTTP 路由：订单相关）
   ← middleware.ts    （请求中间件）

📁 新建 data-models/
   ← user.model.ts    （数据库模型）
   ← order.model.ts

📁 保留/重命名 utils/ → helpers/
   （原 utils/ 内容不变，仅重命名）

🔒 保留在根目录（不移动）
   - index.ts         （入口文件）
   - package.json
   - tsconfig.json

整理后直接子项：5 个目录 + 2 个文件 = 7 ✅
```

然后问用户：**"方案是否合适？如需调整分组名或归属，请告诉我，确认后开始执行。"**

### 第三步：用户确认后执行

只有在用户明确确认后才开始操作。执行顺序：

1. 创建新目录
2. 将文件移入对应目录（同时记录每个文件的旧路径 → 新路径映射）
3. 若已有目录被合并进新目录：先移动其内容，再删除空的旧目录
4. 若已有目录仅重命名：直接重命名

### 第四步：自动修复全项目 import 路径

文件移动后立即执行，无需再次询问用户。

**目标**：找出所有因文件位置变化而失效的相对 import 路径，分两个方向修复。

#### 哪些路径需要修复

只修复**相对路径 import**（以 `./` 或 `../` 开头），绝对路径和包名不动。

涵盖的语言模式：

| 语言 | 需要扫描的模式 |
|------|--------------|
| JS/TS/Vue | `import ... from './foo'`、`import('./foo')`、`require('./foo')` |
| Python | `from .foo import bar`、`from ..foo import bar`（相对 import） |

#### 两个修复方向

**方向 A：外部文件 → 被移动文件**（其他文件引用了被移动文件）

文件被移动后，引用它的其他文件里的路径会失效。

**方向 B：被移动文件 → 未移动文件**（被移动文件内部引用了留在原地的文件）

文件被移动后，其自身内部的相对路径基准改变，原本正确的 `./foo` 或 `../bar` 可能指向错误位置。**这是最容易遗漏的方向。**

> 例：`composables/utils.ts` 移入 `composables/helpers/utils.ts`，内部有 `import from '../useApi'`，移动后变成指向 `composables/useApi`（少了一层），需改为 `../../useApi`。

#### 执行步骤

1. **建立移动映射表**：整理第三步的操作，得到所有被移动文件的 `旧绝对路径 → 新绝对路径` 列表。目录重命名等同于其下所有文件都被移动。

2. **方向 A：搜索外部引用**：
   - 对每个被移动的文件，用 Grep 搜索其文件名（含 `.vue` 等后缀的文件要同时搜带后缀和不带后缀两种形式）在整个项目中的出现位置
   - 只关注 import 语句行，确认路径解析后确实指向被移动的文件（排除同名误判）
   - 从发起 import 的文件所在目录，到被移动文件的**新位置**，计算新相对路径并替换

3. **方向 B：修复被移动文件内部的 import**：
   - 读取每个被移动文件的内容，找出其中所有相对路径 import
   - 对每条相对路径，从文件的**旧位置**解析它原本指向的目标文件的绝对路径
   - 从文件的**新位置**重新计算到该目标文件的相对路径
   - 若新旧路径不同，就地替换

4. **就地更新 import 语句**：用 Edit 工具替换原有路径字符串，保留 import 语句的其余部分不变。

#### 示例

```
移动：src/composables/format.ts → src/composables/helpers/format.ts

方向 A：外部引用修复
  发现 src/components/Button.vue 有：
    import { fmt } from '../composables/format'
  新相对路径：'../composables/helpers/format'
  → 更新

方向 B：内部 import 修复
  format.ts 内部有：
    import { API_BASE } from '../useApi'
  旧位置（src/composables/）解析到：src/useApi.ts ✓
  新位置（src/composables/helpers/）出发，到 src/useApi.ts：'../../useApi'
  → 更新为 '../../useApi'
```

#### 完成后输出

在操作摘要中加一节：

```
🔗 import 路径修复
  方向 A（外部 → 被移动文件）
  - Button.vue: '../composables/format' → '../composables/helpers/format'

  方向 B（被移动文件内部）
  - helpers/format.ts: '../useApi' → '../../useApi'

  共修复 N 处，未发现遗漏。
```

若某个被移动文件没有外部引用且内部无相对 import，注明"无需修复，跳过"。

### 第五步：运行 lint 验证

import 路径修复完成后，自动运行 lint 工具检查是否有残留错误。

#### 检测可用的 lint 工具

按以下顺序探测项目根目录及受影响目录，找到什么就运行什么：

| 检测条件 | 运行命令 |
|----------|---------|
| 存在 `tsconfig.json` 且有 `.vue` 文件 | `pnpm exec vue-tsc --noEmit` |
| 存在 `tsconfig.json`（纯 TS 项目） | `pnpm exec tsc --noEmit` |
| `package.json` 中有 `eslint` 依赖 | `pnpm exec eslint <整理的目录>` |
| 存在 `.flake8` / `setup.cfg` / `pyproject.toml`（含 flake8 配置） | `flake8 <整理的目录>` |
| 存在 `mypy.ini` 或 `pyproject.toml`（含 mypy 配置） | `mypy <整理的目录>` |

若以上均不存在，告知用户"未检测到 lint 工具，跳过验证"。

#### 处理 lint 结果

- **无报错**：在摘要中输出 `✅ lint 通过，无错误`
- **有报错**：列出错误信息，分析哪些是由本次移动引起的（路径未更新、文件未找到等），尝试修复；修复后再次运行 lint 确认
- **lint 工具本身不可用**（命令未找到）：告知用户并跳过

---

## 注意事项

- 只处理**指定目录的直接子项**，不递归整理更深层的目录
- 移动文件，不复制——禁止产生重复文件
- Windows 环境优先用 PowerShell 的 `Move-Item`；Unix 用 `mv`
- 若语义归属模糊，宁可放入更宽泛的分组（如 `misc/`），也不要强行细分
- 操作前确认目录存在且可写
- import 路径修复只改相对路径，绝对路径和 node_modules 包名一律不动
- 若项目有 `tsconfig.json` / `jsconfig.json` 的 `paths` 别名，别名路径不需要修改
