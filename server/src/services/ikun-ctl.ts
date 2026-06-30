/**
 * ikun-ctl CLI 调用封装
 */
import { db } from '@/db'
import { vms, portForwards } from '@/db/schema'
import { eq } from 'drizzle-orm'

const IKUN_CTL = '/usr/local/bin/ikun-ctl'

interface IkunCtlResult {
  success: boolean
  output: string
  error?: string
}

async function runIkunCtl(args: string[]): Promise<IkunCtlResult> {
  try {
    const proc = Bun.spawn([IKUN_CTL, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      return { success: false, output: stdout, error: stderr || `Exit code: ${exitCode}` }
    }

    return { success: true, output: stdout }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, output: '', error: message }
  }
}

// ============================================================
// VM 生命周期
// ============================================================

export async function createVm(options: {
  name: string
  baseImage: string
  cpus: number
  memoryMb: number
  diskGb: number
  sshPort?: number
  password?: string
}) {
  const args = [
    'create',
    '--name', options.name,
    '--base-image', options.baseImage,
    '--cpus', String(options.cpus),
    '--memory', String(options.memoryMb),
    '--disk', String(options.diskGb),
  ]

  if (options.sshPort) {
    args.push('--ssh-port', String(options.sshPort))
  }
  if (options.password) {
    args.push('--password', options.password)
  }

  const result = await runIkunCtl(args)

  if (!result.success) {
    throw new Error(`创建 VM 失败: ${result.error}`)
  }

  // 从输出中解析 VM ID
  const vmIdMatch = result.output.match(/VM\s+(vm-[a-z0-9]+)\s+创建成功/)
  const vmId = vmIdMatch?.[1]

  if (!vmId) {
    throw new Error('无法解析创建的 VM ID')
  }

  // 读取 ikun-ctl 生成的配置并同步到数据库
  const configResult = await runIkunCtl(['status', vmId])
  if (configResult.success) {
    try {
      const config = JSON.parse(configResult.output)
      db.insert(vms).values({
        id: config.id,
        name: config.name,
        status: config.status || 'stopped',
        cpus: config.cpus,
        memoryMb: config.memory_mb,
        diskGb: config.disk_gb,
        baseImage: config.base_image,
        ip: config.ip,
        mac: config.mac,
        tap: config.tap,
        sshPort: config.ssh_port,
        password: config.password,
        apiSocket: config.api_socket,
      }).run()

      // 同步 SSH 端口映射
      db.insert(portForwards).values({
        vmId: config.id,
        hostPort: config.ssh_port,
        guestPort: 22,
        protocol: 'tcp',
      }).run()
    } catch {
      console.error('同步 VM 配置到数据库失败')
    }
  }

  return { vmId, output: result.output }
}

export async function startVm(vmId: string) {
  const result = await runIkunCtl(['start', vmId])

  if (!result.success) {
    throw new Error(`启动 VM 失败: ${result.error}`)
  }

  db.update(vms).set({ status: 'running', updatedAt: new Date().toISOString() }).where(eq(vms.id, vmId)).run()

  return result.output
}

export async function stopVm(vmId: string) {
  const result = await runIkunCtl(['stop', vmId])

  if (!result.success) {
    throw new Error(`停止 VM 失败: ${result.error}`)
  }

  db.update(vms).set({ status: 'stopped', updatedAt: new Date().toISOString() }).where(eq(vms.id, vmId)).run()

  return result.output
}

export async function restartVm(vmId: string) {
  const result = await runIkunCtl(['restart', vmId])

  if (!result.success) {
    throw new Error(`重启 VM 失败: ${result.error}`)
  }

  return result.output
}

export async function destroyVm(vmId: string) {
  const result = await runIkunCtl(['destroy', vmId])

  if (!result.success) {
    throw new Error(`删除 VM 失败: ${result.error}`)
  }

  // 删除数据库记录（级联删除 port_forwards）
  db.delete(vms).where(eq(vms.id, vmId)).run()

  return result.output
}

export async function resetPassword(vmId: string) {
  const result = await runIkunCtl(['reset-password', vmId])

  if (!result.success) {
    throw new Error(`重置密码失败: ${result.error}`)
  }

  // 从输出中解析新密码
  const passwordMatch = result.output.match(/新密码[:：]\s*(\S+)/)
  const newPassword = passwordMatch?.[1]

  if (newPassword) {
    db.update(vms).set({ password: newPassword, updatedAt: new Date().toISOString() }).where(eq(vms.id, vmId)).run()
  }

  return { output: result.output, newPassword }
}

export async function reinstallVm(vmId: string, baseImage: string, password?: string) {
  const args = ['reinstall', vmId, '--base-image', baseImage]
  if (password) args.push('--password', password)

  const result = await runIkunCtl(args)

  if (!result.success) {
    throw new Error(`重装系统失败: ${result.error}`)
  }

  // 重装后密码会变，从服务器 config 读取新密码
  const config = await readVmConfig(vmId)
  db.update(vms).set({
    baseImage,
    password: (config?.password as string) ?? undefined,
    status: 'stopped',
    updatedAt: new Date().toISOString(),
  }).where(eq(vms.id, vmId)).run()

  return result.output
}

export async function resizeVm(vmId: string, options: { cpus?: number; memoryMb?: number; diskGb?: number }) {
  const args = ['resize', vmId]
  if (options.cpus) args.push('--cpus', String(options.cpus))
  if (options.memoryMb) args.push('--memory', String(options.memoryMb))
  if (options.diskGb) args.push('--disk', String(options.diskGb))

  const result = await runIkunCtl(args)

  if (!result.success) {
    throw new Error(`修改配置失败: ${result.error}`)
  }

  // 从服务器 config 读取最新配置同步到数据库
  const config = await readVmConfig(vmId)
  if (config) {
    db.update(vms).set({
      cpus: config.cpus as number,
      memoryMb: config.memory_mb as number,
      diskGb: config.disk_gb as number,
      updatedAt: new Date().toISOString(),
    }).where(eq(vms.id, vmId)).run()
  }

  return result.output
}

// ============================================================
// 工具函数
// ============================================================

export function getVmConfigPath(vmId: string): string {
  return `/data/ikun-cloud/vms/${vmId}/config.json`
}

export async function readVmConfig(vmId: string): Promise<Record<string, unknown> | null> {
  try {
    const file = Bun.file(getVmConfigPath(vmId))
    if (await file.exists()) {
      return await file.json()
    }
  } catch {
    // ignore
  }
  return null
}
