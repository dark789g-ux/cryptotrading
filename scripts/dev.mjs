import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

// 同会话内的子进程，退出时统一清理，避免留下孤儿后端
const children = []
function spawnTracked(cmd, args, opts) {
  const child = spawn(cmd, args, opts)
  children.push(child)
  return child
}

function killAll() {
  for (const child of children) {
    if (!child.pid || child.killed || child.exitCode !== null) continue
    if (isWin) {
      // shell:true 启动时 child.pid 是外层 shell，child.kill() 杀不到真正的
      // nest/node 进程；taskkill /T 按进程树连根杀掉。
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill()
    }
  }
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  killAll()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// 1. 启动 postgres（一次性命令，docker compose up -d 起来后自己退出）
const db = spawn('pnpm', ['db:start'], { stdio: 'inherit', shell: true, cwd: root })
db.on('exit', (code) => {
  if (code !== 0) process.exit(code)

  // 2. 在同一会话前台启动 server（不再 detached，跟随本进程生命周期）
  const server = spawnTracked('pnpm', ['--filter', '@cryptotrading/server', 'dev'], {
    stdio: 'inherit', shell: true, cwd: root,
  })
  server.on('exit', (c) => {
    // 后端意外退出，联动关闭前端并整体退出
    if (!shuttingDown) {
      console.error(`\n后端进程退出（code=${c}），关闭前端...`)
      shutdown(c ?? 1)
    }
  })

  // 3. 等端口 3000 就绪（NestJS app.listen() 是启动最后一步，listen 成功即启动完成），再启动 web
  import('wait-on').then((mod) => {
    const waitOn = mod.default || mod
    waitOn({ resources: ['tcp:3000'], timeout: 60000 })
      .then(() => {
        if (shuttingDown) return
        console.log('\n✓ 后端已就绪，启动前端...\n')
        const web = spawnTracked('pnpm', ['--filter', '@cryptotrading/web', 'dev'], {
          stdio: 'inherit', shell: true, cwd: root,
        })
        web.on('exit', (c) => {
          // 前端退出也整体收摊（连带关后端）
          if (!shuttingDown) shutdown(c ?? 0)
        })
      })
      .catch((err) => {
        console.error('等待后端超时:', err.message)
        shutdown(1)
      })
  })
})
