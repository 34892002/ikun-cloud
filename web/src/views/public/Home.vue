<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NButton, NSpace, NList, NListItem, NTag, NEmpty, NText } from 'naive-ui'
import { api } from '@/api/request'
import { useUserStore } from '@/stores/user'

const router = useRouter()
const userStore = useUserStore()

interface Announcement {
  id: number; title: string; content: string; isActive: number; createdAt: string
}

interface SiteInfo {
  siteName: string; registrationOpen: boolean; registerMode: string
}

const announcements = ref<Announcement[]>([])
const siteInfo = ref<SiteInfo>({ siteName: 'ikun-cloud', registrationOpen: false, registerMode: 'closed' })

onMounted(async () => {
  try {
    const [annData, infoData] = await Promise.all([
      api.get<Announcement[]>('/public/announcements'),
      api.get<SiteInfo>('/public/site-info'),
    ])
    announcements.value = annData
    siteInfo.value = infoData
  } catch {}
})
</script>

<template>
  <div style="min-height: 100vh; background: #f5f5f5">
    <!-- 顶栏 -->
    <div style="background: #fff; border-bottom: 1px solid #e0e0e0; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center">
      <n-text strong style="font-size: 20px">🐔 {{ siteInfo.siteName }}</n-text>
      <n-space>
        <n-button v-if="userStore.isLoggedIn" type="primary" @click="router.push(userStore.isAdmin ? '/admin/dashboard' : '/user/dashboard')">
          进入控制台
        </n-button>
        <template v-else>
          <n-button @click="router.push('/login')">登录</n-button>
          <n-button v-if="siteInfo.registerMode !== 'closed'" type="primary" @click="router.push('/register')">注册</n-button>
        </template>
      </n-space>
    </div>

    <!-- 内容 -->
    <div style="max-width: 800px; margin: 40px auto; padding: 0 24px">
      <n-space vertical :size="24">
        <!-- 站点介绍 -->
        <n-card>
          <n-space vertical :size="8">
            <n-text strong style="font-size: 18px">欢迎使用 {{ siteInfo.siteName }}</n-text>
            <n-text depth="3">基于 Cloud Hypervisor 的轻量 VPS 管理面板，在普通云服务器上"切小鸡"给朋友使用。</n-text>
          </n-space>
        </n-card>

        <!-- 公告 -->
        <n-card title="📢 网站公告">
          <n-list v-if="announcements.length > 0" bordered>
            <n-list-item v-for="ann in announcements" :key="ann.id">
              <n-space vertical :size="4">
                <n-space align="center">
                  <n-text strong>{{ ann.title }}</n-text>
                  <n-text depth="3" style="font-size: 12px">{{ ann.createdAt }}</n-text>
                </n-space>
                <n-text>{{ ann.content }}</n-text>
              </n-space>
            </n-list-item>
          </n-list>
          <n-empty v-else description="暂无公告" />
        </n-card>
      </n-space>
    </div>
  </div>
</template>
