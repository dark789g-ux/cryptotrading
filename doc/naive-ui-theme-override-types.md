# Naive UI 主题覆盖类型陷阱

## 背景

在 `App.vue` 中通过 `GlobalThemeOverrides` 配置 Naive UI 组件主题时，部分直觉上应该存在的属性在类型定义中并不存在，导致 TypeScript 编译报错。

## 结论

配置 Naive UI 主题覆盖前，先查阅对应组件的 theme 类型定义，不要猜测属性名。

## 详情

### 不存在的属性（会导致 TS2353 错误）

```typescript
// 以下属性在 Naive UI v2.41.0 中不存在：
Input: { borderColor: '...' }          // ❌ Input 无 borderColor
Select.peers.InternalSelection: { borderColor: '...' }  // ❌ InternalSelection 无 borderColor
Modal: { borderRadius: '...' }         // ❌ Modal 无 borderRadius
Drawer: { borderRadius: '...' }        // ❌ Drawer 无 borderRadius
```

### 正确做法

通过 `common` 层级的全局变量控制这些样式：

```typescript
common: {
  borderColor: '#D6D3D1',   // 全局边框色，影响所有组件
  borderRadius: '8px',      // 全局圆角
}
```

或使用组件支持的属性（查看类型定义确认）：

```typescript
Input: {
  borderRadius: '8px',   // ✅ 存在
  color: '#F5F5F4',      // ✅ 存在
  fontSizeMedium: '16px' // ✅ 存在
}
```

### 查找可用属性的方法

在 IDE 中跳转到 `naive-ui` 的类型定义：
```
node_modules/naive-ui/es/[component]/styles/light.d.ts
```
或使用 TypeScript 的自动补全功能查看可用 key。
