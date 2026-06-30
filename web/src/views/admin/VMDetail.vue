<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NCard, NButton, NSpace, NDescriptions, NDescriptionsItem, NTag,
  NTable, NModal, NForm, NFormItem, NInput, NInputNumber, NSelect,
  useMessage, NPopconfirm, NEmpty, NSpin, NStatistic, NGrid, NGi,
  NDivider, NRadioGroup, NRadioButton
} from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'
import MetricsChart from '@/components/MetricsChart.vue'
import { useLiveMetrics } from '@/composables/useLiveMetrics'

const { subscribeVmChart, unsubscribeVmChart } = useLiveMetrics()

const route = useRoute()
const router = useRouter()
const message = useMessage()
const vmId = route.params.id as string

interface VM {
  id: string; name: string; status: string; cpus: number; memoryMb: number
  diskGb: number; baseImage: string; ip: string; mac: string; tap: string
  sshPort: number; password?: string; createdAt: string; managed: string
  ownerId: number | null; owner: { id: number; username: string } | null
  ports: PortForward[]
}

interface PortForward {
  id: number; hostPort: number; guestPort: number; protocol: string; active?: boolean
}

const portQuota = ref({ used: 0, limit: 40 })

const portPagination = ref({ pageSize: 10 })

const portColumns: DataTableColumns<PortForward> = [
  { title: '宿主机端口', key: 'hostPort', width: 100 },
  { title: '目标端口', key: 'guestPort', width: 100 },
  { title: '协议', key: 'protocol', width: 80, render(row) { return h(NTag, { size: 'small', type: 'info' }, { default: () => row.protocol.toUpperCase() }) } },
  { title: '状态', key: 'active', width: 80, render(row) { return h(NTag, { size: 'small', type: row.active ? 'success' : 'error' }, { default: () => row.active ? '生效' : '失效' }) } },
  { title: '操作', key: 'actions', width: 80, render(row) {
    return h(NPopconfirm, { onPositiveClick: () => handleDeletePort(row.id) }, {
      trigger: () => h(NButton, { size: 'small', type: 'error', text: true }, { default: () => '删除' }),
      default: () => '确定删除此规则？',
    })
  } },
]

interface User { id: number; username: string; role: string }

const loading = ref(true)
const vm = ref<VM | null>(null)
const hostIp = ref('')
const actionLoading = ref('')

// 监控
const metricType = ref<'traffic' | 'cpu' | 'memory' | 'disk'>('traffic')
const timeRange = ref('1h')
const chartLoading = ref(false)
const samples = ref<Array<{ time: string; rxBytes: number; txBytes: number; cpuUsage: number; memUsed: number; memTotal: number; diskRead: number; diskWrite: number }>>([])
const monthTraffic = ref<{ rxBytes: number; txBytes: number }>({ rxBytes: 0, txBytes: 0 })

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function handleVmChartData(data: { samples: typeof samples.value; monthRx: number; monthTx: number }) {
  samples.value = data.samples
  monthTraffic.value = { rxBytes: data.monthRx, txBytes: data.monthTx }
  chartLoading.value = false
}

function fetchMetrics() {
  chartLoading.value = true
  subscribeVmChart(vmId, timeRange.value, handleVmChartData)
}

function handleRangeChange(range: string) {
  timeRange.value = range
  fetchMetrics()
}

// 端口映射
const showAddPort = ref(false)
const addingPort = ref(false)
const portForm = ref({ hostPort: 8080, guestPort: 80, protocol: 'tcp' })
const protocolOptions = [
  { label: 'TCP', value: 'tcp' },
  { label: 'UDP', value: 'udp' },
]

// 修改配置
const showResize = ref(false)
const resizing = ref(false)
const resizeForm = ref({ cpus: 1, memoryMb: 512, diskGb: 2 })

// 重装系统
const showReinstall = ref(false)
const reinstalling = ref(false)
const reinstallForm = ref({ baseImage: '', password: '' })
const imageOptions = ref<Array<{ label: string; value: string }>>([])

// 分配
const showAssignModal = ref(false)
const assigning = ref(false)
const assignUserId = ref<number>(0)
const userOptions = ref<{ label: string; value: number }[]>([])

