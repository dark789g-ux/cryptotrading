---
paths:
  - "apps/web/**/*.{vue,ts}"
---

# Vue 3 / 前端

## watch 默认懒执行

`watch(source, cb)` 默认懒执行，**不响应初始值**；依赖初始值必须 `{ immediate: true }` 或在 `onMounted` 中补充调用。

## v-if vs v-show 决定异步加载时机

父组件 `v-if`（挂载即展示）vs `v-show`（常驻切换）决定异步加载的触发时机，组件内"开启时触发"逻辑必须先确认。

## `<keep-alive>` 规范

被缓存的组件，`onMounted` 只在首次挂载触发一次，切回不重跑。

依赖"外部 store 可能在其它页面被更新"的异步数据加载（策略命中、用户配置等）必须放 `onActivated`；`onMounted` 仅保留真正一次性初始化。

**响应性陷阱**：`computed` 会响应 store 变化（UI 下拉框正确），而 `onMounted` 加载的普通 `ref` 不会自动刷新，遇到"下拉框有选项但数据不更新"优先排查 keep-alive 缓存。

## Modal 统一复用 AppModal

统一复用 `@/components/common/AppModal.vue`，避免直接 `n-modal`。

AppModal 操作按钮统一放 `#actions` slot，子组件内部禁止自带"保存/取消"按钮（防双重按钮）。

## 条件/表达式构建器规范

凡涉及"比较"的 UI（条件筛选、策略规则、阈值配置），比较目标必须**同时支持字段引用和常量值**两种类型由用户切换，禁止硬编码单一类型。

## 动态字段映射规范

新增支持用户选字段的查询模块必须：
1. 建立 `FIELD_COL_MAP`（前端字段名 → `表别名.列名`）
2. 跳过未知字段记 `logger.warn`
3. 有前提约束的操作符（如上穿/下穿仅限单表指标）在映射表层面校验字段所属表，不满足 warn + skip
4. 前端操作符列表同步反映约束（`disabled`），不能仅靠后端防御

## Naive UI 自定义选项类型

自定义接口用于 `<n-select :options>` 必须 `extends SelectOption`（`import type { SelectOption } from 'naive-ui'`），禁重复声明 `label/value`，否则与 `SelectMixedOption` 判别联合不兼容、`vue-tsc` 报错。

## 修改 import 块后必须立即回读文件头部验证顺序

不得依赖 linter 代替人工确认。

## `defineProps`/`withDefaults` 默认值禁引用 `<script setup>` 局部变量

`defineProps`/`withDefaults` 会被编译器提升到 `setup()` 之外，其 default 工厂内**不能引用** `<script setup>` 里声明的局部 `const`/函数，否则 `@vue/compiler-sfc` 直接报错（"default value ... cannot reference locally declared variables"）。

默认值一律用**内联字面量**，或模块顶层 `import` 进来的常量。

**陷阱**：`vue-tsc --noEmit` 查不出这条 SFC 编译规则错（见下条）。曾因 `withDefaults` 默认工厂引用局部 const，让某懒加载路由整条 vite 转换 500、页面白屏，而 type-check 全绿。

## 前端改动合并前必跑 `vite build`，不能只信 type-check

`pnpm --filter @cryptotrading/web type-check`（`vue-tsc --noEmit`）只做**类型检查**，**不等于 SFC 编译**。模板/宏（`defineProps`/`withDefaults`/`defineEmits`）编译错、SFC 转换错只有 **`pnpm --filter @cryptotrading/web build`（vite）或真机 dev** 才暴露。

涉及 `.vue` 的改动合并前至少跑一次 `vite build`；动到**懒加载路由 / 共享组件**的，再真机点开对应页面确认不白屏。

**教训**：type-check + vitest 全绿的前端提交，曾把 `/money-flow` 整条路由的 SFC 编译崩溃带进 git 历史，直到浏览器实跑才发现。**绿着的 type-check 不代表页面能打开。**
