<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NButton, NSpace, useMessage } from 'naive-ui'
import { api } from '@/api/request'

const router = useRouter()
const message = useMessage()

const loading = ref(false)
const registerMode = ref('closed')
const formValue = ref({ username: '', password: '', inviteCode: '' })

onMounted(async () => {
  try {
    const info = await api.get<{ registerMode: string }>('/public/site-info')
    registerMode.value = info.registerMode || 'closed'
    // 从 URL 参数获取邀请码
    const urlCode = new URLSearchParams(window.location.search).get('code')
    if (urlCode) formValue.value.inviteCode = urlCode
  } catch {}
})

async function handleRegister() {
  if (!formValue.value.username || !formValue.value.password) {
    message.warning('请输入用户名和密码')
    return
  }
  if (formValue.value.password.length < 6) {
    message.warning('密码长度不能少于 6 位')
    return
  }
  if (registerMode.value === 'invite' && !formValue.value.inviteCode) {
    message.warning('请填写邀请码')
    return
  }

  loading.value = true
  try {
    await api.post('/public/register', formValue.value)
    message.success('注册成功，请登录')
    router.push('/login')
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '注册失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f5f5">
    <n-card v-if="registerMode === 'closed'" title="🐔 ikun-cloud" style="width: 400px">
      <p style="text-align: center; color: #999;">暂未开放注册</p>
      <n-button text type="primary" @click="router.push('/login')" block>去登录</n-button>
    </n-card>

    <n-card v-else title="🐔 注册账号" style="width: 400px">
      <template #header-extra>
        <n-button text type="primary" @click="router.push('/')">首页</n-button>
      </template>
      <n-form @submit.prevent="handleRegister">
        <n-form-item label="用户名">
          <n-input v-model:value="formValue.username" placeholder="3-32 个字符" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input v-model:value="formValue.password" type="password" placeholder="至少 6 位" show-password-on="click" />
        </n-form-item>
        <n-form-item v-if="registerMode === 'invite'" label="邀请码">
          <n-input v-model:value="formValue.inviteCode" placeholder="请输入邀请码" />
        </n-form-item>
        <n-space vertical style="width: 100%">
          <n-button type="primary" block :loading="loading" @click="handleRegister">注册</n-button>
          <n-button text type="primary" @click="router.push('/login')" block>已有账号？去登录</n-button>
        </n-space>
      </n-form>
    </n-card>
  </div>
</template>
