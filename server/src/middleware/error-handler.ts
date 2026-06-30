/**
 * 全局错误处理中间件
 */
import type { Context, Next } from 'hono'
import { error } from '@/utils/response'

export async function errorHandler(c: Context, next: Next) {
  try {
    await next()
  } catch (err: unknown) {
    console.error('[Error]', err)

    if (err instanceof Error) {
      return c.json(error(err.message), 500)
    }

    return c.json(error('服务器内部错误'), 500)
  }
}
