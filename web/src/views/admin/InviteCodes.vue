<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NSpace, NDataTable, NTag, NModal, NForm, NFormItem,
  NInput, NInputNumber, useMessage, NPopconfirm
} from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'

const message = useMessage()

interface InviteCode {
  id: number; code: string; remark: string; usedBy: number | null
  usedByUsername: string | null; createdAt: string; usedAt: string | null
}

const loading = ref(true)
const items = ref<InviteCode[]>([])

const showModal = ref(false)
const creating = ref(false)
const form = ref({ remark: '', count: 1 })

const columns: DataTableColumns<InviteCode> = [
  {
    title: '邀请码', key: 'code', width: 140,
    render(row) {
      return h('div', { style: 'display: flex; align-items: center; gap: 8px;' }, [
        h('code', { style: 'font-size: 13px; font-weight: bold;' }, row.code),
        h(NButton, { size: 'tiny', text: true, onClick: () => { navigator.clipboard.writeText(row.code); message.success('已复制') } }, { default: () => '复制' }),
      ])
    },
  },
  { title: '备注', key: 'remark', width: 200 },
  {
    title: '状态', key: 'usedAt', width: 120,
    render(row) {
      if (row.usedAt) {
        return h(NTag, { type: 'error', bordered: false, size: 'small' }, { default: () => `已使用 (${row.usedByUsername || row.usedBy || '-'})` })
      }
      return h(NTag, { type: 'success', bordered: false, size: 'small' }, { default: () => '未使用' })
    },
  },
  { title: '创建时间', key: 'createdAt', width: 180 },
  { title: '使用时间', key: 'usedAt', width: 180, render(row) { return row.usedAt || '-' } },
  {
    title: '操作', key: 'actions', width: 80,
    render(row) {
      if (row.usedAt) return null
      return h(NPopconfirm, { onPositiveClick: () => handleDelete(row.id) }, {
        trigger: () => h(NButton, { size: 'small', type: 'error', text: true }, { default: () => '删除' }),
        default: () => '确定删除此邀请码？',
      })
    },
  },
]

async function fetchItems() {
  loading.value = true
  try { items.value = await api.get<InviteCode[]>('/admin/invite-codes') }
  catch {} finally { loading.value = false }
}

async function handleCreate() {
  if (!form.value.remark) { message.warning('请填写备注'); return }
  creating.value = true
  try {
    const result = await api.post<InviteCode[]>('/admin/invite-codes', form.value)
    message.success(`已创建 ${result.length} 个邀请码`)
    showModal.value = false
    form.value = { remark: '', count: 1 }
    await fetchItems()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '创建失败') }
  finally { creating.value = false }
}

async function handleDelete(id: number) {
  try { await api.delete(`/admin/invite-codes/${id}`); message.success('已删除'); await fetchItems() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '删除失败') }
}

onMounted(() => fetchItems())
</script>

<template>
  <n-space vertical :size="16">
    <n-space justify="space-between" align="center">
      <h2 style="margin: 0">邀请码管理</h2>
      <n-button type="primary" @click="showModal = true">创建邀请码</n-button>
    </n-space>

    <n-card>
      <n-data-table :columns="columns" :data="items" :loading="loading" :bordered="false" :single-line="false" />
    </n-card>

    <n-modal v-model:show="showModal" title="创建邀请码" preset="dialog" style="width: 450px">
      <n-form label-placement="left" label-width="60">
        <n-form-item label="备注" required>
          <n-input v-model:value="form.remark" placeholder="如：xx网特邀嘉宾" />
        </n-form-item>
        <n-form-item label="数量">
          <n-input-number v-model:value="form.count" :min="1" :max="50" />
          <template #feedback>批量生成，每个邀请码随机 8 位</template>
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="handleCreate">创建</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-space>
</template>
