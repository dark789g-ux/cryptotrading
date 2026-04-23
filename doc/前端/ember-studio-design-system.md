# Ember Studio 设计系统迁移

## 背景

2026-04-13 前端从 glassmorphism（毛玻璃+蓝紫渐变）迁移至 Ember Studio 暖色大地色调设计系统。完整设计规范见 `.prompts/design-Ember-studio.md`。

## 结论

所有 UI 开发遵循 Ember Studio 规范：赤陶土主色、暖白表面、衬线标题字体、无毛玻璃效果。

## 详情

### 色彩映射

| 用途 | 旧值 | 新值（Ember） |
|------|------|---------------|
| 主色 | `#667eea`（蓝紫渐变） | `#C2410C`（赤陶土） |
| 主色悬浮 | `#7c8ff0` | `#9A3412`（烧赭色） |
| 强调色 | `#3b82f6` | `#F59E0B`（琥珀） |
| 背景 | `linear-gradient(#f5f7fa, #e4e8ec)` | `#FAFAF9`（暖白） |
| 表面/卡片 | `rgba(255,255,255,0.7)` + blur | `#F5F5F4`（实色米白） |
| 悬浮表面 | `rgba(255,255,255,0.8)` | `#E7E5E4` |
| 主文字 | `rgba(0,0,0,0.9)` | `#1C1917`（暖近黑） |
| 次要文字 | `rgba(0,0,0,0.6)` | `#57534E` |
| 边框 | `rgba(255,255,255,0.5)` | `#D6D3D1`（暖灰） |

### CSS 变量

- 旧 `--glass-*` 变量名保留但值已映射到 Ember 色值（向后兼容）
- 新代码应使用 `--ember-*` 变量：`--ember-primary`、`--ember-surface`、`--ember-text` 等
- 定义在 `apps/web/src/styles/glassmorphism.css`（文件名未改，内容已完全重写）

### 字体栈

| 用途 | 字体 | 字重 |
|------|------|------|
| 标题（h1-h3） | Playfair Display | 700, letter-spacing -0.02em |
| 正文/UI | Source Sans 3 | 400（正文）、600（强调） |
| 代码/日志 | Fira Code | 400, 启用连字 |

通过 `index.html` 的 Google Fonts `<link>` 加载。

### 圆角规范

- 按钮/输入框：8px
- 卡片/面板/模态框：12px
- 标签片/头像/进度条：9999px
- 行内代码/小徽章：4px

### Naive UI 主题覆盖

在 `App.vue` 中通过 `themeOverrides` 对象统一配置，`:theme="null"` 强制浅色模式。

### 深色模式

当前仅实现浅色模式。`useTheme.ts` 已简化，仅导出 `echartsTheme`。`isDark`、`toggleTheme`、`theme` 已移除。侧边栏的深色/浅色切换按钮已移除。
