/**
 * 租户路由 — /api/user/*
 * root 和 user 登录后均可访问，user 只能操作自己的 VM
 */
import { Hono } from 'hono'
import { compareSync, hashSync } from 'bcryptjs'
import { db } from '@/db'
import { vms, portForwards, users, siteSettings } from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { success, error } from '@/utils/response'
import { authenticate, requireAuth } from '@/middleware/auth'
import type { JwtPayload } from '@/middleware/auth'
import * as ikunCtl from '@/services/ikun-ctl'
import { getServerVms, getServerVm, type ServerVmConfig } from '@/services/server-vms'
import { flushRulesByIp, ruleExists, addPortForward, removePortForward } from '@/services/iptables'

const userRoutes = new Hono()

// 所有路由需要认证
userRoutes.use('*', authenticate, requireAuth)

const PORT_LIMIT_DEFAULT = 40

/**
 * 从 site_settings 读取 NAT 上限
 */
function getNatLimit(): number {
  const setting = db.select().from(siteSettings).where(eq(siteSettings.key, 'nat_limit')).get()
  return setting ? (Number(setting.value) || PORT_LIMIT_DEFAULT) : PORT_LIMIT_DEFAULT
}

/**
 * 从 site_settings 读取 NAT 黑名单端口
 */
function getNatBlacklist(): Set<number> {
  const setting = db.select().from(siteSettings).where(eq(siteSettings.key, 'nat_blacklist')).get()
  if (!setting || !setting.value) return new Set()
  return new Set(setting.value.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0))
}

/**
 * 确保 VM 在数据库中存在（服务器手动创建的 VM 需要先同步）
 * 返回数据库中的 VM 记录
 */
function ensureVmInDb(vmId: string) {
  let dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
  if (dbVm) return dbVm

  const serverVm = getServerVm(vmId)
  if (!serverVm) return null

  db.insert(vms).values({
    id: serverVm.id,
    name: serverVm.name,
    status: serverVm.status || 'stopped',
    cpus: serverVm.cpus,
    memoryMb: serverVm.memory_mb,
    diskGb: serverVm.disk_gb,
    baseImage: serverVm.base_image || 'unknown',
    ip: serverVm.ip,
    mac: serverVm.mac,
    tap: serverVm.tap,
    sshPort: serverVm.ssh_port,
    password: serverVm.password,
    apiSocket: serverVm.api_socket,
  }).run()

  return db.select().from(vms).where(eq(vms.id, vmId)).get()
}

/**
 * 校验 user 是否有权操作该 VM
 * root 可操作所有，user 只能操作 owner_id = 自己的
 */
function checkVmAccess(userId: number, role: string, vmId: string) {
  const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
  if (dbVm) {
    if (role === 'root') return { dbVm, allowed: true }
    if (dbVm.ownerId === userId) return { dbVm, allowed: true }
    return { dbVm, allowed: false, reason: '无权操作此 VM' }
  }
  // 数据库没有时，root 可以从服务器读
  if (role === 'root') {
    const serverVm = getServerVm(vmId)
    if (serverVm) return { dbVm: null, allowed: true }
  }
  return { dbVm: null, allowed: false, reason: 'VM 不存在' }
}

/**
 * 合并数据库配置 + 服务器实际状态
 */
function mergeVm(dbVm: Record<string, unknown>, serverVm: ServerVmConfig | null) {
  if (!serverVm) {
    return { ...dbVm, managed: 'stale' as const }
  }
  return {
    ...dbVm,
    status: serverVm.status,
    ip: serverVm.ip,
    sshPort: serverVm.ssh_port,
    password: serverVm.password,
    managed: 'managed' as const,
  }
}

// ============================================================
// GET /me — 当前用户信息
// ============================================================
userRoutes.get('/me', (c) => {
  const user = c.get('user')!
  const dbUser = db.select().from(users).where(eq(users.id, user.userId)).get()
  if (!dbUser) {
    return c.json(error('用户不存在'), 404)
  }
  return c.json(success({ id: dbUser.id, username: dbUser.username, role: dbUser.role, createdAt: dbUser.createdAt }))
})

