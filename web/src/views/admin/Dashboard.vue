<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { NGrid, NGi, NCard, NStatistic, NSpin, NSpace } from 'naive-ui'
import { useLiveMetrics, type DashboardData } from '@/composables/useLiveMetrics'

const { subscribeDashboard, unsubscribeDashboard } = useLiveMetrics()

const loading = ref(true)
const data = ref<DashboardData | null>(null)

function formatBytes(bytes: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  if (i < 0 || i >= sizes.length) return '0 B'
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

onMounted(() => {
  subscribeDashboard((d) => {
    data.value = d
    loading.value = false
  })
})

onBeforeUnmount(() => {
  unsubscribeDashboard()
})
</script>

<template>
  <n-spin :show="loading">
    <n-space vertical :size="24">
      <h2 style="margin: 0">管理员仪表盘</h2>

      <!-- VM 统计 -->
      <n-grid :cols="4" :x-gap="16" :y-gap="16" v-if="data">
        <n-gi>
          <n-card><n-statistic label="VM 总数" :value="data.vms.total" /></n-card>
        </n-gi>
        <n-gi>
          <n-card><n-statistic label="运行中" :value="data.vms.running" :value-style="{ color: '#18a058' }" /></n-card>
        </n-gi>
        <n-gi>
          <n-card><n-statistic label="已停止" :value="data.vms.stopped" :value-style="{ color: '#d03050' }" /></n-card>
        </n-gi>
        <n-gi>
          <n-card><n-statistic label="异常" :value="data.vms.error" :value-style="{ color: '#f0a020' }" /></n-card>
        </n-gi>
      </n-grid>

      <!-- 宿主机状态 -->
      <n-grid :cols="4" :x-gap="16" :y-gap="16" v-if="data">
        <n-gi>
          <n-card title="CPU">
            <n-statistic label="使用率" :value="`${data.host.cpu.usage}%`" />
            <div style="margin-top: 8px; color: #999; font-size: 12px">{{ data.host.cpu.cores }} 核</div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card title="内存">
            <n-statistic label="使用率" :value="`${data.host.memory.usage}%`" />
            <div style="margin-top: 8px; color: #999; font-size: 12px">{{ formatBytes(data.host.memory.used) }} / {{ formatBytes(data.host.memory.total) }}</div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card title="Swap">
            <n-statistic label="使用率" :value="`${data.host.swap.usage}%`" />
            <div style="margin-top: 8px; color: #999; font-size: 12px">{{ formatBytes(data.host.swap.used) }} / {{ formatBytes(data.host.swap.total) }}</div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card title="磁盘">
            <n-statistic label="使用率" :value="`${data.host.disk.usage}%`" />
            <div style="margin-top: 8px; color: #999; font-size: 12px">{{ formatBytes(data.host.disk.used) }} / {{ formatBytes(data.host.disk.total) }}</div>
          </n-card>
        </n-gi>
      </n-grid>

      <!-- 母鸡流量 -->
      <n-grid :cols="1" :x-gap="16" :y-gap="16" v-if="data">
        <n-gi>
          <n-card title="流量 (母鸡)">
            <n-space justify="space-around">
              <n-statistic label="↓ 接收" :value="formatBytes(data.host.network.rxBytes)" :value-style="{ color: '#2080f0' }" />
              <n-statistic label="↑ 发送" :value="formatBytes(data.host.network.txBytes)" :value-style="{ color: '#18a058' }" />
            </n-space>
          </n-card>
        </n-gi>
      </n-grid>
    </n-space>
  </n-spin>
</template>
