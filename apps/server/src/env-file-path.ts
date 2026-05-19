import * as path from 'path';

// __dirname 在 src/main.ts、src/app.module.ts、以及构建产物
// dist/main.js、dist/app.module.js 中均位于 apps/server 下一级，
// 故统一向上三级到仓库根：
//   apps/server/{src|dist} → apps/server → apps → 仓库根
export const REPO_ENV_PATH = path.resolve(__dirname, '../../../.env');
