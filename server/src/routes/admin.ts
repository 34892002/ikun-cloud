/**
 * 管理员路由 — /api/admin/*
 * 仅 root 可访问
 */
import { Hono } from 'hono'
import { hashSync } from 'bcryptjs'
import { db } from '@/db'
import { users, vms, portForwards, siteSettings, announcements, inviteCodes } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { success, error } from '@/utils/response'
import { authenticate, requireRole } from '@/middleware/auth'
import * as ikunCtl from '@/services/ikun-ctl'
import { getServerVms, getServerVm, type ServerVmConfig } from '@/services/server-vms'
import { listImages } from '@/services/images'
import { flushRulesByIp } from '@/services/iptables'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const adminRoutes = new Hono()

// 所有路由需要 root 角色
adminRoutes.use('*', authenticate, requireRole('root'))

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
// 宿主机状态
// ============================================================

interface HostStatus {
  cpu: { usage: number; cores: number }
  memory: { total: number; used: number; usage: number }
  disk: { total: number; used: number; usage: number }
  network: { rxBytes: number; txBytes: number; rxRate: number; txRate: number }
}

function getHostStatus(): HostStatus {
  const cpuInfo = readFileSync('/proc/cpuinfo', 'utf-8')
  const cpuCores = (cpuInfo.match(/processor/gi) || []).length

  const memInfo = readFileSync('/proc/meminfo', 'utf-8')
  const memTotal = Number(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024
  const memAvailable = Number(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024
  const memUsed = memTotal - memAvailable
  const memUsage = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0

  let diskTotal = 0, diskUsed = 0, diskUsage = 0
  try {
    const proc = Bun.spawnSync(['df', '-B1', '/'])
    const output = proc.stdout.toString()
    const lines = output.trim().split('\n')
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/)
      diskTotal = Number(parts[1]) || 0
      diskUsed = Number(parts[2]) || 0
      diskUsage = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0
    }
  } catch {}

  let cpuUsage = 0
  try {
    const stat1 = readFileSync('/proc/stat', 'utf-8')
    const values1 = stat1.split('\n')[0].split(/\s+/).slice(1).map(Number)
    const idle1 = values1[3]
    const total1 = values1.reduce((a, b) => a + b, 0)
    Bun.spawnSync(['sleep', '0.1'])
    const stat2 = readFileSync('/proc/stat', 'utf-8')
    const values2 = stat2.split('\n')[0].split(/\s+/).slice(1).map(Number)
    const idle2 = values2[3]
    const total2 = values2.reduce((a, b) => a + b, 0)
    const idleDiff = idle2 - idle1
    const totalDiff = total2 - total1
    cpuUsage = totalDiff > 0 ? Math.round(((totalDiff - idleDiff) / totalDiff) * 100) : 0
  } catch {}

  let rxBytes = 0, txBytes = 0
  try {
    const netDev = readFileSync('/proc/net/dev', 'utf-8')
    const lines = netDev.split('\n').slice(2)
    for (const line of lines) {
      const parts = line.trim().split(/[:\s]+/)
      if (parts.length < 10) continue
      const iface = parts[0]
      if (iface === 'lo' || iface.startsWith('tap') || iface === 'ikun-br0') continue
      rxBytes += Number(parts[1]) || 0
      txBytes += Number(parts[9]) || 0
    }
  } catch {}

  return {
    cpu: { usage: cpuUsage, cores: cpuCores },
    memory: { total: memTotal, used: memUsed, usage: memUsage },
    disk: { total: diskTotal, used: diskUsed, usage: diskUsage },
    network: { rxBytes, txBytes, rxRate: 0, txRate: 0 },
  }
}

// ============================================================
// GET /dashboard — 全局仪表盘
// ============================================================
adminRoutes.get('/dashboard', (c) => {
  const allVms = db.select().from(vms).all()

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

  let hostStatus: HostStatus
  try {
    hostStatus = getHostStatus()
  } catch {
    hostStatus = { cpu: { usage: 0, cores: 0 }, memory: { total: 0, used: 0, usage: 0 }, disk: { total: 0, used: 0, usage: 0 }, network: { rxBytes: 0, txBytes: 0, rxRate: 0, txRate: 0 } }
  }

  return c.json(success({
    vms: { total: allVms.length, running, stopped, error: errorVms },
    host: hostStatus,
  }))
})

