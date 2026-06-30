/**
 * 默认数据初始化（P1 租户系统）
 */
import { hashSync } from 'bcryptjs'
import { db } from './index'
import { users, siteSettings } from './schema'
import { eq } from 'drizzle-orm'

export function seedDefaults() {
  // 1. 创建默认 root 管理员
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin'
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'

  const existing = db.select().from(users).where(eq(users.username, username)).get()

  if (existing) {
    // 确保现有 admin 有 root 角色
    if (existing.role !== 'root') {
      db.update(users).set({ role: 'root' }).where(eq(users.id, existing.id)).run()
      console.log(`ℹ️  用户 "${username}" 角色已升级为 root`)
    }
    console.log(`ℹ️  管理员 "${username}" 已存在`)
  } else {
    const passwordHash = hashSync(password, 10)
    db.insert(users).values({ username, passwordHash, role: 'root' }).run()
    console.log(`✅ 默认管理员创建成功: ${username} / ${password}`)
    console.log('⚠️  请在生产环境修改默认密码！')
  }

  // 2. 初始化网站配置默认值
  const defaults: Record<string, string> = {
    registration_open: 'false',
    register_mode: 'closed',
    site_name: 'ikun-cloud',
    host_ip: '',
    nat_limit: '40',
    nat_blacklist: '22,3389,3000',
  }

  for (const [key, value] of Object.entries(defaults)) {
    const existing = db.select().from(siteSettings).where(eq(siteSettings.key, key)).get()
    if (!existing) {
      db.insert(siteSettings).values({ key, value }).run()
      console.log(`✅ 配置初始化: ${key} = ${value}`)
    }
  }
}

// 直接运行时执行
if (import.meta.main) {
  seedDefaults()
}
