/**
 * Cloud Hypervisor 进程 PID 查找
 *
 * config.json 的 pid 字段可能是：
 * - 直接的 CH 进程 PID
 * - sh wrapper 的 PID（需要查找子进程）
 */
import { readFileSync, existsSync } from 'node:fs'

/**
 * 从 VM 配置文件获取 cloud-hypervisor 进程 PID
 * @returns PID 字符串，找不到返回 null
 */
export function getChPid(configPath: string): string | null {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (!config.pid) return null

    const pids = String(config.pid).split('\n').map((s: string) => s.trim()).filter(Boolean)

    // 直接匹配 cloud-hypervisor
    for (const p of pids) {
      try {
        const comm = readFileSync(`/proc/${p}/comm`, 'utf-8').trim()
        if (comm.startsWith('cloud-hyperviso')) return p
      } catch {}
    }

    // config.pid 是 sh wrapper，查找子进程中的 cloud-hypervisor
    if (pids.length > 0) {
      try {
        const children = readFileSync(`/proc/${pids[0]}/task/${pids[0]}/children`, 'utf-8').trim().split(/\s+/)
        for (const child of children) {
          try {
            const comm = readFileSync(`/proc/${child}/comm`, 'utf-8').trim()
            if (comm.startsWith('cloud-hyperviso')) return child
          } catch {}
        }
      } catch {}
    }

    return pids[0] || null
  } catch {
    return null
  }
}
