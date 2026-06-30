<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NButton, NSpace, useMessage } from 'naive-ui'
import { useUserStore } from '@/stores/user'
import '@cap.js/widget'

const router = useRouter()
const message = useMessage()
const userStore = useUserStore()

const loading = ref(false)
const capToken = ref('')
const formValue = ref({
  username: '',
  password: '',
})

function onCapSolve(e: CustomEvent<{ token: string }>) {
  capToken.value = e.detail.token
}

function onCapError() {
  capToken.value = ''
}

async function handleLogin() {
  if (!formValue.value.username || !formValue.value.password) {
    message.warning('请输入用户名和密码')
    return
  }
  if (!capToken.value) {
    message.warning('请先完成人机验证')
    return
  }

  loading.value = true
  try {
    await userStore.login(formValue.value.username, formValue.value.password, capToken.value)
    message.success('登录成功')
    if (userStore.isAdmin) {
      router.push('/admin/dashboard')
    } else {
      router.push('/user/dashboard')
    }
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '登录失败')
    // 登录失败后重置 Cap
    capToken.value = ''
    const widget = document.querySelector('cap-widget')
    if (widget) (widget as any).reset()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f5f5">
    <n-card title="🐔 ikun-cloud" style="width: 400px">
      <template #header-extra>
        <n-button text type="primary" @click="router.push('/')">首页</n-button>
      </template>
      <n-form @submit.prevent="handleLogin">
        <n-form-item label="用户名">
          <n-input v-model:value="formValue.username" placeholder="请输入用户名" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input
            v-model:value="formValue.password"
            type="password"
            placeholder="请输入密码"
            show-password-on="click"
            @keyup.enter="handleLogin"
          />
        </n-form-item>
        <n-form-item label="验证">
          <cap-widget
            data-cap-api-endpoint="/api/public/cap"
            data-cap-i18n-initial-state="点击验证"
            data-cap-i18n-verifying-label="验证中..."
            data-cap-i18n-solved-label="验证通过"
            data-cap-i18n-error-label="验证失败，点击重试"
            @solve="onCapSolve"
            @error="onCapError"
          />
        </n-form-item>
        <n-space vertical style="width: 100%">
          <n-button
            type="primary"
            block
            :loading="loading"
            :disabled="!capToken"
            @click="handleLogin"
          >
            登录
          </n-button>
          <n-button text type="primary" @click="router.push('/register')" block>
            没有账号？去注册
          </n-button>
        </n-space>
      </n-form>
    </n-card>
  </div>
</template>
