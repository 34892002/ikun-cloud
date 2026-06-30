/**
 * WebSocket 数据订阅
 *
 * - 图表订阅：VM 历史图表数据（60s 推送）
 * - 仪表盘订阅：宿主机状态 + VM 统计（3s 推送）
 */
import { readFileSync } from 'node:fs'
import { getServerVms } from '@/services/server-vms'

// ============================================================
// 客户端订阅管理
// ============================================================

const clients = new Set<any>()
const vmSubscriptions = new Map<any, { vmId: string; range: string }>()
const dashboardSubscriptions = new Set<any>()

// 动态导入 db（避免循环依赖）
let dbModule: typeof import('@/db') | null = null

async function getDb() {
  if (!dbModule) {
    dbModule = await import('@/db')
  }
  return { db: dbModule.db, schema: dbModule.schema }
}

// ============================================================
// 仪表盘数据采集
// ============================================================

async function collectDashboardData() {
  // 服务器实际状态（config.json）
  const serverVms = getServerVms()
  const serverVmIds = new Set(serverVms.map(v => v.id))

  // 数据库记录
  const { db, schema } = await getDb()
  const dbVms = db.select().from(schema.vms).all()
  const dbVmIds = new Set(dbVms.map(v => v.id))

  // 孤儿 VM：服务器有，数据库没有
  const orphanCount = serverVms.filter(v => !dbVmIds.has(v.id)).length
  // 幽灵 VM：数据库有，服务器没有
  const ghostCount = dbVms.filter(v => !serverVmIds.has(v.id)).length
  const errorCount = orphanCount + ghostCount

  const running = serverVms.filter(v => v.status === 'running').length
  const stopped = serverVms.filter(v => v.status === 'stopped').length
  // 总数 = 服务器上的 + 幽灵 VM
  const total = serverVms.length + ghostCount

  const host = getHostStatus()

  return {
    vms: { total, running, stopped, error: errorCount },
    host,
  }
}

