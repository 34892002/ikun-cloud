<script setup lang="ts">
import { ref, onMounted, h, computed } from 'vue'
import {
  NCard, NButton, NSpace, NDataTable, NTag, NForm, NFormItem,
  NInput, useMessage, NPopconfirm, NGrid, NGi, NStatistic
} from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'

const message = useMessage()
const loading = ref(true)
const saving = ref(false)

// 网络配置
const natLimit = ref('40')
const natBlacklist = ref('22,3389,3000')
const hostIp = ref('')

// 已分配端口列表
interface AllocatedPort {
  id: number; vmId: string; vmName: string; hostPort: number; guestPort: number
  protocol: string; owner: string | null
}
const ports = ref<AllocatedPort[]>([])

const pagination = ref({ pageSize: 20 })

const blacklistPorts = computed(() => {
  return natBlacklist.value.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
})

const portColumns: DataTableColumns<AllocatedPort> = [
  { title: '宿主端口', key: 'hostPort', width: 100, sorter: (a, b) => a.hostPort - b.hostPort },
  { title: '目标端口', key: 'guestPort', width: 100 },
  { title: '协议', key: 'protocol', width: 80, render(row) { return h(NTag, { size: 'small', type: 'info' }, { default: () => row.protocol.toUpperCase() }) } },
  { title: 'VM', key: 'vmName', width: 150, render(row) { return `${row.vmName} (${row.vmId})` } },
  { title: '用户', key: 'owner', width: 120, render(row) { return row.owner || '(管理员)' } },
]

async function fetchConfig() {
  loading.value = true
  try {
    const settings = await api.get<Record<string, string>>('/admin/settings')
    natLimit.value = settings.nat_limit || '40'
    natBlacklist.value = settings.nat_blacklist || '22,3389,3000'
    hostIp.value = settings.host_ip || ''
  } catch {} finally { loading.value = false }
}

async function fetchPorts() {
  try {
    const data = await api.get<AllocatedPort[]>('/admin/network/ports')
    ports.value = data
  } catch {}
}

async function handleSave() {
  saving.value = true
  try {
    await api.put('/admin/settings', {
      nat_limit: natLimit.value,
      nat_blacklist: natBlacklist.value,
      host_ip: hostIp.value,
    })
    message.success('网络配置已保存')
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '保存失败') }
  finally { saving.value = false }
}

onMounted(() => {
  fetchConfig()
  fetchPorts()
})
</script>

<template>
  <n-space vertical :size="16">
    <h2 style="margin: 0">网络配置</h2>

    <!-- NAT 配置 -->
    <n-card title="NAT 配置" :loading="loading">
      <n-form label-placement="left" label-width="120">
        <n-form-item label="宿主机公网 IP">
          <n-input v-model:value="hostIp" placeholder="如 1.2.3.4" style="width: 300px" />
          <template #feedback>VM 详情页显示的公网 IP</template>
        </n-form-item>
        <n-form-item label="单 VM 端口上限">
          <n-input v-model:value="natLimit" placeholder="40" style="width: 200px" />
          <template #feedback>每个 VM 最多可配置的端口映射规则数</template>
        </n-form-item>
        <n-form-item label="端口黑名单">
          <n-input v-model:value="natBlacklist" placeholder="22,3389,3000" />
          <template #feedback>母鸡占用的端口，禁止分配给 VM（逗号分隔）</template>
        </n-form-item>
        <n-form-item>
          <n-button type="primary" :loading="saving" @click="handleSave">保存配置</n-button>
        </n-form-item>
      </n-form>
    </n-card>

    <!-- 黑名单预览 -->
    <n-card title="黑名单端口">
      <n-space v-if="blacklistPorts.length > 0">
        <n-tag v-for="p in blacklistPorts" :key="p" type="error" bordered>{{ p }}</n-tag>
      </n-space>
      <span v-else style="color: #999">无黑名单端口</span>
    </n-card>

    <!-- 已分配端口 -->
    <n-card title="已分配端口">
      <template #header-extra>
        <n-tag type="info">{{ ports.length }} 条规则</n-tag>
      </template>
      <n-data-table :columns="portColumns" :data="ports" :bordered="false" :single-line="false" size="small" :pagination="pagination" />
    </n-card>
  </n-space>
</template>
