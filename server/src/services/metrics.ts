/**
 * VM 监控采集服务
 *
 * - 每 60 秒采集流量/CPU/内存/磁盘IO
 * - 每小时聚合原始数据到 vm_metrics_hourly，删除超过 24 小时的原始数据
 */
import { db, sqlite } from '@/db'
import { vms, trafficSamples, cpuSamples, memSamples, diskSamples } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { getChPid } from '@/utils/ch-pid'
import { readTapStats, readProcStat, readProcStatus, readProcIo } from '@/utils/sysinfo'
import { getServerVms } from '@/services/server-vms'

const SAMPLE_INTERVAL_MS = 60_000      // 60 秒
const CLEANUP_INTERVAL_MS = 3_600_000  // 1 小时

// 上次采样缓存
const trafficCache = new Map<string, { rx: number; tx: number }>()
const diskCache = new Map<string, { read: number; write: number }>()
const cpuCache = new Map<string, { total: number; wallMs: number }>()

// ============================================================
// 采集逻辑
// ============================================================

function sampleAll() {
  try {
    // 获取数据库中所有 VM
    const allDbVms = db.select().from(vms).all()
    const dbVmMap = new Map(allDbVms.map(v => [v.id, v]))

    // 获取服务器实际运行的 VM（含进程存活检查）
    const serverVms = getServerVms()
    const runningServerVms = serverVms.filter(v => v.status === 'running')

    // 同步状态：服务器上运行但数据库标记 stopped 的，更新数据库
    for (const sv of runningServerVms) {
      const dbVm = dbVmMap.get(sv.id)
      if (dbVm && dbVm.status !== 'running') {
        db.update(vms).set({ status: 'running', updatedAt: new Date().toISOString() }).where(eq(vms.id, sv.id)).run()
      }
    }
    // 数据库标记 running 但服务器已停止的，更新数据库
    for (const dbVm of allDbVms) {
      if (dbVm.status === 'running' && !runningServerVms.find(v => v.id === dbVm.id)) {
        db.update(vms).set({ status: 'stopped', updatedAt: new Date().toISOString() }).where(eq(vms.id, dbVm.id)).run()
      }
    }

    // 只采集实际运行的 VM
    const runningVms = allDbVms.filter(vm => runningServerVms.find(v => v.id === vm.id))

    for (const vm of runningVms) {
      const configPath = `/data/ikun-cloud/vms/${vm.id}/config.json`
      const pid = getChPid(configPath)
      const memTotal = vm.memoryMb * 1024 * 1024

      // --- 流量 ---
      if (vm.tap) {
        const stats = readTapStats(vm.tap)
        if (stats) {
          const prev = trafficCache.get(vm.id)
          let rxDelta = 0, txDelta = 0
          if (prev) {
            rxDelta = stats.rx >= prev.rx ? stats.rx - prev.rx : stats.rx
            txDelta = stats.tx >= prev.tx ? stats.tx - prev.tx : stats.tx
          }
          trafficCache.set(vm.id, { rx: stats.rx, tx: stats.tx })
          if (prev && (rxDelta > 0 || txDelta > 0)) {
            db.insert(trafficSamples).values({ vmId: vm.id, rxBytes: rxDelta, txBytes: txDelta }).run()
          }
        }
      }

      // --- CPU / 内存（需要 PID） ---
      if (pid && existsSync(`/proc/${pid}`)) {
        // CPU
        const cpuStat = readProcStat(pid)
        if (cpuStat) {
          const prev = cpuCache.get(vm.id)
          const nowMs = Date.now()
          if (prev) {
            const tickDelta = cpuStat.total - prev.total
            const wallDeltaMs = nowMs - prev.wallMs
            if (wallDeltaMs > 0) {
              if (tickDelta < 0) {
                // 进程重启或 PID 复用，清掉旧数据重新采样
                cpuCache.set(vm.id, { total: cpuStat.total, wallMs: nowMs })
              } else {
                const ticksPerSec = 100 // Linux 默认 HZ=100
                const cpuPercent = Math.min(100, (tickDelta / (wallDeltaMs / 1000) / ticksPerSec) * 100)
                db.insert(cpuSamples).values({ vmId: vm.id, usage: Math.round(cpuPercent * 10) / 10 }).run()
                cpuCache.set(vm.id, { total: cpuStat.total, wallMs: nowMs })
              }
            }
          } else {
            cpuCache.set(vm.id, { total: cpuStat.total, wallMs: nowMs })
          }
        }

        // 内存
        const memRss = readProcStatus(pid)
        if (memRss) {
          db.insert(memSamples).values({ vmId: vm.id, used: memRss, total: memTotal }).run()
        }

        // 磁盘 IO
        const ioStat = readProcIo(pid)
        if (ioStat) {
          const prev = diskCache.get(vm.id)
          let readDelta = 0, writeDelta = 0
          if (prev) {
            readDelta = ioStat.read >= prev.read ? ioStat.read - prev.read : ioStat.read
            writeDelta = ioStat.write >= prev.write ? ioStat.write - prev.write : ioStat.write
          }
          diskCache.set(vm.id, { read: ioStat.read, write: ioStat.write })
          if (prev && (readDelta > 0 || writeDelta > 0)) {
            db.insert(diskSamples).values({ vmId: vm.id, readBytes: readDelta, writeBytes: writeDelta }).run()
          }
        }
      }
    }

    // 清理停机 VM 的缓存
    const runningIds = new Set(runningVms.map(v => v.id))
    for (const cache of [trafficCache, cpuCache, diskCache]) {
      for (const id of cache.keys()) {
        if (!runningIds.has(id)) cache.delete(id)
      }
    }
  } catch (err) {
    console.error('[metrics] 采集失败:', err)
  }
}

