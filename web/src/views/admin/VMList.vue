<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NSpace, NDataTable, NTag, NModal, NForm, NFormItem,
  NInput, NInputNumber, NSelect, useMessage, NPopconfirm, NDrawer,
  NDrawerContent
} from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'
import { useRouter } from 'vue-router'

const message = useMessage()
const router = useRouter()

interface VM {
  id: string; name: string; status: string; cpus: number; memoryMb: number
  diskGb: number; baseImage: string; ip: string; sshPort: number; password?: string
  createdAt: string; managed: string; ownerId: number | null
  owner: { id: number; username: string } | null
}

interface User { id: number; username: string; role: string }

const loading = ref(true)
const vms = ref<VM[]>([])
const users = ref<User[]>([])
const imageOptions = ref<{ label: string; value: string }[]>([])

const showCreateDrawer = ref(false)
const creating = ref(false)
const createForm = ref({ name: '', baseImage: '', cpus: 1, memoryMb: 512, diskGb: 2, password: '', ownerId: 0 })

const showAssignModal = ref(false)
const assigning = ref(false)
const assignTarget = ref<{ vmId: string; userId: number }>({ vmId: '', userId: 0 })

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
  { title: 'IP', key: 'ip', width: 130 },
  { title: 'SSH', key: 'sshPort', width: 70 },
  {
    title: '配置', key: 'config', width: 140,
    render(row) { return `${row.cpus}C / ${row.memoryMb}MB / ${row.diskGb}GB` },
  },
  {
    title: '分配给', key: 'owner', width: 120,
    render(row) {
      if (row.owner) return h(NTag, { type: 'success', bordered: false, size: 'small' }, { default: () => row.owner!.username })
      return h(NTag, { type: 'default', bordered: false, size: 'small' }, { default: () => '未分配' })
    },
  },
  {
    title: '操作', key: 'actions', width: 320,
    render(row) {
      return h(NSpace, { size: 4 }, {
        default: () => [
          row.status !== 'running' ? h(NButton, { size: 'small', type: 'success', loading: rowActionLoading.value === `start-${row.id}`, onClick: () => handleStart(row.id) }, { default: () => '启动' }) : null,
          row.status === 'running' ? h(NButton, { size: 'small', type: 'warning', loading: rowActionLoading.value === `stop-${row.id}`, onClick: () => handleStop(row.id) }, { default: () => '停止' }) : null,
          h(NButton, { size: 'small', onClick: () => router.push(`/admin/vms/${row.id}`) }, { default: () => '管理' }),
          h(NButton, { size: 'small', type: 'info', onClick: () => openAssign(row) }, { default: () => '分配' }),
          h(NPopconfirm, { onPositiveClick: () => handleDelete(row.id) }, {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => '删除' }),
            default: () => `确定删除 ${row.name}？`,
          }),
        ],
      })
    },
  },
]

async function fetchVms() {
  loading.value = true
  try {
    const data = await api.get<{ items: VM[] }>('/admin/vms')
    vms.value = data.items
  } catch { message.error('获取 VM 列表失败') } finally { loading.value = false }
}

async function fetchUsers() {
  try { users.value = await api.get<User[]>('/admin/users') } catch {}
}

async function fetchImages() {
  try {
    const data = await api.get<Array<{ name: string; size_gb: number }>>('/admin/images')
    imageOptions.value = data.map(t => ({ label: `${t.name} (${t.size_gb}GB)`, value: t.name }))
  } catch {}
}

const rowActionLoading = ref('')

async function handleStart(id: string) {
  rowActionLoading.value = `start-${id}`
  try { await api.post(`/admin/vms/${id}/start`); message.success('启动成功'); await fetchVms() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '启动失败') }
  finally { rowActionLoading.value = '' }
}

async function handleStop(id: string) {
  rowActionLoading.value = `stop-${id}`
  try { await api.post(`/admin/vms/${id}/stop`); message.success('已停止'); await fetchVms() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '停止失败') }
  finally { rowActionLoading.value = '' }
}

