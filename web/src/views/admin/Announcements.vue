<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NSpace, NDataTable, NTag, NModal, NForm, NFormItem,
  NInput, NSwitch, useMessage, NPopconfirm
} from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'

const message = useMessage()

interface Announcement {
  id: number; title: string; content: string; isActive: number; createdAt: string; updatedAt: string
}

const loading = ref(true)
const items = ref<Announcement[]>([])

const showModal = ref(false)
const saving = ref(false)
const isEdit = ref(false)
const form = ref({ id: 0, title: '', content: '', isActive: true })

const columns: DataTableColumns<Announcement> = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '标题', key: 'title', width: 200 },
  { title: '内容', key: 'content', width: 300, ellipsis: { tooltip: true } },
  {
    title: '状态', key: 'isActive', width: 80,
    render(row) {
      return h(NTag, { type: row.isActive ? 'success' : 'default', bordered: false }, { default: () => row.isActive ? '显示' : '隐藏' })
    },
  },
  { title: '创建时间', key: 'createdAt', width: 180 },
  {
    title: '操作', key: 'actions', width: 160,
    render(row) {
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(NPopconfirm, { onPositiveClick: () => handleDelete(row.id) }, {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => '删除' }),
            default: () => '确定删除此公告？',
          }),
        ],
      })
    },
  },
]

async function fetchItems() {
  loading.value = true
  try { items.value = await api.get<Announcement[]>('/admin/announcements') }
  catch {} finally { loading.value = false }
}

function openCreate() {
  isEdit.value = false
  form.value = { id: 0, title: '', content: '', isActive: true }
  showModal.value = true
}

function openEdit(item: Announcement) {
  isEdit.value = true
  form.value = { id: item.id, title: item.title, content: item.content, isActive: !!item.isActive }
  showModal.value = true
}

async function handleSave() {
  if (!form.value.title || !form.value.content) {
    message.warning('请填写标题和内容'); return
  }
  saving.value = true
  try {
    if (isEdit.value) {
      await api.put(`/admin/announcements/${form.value.id}`, form.value)
      message.success('公告已更新')
    } else {
      await api.post('/admin/announcements', form.value)
      message.success('公告已创建')
    }
    showModal.value = false
    await fetchItems()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '操作失败') }
  finally { saving.value = false }
}

async function handleDelete(id: number) {
  try { await api.delete(`/admin/announcements/${id}`); message.success('已删除'); await fetchItems() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '删除失败') }
}

onMounted(() => fetchItems())
</script>

<template>
  <n-space vertical :size="16">
    <n-space justify="space-between" align="center">
      <h2 style="margin: 0">公告管理</h2>
      <n-button type="primary" @click="openCreate">创建公告</n-button>
    </n-space>

    <n-card>
      <n-data-table :columns="columns" :data="items" :loading="loading" :bordered="false" :single-line="false" />
    </n-card>

    <n-modal v-model:show="showModal" :title="isEdit ? '编辑公告' : '创建公告'" preset="dialog" style="width: 500px">
      <n-form label-placement="left" label-width="60">
        <n-form-item label="标题" required><n-input v-model:value="form.title" /></n-form-item>
        <n-form-item label="内容" required><n-input v-model:value="form.content" type="textarea" :rows="4" /></n-form-item>
        <n-form-item label="显示"><n-switch v-model:value="form.isActive" /></n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showModal = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="handleSave">{{ isEdit ? '保存' : '创建' }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-space>
</template>