function getHostStatus() {
  // CPU
  const cpuInfo = readFileSync('/proc/cpuinfo', 'utf-8')
  const cores = (cpuInfo.match(/processor/gi) || []).length

  // 内存
  const memInfo = readFileSync('/proc/meminfo', 'utf-8')
  const memTotal = Number(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024
  const memAvailable = Number(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024
  const memUsed = memTotal - memAvailable
  const memUsage = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0

  // Swap
  const swapTotal = Number(memInfo.match(/SwapTotal:\s+(\d+)/)?.[1] || 0) * 1024
  const swapFree = Number(memInfo.match(/SwapFree:\s+(\d+)/)?.[1] || 0) * 1024
  const swapUsed = swapTotal - swapFree
  const swapUsage = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0

  // 磁盘
  let diskTotal = 0, diskUsed = 0, diskUsage = 0
  try {
    const proc = Bun.spawnSync(['df', '-B1', '/'])
    const lines = proc.stdout.toString().trim().split('\n')
    if (lines.length >= 2 && lines[1]) {
      const parts = lines[1].split(/\s+/)
      diskTotal = Number(parts[1] ?? 0) || 0
      diskUsed = Number(parts[2] ?? 0) || 0
      diskUsage = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0
    }
  } catch {}

  // CPU 使用率（两次采样差值）
  let cpuUsage = 0
  try {
    const stat1 = readFileSync('/proc/stat', 'utf-8')
    const values1 = stat1.split('\n')[0]?.split(/\s+/).slice(1).map(Number) ?? []
    const idle1 = values1[3] || 0
    const total1 = values1.reduce((a, b) => a + b, 0)
    Bun.spawnSync(['sleep', '0.1'])
    const stat2 = readFileSync('/proc/stat', 'utf-8')
    const values2 = stat2.split('\n')[0]?.split(/\s+/).slice(1).map(Number) ?? []
    const idle2 = values2[3] || 0
    const total2 = values2.reduce((a, b) => a + b, 0)
    cpuUsage = total2 - total1 > 0 ? Math.round(((total2 - total1 - (idle2 - idle1)) / (total2 - total1)) * 100) : 0
  } catch {}

  // 网络（排除 lo、tap、bridge）
  let rxBytes = 0, txBytes = 0
  try {
    const netDev = readFileSync('/proc/net/dev', 'utf-8')
    for (const line of netDev.split('\n').slice(2)) {
      const parts = line.trim().split(/[:\s]+/)
      if (parts.length < 10 || !parts[0]) continue
      const iface = parts[0]
      if (iface === 'lo' || iface.startsWith('tap') || iface === 'ikun-br0') continue
      rxBytes += Number(parts[1]) || 0
      txBytes += Number(parts[9]) || 0
    }
  } catch {}

  return {
    cpu: { usage: cpuUsage, cores },
    memory: { total: memTotal, used: memUsed, usage: memUsage },
    swap: { total: swapTotal, used: swapUsed, usage: swapUsage },
    disk: { total: diskTotal, used: diskUsed, usage: diskUsage },
    network: { rxBytes, txBytes },
  }
}

// ============================================================
// VM 图表查询
// ============================================================

async function queryVmChart(vmId: string, range: string) {
  const { db, schema } = await getDb()
  const { eq, sql } = await import('drizzle-orm')

  const vm = db.select().from(schema.vms).where(eq(schema.vms.id, vmId)).get()
  if (!vm) return null

  const now = new Date()
  const useHourly = range === '7d' || range === '30d'

  const msMap: Record<string, number> = { '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 }
  const ms = msMap[range] ?? msMap['24h'] ?? 24 * 3600_000
  const startTime = new Date(now.getTime() - ms).toISOString().replace('T', ' ').slice(0, 19)

  let samples: any[] = []

  if (useHourly) {
    const rows = db.all(sql`
      SELECT hour_start AS time, rx_bytes, tx_bytes, cpu_avg, cpu_max,
             mem_avg, mem_max, mem_total, disk_read, disk_write
      FROM vm_metrics_hourly
      WHERE vm_id = ${vmId} AND hour_start >= ${startTime}
      ORDER BY hour_start
    `) as any[]

    samples = rows.map(r => ({
      time: r.time,
      rxBytes: r.rx_bytes, txBytes: r.tx_bytes,
      cpuUsage: r.cpu_avg, cpuMax: r.cpu_max,
      memUsed: r.mem_avg, memMax: r.mem_max, memTotal: r.mem_total,
      diskRead: r.disk_read, diskWrite: r.disk_write,
    }))
  } else {
    const traffic = db.all(sql`
      SELECT strftime('%Y-%m-%d %H:%M', sampled_at) AS t, SUM(rx_bytes) AS rx, SUM(tx_bytes) AS tx
      FROM traffic_samples WHERE vm_id = ${vmId} AND sampled_at >= ${startTime}
      GROUP BY t ORDER BY t
    `) as Array<{ t: string; rx: number; tx: number }>

    const cpu = db.all(sql`
      SELECT strftime('%Y-%m-%d %H:%M', sampled_at) AS t, ROUND(AVG(usage), 1) AS usage
      FROM cpu_samples WHERE vm_id = ${vmId} AND sampled_at >= ${startTime}
      GROUP BY t ORDER BY t
    `) as Array<{ t: string; usage: number }>

    const mem = db.all(sql`
      SELECT strftime('%Y-%m-%d %H:%M', sampled_at) AS t, ROUND(AVG(used)) AS used, MAX(total) AS total
      FROM mem_samples WHERE vm_id = ${vmId} AND sampled_at >= ${startTime}
      GROUP BY t ORDER BY t
    `) as Array<{ t: string; used: number; total: number }>

    const disk = db.all(sql`
      SELECT strftime('%Y-%m-%d %H:%M', sampled_at) AS t, SUM(read_bytes) AS rd, SUM(write_bytes) AS wr
      FROM disk_samples WHERE vm_id = ${vmId} AND sampled_at >= ${startTime}
      GROUP BY t ORDER BY t
    `) as Array<{ t: string; rd: number; wr: number }>

    const map = new Map<string, any>()
    for (const r of traffic) map.set(r.t, { time: r.t, rxBytes: r.rx, txBytes: r.tx, cpuUsage: 0, memUsed: 0, memTotal: 0, diskRead: 0, diskWrite: 0 })
    for (const r of cpu) { const d = map.get(r.t) || { time: r.t, rxBytes: 0, txBytes: 0, cpuUsage: 0, memUsed: 0, memTotal: 0, diskRead: 0, diskWrite: 0 }; d.cpuUsage = r.usage; map.set(r.t, d) }
    for (const r of mem) { const d = map.get(r.t) || { time: r.t, rxBytes: 0, txBytes: 0, cpuUsage: 0, memUsed: 0, memTotal: 0, diskRead: 0, diskWrite: 0 }; d.memUsed = r.used; d.memTotal = r.total; map.set(r.t, d) }
    for (const r of disk) { const d = map.get(r.t) || { time: r.t, rxBytes: 0, txBytes: 0, cpuUsage: 0, memUsed: 0, memTotal: 0, diskRead: 0, diskWrite: 0 }; d.diskRead = r.rd; d.diskWrite = r.wr; map.set(r.t, d) }

    samples = Array.from(map.values()).sort((a, b) => a.time.localeCompare(b.time))
  }

  const total = {
    rxBytes: samples.reduce((s, r) => s + r.rxBytes, 0),
    txBytes: samples.reduce((s, r) => s + r.txBytes, 0),
    cpuAvg: samples.length ? Math.round(samples.reduce((s, r) => s + r.cpuUsage, 0) / samples.length * 10) / 10 : 0,
    cpuMax: samples.length ? Math.max(...samples.map(r => r.cpuUsage)) : 0,
    memAvg: samples.length ? Math.round(samples.reduce((s, r) => s + r.memUsed, 0) / samples.length) : 0,
    memMax: samples.length ? Math.max(...samples.map(r => r.memUsed)) : 0,
    diskRead: samples.reduce((s, r) => s + r.diskRead, 0),
    diskWrite: samples.reduce((s, r) => s + r.diskWrite, 0),
  }

  const monthStart = now.toISOString().slice(0, 7) + '-01 00:00:00'
  const monthTraffic = db.all(sql`
    SELECT SUM(rx_bytes) AS rx, SUM(tx_bytes) AS tx
    FROM vm_metrics_hourly WHERE vm_id = ${vmId} AND hour_start >= ${monthStart}
  `) as Array<{ rx: number; tx: number }>
  const month = monthTraffic[0] || { rx: 0, tx: 0 }

  return { vmId, range, samples, total, monthRx: month.rx || 0, monthTx: month.tx || 0 }
}

// ============================================================
// 定时推送
// ============================================================

// 仪表盘推送（3s）
const DASHBOARD_PUSH_MS = 3_000
let dashboardTimer: ReturnType<typeof setInterval> | null = null

async function pushDashboard() {
  if (dashboardSubscriptions.size === 0) return
  try {
    const data = await collectDashboardData()
    const payload = JSON.stringify({ type: 'dashboard', data, ts: Date.now() })
    for (const ws of dashboardSubscriptions) {
      try { ws.send(payload) } catch {}
    }
  } catch (err) {
    console.error('[ws-broadcast] 仪表盘推送失败:', err)
  }
}

// 图表推送（60s）
const CHART_PUSH_MS = 60_000
let chartTimer: ReturnType<typeof setInterval> | null = null

async function pushChart() {
  for (const [ws, sub] of vmSubscriptions) {
    try {
      const data = await queryVmChart(sub.vmId, sub.range)
      if (data) ws.send(JSON.stringify({ type: 'vm_chart', data, ts: Date.now() }))
    } catch {}
  }
}

export function startPush() {
  if (!dashboardTimer) {
    console.log('[ws-broadcast] 仪表盘推送启动 (间隔 3s)')
    dashboardTimer = setInterval(pushDashboard, DASHBOARD_PUSH_MS)
  }
  if (!chartTimer) {
    console.log('[ws-broadcast] 图表推送启动 (间隔 60s)')
    chartTimer = setInterval(pushChart, CHART_PUSH_MS)
  }
}

export function stopPush() {
  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null }
  if (chartTimer) { clearInterval(chartTimer); chartTimer = null }
}

// ============================================================
// 消息处理
// ============================================================

export function handleMessage(ws: any, raw: string) {
  try {
    const msg = JSON.parse(raw)
    if (msg.action === 'subscribe_vm' && msg.vmId) {
      const range = msg.range || '1h'
      vmSubscriptions.set(ws, { vmId: msg.vmId, range })
      queryVmChart(msg.vmId, range).then(data => {
        if (data) {
          try { ws.send(JSON.stringify({ type: 'vm_chart', data, ts: Date.now() })) } catch {}
        }
      })
    } else if (msg.action === 'unsubscribe_vm') {
      vmSubscriptions.delete(ws)
    } else if (msg.action === 'subscribe_dashboard') {
      dashboardSubscriptions.add(ws)
      // 立即推送一次
      collectDashboardData().then(data => {
        try { ws.send(JSON.stringify({ type: 'dashboard', data, ts: Date.now() })) } catch {}
      })
    } else if (msg.action === 'unsubscribe_dashboard') {
      dashboardSubscriptions.delete(ws)
    }
  } catch {}
}

export function addClient(ws: any) {
  clients.add(ws)
}

export function removeClient(ws: any) {
  clients.delete(ws)
  vmSubscriptions.delete(ws)
  dashboardSubscriptions.delete(ws)
}