// ============================================================
// 聚合 + 清理
// ============================================================

function aggregateAndCleanup() {
  try {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19)
    const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)

    // 流量聚合（超过 1 小时的数据）
    sqlite.prepare(`
      INSERT OR REPLACE INTO vm_metrics_hourly (vm_id, hour_start, rx_bytes, tx_bytes)
      SELECT vm_id, strftime('%Y-%m-%d %H:00', sampled_at), SUM(rx_bytes), SUM(tx_bytes)
      FROM traffic_samples WHERE sampled_at < ?
      GROUP BY vm_id, strftime('%Y-%m-%d %H:00', sampled_at)
    `).run(oneHourAgo)

    // CPU 聚合
    sqlite.prepare(`
      INSERT INTO vm_metrics_hourly (vm_id, hour_start, cpu_avg, cpu_max)
      SELECT vm_id, strftime('%Y-%m-%d %H:00', sampled_at), AVG(usage), MAX(usage)
      FROM cpu_samples WHERE sampled_at < ?
      GROUP BY vm_id, strftime('%Y-%m-%d %H:00', sampled_at)
      ON CONFLICT(vm_id, hour_start) DO UPDATE SET
        cpu_avg = excluded.cpu_avg, cpu_max = excluded.cpu_max
    `).run(oneHourAgo)

    // 内存聚合
    sqlite.prepare(`
      INSERT INTO vm_metrics_hourly (vm_id, hour_start, mem_avg, mem_max, mem_total)
      SELECT vm_id, strftime('%Y-%m-%d %H:00', sampled_at), AVG(used), MAX(used), MAX(total)
      FROM mem_samples WHERE sampled_at < ?
      GROUP BY vm_id, strftime('%Y-%m-%d %H:00', sampled_at)
      ON CONFLICT(vm_id, hour_start) DO UPDATE SET
        mem_avg = excluded.mem_avg, mem_max = excluded.mem_max, mem_total = excluded.mem_total
    `).run(oneHourAgo)

    // 磁盘 IO 聚合
    sqlite.prepare(`
      INSERT INTO vm_metrics_hourly (vm_id, hour_start, disk_read, disk_write)
      SELECT vm_id, strftime('%Y-%m-%d %H:00', sampled_at), SUM(read_bytes), SUM(write_bytes)
      FROM disk_samples WHERE sampled_at < ?
      GROUP BY vm_id, strftime('%Y-%m-%d %H:00', sampled_at)
      ON CONFLICT(vm_id, hour_start) DO UPDATE SET
        disk_read = excluded.disk_read, disk_write = excluded.disk_write
    `).run(oneHourAgo)

    // 删除超过 24 小时的原始数据
    const tables = ['traffic_samples', 'cpu_samples', 'mem_samples', 'disk_samples']
    for (const table of tables) {
      const result = sqlite.prepare(`DELETE FROM ${table} WHERE sampled_at < ?`).run(oneDayAgo)
      if (result.changes > 0) {
        console.log(`[metrics] 清理 ${table}: ${result.changes} 条`)
      }
    }
  } catch (err) {
    console.error('[metrics] 聚合清理失败:', err)
  }
}

// ============================================================
// 启动 / 停止
// ============================================================

let sampleTimer: ReturnType<typeof setInterval> | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null

export function startMetricsCollector() {
  if (sampleTimer) return
  console.log('[metrics] 监控采集服务启动 (间隔 60s)')
  sampleAll()
  sampleTimer = setInterval(sampleAll, SAMPLE_INTERVAL_MS)
  cleanupTimer = setInterval(aggregateAndCleanup, CLEANUP_INTERVAL_MS)
}

export function stopMetricsCollector() {
  if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
  console.log('[metrics] 监控采集服务已停止')
}
