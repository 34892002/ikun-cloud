/**
 * 用户状态管理（P1 租户系统）
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/request'

interface UserInfo {
  id: number
  username: string
  role: 'root' | 'user'
}

export const useUserStore = defineStore('user', () => {
  const token = ref<string>(localStorage.getItem('token') || '')
  const userInfo = ref<UserInfo | null>(null)

  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => userInfo.value?.role === 'root')

  async function login(username: string, password: string, capToken?: string) {
    const data = await api.post<{ token: string; user: UserInfo }>('/public/login', {
      username,
      password,
      capToken,
    })
    token.value = data.token
    userInfo.value = data.user
    localStorage.setItem('token', data.token)
  }

  async function fetchUserInfo() {
    if (!token.value) return
    try {
      const data = await api.get<UserInfo>('/user/me')
      userInfo.value = data
    } catch {
      logout()
    }
  }

  function logout() {
    token.value = ''
    userInfo.value = null
    localStorage.removeItem('token')
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    isAdmin,
    login,
    fetchUserInfo,
    logout,
  }
})