// ============================================================
// GET /host/status — 宿主机状态
// ============================================================
adminRoutes.get('/host/status', (c) => {
  try {
    return c.json(success(getHostStatus()))
  } catch {
    return c.json(success({ cpu: { usage: 0, cores: 0 }, memory: { total: 0, used: 0, usage: 0 }, disk: { total: 0, used: 0, usage: 0 }, network: { rxBytes: 0, txBytes: 0, rxRate: 0, txRate: 0 } }))
  }
})

// ============================================================
// 用户管理
// ============================================================

// GET /users — 用户列表
adminRoutes.get('/users', (c) => {
  const allUsers = db.select().from(users).all()
  const items = allUsers.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    inviteCode: u.inviteCode,
    createdAt: u.createdAt,
    vmCount: db.select().from(vms).where(eq(vms.ownerId, u.id)).all().length,
  }))
  return c.json(success(items))
})

// POST /users — 创建用户
adminRoutes.post('/users', async (c) => {
  const body = await c.req.json<{ username: string; password: string; role?: string }>()

  if (!body.username || !body.password) {
    return c.json(error('用户名和密码不能为空'), 400)
  }

  if (body.password.length < 6) {
    return c.json(error('密码长度不能少于 6 位'), 400)
  }

  const existing = db.select().from(users).where(eq(users.username, body.username)).get()
  if (existing) {
    return c.json(error('用户名已存在'), 409)
  }

  const role = body.role === 'root' ? 'root' : 'user'
  const passwordHash = hashSync(body.password, 10)
  const newUser = db.insert(users).values({ username: body.username, passwordHash, role }).returning().get()

  return c.json(success({ id: newUser.id, username: newUser.username, role: newUser.role }, '用户创建成功'))
})

// PUT /users/:id — 编辑用户
adminRoutes.put('/users/:id', async (c) => {
  const userId = Number(c.req.param('id'))
  const body = await c.req.json<{ username?: string; role?: string }>()

  const dbUser = db.select().from(users).where(eq(users.id, userId)).get()
  if (!dbUser) {
    return c.json(error('用户不存在'), 404)
  }

  const updates: Record<string, unknown> = {}
  if (body.username) {
    const existing = db.select().from(users).where(eq(users.username, body.username)).get()
    if (existing && existing.id !== userId) {
      return c.json(error('用户名已存在'), 409)
    }
    updates.username = body.username
  }
  if (body.role && ['root', 'user'].includes(body.role)) {
    updates.role = body.role
  }

  if (Object.keys(updates).length > 0) {
    db.update(users).set(updates).where(eq(users.id, userId)).run()
  }

  const updated = db.select().from(users).where(eq(users.id, userId)).get()
  return c.json(success({ id: updated!.id, username: updated!.username, role: updated!.role }, '用户更新成功'))
})

// DELETE /users/:id — 删除用户
adminRoutes.delete('/users/:id', async (c) => {
  const userId = Number(c.req.param('id'))

  const dbUser = db.select().from(users).where(eq(users.id, userId)).get()
  if (!dbUser) {
    return c.json(error('用户不存在'), 404)
  }

  // 不允许删除自己
  const currentUser = c.get('user')!
  if (dbUser.id === currentUser.userId) {
    return c.json(error('不能删除自己'), 400)
  }

  // 将该用户的 VM 的 owner_id 置为 null（取消分配）
  db.update(vms).set({ ownerId: null }).where(eq(vms.ownerId, userId)).run()

  db.delete(users).where(eq(users.id, userId)).run()

  return c.json(success(null, '用户已删除，其 VM 已取消分配'))
})

