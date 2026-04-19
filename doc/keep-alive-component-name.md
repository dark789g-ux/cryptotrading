# keep-alive 必须显式声明组件 name

## 背景

Vue 3 `<script setup>` 语法下，组件没有通过 `defineOptions` 显式声明 `name` 时，`<keep-alive include="...">` 的字符串匹配可能失效，导致组件仍然被销毁重建，状态无法保留。

## 结论

使用 `<keep-alive include="XxxView">` 时，目标组件必须用 `defineOptions({ name: 'XxxView' })` 显式声明同名的 `name`。

## 详情

**症状**：切换路由再回来，页面状态（筛选条件、周期选择、分页等）全部重置。

**根因**：`<keep-alive>` 通过组件的 `name` 选项匹配，`<script setup>` 虽然 Vite 会从文件名推断 `__name`，但该值不一定等同于 `keep-alive` 使用的 `name` 属性。

**解法**：

Layout.vue — 包裹 `<keep-alive>`：
```vue
<router-view v-slot="{ Component }">
  <transition name="fade" mode="out-in">
    <keep-alive include="SymbolsView">
      <component :is="Component" />
    </keep-alive>
  </transition>
</router-view>
```

SymbolsView.vue — 显式声明 name（放在 `<script setup>` 第一行）：
```vue
<script setup lang="ts">
defineOptions({ name: 'SymbolsView' })
// ...
</script>
```

**注意**：`include` 中的字符串必须与 `defineOptions` 的 `name` 值完全一致（大小写敏感）。
