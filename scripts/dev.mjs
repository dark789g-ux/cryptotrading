import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 1. 启动 postgres
const db = spawn('pnpm', ['db:start'], { stdio: 'inherit', shell: true, cwd: root })
db.on('exit', (code) => {
  if (code !== 0) process.exit(code)

  // 2. 后台启动 server
  const server = spawn('pnpm', ['--filter', '@cryptotrading/server', 'dev'], {
    stdio: 'inherit', shell: true, cwd: root, detached: true,
  })
  server.unref()

  // 3. 等待端口 3000 就绪后启动 web
  import('wait-on').then(({ waitOn }) => {
    waitOn({ resources: ['tcp:3000'], timeout: 60000 })
      .then(() => {
        console.log('\n✓ 后端已就绪，启动前端...\n')
        const web = spawn('pnpm', ['--filter', '@cryptotrading/web', 'dev'], {
          stdio: 'inherit', shell: true, cwd: root,
        })
        // Ctrl+C 时同时关掉 server
        process.on('SIGINT', () => { server.kill(); web.kill(); process.exit() })
      })
      .catch((err) => {
        console.error('等待后端超时:', err.message)
        server.kill()
        process.exit(1)
      })
  })
})