// POST /users/:id/reset-password — 重置用户密码
adminRoutes.post('/users/:id/reset-password', async (c) => {
  const userId = Number(c.req.param('id'))
  const body = await c.req.json<{ password: string }>()

  if (!body.password || body.password.length < 6) {
    return c.json(error('密码长度不能少于 6 位'), 400)
  }

  const dbUser = db.select().from(users).where(eq(users.id, userId)).get()
  if (!dbUser) {
    return c.json(error('用户不存在'), 404)
  }

  const passwordHash = hashSync(body.password, 10)
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run()

  return c.json(success(null, '密码重置成功'))
})

// ============================================================
// VM 管理
// ============================================================

// GET /vms — 所有 VM 列表（含分配状态）
adminRoutes.get('/vms', (c) => {
  const status = c.req.query('status')
  const page = Number(c.req.query('page')) || 1
  const pageSize = Number(c.req.query('pageSize')) || 20

  const dbVms = db.select().from(vms).all()
  const dbVmIds = new Set(dbVms.map((v) => v.id))

  const serverVms = getServerVms()
  const serverVmMap = new Map(serverVms.map((v) => [v.id, v]))

  const allVms: Record<string, unknown>[] = []

  for (const vm of dbVms) {
    const serverVm = serverVmMap.get(vm.id) ?? null
    const merged = mergeVm(vm, serverVm)
    // 附带 owner 信息
    if (vm.ownerId) {
      const owner = db.select().from(users).where(eq(users.id, vm.ownerId)).get()
      merged.owner = owner ? { id: owner.id, username: owner.username } : null
    }
    allVms.push(merged)
  }

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
      owner: null,
      managed: 'manual' as const,
    })
  }

  allVms.sort((a, b) => (a.id as string).localeCompare(b.id as string))

  const filtered = status ? allVms.filter((vm) => vm.status === status) : allVms
  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  return c.json(success({ items, total, page, pageSize }))
})

// POST /vms — 创建 VM
adminRoutes.post('/vms', async (c) => {
  const body = await c.req.json<{
    name: string
    baseImage: string
    cpus?: number
    memoryMb?: number
    diskGb?: number
    sshPort?: number
    password?: string
    ownerId?: number
  }>()

  if (!body.name || !body.baseImage) {
    return c.json(error('名称和基础镜像不能为空'), 400)
  }

  // 如果指定了 owner，验证存在
  if (body.ownerId && body.ownerId > 0) {
    const owner = db.select().from(users).where(eq(users.id, body.ownerId)).get()
    if (!owner) {
      return c.json(error('指定的用户不存在'), 400)
    }
  }

  try {
    const result = await ikunCtl.createVm({
      name: body.name,
      baseImage: body.baseImage,
      cpus: body.cpus || 1,
      memoryMb: body.memoryMb || 512,
      diskGb: body.diskGb || 2,
      sshPort: body.sshPort,
      password: body.password,
    })

    // 设置 owner
    if (body.ownerId && body.ownerId > 0) {
      db.update(vms).set({ ownerId: body.ownerId }).where(eq(vms.id, result.vmId)).run()
    }

    // 创建后自动启动
    await ikunCtl.startVm(result.vmId)

    const dbVm = db.select().from(vms).where(eq(vms.id, result.vmId)).get()
    const serverVm = getServerVm(result.vmId)
    return c.json(success(mergeVm(dbVm!, serverVm)))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '创建失败'), 500)
  }
})

// DELETE /vms/:id — 删除 VM
adminRoutes.delete('/vms/:id', async (c) => {
  const vmId = c.req.param('id')

  const serverVm = getServerVm(vmId)
  const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()

  if (!serverVm && dbVm) {
    await flushRulesByIp(dbVm.ip)
    db.delete(portForwards).where(eq(portForwards.vmId, vmId)).run()
    db.delete(vms).where(eq(vms.id, vmId)).run()
    // 清理残留磁盘
    const diskPath = `/data/ikun-cloud/disks/${vmId}.qcow2`
    if (existsSync(diskPath)) {
      await Bun.spawn(['rm', '-f', diskPath]).exited
    }
    return c.json(success(null, '已清理失效记录'))
  }

  const vmIp = serverVm?.ip ?? dbVm?.ip

  try {
    if (vmIp) {
      await flushRulesByIp(vmIp)
    }
    await ikunCtl.destroyVm(vmId)
    return c.json(success(null, '删除成功'))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '删除失败'), 500)
  }
})