async function fetchVm() {
  loading.value = true
  try { vm.value = await api.get<VM>(`/admin/vms/${vmId}`) }
  catch { message.error('获取 VM 详情失败'); router.push('/admin/vms') }
  finally { loading.value = false }
}

async function handleStart() {
  actionLoading.value = 'start'
  try { await api.post(`/admin/vms/${vmId}/start`); message.success('启动成功'); await fetchVm() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '启动失败') }
  finally { actionLoading.value = '' }
}

async function handleStop() {
  actionLoading.value = 'stop'
  try { await api.post(`/admin/vms/${vmId}/stop`); message.success('已停止'); await fetchVm() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '停止失败') }
  finally { actionLoading.value = '' }
}

async function handleRestart() {
  actionLoading.value = 'restart'
  try { await api.post(`/admin/vms/${vmId}/restart`); message.success('重启成功'); await fetchVm() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '重启失败') }
  finally { actionLoading.value = '' }
}

async function handleDelete() {
  try { await api.delete(`/admin/vms/${vmId}`); message.success('已删除'); router.push('/admin/vms') }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '删除失败') }
}

async function handleResetPassword() {
  try {
    const result = await api.post<{ newPassword?: string }>(`/admin/vms/${vmId}/reset-password`)
    message.success('密码重置成功')
    await fetchVm()
    if (result?.newPassword) message.info(`新密码: ${result.newPassword}`, { duration: 10000 })
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '重置失败') }
}

async function handleAddPort() {
  addingPort.value = true
  try {
    await api.post(`/user/network/vms/${vmId}/ports`, portForm.value)
    message.success('端口映射添加成功')
    showAddPort.value = false
    portForm.value = { hostPort: 8080, guestPort: 80, protocol: 'tcp' }
    await fetchVm()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '添加失败') }
  finally { addingPort.value = false }
}

async function handleDeletePort(portId: number) {
  try { await api.delete(`/user/network/vms/${vmId}/ports/${portId}`); message.success('已删除'); await fetchVm() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '删除失败') }
}

function openResize() {
  if (vm.value) resizeForm.value = { cpus: vm.value.cpus, memoryMb: vm.value.memoryMb, diskGb: vm.value.diskGb }
  showResize.value = true
}

async function handleResize() {
  resizing.value = true
  try {
    await api.patch(`/admin/vms/${vmId}`, resizeForm.value)
    message.success('配置已更新')
    showResize.value = false
    await fetchVm()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '修改失败') }
  finally { resizing.value = false }
}

async function fetchImages() {
  try {
    const data = await api.get<Array<{ name: string; size_gb: number }>>('/admin/images')
    imageOptions.value = data.map(img => ({ label: `${img.name} (${img.size_gb}GB)`, value: img.name }))
  } catch {}
}

function openReinstall() {
  fetchImages()
  reinstallForm.value.baseImage = vm.value?.baseImage || ''
  showReinstall.value = true
}

async function handleReinstall() {
  reinstalling.value = true
  try {
    await api.post(`/admin/vms/${vmId}/reinstall`, { baseImage: reinstallForm.value.baseImage, password: reinstallForm.value.password || undefined })
    message.success('重装完成')
    showReinstall.value = false
    await fetchVm()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '重装失败') }
  finally { reinstalling.value = false }
}

async function fetchUsers() {
  try {
    const data = await api.get<User[]>('/admin/users')
    userOptions.value = [
      { label: '取消分配', value: 0 },
      ...data.filter(u => u.role === 'user').map(u => ({ label: u.username, value: u.id })),
    ]
  } catch {}
}

function openAssign() {
  assignUserId.value = vm.value?.ownerId || 0
  showAssignModal.value = true
}

async function handleAssign() {
  assigning.value = true
  try {
    if (assignUserId.value > 0) {
      await api.post(`/admin/vms/${vmId}/assign`, { userId: assignUserId.value })
      message.success('分配成功')
    } else {
      await api.post(`/admin/vms/${vmId}/unassign`)
      message.success('已取消分配')
    }
    showAssignModal.value = false
    await fetchVm()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '操作失败') }
  finally { assigning.value = false }
}

