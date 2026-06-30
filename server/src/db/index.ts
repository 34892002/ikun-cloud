/**
 * 数据库连接封装 — 使用 bun:sqlite（P1 租户系统）
 */
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const dbPath = process.env.DB_PATH || './data/ikun-cloud.db'

// 确保数据库目录存在
mkdirSync(dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath)

// 启用 WAL 模式和外键约束
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA foreign_keys = ON')

// 建表
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    invite_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    remark TEXT NOT NULL,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped',
    cpus INTEGER NOT NULL DEFAULT 1,
    memory_mb INTEGER NOT NULL DEFAULT 512,
    disk_gb INTEGER NOT NULL DEFAULT 20,
    base_image TEXT NOT NULL,
    ip TEXT NOT NULL,
    mac TEXT NOT NULL,
    tap TEXT NOT NULL,
    ssh_port INTEGER NOT NULL,
    password TEXT,
    api_socket TEXT,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS port_forwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    host_port INTEGER NOT NULL,
    guest_port INTEGER NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'tcp',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 流量采样
  CREATE TABLE IF NOT EXISTS traffic_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    rx_bytes INTEGER NOT NULL,
    tx_bytes INTEGER NOT NULL,
    sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_traffic_samples_vm_time ON traffic_samples(vm_id, sampled_at);

  -- CPU 采样
  CREATE TABLE IF NOT EXISTS cpu_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    usage REAL NOT NULL,
    sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cpu_samples_vm_time ON cpu_samples(vm_id, sampled_at);

  -- 内存采样
  CREATE TABLE IF NOT EXISTS mem_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    used INTEGER NOT NULL,
    total INTEGER NOT NULL,
    sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mem_samples_vm_time ON mem_samples(vm_id, sampled_at);

  -- 磁盘 IO 采样
  CREATE TABLE IF NOT EXISTS disk_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    read_bytes INTEGER NOT NULL,
    write_bytes INTEGER NOT NULL,
    sampled_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_disk_samples_vm_time ON disk_samples(vm_id, sampled_at);

  -- 小时聚合表
  CREATE TABLE IF NOT EXISTS vm_metrics_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    hour_start TEXT NOT NULL,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    cpu_avg REAL NOT NULL DEFAULT 0,
    cpu_max REAL NOT NULL DEFAULT 0,
    mem_avg INTEGER NOT NULL DEFAULT 0,
    mem_max INTEGER NOT NULL DEFAULT 0,
    mem_total INTEGER NOT NULL DEFAULT 0,
    disk_read INTEGER NOT NULL DEFAULT 0,
    disk_write INTEGER NOT NULL DEFAULT 0,
    UNIQUE(vm_id, hour_start)
  );
  CREATE INDEX IF NOT EXISTS idx_vm_metrics_hourly_vm ON vm_metrics_hourly(vm_id, hour_start);
`)

export const db = drizzle(sqlite, { schema })

// 导出原始 SQLite 实例
export { sqlite }

export { schema }
