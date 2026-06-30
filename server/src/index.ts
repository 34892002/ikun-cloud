/**
 * ikun-cloud API Server（P1 租户系统）
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { errorHandler } from '@/middleware/error-handler'
import { authenticate } from '@/middleware/auth'
import publicRoutes from '@/routes/public'
import userRoutes from '@/routes/user'
import adminRoutes from '@/routes/admin'
import { startMetricsCollector } from '@/services/metrics'
import { addClient, removeClient, handleMessage, startPush } from '@/services/ws-broadcast'
import { seedDefaults } from '@/db/seed'
import { join } from 'node:path'
import { verify } from 'jsonwebtoken'
import type { JwtPayload } from '@/middleware/auth'

seedDefaults()

const app = new Hono()

app.use('*', logger())
app.use('*', cors())
app.use('*', errorHandler)

// 全局认证解析（不拦截，注入 user 到 context）
app.use('*', authenticate)

// API 路由
app.route('/api/public', publicRoutes)
app.route('/api/user', userRoutes)
app.route('/api/admin', adminRoutes)

const port = Number(process.env.PORT) || 3000
const distPath = join(process.cwd(), '..', 'web', 'dist')
const JWT_SECRET = process.env.JWT_SECRET || 'ikun-cloud-secret-key-change-in-production'

console.log(`🚀 ikun-cloud running at http://localhost:${port}`)

// 启动采集
startMetricsCollector()
startPush()

// 显式 Bun.serve 以支持 WebSocket
const server = Bun.serve({
  port,
  async fetch(request: Request) {
    const url = new URL(request.url)

    // WebSocket 升级
    if (url.pathname === '/api/ws') {
      const token = url.searchParams.get('token')
      if (!token) return new Response('Unauthorized', { status: 401 })
      try {
        verify(token, JWT_SECRET) as JwtPayload
      } catch {
        return new Response('Unauthorized', { status: 401 })
      }
      const ok = server.upgrade(request, { data: { token } })
      if (ok) return undefined as any
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // Hono API 路由
    const response = await app.fetch(request)
    // API 路径直接返回（包括 404 JSON），不走 SPA fallback
    if (url.pathname.startsWith('/api/')) return response
    if (response.status !== 404) return response

    // 静态文件
    let filePath = join(distPath, url.pathname)
    if (!url.pathname.includes('.')) {
      filePath = join(distPath, 'index.html')
    }
    const file = Bun.file(filePath)
    if (await file.exists()) return new Response(file)

    return response
  },
  websocket: {
    open(ws: any) {
      addClient(ws)
    },
    close(ws: any) {
      removeClient(ws)
    },
    message(ws: any, message: any) {
      handleMessage(ws, String(message))
    },
  },
})

export default server
