# Naive UI 组件必须手动 import

## 背景
项目前端未配置 unplugin-vue-components 自动导入，所有 Naive UI 组件必须在 `<script setup>` 中显式 import。

## 结论
模板中用到的每一个 `n-xxx` 组件，都必须从 `naive-ui` 导入对应的 Pascal-case 名称，否则运行时报 `Failed to resolve component: n-xxx`。

## 详情

错误现象：控制台大量 `[Vue warn]: Failed to resolve component: n-select`、`n-space` 等，组件渲染为空。

正确做法（以 SymbolsView.vue 为例）：

```ts
import {
  NButton, NIcon, NSelect, NSpace, NInput, NBadge, NTag,
  NCard, NDataTable, NInputNumber, NDivider, NEmpty, NDrawer, NDrawerContent,
  useMessage,
} from 'naive-ui'
```

命名规则：`n-data-table` → `NDataTable`，`n-drawer-content` → `NDrawerContent`，依此类推。

新建组件时检查清单：
1. 模板里用了哪些 `n-` 开头的标签？
2. 全部加入 import 列表。
