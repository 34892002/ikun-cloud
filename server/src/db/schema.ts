/**
 * 数据库表结构定义（P1 租户系统）
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ============================================================
// 邀请码表
// ============================================================
export const inviteCodes = sqliteTable('invite_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  remark: text('remark').notNull(),
  usedBy: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`datetime('now')`),
  usedAt: text('used_at'),
})

// ============================================================
// 用户表（root 管理员 + user 租户，同表 role 字段区分）
// ============================================================
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'), // 'root' | 'user'
  inviteCode: text('invite_code'), // 使用的邀请码
  createdAt: text('created_at').notNull().default(sql`datetime('now')`),
})

// ============================================================
// VM 实例表（owner_id 关联租户，NULL 表示未分配）
// ============================================================
export const vms = sqliteTable('vms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('stopped'),
  cpus: integer('cpus').notNull().default(1),
  memoryMb: integer('memory_mb').notNull().default(512),
  diskGb: integer('disk_gb').notNull().default(20),
  baseImage: text('base_image').notNull(),
  ip: text('ip').notNull(),
  mac: text('mac').notNull(),
  tap: text('tap').notNull(),
  sshPort: integer('ssh_port').notNull(),
  password: text('password'),
  apiSocket: text('api_socket'),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`datetime('now')`),
  updatedAt: text('updated_at').notNull().default(sql`datetime('now')`),
})

// ============================================================
// 端口映射规则表
// ============================================================
export const portForwards = sqliteTable('port_forwards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id').notNull().references(() => vms.id, { onDelete: 'cascade' }),
  hostPort: integer('host_port').notNull(),
  guestPort: integer('guest_port').notNull(),
  protocol: text('protocol').notNull().default('tcp'),
  createdAt: text('created_at').notNull().default(sql`datetime('now')`),
})

// ============================================================
// 网站配置表（key-value）
// ============================================================
export const siteSettings = sqliteTable('site_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

// ============================================================
// 公告表
// ============================================================
export const announcements = sqliteTable('announcements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  content: text('content').notNull(),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`datetime('now')`),
  updatedAt: text('updated_at').notNull().default(sql`datetime('now')`),
})

// ============================================================
// 操作日志表（预留）
// ============================================================
export const operationLogs = sqliteTable('operation_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id'),
  action: text('action').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull().default(sql`datetime('now')`),
})

// ============================================================
// 监控采样表（保留 24 小时）
// ============================================================

export const trafficSamples = sqliteTable('traffic_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id').notNull().references(() => vms.id, { onDelete: 'cascade' }),
  rxBytes: integer('rx_bytes').notNull(),
  txBytes: integer('tx_bytes').notNull(),
  sampledAt: text('sampled_at').notNull().default(sql`datetime('now')`),
})

export const cpuSamples = sqliteTable('cpu_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id').notNull().references(() => vms.id, { onDelete: 'cascade' }),
  usage: real('usage').notNull(),
  sampledAt: text('sampled_at').notNull().default(sql`datetime('now')`),
})

export const memSamples = sqliteTable('mem_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id').notNull().references(() => vms.id, { onDelete: 'cascade' }),
  used: integer('used').notNull(),
  total: integer('total').notNull(),
  sampledAt: text('sampled_at').notNull().default(sql`datetime('now')`),
})

export const diskSamples = sqliteTable('disk_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id').notNull().references(() => vms.id, { onDelete: 'cascade' }),
  readBytes: integer('read_bytes').notNull(),
  writeBytes: integer('write_bytes').notNull(),
  sampledAt: text('sampled_at').notNull().default(sql`datetime('now')`),
})

// ============================================================
// 小时聚合表（永久保留）
// ============================================================

export const vmMetricsHourly = sqliteTable('vm_metrics_hourly', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vmId: text('vm_id').notNull().references(() => vms.id, { onDelete: 'cascade' }),
  hourStart: text('hour_start').notNull(),
  rxBytes: integer('rx_bytes').notNull().default(0),
  txBytes: integer('tx_bytes').notNull().default(0),
  cpuAvg: real('cpu_avg').notNull().default(0),
  cpuMax: real('cpu_max').notNull().default(0),
  memAvg: integer('mem_avg').notNull().default(0),
  memMax: integer('mem_max').notNull().default(0),
  memTotal: integer('mem_total').notNull().default(0),
  diskRead: integer('disk_read').notNull().default(0),
  diskWrite: integer('disk_write').notNull().default(0),
})