onMounted(async () => {
  await fetchVm()
  fetchUsers()
  fetchMetrics()
  // 获取公网 IP
  try {
    const info = await api.get<{ hostIp: string }>('/public/site-info')
    hostIp.value = info.hostIp || ''
  } catch {}
  // 获取端口配额
  try {
    const portData = await api.get<{ items: PortForward[]; usedCount: number; limit: number }>(`/user/network/vms/${vmId}/ports`)
    portQuota.value = { used: portData.usedCount, limit: portData.limit }
  } catch {}
})

onBeforeUnmount(() => {
  unsubscribeVmChart()
})
</script>

<template>
  <n-spin :show="loading">
    <n-space vertical :size="16" v-if="vm">
      <!-- 顶部操作栏 -->
      <n-space justify="space-between" align="center">
        <n-space align="center">
          <n-button @click="router.push('/admin/vms')">← 返回列表</n-button>
          <h2 style="margin: 0">{{ vm.name }}</h2>
          <n-tag :type="vm.status === 'running' ? 'success' : 'error'" bordered>
            {{ vm.status === 'running' ? '运行中' : '已停止' }}
          </n-tag>
        </n-space>
        <n-space>
          <n-button v-if="vm.status !== 'running'" type="success" :loading="actionLoading === 'start'" @click="handleStart">启动</n-button>
          <n-button v-if="vm.status === 'running'" type="warning" :loading="actionLoading === 'stop'" @click="handleStop">停止</n-button>
          <n-button v-if="vm.status === 'running'" :loading="actionLoading === 'restart'" @click="handleRestart">重启</n-button>
          <n-button @click="openResize">修改配置</n-button>
          <n-button type="info" @click="openAssign">分配</n-button>
          <n-button type="warning" @click="openReinstall">重装系统</n-button>
          <n-button @click="handleResetPassword">重置密码</n-button>
          <n-popconfirm @positive-click="handleDelete">
            <template #trigger><n-button type="error">删除</n-button></template>
            确定删除 {{ vm.name }}？
          </n-popconfirm>
        </n-space>
      </n-space>

      <!-- 基本信息 -->
      <n-card title="基本信息">
        <n-descriptions :column="3" bordered label-placement="left">
          <n-descriptions-item label="VM ID">{{ vm.id }}</n-descriptions-item>
          <n-descriptions-item label="名称">{{ vm.name }}</n-descriptions-item>
          <n-descriptions-item label="管理方式">
            <n-tag :type="vm.managed === 'managed' ? 'success' : vm.managed === 'manual' ? 'warning' : 'error'">
              {{ vm.managed === 'managed' ? '面板管理' : vm.managed === 'manual' ? '手动管理' : '已失效' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item label="基础镜像">{{ vm.baseImage }}</n-descriptions-item>
          <n-descriptions-item label="CPU">{{ vm.cpus }} 核</n-descriptions-item>
          <n-descriptions-item label="内存">{{ vm.memoryMb }} MB</n-descriptions-item>
          <n-descriptions-item label="磁盘">{{ vm.diskGb }} GB</n-descriptions-item>
          <n-descriptions-item label="创建时间">{{ vm.createdAt }}</n-descriptions-item>
        </n-descriptions>
      </n-card>

      <!-- 网络信息 -->
      <n-card title="网络信息">
        <n-descriptions :column="3" bordered label-placement="left">
          <n-descriptions-item label="内网 IP">{{ vm.ip }}</n-descriptions-item>
          <n-descriptions-item label="MAC 地址">{{ vm.mac }}</n-descriptions-item>
          <n-descriptions-item label="公网IP">
            <code>{{ hostIp || '未配置' }}</code>
          </n-descriptions-item>
          <n-descriptions-item label="Root 密码">
            <n-tag type="info">{{ vm.password || '***' }}</n-tag>
          </n-descriptions-item>
        </n-descriptions>
      </n-card>

      <!-- 端口映射 -->
      <n-card title="端口映射">
        <template #header-extra>
          <n-space align="center">
            <n-tag size="small" :type="portQuota.used >= portQuota.limit ? 'error' : 'info'">
              {{ portQuota.used }} / {{ portQuota.limit }} 条规则
            </n-tag>
            <n-button type="primary" size="small" @click="showAddPort = true" :disabled="portQuota.used >= portQuota.limit">添加规则</n-button>
          </n-space>
        </template>
        <n-data-table v-if="vm.ports && vm.ports.length > 0" :columns="portColumns" :data="vm.ports" :bordered="true" :single-line="false" size="small" :pagination="portPagination" />
        <n-empty v-else description="暂无端口映射规则" />
      </n-card>

      <!-- 资源监控 -->
      <n-card title="资源监控">
        <n-grid :cols="2" :x-gap="24" style="margin-bottom: 20px;">
          <n-gi><n-statistic label="本月下行" :value="formatBytes(monthTraffic.rxBytes)" /></n-gi>
          <n-gi><n-statistic label="本月上行" :value="formatBytes(monthTraffic.txBytes)" /></n-gi>
        </n-grid>
        <n-divider style="margin: 0 0 16px;" />
        <MetricsChart
          v-model:metric="metricType"
          :samples="samples"
          :loading="chartLoading"
        />
        <n-space justify="center" style="margin-top: 12px;">
          <n-radio-group :value="timeRange" size="small" @update:value="handleRangeChange">
            <n-radio-button value="1h">1小时</n-radio-button>
            <n-radio-button value="6h">6小时</n-radio-button>
            <n-radio-button value="24h">24小时</n-radio-button>
            <n-radio-button value="7d">7天</n-radio-button>
            <n-radio-button value="30d">30天</n-radio-button>
          </n-radio-group>
        </n-space>
      </n-card>
    </n-space>

    <!-- 添加端口映射弹窗 -->
    <n-modal v-model:show="showAddPort" title="添加端口映射" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="宿主机端口"><n-input-number v-model:value="portForm.hostPort" :min="1" :max="65535" /></n-form-item>
        <n-form-item label="目标端口"><n-input-number v-model:value="portForm.guestPort" :min="1" :max="65535" /></n-form-item>
        <n-form-item label="协议"><n-select v-model:value="portForm.protocol" :options="protocolOptions" /></n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showAddPort = false">取消</n-button>
          <n-button type="primary" :loading="addingPort" @click="handleAddPort">添加</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 修改配置弹窗 -->
    <n-modal v-model:show="showResize" title="修改配置" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="CPU 核数"><n-input-number v-model:value="resizeForm.cpus" :min="1" :max="8" /></n-form-item>
        <n-form-item label="内存 (MB)"><n-input-number v-model:value="resizeForm.memoryMb" :min="128" :step="128" /></n-form-item>
        <n-form-item label="磁盘 (GB)">
          <n-input-number v-model:value="resizeForm.diskGb" :min="vm?.diskGb || 2" :step="1" />
          <template #feedback>磁盘只能扩大，不能缩小</template>
        </n-form-item>
        <p style="color: #f0a020; margin: 0; font-size: 13px">⚠ 修改配置后 VM 会自动重启，短暂中断</p>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showResize = false">取消</n-button>
          <n-button type="primary" :loading="resizing" @click="handleResize">确认修改</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 重装系统弹窗 -->
    <n-modal v-model:show="showReinstall" title="重装系统" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="系统镜像">
          <n-select v-model:value="reinstallForm.baseImage" :options="imageOptions" />
        </n-form-item>
        <n-form-item label="Root 密码">
          <n-input v-model:value="reinstallForm.password" placeholder="留空则随机生成" />
        </n-form-item>
        <p style="color: #d03050; margin: 0; font-size: 13px">⚠ 重装会清除磁盘数据，VM 将自动重启</p>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showReinstall = false">取消</n-button>
          <n-button type="warning" :loading="reinstalling" @click="handleReinstall">确认重装</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 分配弹窗 -->
    <n-modal v-model:show="showAssignModal" title="分配 VM" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="分配给">
          <n-select v-model:value="assignUserId" :options="userOptions" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showAssignModal = false">取消</n-button>
          <n-button type="primary" :loading="assigning" @click="handleAssign">确认</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-spin>
</template>
