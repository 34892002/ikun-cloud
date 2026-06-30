<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NForm, NFormItem, NSwitch, NInput, NButton, NSpace, NSelect, useMessage } from 'naive-ui'
import { api } from '@/api/request'

const message = useMessage()
const loading = ref(true)
const saving = ref(false)

const settings = ref({
  site_name: 'ikun-cloud',
  registration_open: 'false',
  register_mode: 'closed',
})

const modeOptions = [
  { label: '关闭注册', value: 'closed' },
  { label: '开放注册', value: 'open' },
  { label: '邀请码注册', value: 'invite' },
]

onMounted(async () => {
  try {
    const data = await api.get<Record<string, string>>('/admin/settings')
    settings.value = { ...settings.value, ...data }
    // 兼容旧数据
    if (!settings.value.register_mode) {
      settings.value.register_mode = settings.value.registration_open === 'true' ? 'open' : 'closed'
    }
  } catch {} finally { loading.value = false }
})

async function handleSave() {
  saving.value = true
  try {
    // 同步 registration_open 字段
    settings.value.registration_open = settings.value.register_mode === 'closed' ? 'false' : 'true'
    await api.put('/admin/settings', settings.value)
    message.success('配置已保存')
  } catch (e: unknown) { message.error(e instanceof Error ? e.message : '保存失败') }
  finally { saving.value = false }
}
</script>

<template>
  <n-space vertical :size="16">
    <h2 style="margin: 0">网站配置</h2>
    <n-card :loading="loading">
      <n-form label-placement="left" label-width="120">
        <n-form-item label="站点名称">
          <n-input v-model:value="settings.site_name" placeholder="ikun-cloud" />
        </n-form-item>
        <n-form-item label="注册模式">
          <n-select v-model:value="settings.register_mode" :options="modeOptions" />
          <template #feedback>
            <span v-if="settings.register_mode === 'closed'">不允许注册新用户</span>
            <span v-else-if="settings.register_mode === 'open'">任何人都可以注册</span>
            <span v-else>用户注册时需要填写有效的邀请码，注册后邀请码自动作废</span>
          </template>
        </n-form-item>
        <n-form-item>
          <n-button type="primary" :loading="saving" @click="handleSave">保存配置</n-button>
        </n-form-item>
      </n-form>
    </n-card>
  </n-space>
</template>