// ============================================================
// PUT /password — 修改自己的登录密码
// ============================================================
userRoutes.put('/password', async (c) => {
  const user = c.get('user')!
  const { oldPassword, newPassword } = await c.req.json<{ oldPassword: string; newPassword: string }>()

  if (!oldPassword || !newPassword) {
    return c.json(error('旧密码和新密码不能为空'), 400)
  }

  if (newPassword.length < 6) {
    return c.json(error('新密码长度不能少于 6 位'), 400)
  }

  const dbUser = db.select().from(users).where(eq(users.id, user.userId)).get()
  if (!dbUser) {
    return c.json(error('用户不存在'), 404)
  }

  if (!compareSync(oldPassword, dbUser.passwordHash)) {
    return c.json(error('旧密码错误'), 400)
  }

  const newPasswordHash = hashSync(newPassword, 10)
  db.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, user.userId)).run()

  return c.json(success(null, '密码修改成功'))
})

// ============================================================
// GET /vms — VM 列表（root 看全部，user 只看自己的）
// ============================================================
userRoutes.get('/vms', (c) => {
  const user = c.get('user')!
  const status = c.req.query('status')
  const page = Number(c.req.query('page')) || 1
  const pageSize = Number(c.req.query('pageSize')) || 20

  // 读数据库
  let dbVms: Array<typeof vms.$inferSelect>
  if (user.role === 'root') {
    dbVms = db.select().from(vms).all()
  } else {
    dbVms = db.select().from(vms).where(eq(vms.ownerId, user.userId)).all()
  }

  const dbVmIds = new Set(dbVms.map((v) => v.id))

  // 读服务器实际配置
  const serverVms = getServerVms()
  const serverVmMap = new Map(serverVms.map((v) => [v.id, v]))

  // 合并
  const allVms: Record<string, unknown>[] = []

  for (const vm of dbVms) {
    const serverVm = serverVmMap.get(vm.id) ?? null
    allVms.push(mergeVm(vm, serverVm))
  }

  // root 时也显示服务器上有但数据库没有的 VM
  if (user.role === 'root') {
    for (const svm of serverVms) {
      if (dbVmIds.has(svm.id)) continue
      allVms.push({
        id: svm.id,
        name: svm.name,
        status: svm.status,
        cpus: svm.cpus,
        memoryMb: svm.memory_mb,
        diskGb: svm.disk_gb,
        baseImage: svm.base_image || 'unknown',
        ip: svm.ip,
        mac: svm.mac,
        tap: svm.tap,
        sshPort: svm.ssh_port,
        password: svm.password,
        createdAt: svm.created_at,
        ownerId: null,
        managed: 'manual' as const,
      })
    }
  }

  allVms.sort((a, b) => (a.id as string).localeCompare(b.id as string))

  const filtered = status
    ? allVms.filter((vm) => vm.status === status)
    : allVms

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  return c.json(success({ items, total, page, pageSize }))
})

// ============================================================
// GET /vms/:id — VM 详情
// ============================================================
userRoutes.get('/vms/:id', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')

  // 1. 先查数据库
  const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
  if (dbVm) {
    // user 只能看自己的
    if (user.role !== 'root' && dbVm.ownerId !== user.userId) {
      return c.json(error('无权查看此 VM'), 403)
    }
    const portsDb = db.select().from(portForwards).where(eq(portForwards.vmId, vmId)).all()
    const serverVm = getServerVm(vmId)
    const ip = serverVm?.ip ?? dbVm.ip
    const ports = await Promise.all(
      portsDb.map(async (p) => ({
        ...p,
        active: await ruleExists(p.hostPort, p.guestPort, ip, p.protocol),
      }))
    )
    return c.json(success({ ...mergeVm(dbVm, serverVm), ports }))
  }

  // 2. root 时也查服务器（手动创建的 VM）
  if (user.role === 'root') {
    const serverVm = getServerVm(vmId)
    if (serverVm) {
      return c.json(success({
        id: serverVm.id,
        name: serverVm.name,
        status: serverVm.status,
        cpus: serverVm.cpus,
        memoryMb: serverVm.memory_mb,
        diskGb: serverVm.disk_gb,
        baseImage: serverVm.base_image || 'unknown',
        ip: serverVm.ip,
        mac: serverVm.mac,
        tap: serverVm.tap,
        sshPort: serverVm.ssh_port,
        password: serverVm.password,
        createdAt: serverVm.created_at,
        ownerId: null,
        managed: 'manual' as const,
        ports: [],
      }))
    }
  }

  return c.json(error('VM 不存在'), 404)
})

