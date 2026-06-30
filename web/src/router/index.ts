/**
 * 路由配置（P1 租户系统）
 */
import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // ========== 公开页面 ==========
    {
      path: '/',
      name: 'Home',
      component: () => import('@/views/public/Home.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/public/Login.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/register',
      name: 'Register',
      component: () => import('@/views/public/Register.vue'),
      meta: { requiresAuth: false },
    },

    // ========== 用户页面 ==========
    {
      path: '/user',
      component: () => import('@/layouts/UserLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/user/dashboard',
        },
        {
          path: 'dashboard',
          name: 'UserDashboard',
          component: () => import('@/views/user/Dashboard.vue'),
        },
        {
          path: 'vms',
          name: 'UserVMList',
          component: () => import('@/views/user/VMList.vue'),
        },
        {
          path: 'vms/:id',
          name: 'UserVMDetail',
          component: () => import('@/views/user/VMDetail.vue'),
        },
      ],
    },

    // ========== 管理员页面 ==========
    {
      path: '/admin',
      component: () => import('@/layouts/AdminLayout.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
      children: [
        {
          path: '',
          redirect: '/admin/dashboard',
        },
        {
          path: 'dashboard',
          name: 'AdminDashboard',
          component: () => import('@/views/admin/Dashboard.vue'),
        },
        {
          path: 'vms',
          name: 'AdminVMList',
          component: () => import('@/views/admin/VMList.vue'),
        },
        {
          path: 'vms/:id',
          name: 'AdminVMDetail',
          component: () => import('@/views/admin/VMDetail.vue'),
        },
        {
          path: 'users',
          name: 'AdminUsers',
          component: () => import('@/views/admin/Users.vue'),
        },
        {
          path: 'images',
          name: 'AdminImages',
          component: () => import('@/views/admin/Images.vue'),
        },
        {
          path: 'settings',
          name: 'AdminSettings',
          component: () => import('@/views/admin/Settings.vue'),
        },
        {
          path: 'announcements',
          name: 'AdminAnnouncements',
          component: () => import('@/views/admin/Announcements.vue'),
        },
        {
          path: 'invite-codes',
          name: 'AdminInviteCodes',
          component: () => import('@/views/admin/InviteCodes.vue'),
        },
        {
          path: 'network',
          name: 'AdminNetwork',
          component: () => import('@/views/admin/Network.vue'),
        },
      ],
    },

    // 404
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

router.beforeEach(async (to) => {
  const userStore = useUserStore()

  // 未登录时只允许访问公开页面
  if (to.meta.requiresAuth && !userStore.isLoggedIn) {
    return { name: 'Login' }
  }

  // 已登录时获取用户信息（如果还没有）
  if (userStore.isLoggedIn && !userStore.userInfo) {
    await userStore.fetchUserInfo()
  }

  // admin 路由需要 root 角色
  if (to.meta.requiresAdmin && !userStore.isAdmin) {
    return { name: 'UserDashboard' }
  }

  // 已登录访问登录页 → 跳转到对应首页
  if (to.name === 'Login' && userStore.isLoggedIn) {
    return userStore.isAdmin ? { name: 'AdminDashboard' } : { name: 'UserDashboard' }
  }
})

export default router