// GET /vms/:id — VM 详情
adminRoutes.get('/vms/:id', (c) => {
  const vmId = c.req.param('id')
  const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
  const serverVm = getServerVm(vmId)
  if (!dbVm && !serverVm) return c.json(error('VM 不存在'), 404)
  const owner = dbVm?.ownerId ? db.select().from(users).where(eq(users.id, dbVm.ownerId)).get() : null
  const ports = db.select().from(portForwards).where(eq(portForwards.vmId, vmId)).all()
  return c.json(success({ ...mergeVm({ ...dbVm, owner: owner ? { id: owner.id, username: owner.username } : null }, serverVm), ports }))
})

// POST /vms/:id/start — 启动 VM
adminRoutes.post('/vms/:id/start', async (c) => {
  const vmId = c.req.param('id')
  const serverVm = getServerVm(vmId)
  if (serverVm?.status === 'running') return c.json(error('VM 已在运行'), 400)
  try {
    await ikunCtl.startVm(vmId)
    const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    return c.json(success(mergeVm(dbVm!, getServerVm(vmId))))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '启动失败'), 500)
  }
})

// POST /vms/:id/stop — 停止 VM
adminRoutes.post('/vms/:id/stop', async (c) => {
  const vmId = c.req.param('id')
  try {
    await ikunCtl.stopVm(vmId)
    const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    return c.json(success(mergeVm(dbVm!, getServerVm(vmId))))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '停止失败'), 500)
  }
})

// POST /vms/:id/restart — 重启 VM
adminRoutes.post('/vms/:id/restart', async (c) => {
  const vmId = c.req.param('id')
  try {
    await ikunCtl.restartVm(vmId)
    const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    return c.json(success(mergeVm(dbVm!, getServerVm(vmId))))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '重启失败'), 500)
  }
})

// POST /vms/:id/reset-password — 重置密码
adminRoutes.post('/vms/:id/reset-password', async (c) => {
  const vmId = c.req.param('id')
  try {
    const result = await ikunCtl.resetPassword(vmId)
    const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    return c.json(success({ ...mergeVm(dbVm!, getServerVm(vmId)), newPassword: result.newPassword }))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '重置密码失败'), 500)
  }
})

// POST /vms/:id/reinstall — 重装系统
adminRoutes.post('/vms/:id/reinstall', async (c) => {
  const vmId = c.req.param('id')
  const body = await c.req.json<{ baseImage: string; password?: string }>()
  if (!body.baseImage) return c.json(error('镜像不能为空'), 400)
  try {
    await ikunCtl.reinstallVm(vmId, body.baseImage, body.password)
    const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    return c.json(success(mergeVm(dbVm!, getServerVm(vmId))))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '重装失败'), 500)
  }
})

// PATCH /vms/:id — 修改 VM 配置
adminRoutes.patch('/vms/:id', async (c) => {
  const vmId = c.req.param('id')
  const body = await c.req.json<{ cpus?: number; memoryMb?: number; diskGb?: number }>()

  if (!body.cpus && !body.memoryMb && !body.diskGb) {
    return c.json(error('至少指定一个配置项'), 400)
  }

  const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
  if (!dbVm) {
    return c.json(error('VM 不存在'), 404)
  }

  if (body.diskGb && body.diskGb < dbVm.diskGb) {
    return c.json(error(`磁盘只能扩大，当前 ${dbVm.diskGb}GB`), 400)
  }

  try {
    await ikunCtl.resizeVm(vmId, {
      cpus: body.cpus,
      memoryMb: body.memoryMb,
      diskGb: body.diskGb,
    })

    const updatedDbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    const serverVm = getServerVm(vmId)
    return c.json(success(mergeVm(updatedDbVm!, serverVm)))
  } catch (err: unknown) {
    return c.json(error(err instanceof Error ? err.message : '修改配置失败'), 500)
  }
})

