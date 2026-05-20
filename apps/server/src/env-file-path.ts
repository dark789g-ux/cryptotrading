import * as fs from 'fs';
import * as path from 'path';

// 不能靠数 `../` 层数定位仓库根：nest 构建产物的嵌套深度随
// nest-cli.json 的 entryFile / tsconfig rootDir 变化（实测产物在
// apps/server/dist/apps/server/src/main.js，比 src 运行时深 3 级），
// 写死层数会让 dist 运行时把 .env 指到不存在的路径、dotenv 静默落空。
// 故从 __dirname 逐级上溯，找含 pnpm-workspace.yaml 的目录作为仓库根。
function findRepoRoot(start: string): string {
  let dir = start;
  // 上溯直到文件系统根
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // 兜底：未找到标志文件时退回原始 3 级假设，至少不抛异常
      return path.resolve(start, '../../../');
    }
    dir = parent;
  }
}

export const REPO_ENV_PATH = path.join(findRepoRoot(__dirname), '.env');
