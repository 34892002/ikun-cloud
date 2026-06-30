<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import { NCard, NDataTable, NSpace, NTag } from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'

interface Image {
  name: string; size_gb: number; available: boolean
}

const loading = ref(true)
const images = ref<Image[]>([])

const columns: DataTableColumns<Image> = [
  { title: '镜像名称', key: 'name', width: 200 },
  {
    title: '大小', key: 'size_gb', width: 120,
    render(row) { return `${row.size_gb} GB` },
  },
  {
    title: '状态', key: 'available', width: 120,
    render(row) {
      return h(NTag, { type: row.available ? 'success' : 'error', bordered: false }, { default: () => row.available ? '可用' : '不可用' })
    },
  },
]

onMounted(async () => {
  try { images.value = await api.get<Image[]>('/admin/images') }
  catch {} finally { loading.value = false }
})
</script>

<template>
  <n-space vertical :size="16">
    <h2 style="margin: 0">镜像管理</h2>
    <n-card>
      <n-data-table :columns="columns" :data="images" :loading="loading" :bordered="false" :single-line="false" />
    </n-card>
  </n-space>
</template>
