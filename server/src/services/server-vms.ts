import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getChPid } from '@/utils/ch-pid'

const VMS_DIR = '/data/ikun-cloud/vms'

export interface ServerVmConfig {
  id: string
  name: string
  status: string
  cpus: number
  memory_mb: number
  disk_gb: number
  base_image: string
  ip: string
  mac: string
  tap: string
  ssh_port: number
  password?: string
  api_socket?: string
  created_at?: string
}

/**
 * 检查 CH 进程是否存活
 */
function isChAlive(vmId: string): boolean {
  const configPath = join(VMS_DIR, vmId, 'config.json')
  const pid = getChPid(configPath)
  if (!pid) return false
  return existsSync(`/proc/${pid}`)
}

/**
 * 获取 VM 真实状态（config.json + 进程存活检查）
 */
function getRealStatus(vmId: string, configStatus: string): string {
  if (configStatus !== 'running') return configStatus
  return isChAlive(vmId) ? 'running' : 'stopped'
}

export function getServerVms(): ServerVmConfig[] {
  if (!existsSync(VMS_DIR)) {
    return []
  }

  const vms: ServerVmConfig[] = []
  const dirs = readdirSync(VMS_DIR)

  for (const dir of dirs) {
    const configPath = join(VMS_DIR, dir, 'config.json')
    if (!existsSync(configPath)) continue

    try {
      const content = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(content)
      config.status = getRealStatus(dir, config.status || 'stopped')
      vms.push(config)
    } catch {
      // ignore
    }
  }

  return vms
}

export function getServerVm(vmId: string): ServerVmConfig | null {
  const configPath = join(VMS_DIR, vmId, 'config.json')
  if (!existsSync(configPath)) return null

  try {
    const content = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content)
    config.status = getRealStatus(vmId, config.status || 'stopped')
    return config
  } catch {
    return null
  }
}
