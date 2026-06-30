<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NGrid, NGi, NCard, NStatistic, NSpin, NSpace, NButton, NTag } from 'naive-ui'
import { api } from '@/api/request'

const router = useRouter()
const loading = ref(true)

interface VM {
  id: string; name: string; status: string; cpus: number; memoryMb: number
  diskGb: number; sshPort: number
}

const vms = ref<VM[]>([])

const stats = ref({ total: 0, running: 0, stopped: 0, error: 0 })

onMounted(async () => {
  try {
    const data = await api.get<{ items: VM[] }>('/user/vms')
    vms.value = data.items
    stats.value = {
      total: data.items.length,
      running: data.items.filter(v => v.status === 'running').length,
      stopped: data.items.filter(v => v.status === 'stopped').length,
      error: data.items.filter(v => v.status === 'error').length,
    }
  } catch {} finally { loading.value = false }
})
</script>

<template>
  <n-spin :show="loading">
    <n-space vertical :size="24">
      <n-space justify="space-between" align="center">
        <h2 style="margin: 0">我的仪表盘</h2>
        <n-button type="primary" @click="router.push('/user/vms')">管理我的小鸡</n-button>
      </n-space>

      <n-grid :cols="4" :x-gap="16" :y-gap="16">
        <n-gi>
          <n-card><n-statistic label="我的 VM" :value="stats.total" /></n-card>
        </n-gi>
        <n-gi>
          <n-card><n-statistic label="运行中" :value="stats.running" :value-style="{ color: '#18a058' }" /></n-card>
        </n-gi>
        <n-gi>
          <n-card><n-statistic label="已停止" :value="stats.stopped" :value-style="{ color: '#d03050' }" /></n-card>
        </n-gi>
        <n-gi>
          <n-card><n-statistic label="异常" :value="stats.error" :value-style="{ color: '#f0a020' }" /></n-card>
        </n-gi>
      </n-grid>

      <!-- 我的 VM 列表 -->
      <n-card title="我的小鸡" v-if="vms.length > 0">
        <n-space vertical :size="8">
          <n-card v-for="vm in vms" :key="vm.id" size="small" hoverable style="cursor: pointer" @click="router.push(`/user/vms/${vm.id}`)">
            <n-space justify="space-between" align="center">
              <n-space align="center">
                <n-tag :type="vm.status === 'running' ? 'success' : 'error'" size="small" bordered>
                  {{ vm.status === 'running' ? '运行中' : '已停止' }}
                </n-tag>
                <span style="font-weight: bold">{{ vm.name }}</span>
                <span style="color: #999; font-size: 12px">{{ vm.cpus }}C / {{ vm.memoryMb }}MB / {{ vm.diskGb }}GB</span>
              </n-space>
              <n-button size="small" text type="primary">详情 →</n-button>
            </n-space>
          </n-card>
        </n-space>
      </n-card>
    </n-space>
  </n-spin>
</template>
