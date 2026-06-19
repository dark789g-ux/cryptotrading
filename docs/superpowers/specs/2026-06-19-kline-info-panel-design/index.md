# K 线右侧标的信息面板设计（索引）

- **日期**：2026-06-19
- **范围**：`apps/web`（三种标的详情面板）
- **状态**：待实现

## 项目背景与目标摘要

在标的详情面板（K 线图视图）中，目前只有 K 线图本身。用户查看某标的 K 线时，无法在同一屏看到该标的的基本面 / 分类 / 行情属性，需切到列表列或 Drawer 头部。

**目标**：在 K 线图右侧增加一个可折叠 / 展开的竖向信息侧栏，展示当前选中标的的相关属性。折叠后侧栏完全隐藏，仅在 K 线工具栏留一个触发按钮，使 K 线获得最大可视化空间。

**覆盖范围与分阶段实施**：
- **阶段 1（本次实现）**：A 股（9 字段，数据现成）+ 美股（6 字段，数据现成）。两者数据均已在列表行 `row` 中，无需后端改动。
- **阶段 2（后续独立任务）**：加密面板。需先补建后端 `pct_chg` 列（klines 表无此列，需 migration + 同步逻辑回填 + 后端 SELECT + 前端类型），详见 `./03-fields.md` §3.3。

**关键决策**：
- 方案 A（共享 `KlineWithInfoPanel` 包装组件 + 插槽注入按类型差异化字段）
- A 股 / 美股数据全部来自列表行 `row` 快照，无需新增请求或后端改动
- 格式化复用现有 `aSharesFormatters.ts`，仅新增 `formatVolumeRatio`
- 默认折叠，状态持久化 localStorage（按标的类型区分 key）
- 容器 < 620px 自动折叠 + 禁用按钮，无过渡动画

## 子文档清单

| 文件 | 内容 |
|---|---|
| [01-context.md](./01-context.md) | 背景与目标、现状摸底（file:line 为证）、方案选择 |
| [02-architecture.md](./02-architecture.md) | 组件架构（KlineWithInfoPanel / InfoRow / *InfoFields） |
| [03-fields.md](./03-fields.md) | 字段表与格式化映射、数据口径 |
| [04-layout.md](./04-layout.md) | 布局 ASCII、错误处理 |
| [05-implementation.md](./05-implementation.md) | 改动清单、测试策略、验证标准 |

## 建议阅读顺序

1. `01-context.md` —— 理解背景与现状（含现有格式化函数清单）
2. `02-architecture.md` —— 组件设计与插槽契约
3. `03-fields.md` —— 三种标的的字段表（实现 *InfoFields 时查阅）
4. `04-layout.md` —— 布局与边界处理
5. `05-implementation.md` —— 落地清单与测试

## 跨文档引用约定

- 子文档间引用优先用文字描述定位（如"见 03-fields.md §3.1"），避免中文锚点在不同 Markdown 渲染器下失效
- 若用锚点，取标题文本小写、空格与标点（含全角括号 `（）`）转/去除为连字符，如 `## 3.1 A 股（AStockInfoFields）` → `#31-a-股astockinfofields`
