/**
 * iptables 工具模块
 *
 * 所有 iptables 操作集中管理，避免散落在各处导致规则残留。
 */

/** 执行 iptables 命令 */
async function exec(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['iptables', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

// ============================================================
// 问题 3 + 4：按 IP 清空 + 单条规则检查
// ============================================================

/**
 * 按 IP 清空所有 iptables 规则（问题 1 + 4）
 * 不管规则是谁加的，SSH 端口还是应用端口，全部清干净。
 */
export async function flushRulesByIp(vmIp: string): Promise<number> {
  let count = 0

  // 清 PREROUTING DNAT（目标到该 IP 的所有转发）
  const { stdout: natList } = await exec(['-t', 'nat', '-S', 'PREROUTING'])
  for (const line of natList.split('\n')) {
    if (line.includes(vmIp)) {
      const delArgs = line.replace(/^-A/, '-D').trim().split(/\s+/)
      await exec(['-t', 'nat', ...delArgs])
      count++
    }
  }

  // 清 OUTPUT DNAT
  const { stdout: outList } = await exec(['-t', 'nat', '-S', 'OUTPUT'])
  for (const line of outList.split('\n')) {
    if (line.includes(vmIp)) {
      const delArgs = line.replace(/^-A/, '-D').trim().split(/\s+/)
      await exec(['-t', 'nat', ...delArgs])
      count++
    }
  }

  // 清 FORWARD（放行该 IP 的所有规则）
  const { stdout: fwdList } = await exec(['-S', 'FORWARD'])
  for (const line of fwdList.split('\n')) {
    if (line.includes(vmIp)) {
      const delArgs = line.replace(/^-A/, '-D').trim().split(/\s+/)
      await exec(delArgs)
      count++
    }
  }

  return count
}

/**
 * 检查某条 DNAT 规则是否实际存在于 iptables（问题 3）
 */
export async function ruleExists(hostPort: number, guestPort: number, vmIp: string, protocol = 'tcp'): Promise<boolean> {
  const { exitCode } = await exec([
    '-t', 'nat', '-C', 'PREROUTING',
    '-p', protocol, '--dport', String(hostPort),
    '-j', 'DNAT', '--to-destination', `${vmIp}:${guestPort}`,
  ])
  return exitCode === 0
}

/**
 * 添加单条端口转发规则
 */
export async function addPortForward(hostPort: number, guestPort: number, vmIp: string, protocol = 'tcp'): Promise<boolean> {
  // 外部访问
  const { exitCode } = await exec([
    '-t', 'nat', '-A', 'PREROUTING',
    '-p', protocol, '--dport', String(hostPort),
    '-j', 'DNAT', '--to-destination', `${vmIp}:${guestPort}`,
  ])
  if (exitCode !== 0) return false

  // 本地访问
  await exec([
    '-t', 'nat', '-A', 'OUTPUT',
    '-p', protocol, '--dport', String(hostPort),
    '-j', 'DNAT', '--to-destination', `${vmIp}:${guestPort}`,
  ])

  await exec([
    '-A', 'FORWARD',
    '-p', protocol, '-d', vmIp, '--dport', String(guestPort),
    '-j', 'ACCEPT',
  ])
  return true
}

/**
 * 删除单条端口转发规则
 */
export async function removePortForward(hostPort: number, guestPort: number, vmIp: string, protocol = 'tcp'): Promise<void> {
  await exec([
    '-t', 'nat', '-D', 'PREROUTING',
    '-p', protocol, '--dport', String(hostPort),
    '-j', 'DNAT', '--to-destination', `${vmIp}:${guestPort}`,
  ])
  await exec([
    '-t', 'nat', '-D', 'OUTPUT',
    '-p', protocol, '--dport', String(hostPort),
    '-j', 'DNAT', '--to-destination', `${vmIp}:${guestPort}`,
  ])
  await exec([
    '-D', 'FORWARD',
    '-p', protocol, '-d', vmIp, '--dport', String(guestPort),
    '-j', 'ACCEPT',
  ])
}