// POST /vms/:id/assign — 分配 VM 给用户
adminRoutes.post('/vms/:id/assign', async (c) => {
  const vmId = c.req.param('id')
  const body = await c.req.json<{ userId: number }>()

  if (!body.userId) {
    return c.json(error('userId 不能为空'), 400)
  }

  const targetUser = db.select().from(users).where(eq(users.id, body.userId)).get()
  if (!targetUser) {
    return c.json(error('用户不存在'), 404)
  }

  let dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()

  // 如果 VM 不在数据库中（服务器手动创建的），先同步到数据库
  if (!dbVm) {
    const serverVm = getServerVm(vmId)
    if (!serverVm) {
      return c.json(error('VM 不存在'), 404)
    }
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
      ownerId: body.userId,
    }).run()

    // 同步 SSH 端口映射
    if (serverVm.ssh_port) {
      const existing = db.select().from(portForwards)
        .where(eq(portForwards.vmId, serverVm.id))
        .get()
      if (!existing) {
        db.insert(portForwards).values({
          vmId: serverVm.id,
          hostPort: serverVm.ssh_port,
          guestPort: 22,
          protocol: 'tcp',
        }).run()
      }
    }

    dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
    return c.json(success({ ...dbVm, owner: { id: targetUser.id, username: targetUser.username } }, `已同步并分配给 ${targetUser.username}`))
  }

  db.update(vms).set({ ownerId: body.userId }).where(eq(vms.id, vmId)).run()

  const updated = db.select().from(vms).where(eq(vms.id, vmId)).get()
  return c.json(success({ ...updated, owner: { id: targetUser.id, username: targetUser.username } }, `已分配给 ${targetUser.username}`))
})

// POST /vms/:id/unassign — 取消分配
adminRoutes.post('/vms/:id/unassign', async (c) => {
  const vmId = c.req.param('id')

  const dbVm = db.select().from(vms).where(eq(vms.id, vmId)).get()
  if (!dbVm) {
    return c.json(error('VM 不存在'), 404)
  }

  db.update(vms).set({ ownerId: null }).where(eq(vms.id, vmId)).run()

  return c.json(success(null, '已取消分配'))
})

// ============================================================
// 镜像管理
// ============================================================

adminRoutes.get('/images', (c) => {
  const images = listImages()
  return c.json(success(images))
})

// ============================================================
// 网站配置
// ============================================================

// GET /settings — 网站配置
adminRoutes.get('/settings', (c) => {
  const settings = db.select().from(siteSettings).all()
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]))
  return c.json(success(map))
})

// PUT /settings — 修改网站配置
adminRoutes.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>()

  for (const [key, value] of Object.entries(body)) {
    const existing = db.select().from(siteSettings).where(eq(siteSettings.key, key)).get()
    if (existing) {
      db.update(siteSettings).set({ value }).where(eq(siteSettings.key, key)).run()
    } else {
      db.insert(siteSettings).values({ key, value }).run()
    }
  }

  return c.json(success(null, '配置已更新'))
})

// ============================================================
// 公告管理
// ============================================================

// GET /announcements — 公告列表（含全部，包括未激活）
adminRoutes.get('/announcements', (c) => {
  const items = db.select().from(announcements).all().sort((a, b) => b.id - a.id)
  return c.json(success(items))
})

// POST /announcements — 创建公告
adminRoutes.post('/announcements', async (c) => {
  const body = await c.req.json<{ title: string; content: string; isActive?: boolean }>()

  if (!body.title || !body.content) {
    return c.json(error('标题和内容不能为空'), 400)
  }

  const item = db.insert(announcements).values({
    title: body.title,
    content: body.content,
    isActive: body.isActive === false ? 0 : 1,
  }).returning().get()

  return c.json(success(item, '公告创建成功'))
})