// ============================================================
// POST /vms/:id/start — 启动
// ============================================================
userRoutes.post('/vms/:id/start', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  const serverVm = getServerVm(vmId)
  if (serverVm?.status === 'running') {
    return c.json(error('VM 已在运行'), 400)
  }

  try {
    await ikunCtl.startVm(vmId)
    const updatedServerVm = getServerVm(vmId)
    return c.json(success(dbVm ? mergeVm(dbVm, updatedServerVm) : updatedServerVm))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '启动失败'), 500)
  }
})

// ============================================================
// POST /vms/:id/stop — 停止
// ============================================================
userRoutes.post('/vms/:id/stop', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  try {
    await ikunCtl.stopVm(vmId)
    const updatedServerVm = getServerVm(vmId)
    return c.json(success(dbVm ? mergeVm(dbVm, updatedServerVm) : updatedServerVm))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '停止失败'), 500)
  }
})

// ============================================================
// POST /vms/:id/restart — 重启
// ============================================================
userRoutes.post('/vms/:id/restart', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  try {
    await ikunCtl.restartVm(vmId)
    const updatedServerVm = getServerVm(vmId)
    return c.json(success(dbVm ? mergeVm(dbVm, updatedServerVm) : updatedServerVm))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '重启失败'), 500)
  }
})

// ============================================================
// POST /vms/:id/reset-password — 重置 VM 密码
// ============================================================
userRoutes.post('/vms/:id/reset-password', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  try {
    const result = await ikunCtl.resetPassword(vmId)
    const serverVm = getServerVm(vmId)
    return c.json(success({ ...(dbVm ? mergeVm(dbVm, serverVm) : serverVm), newPassword: result.newPassword }))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '重置密码失败'), 500)
  }
})

// ============================================================
// POST /vms/:id/reinstall — 重装系统
// ============================================================
userRoutes.post('/vms/:id/reinstall', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const body = await c.req.json<{ baseImage: string; password?: string }>()

  if (!body.baseImage) {
    return c.json(error('镜像不能为空'), 400)
  }

  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  try {
    await ikunCtl.reinstallVm(vmId, body.baseImage, body.password)
    const serverVm = getServerVm(vmId)
    return c.json(success(dbVm ? mergeVm(dbVm, serverVm) : serverVm))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '重装失败'), 500)
  }
})

// ============================================================
// GET /network/vms/:id/ports — 端口映射列表（含配额信息）
// ============================================================
userRoutes.get('/network/vms/:id/ports', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  const vmIp = dbVm?.ip ?? getServerVm(vmId)?.ip
  if (!vmIp) return c.json(error('VM 不存在'), 404)

  const ports = db.select().from(portForwards).where(eq(portForwards.vmId, vmId)).all()
  const items = await Promise.all(
    ports.map(async (p) => ({
      ...p,
      active: await ruleExists(p.hostPort, p.guestPort, vmIp, p.protocol),
    }))
  )

  // 计算配额（单 VM 统计）
  const natLimit = getNatLimit()
  const usedCount = items.length

  return c.json(success({ items, usedCount, limit: natLimit }))
})

