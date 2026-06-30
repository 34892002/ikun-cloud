/**
 * 认证与权限中间件（P1 租户系统）
 */
import type { Context, Next } from 'hono'
import { verify } from 'jsonwebtoken'
import { error } from '@/utils/response'

const JWT_SECRET = process.env.JWT_SECRET || 'ikun-cloud-secret-key-change-in-production'

export type UserRole = 'root' | 'user'

export interface JwtPayload {
  userId: number
  username: string
  role: UserRole
}

// 扩展 Hono Context 的变量类型
declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload | null
  }
}

/**
 * authenticate — 解析 JWT，注入 user（不拦截，无 token 则 user=null）
 */
export async function authenticate(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    c.set('user', null)
    await next()
    return
  }

  const token = authHeader.substring(7)

  try {
    const payload = verify(token, JWT_SECRET) as JwtPayload
    c.set('user', payload)
  } catch {
    c.set('user', null)
  }

  await next()
}

/**
 * requireAuth — 校验已登录
 */
export async function requireAuth(c: Context, next: Next) {
  const user = c.get('user')
  if (!user) {
    return c.json(error('未授权，请先登录', 401), 401)
  }
  await next()
}

/**
 * requireRole — 校验角色
 */
export function requireRole(...roles: UserRole[]) {
  return async (c: Context, next: Next) => {
    const user = c.get('user')
    if (!user) {
      return c.json(error('未授权，请先登录', 401), 401)
    }
    if (!roles.includes(user.role)) {
      return c.json(error('权限不足', 403), 403)
    }
    await next()
  }
}

export { JWT_SECRET }