async function handleDelete(id: string) {
  rowActionLoading.value = `delete-${id}`
  try { await api.delete(`/admin/vms/${id}`); message.success('已删除'); await fetchVms() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '删除失败') }
  finally { rowActionLoading.value = '' }
}

async function handleCreate() {
  if (!createForm.value.name || !createForm.value.baseImage) {
    message.warning('请填写名称和选择镜像'); return
  }
  creating.value = true
  try {
    await api.post('/admin/vms', createForm.value)
    message.success('VM 创建成功')
    showCreateDrawer.value = false
    createForm.value = { name: '', baseImage: '', cpus: 1, memoryMb: 512, diskGb: 2, password: '', ownerId: 0 }
    await fetchVms()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '创建失败') }
  finally { creating.value = false }
}

function openAssign(vm: VM) {
  assignTarget.value = { vmId: vm.id, userId: vm.ownerId || 0 }
  showAssignModal.value = true
}

async function handleAssign() {
  assigning.value = true
  try {
    if (assignTarget.value.userId > 0) {
      await api.post(`/admin/vms/${assignTarget.value.vmId}/assign`, { userId: assignTarget.value.userId })
      message.success('分配成功')
    } else {
      await api.post(`/admin/vms/${assignTarget.value.vmId}/unassign`)
      message.success('已取消分配')
    }
    showAssignModal.value = false
    await fetchVms()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '操作失败') }
  finally { assigning.value = false }
}

const userOptions = ref<{ label: string; value: number }[]>([])

function updateUserOptions() {
  userOptions.value = [
    { label: '不分配', value: 0 },
    ...users.value.filter(u => u.role === 'user').map(u => ({ label: u.username, value: u.id })),
  ]
}

onMounted(async () => {
  await Promise.all([fetchVms(), fetchUsers(), fetchImages()])
  updateUserOptions()
})
</script>

<template>
  <n-space vertical :size="16">
    <n-space justify="space-between" align="center">
      <h2 style="margin: 0">VM 管理</h2>
      <n-button type="primary" @click="showCreateDrawer = true">创建 VM</n-button>
    </n-space>

    <n-card>
      <n-data-table :columns="columns" :data="vms" :loading="loading" :bordered="false" :single-line="false" />
    </n-card>

    <!-- 创建 VM 抽屉 -->
    <n-drawer v-model:show="showCreateDrawer" :width="400" placement="right">
      <n-drawer-content title="创建虚拟机">
        <n-form label-placement="left" label-width="80">
          <n-form-item label="名称" required><n-input v-model:value="createForm.name" placeholder="如：小鸡-张三" /></n-form-item>
          <n-form-item label="基础镜像" required><n-select v-model:value="createForm.baseImage" :options="imageOptions" placeholder="选择镜像" /></n-form-item>
          <n-form-item label="CPU 核数"><n-input-number v-model:value="createForm.cpus" :min="1" :max="8" /></n-form-item>
          <n-form-item label="内存 (MB)"><n-input-number v-model:value="createForm.memoryMb" :min="128" :step="128" /></n-form-item>
          <n-form-item label="磁盘 (GB)"><n-input-number v-model:value="createForm.diskGb" :min="2" :step="1" /></n-form-item>
          <n-form-item label="密码"><n-input v-model:value="createForm.password" placeholder="留空自动生成" /></n-form-item>
          <n-form-item label="分配给"><n-select v-model:value="createForm.ownerId" :options="userOptions" placeholder="选择用户（可选）" /></n-form-item>
        </n-form>
        <template #footer>
          <n-space>
            <n-button @click="showCreateDrawer = false">取消</n-button>
            <n-button type="primary" :loading="creating" @click="handleCreate">创建</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 分配弹窗 -->
    <n-modal v-model:show="showAssignModal" title="分配 VM" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="分配给">
          <n-select v-model:value="assignTarget.userId" :options="userOptions" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showAssignModal = false">取消</n-button>
          <n-button type="primary" :loading="assigning" @click="handleAssign">确认</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-space>
</template>
