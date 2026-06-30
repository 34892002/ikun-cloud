<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NCard, NButton, NSpace, NDataTable, NTag, NModal, NForm, NFormItem,
  NInput, NSelect, useMessage, NPopconfirm
} from 'naive-ui'
import { api } from '@/api/request'
import type { DataTableColumns } from 'naive-ui'

const message = useMessage()

interface User {
  id: number; username: string; role: string; inviteCode: string | null; createdAt: string; vmCount: number
}

const loading = ref(true)
const users = ref<User[]>([])

const showCreateModal = ref(false)
const creating = ref(false)
const createForm = ref({ username: '', password: '', role: 'user' })

const showEditModal = ref(false)
const editing = ref(false)
const editForm = ref({ id: 0, username: '', role: 'user' })

const showResetModal = ref(false)
const resetting = ref(false)
const resetForm = ref({ id: 0, username: '', password: '' })

const roleOptions = [
  { label: '租户 (user)', value: 'user' },
  { label: '管理员 (root)', value: 'root' },
]

const columns: DataTableColumns<User> = [
  { title: 'ID', key: 'id', width: 80 },
  { title: '用户名', key: 'username', width: 150 },
  {
    title: '角色', key: 'role', width: 120,
    render(row) {
      return h(NTag, { type: row.role === 'root' ? 'warning' : 'info', bordered: false }, { default: () => row.role === 'root' ? '管理员' : '租户' })
    },
  },
  { title: 'VM 数量', key: 'vmCount', width: 100 },
  { title: '邀请码', key: 'inviteCode', width: 120, render(row) { return row.inviteCode || '-' } },
  { title: '创建时间', key: 'createdAt', width: 180 },
  {
    title: '操作', key: 'actions', width: 240,
    render(row) {
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => '编辑' }),
          h(NButton, { size: 'small', type: 'info', onClick: () => openReset(row) }, { default: () => '重置密码' }),
          h(NPopconfirm, { onPositiveClick: () => handleDelete(row.id) }, {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => '删除' }),
            default: () => `确定删除用户 ${row.username}？其 VM 将取消分配。`,
          }),
        ],
      })
    },
  },
]

async function fetchUsers() {
  loading.value = true
  try { users.value = await api.get<User[]>('/admin/users') }
  catch { message.error('获取用户列表失败') } finally { loading.value = false }
}

async function handleCreate() {
  if (!createForm.value.username || !createForm.value.password) {
    message.warning('请填写用户名和密码'); return
  }
  creating.value = true
  try {
    await api.post('/admin/users', createForm.value)
    message.success('用户创建成功')
    showCreateModal.value = false
    createForm.value = { username: '', password: '', role: 'user' }
    await fetchUsers()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '创建失败') }
  finally { creating.value = false }
}

function openEdit(user: User) {
  editForm.value = { id: user.id, username: user.username, role: user.role }
  showEditModal.value = true
}

async function handleEdit() {
  editing.value = true
  try {
    await api.put(`/admin/users/${editForm.value.id}`, { username: editForm.value.username, role: editForm.value.role })
    message.success('用户更新成功')
    showEditModal.value = false
    await fetchUsers()
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '更新失败') }
  finally { editing.value = false }
}

function openReset(user: User) {
  resetForm.value = { id: user.id, username: user.username, password: '' }
  showResetModal.value = true
}

async function handleReset() {
  if (resetForm.value.password.length < 6) { message.warning('密码长度不能少于 6 位'); return }
  resetting.value = true
  try {
    await api.post(`/admin/users/${resetForm.value.id}/reset-password`, { password: resetForm.value.password })
    message.success('密码重置成功')
    showResetModal.value = false
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '重置失败') }
  finally { resetting.value = false }
}

async function handleDelete(id: number) {
  try { await api.delete(`/admin/users/${id}`); message.success('用户已删除'); await fetchUsers() }
  catch (e: unknown) { message.error(e instanceof Error ? e.message : '删除失败') }
}

onMounted(() => fetchUsers())
</script>

<template>
  <n-space vertical :size="16">
    <n-space justify="space-between" align="center">
      <h2 style="margin: 0">用户管理</h2>
      <n-button type="primary" @click="showCreateModal = true">创建用户</n-button>
    </n-space>

    <n-card>
      <n-data-table :columns="columns" :data="users" :loading="loading" :bordered="false" :single-line="false" />
    </n-card>

    <!-- 创建用户 -->
    <n-modal v-model:show="showCreateModal" title="创建用户" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="用户名" required><n-input v-model:value="createForm.username" /></n-form-item>
        <n-form-item label="密码" required><n-input v-model:value="createForm.password" type="password" show-password-on="click" /></n-form-item>
        <n-form-item label="角色"><n-select v-model:value="createForm.role" :options="roleOptions" /></n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showCreateModal = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="handleCreate">创建</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 编辑用户 -->
    <n-modal v-model:show="showEditModal" title="编辑用户" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="用户名"><n-input v-model:value="editForm.username" /></n-form-item>
        <n-form-item label="角色"><n-select v-model:value="editForm.role" :options="roleOptions" /></n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showEditModal = false">取消</n-button>
          <n-button type="primary" :loading="editing" @click="handleEdit">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 重置密码 -->
    <n-modal v-model:show="showResetModal" title="重置密码" preset="dialog">
      <p>为用户 <strong>{{ resetForm.username }}</strong> 设置新密码：</p>
      <n-form label-placement="left" label-width="80">
        <n-form-item label="新密码"><n-input v-model:value="resetForm.password" type="password" placeholder="至少 6 位" show-password-on="click" /></n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showResetModal = false">取消</n-button>
          <n-button type="primary" :loading="resetting" @click="handleReset">确认重置</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-space>
</template>
