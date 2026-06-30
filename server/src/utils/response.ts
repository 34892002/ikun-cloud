/**
 * 统一响应格式工具
 */

export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

export function success<T>(data: T, message = 'ok'): ApiResponse<T> {
  return { code: 0, message, data }
}

export function error(message: string, code = -1): ApiResponse<null> {
  return { code, message, data: null }
}
