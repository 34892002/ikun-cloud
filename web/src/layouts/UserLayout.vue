<script setup lang="ts">
import { ref, h, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import {
  NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu,
  NButton, NAvatar, NDropdown, NSpace, NText, NIcon, NModal,
  NForm, NFormItem, NInput, useMessage
} from 'naive-ui'
import { DesktopOutline, ServerOutline, LogOutOutline, HomeOutline, KeyOutline } from '@vicons/ionicons5'
import { useUserStore } from '@/stores/user'
import { api } from '@/api/request'
import type { MenuOption } from 'naive-ui'
import type { Component } from 'vue'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const message = useMessage()
const collapsed = ref(false)

function renderIcon(icon: Component) {
  return () => h(NIcon, null, { default: () => h(icon) })
}

const menuOptions: MenuOption[] = [
  { label: '仪表盘', key: 'UserDashboard', icon: renderIcon(DesktopOutline) },
  { label: '我的小鸡', key: 'UserVMList', icon: renderIcon(ServerOutline) },
  { label: '返回首页', key: 'Home', icon: renderIcon(HomeOutline) },
]

const activeKey = computed(() => route.name as string)

function handleMenuUpdate(key: string) {
  router.push({ name: key })
}

// 修改密码
const showPasswordModal = ref(false)
const changingPassword = ref(false)
const passwordForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' })

const userDropdownOptions = [
  { label: '修改密码', key: 'password', icon: renderIcon(KeyOutline) },
  { label: '退出登录', key: 'logout', icon: renderIcon(LogOutOutline) },
]

function handleUserDropdown(key: string) {
  if (key === 'logout') {
    userStore.logout()
    router.push('/login')
  } else if (key === 'password') {
    passwordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' }
    showPasswordModal.value = true
  }
}

async function handleChangePassword() {
  if (!passwordForm.value.oldPassword || !passwordForm.value.newPassword) {
    message.warning('请填写旧密码和新密码')
    return
  }
  if (passwordForm.value.newPassword.length < 6) {
    message.warning('新密码长度不能少于 6 位')
    return
  }
  if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) {
    message.warning('两次输入的密码不一致')
    return
  }

  changingPassword.value = true
  try {
    await api.put('/user/password', {
      oldPassword: passwordForm.value.oldPassword,
      newPassword: passwordForm.value.newPassword,
    })
    message.success('密码修改成功')
    showPasswordModal.value = false
  } catch (e: unknown) {
    message.error(e instanceof Error ? e.message : '修改失败')
  } finally {
    changingPassword.value = false
  }
}
</script>

<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider bordered :collapsed="collapsed" collapse-mode="width" :collapsed-width="64" :width="200" show-trigger @collapse="collapsed = true" @expand="collapsed = false">
      <div style="padding: 16px; text-align: center">
        <n-text strong style="font-size: 18px">{{ collapsed ? '🐔' : '🐔 ikun-cloud' }}</n-text>
      </div>
      <n-menu :collapsed="collapsed" :collapsed-width="64" :collapsed-icon-size="22" :options="menuOptions" :value="activeKey" @update:value="handleMenuUpdate" />
    </n-layout-sider>

    <n-layout>
      <n-layout-header bordered style="height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px">
        <n-tag type="info" size="small">租户</n-tag>
        <n-space align="center">
          <n-text>{{ userStore.userInfo?.username }}</n-text>
          <n-dropdown :options="userDropdownOptions" @select="handleUserDropdown">
            <n-button quaternary circle>
              <n-avatar :size="32" round>{{ userStore.userInfo?.username?.[0]?.toUpperCase() || 'U' }}</n-avatar>
            </n-button>
          </n-dropdown>
        </n-space>
      </n-layout-header>

      <n-layout-content content-style="padding: 24px;" :native-scrollbar="false">
        <router-view />
      </n-layout-content>
    </n-layout>

    <!-- 修改密码弹窗 -->
    <n-modal v-model:show="showPasswordModal" title="修改密码" preset="dialog">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="旧密码"><n-input v-model:value="passwordForm.oldPassword" type="password" show-password-on="click" /></n-form-item>
        <n-form-item label="新密码"><n-input v-model:value="passwordForm.newPassword" type="password" placeholder="至少 6 位" show-password-on="click" /></n-form-item>
        <n-form-item label="确认密码"><n-input v-model:value="passwordForm.confirmPassword" type="password" show-password-on="click" /></n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showPasswordModal = false">取消</n-button>
          <n-button type="primary" :loading="changingPassword" @click="handleChangePassword">确认修改</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-layout>
</template>