// PUT /announcements/:id — 编辑公告
adminRoutes.put('/announcements/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ title?: string; content?: string; isActive?: boolean }>()

  const existing = db.select().from(announcements).where(eq(announcements.id, id)).get()
  if (!existing) {
    return c.json(error('公告不存在'), 404)
  }

  const updates: Record<string, unknown> = {}
  if (body.title) updates.title = body.title
  if (body.content) updates.content = body.content
  if (body.isActive !== undefined) updates.isActive = body.isActive ? 1 : 0
  updates.updatedAt = new Date().toISOString()

  db.update(announcements).set(updates).where(eq(announcements.id, id)).run()

  const updated = db.select().from(announcements).where(eq(announcements.id, id)).get()
  return c.json(success(updated, '公告更新成功'))
})

// DELETE /announcements/:id — 删除公告
adminRoutes.delete('/announcements/:id', (c) => {
  const id = Number(c.req.param('id'))

  const existing = db.select().from(announcements).where(eq(announcements.id, id)).get()
  if (!existing) {
    return c.json(error('公告不存在'), 404)
  }

  db.delete(announcements).where(eq(announcements.id, id)).run()
  return c.json(success(null, '公告已删除'))
})

// ============================================================
// GET /metrics/summary — 全局监控
// ============================================================
adminRoutes.get('/metrics/summary', (c) => {
  const allVms = db.select().from(vms).all()
  return c.json(success({
    vms: allVms.map((vm) => ({ vmId: vm.id, name: vm.name })),
  }))
})

// ============================================================
// 邀请码管理
// ============================================================

// GET /invite-codes — 邀请码列表
adminRoutes.get('/invite-codes', (c) => {
  const items = db.select().from(inviteCodes).all()
  // 附带使用者信息
  const result = items.map((item) => {
    let usedByUsername: string | null = null
    if (item.usedBy) {
      const u = db.select().from(users).where(eq(users.id, item.usedBy)).get()
      usedByUsername = u?.username ?? null
    }
    return { ...item, usedByUsername }
  })
  return c.json(success(result))
})

// POST /invite-codes — 创建邀请码
adminRoutes.post('/invite-codes', async (c) => {
  const body = await c.req.json<{ code?: string; remark: string; count?: number }>()

  if (!body.remark) {
    return c.json(error('备注不能为空'), 400)
  }

  const count = Math.min(body.count || 1, 50)
  const codes: Array<typeof inviteCodes.$inferSelect> = []

  for (let i = 0; i < count; i++) {
    const code = body.code && count === 1 ? body.code : generateCode()
    try {
      const inserted = db.insert(inviteCodes).values({ code, remark: body.remark }).returning().get()
      codes.push(inserted)
    } catch {
      // code 重复，重试
      const retryCode = generateCode()
      const inserted = db.insert(inviteCodes).values({ code: retryCode, remark: body.remark }).returning().get()
      codes.push(inserted)
    }
  }

  return c.json(success(codes, `已创建 ${codes.length} 个邀请码`))
})

// DELETE /invite-codes/:id — 删除邀请码
adminRoutes.delete('/invite-codes/:id', (c) => {
  const id = Number(c.req.param('id'))
  const existing = db.select().from(inviteCodes).where(eq(inviteCodes.id, id)).get()
  if (!existing) {
    return c.json(error('邀请码不存在'), 404)
  }
  db.delete(inviteCodes).where(eq(inviteCodes.id, id)).run()
  return c.json(success(null, '已删除'))
})

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// ============================================================
// 网络配置：所有已分配端口
// ============================================================

adminRoutes.get('/network/ports', (c) => {
  const allPorts = db.select().from(portForwards).all()
  const allVms = db.select().from(vms).all()
  const vmMap = new Map(allVms.map((v) => [v.id, v]))
  const allUsers = db.select().from(users).all()
  const userMap = new Map(allUsers.map((u) => [u.id, u.username]))

  const result = allPorts.map((p) => {
    const vm = vmMap.get(p.vmId)
    return {
      id: p.id,
      vmId: p.vmId,
      vmName: vm?.name || p.vmId,
      hostPort: p.hostPort,
      guestPort: p.guestPort,
      protocol: p.protocol,
      owner: vm?.ownerId ? (userMap.get(vm.ownerId) || null) : null,
    }
  }).sort((a, b) => a.hostPort - b.hostPort)

  return c.json(success(result))
})

export default adminRoutes