// ============================================================
// POST /network/vms/:id/ports — 添加端口映射（每用户上限 40 条）
// ============================================================
userRoutes.post('/network/vms/:id/ports', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const body = await c.req.json<{ hostPort: number; guestPort: number; protocol?: string }>()

  if (!body.hostPort || !body.guestPort) {
    return c.json(error('宿主端口和目标端口不能为空'), 400)
  }

  if (body.hostPort < 1 || body.hostPort > 65535 || body.guestPort < 1 || body.guestPort > 65535) {
    return c.json(error('端口范围 1-65535'), 400)
  }

  const { allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  // 确保 VM 在数据库中（端口映射需要外键关联）
  const syncedVm = ensureVmInDb(vmId)
  if (!syncedVm) return c.json(error('VM 不存在'), 404)

  // 检查黑名单
  const blacklist = getNatBlacklist()
  if (blacklist.has(body.hostPort)) {
    return c.json(error(`端口 ${body.hostPort} 在黑名单中，禁止分配`), 400)
  }

  // 检查单 VM 端口规则上限
  const vmPorts = db.select().from(portForwards).where(eq(portForwards.vmId, vmId)).all()
  if (vmPorts.length >= getNatLimit()) {
    return c.json(error(`该 VM 端口映射规则已达上限`), 400)
  }

  // 检查宿主端口是否已被任意 VM 占用
  const existing = db.select().from(portForwards).where(eq(portForwards.hostPort, body.hostPort)).get()
  if (existing) {
    return c.json(error(`端口 ${body.hostPort} 已被 VM ${existing.vmId} 占用`), 400)
  }

  // 添加 iptables 规则
  const protocol = body.protocol || 'tcp'
  const ok = await addPortForward(body.hostPort, body.guestPort, syncedVm.ip, protocol)
  if (!ok) {
    return c.json(error('添加 iptables 规则失败'), 500)
  }

  const portForward = db.insert(portForwards).values({
    vmId,
    hostPort: body.hostPort,
    guestPort: body.guestPort,
    protocol,
  }).returning().get()

  return c.json(success({ ...portForward, active: true }))
})

// ============================================================
// DELETE /network/vms/:id/ports/:pid — 删除端口映射
// ============================================================
userRoutes.delete('/network/vms/:id/ports/:pid', async (c) => {
  const user = c.get('user')!
  const vmId = c.req.param('id')
  const portId = Number(c.req.param('pid'))

  const { dbVm, allowed, reason } = checkVmAccess(user.userId, user.role, vmId)
  if (!allowed) return c.json(error(reason!), 403)

  const vmIp = dbVm?.ip ?? getServerVm(vmId)?.ip
  if (!vmIp) return c.json(error('VM 不存在'), 404)

  const portForward = db.select().from(portForwards)
    .where(and(eq(portForwards.id, portId), eq(portForwards.vmId, vmId)))
    .get()

  if (!portForward) {
    return c.json(error('端口映射不存在'), 404)
  }

  await removePortForward(portForward.hostPort, portForward.guestPort, vmIp, portForward.protocol)
  db.delete(portForwards).where(eq(portForwards.id, portId)).run()

  return c.json(success(null, '删除成功'))
})

// ============================================================
// GET /dashboard — 用户仪表盘
// ============================================================
userRoutes.get('/dashboard', (c) => {
  const user = c.get('user')!

  let allVms: Array<typeof vms.$inferSelect>
  if (user.role === 'root') {
    allVms = db.select().from(vms).all()
  } else {
    allVms = db.select().from(vms).where(eq(vms.ownerId, user.userId)).all()
  }

  // 合并服务器实际状态
  const serverVms = getServerVms()
  const serverVmMap = new Map(serverVms.map((v) => [v.id, v]))

  const merged = allVms.map((vm) => {
    const sv = serverVmMap.get(vm.id)
    return { ...vm, status: sv?.status ?? vm.status }
  })

  const running = merged.filter((vm) => vm.status === 'running').length
  const stopped = merged.filter((vm) => vm.status === 'stopped').length
  const errorVms = merged.filter((vm) => vm.status === 'error').length

  return c.json(success({
    vms: {
      total: allVms.length,
      running,
      stopped,
      error: errorVms,
    },
  }))
})

// ============================================================
// GET /metrics/summary — 用户 VM 监控
// ============================================================
userRoutes.get('/metrics/summary', (c) => {
  const user = c.get('user')!

  let allVms: Array<typeof vms.$inferSelect>
  if (user.role === 'root') {
    allVms = db.select().from(vms).all()
  } else {
    allVms = db.select().from(vms).where(eq(vms.ownerId, user.userId)).all()
  }

  return c.json(success({
    vms: allVms.map((vm) => ({ vmId: vm.id, name: vm.name })),
  }))
})

export default userRoutes
