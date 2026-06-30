/**
 * API 请求封装（统一拦截器）
 */
import { useUserStore } from '@/stores/user'
import { createDiscreteApi } from 'naive-ui'

interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

const BASE_URL = '/api'

// 独立 API（可在 Vue 组件外使用）
const { message } = createDiscreteApi(['message'])

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options

  const userStore = useUserStore()

  const config: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  }

  if (userStore.token) {
    config.headers = {
      ...config.headers,
      Authorization: `Bearer ${userStore.token}`,
    }
  }

  if (body) {
    config.body = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${url}`, config)
  } catch {
    message.error('网络连接失败，请检查网络')
    throw new Error('网络连接失败')
  }

  // ========== 统一拦截 ==========

  // 401 未授权 → 清除登录态，跳转登录页
  if (response.status === 401) {
    userStore.logout()
    message.warning('登录已过期，请重新登录')
    window.location.href = '/login'
    throw new Error('未授权，请重新登录')
  }

  // 403 权限不足 → 提示并跳转到对应首页
  if (response.status === 403) {
    message.error('权限不足')
    if (userStore.isAdmin) {
      window.location.href = '/admin/dashboard'
    } else {
      window.location.href = '/user/dashboard'
    }
    throw new Error('权限不足')
  }

  // 404
  if (response.status === 404) {
    message.error('请求的资源不存在')
    throw new Error('资源不存在')
  }

  // 500+
  if (response.status >= 500) {
    message.error('服务器错误，请稍后重试')
    throw new Error('服务器错误')
  }

  // 解析 JSON
  let result: ApiResponse<T>
  try {
    result = await response.json()
  } catch {
    message.error('响应格式错误')
    throw new Error('响应格式错误')
  }

  // 业务错误码
  if (result.code !== 0) {
    throw new Error(result.message || '请求失败')
  }

  return result.data
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) => request<T>(url, { method: 'POST', body }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PUT', body }),
  patch: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PATCH', body }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}

export type { ApiResponse }
