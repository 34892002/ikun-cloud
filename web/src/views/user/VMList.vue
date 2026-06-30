<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NButton, NSpace, NDataTable, NTag, useMessage, NPopconfirm } from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'

const router = useRouter()
const message = useMessage()

interface VM {
  id: string; name: string; status: string; cpus: number; memoryMb: number
  diskGb: number; baseImage: string; ip: string; sshPort: number; password?: string
  createdAt: string; managed: string
}

const loading = ref(true)
const vms = ref<VM[]>([])

const columns: DataTableColumns<VM> = [
  { title: 'ID', key: 'id', width: 120 },
  { title: '名称', key: 'name', width: 150 },
  {
    title: '状态', key: 'status', width: 100,
    render(row) {
      const typeMap: Record<string, 'success' | 'error' | 'warning'> = { running: 'success', stopped: 'error', error: 'warning' }
      const labelMap: Record<string, string> = { running: '运行中', stopped: '已停止', error: '异常' }
      return h(NTag, { type: typeMap[row.status] || 'info', bordered: false }, { default: () => labelMap[row.status] || row.status })
    },
  },
  { title: 'IP', key: 'ip', width: 140 },
  { title: 'SSH 端口', key: 'sshPort', width: 100 },
  {
    title: '配置', key: 'config', width: 140,
    render(row) { return `${row.cpus}C / ${row.memoryMb}MB / ${row.diskGb}GB` },
  },
  {
    title: '操作', key: 'actions', width: 220,
    render(row) {
      return h(NSpace, { size: 4 }, {
        default: () => [
          row.status !== 'running' ? h(NButton, { size: 'small', type: 'success', loading: rowActionLoading.value === `start-${row.id}`, onClick: () => handleStart(row.id) }, { default: () => '启动' }) : null,
          row.status === 'running' ? h(NButton, { size: 'small', type: 'warning', loading: rowActionLoading.value === `stop-${row.id}`, onClick: () => handleStop(row.id) }, { default: () => '停止' }) : null,
          row.status === 'running' ? h(NButton, { size: 'small', type: 'info', loading: rowActionLoading.value === `restart-${row.id}`, onClick: () => handleRestart(row.id) }, { default: () => '重启' }) : null,
          h(NButton, { size: 'small', onClick: () => router.push(`/user/vms/${row.id}`) }, { default: () => '详情' }),
        ],
      })
    },
  },
]

async function fetchVms() {
  loading.value = true
  try {
    const data = await api.get<{ items: VM[] }>('/user/vms')
    vms.value = data.items
  } catch { message.error('获取 VM 列表失败') } finally { loading.value = false }
}

const rowActionLoading = ref('')

async function handleStart(id: string) {
  rowActionLoading.value = `start-${id}`
  try { await api.post(`/user/vms/${id}/start`); message.success('启动成功'); await fetchVms() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '启动失败') }
  finally { rowActionLoading.value = '' }
}

async function handleStop(id: string) {
  rowActionLoading.value = `stop-${id}`
  try { await api.post(`/user/vms/${id}/stop`); message.success('已停止'); await fetchVms() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '停止失败') }
  finally { rowActionLoading.value = '' }
}

async function handleRestart(id: string) {
  rowActionLoading.value = `restart-${id}`
  try { await api.post(`/user/vms/${id}/restart`); message.success('重启成功'); await fetchVms() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '重启失败') }
  finally { rowActionLoading.value = '' }
}

onMounted(() => fetchVms())
</script>

<template>
  <n-space vertical :size="16">
    <h2 style="margin: 0">我的小鸡</h2>
    <n-card>
      <n-data-table :columns="columns" :data="vms" :loading="loading" :bordered="false" :single-line="false" />
    </n-card>
  </n-space>
</template>
