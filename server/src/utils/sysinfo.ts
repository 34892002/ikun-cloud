/**
 * 系统数据读取工具
 *
 * 从 /sys 和 /proc 读取 TAP 流量、进程 CPU/内存/磁盘IO
 */
import { readFileSync } from 'node:fs'

/** 读取 TAP 设备 rx/tx 字节数 */
export function readTapStats(tapName: string): { rx: number; tx: number } | null {
  try {
    const rx = parseInt(readFileSync(`/sys/class/net/${tapName}/statistics/rx_bytes`, 'utf-8').trim(), 10)
    const tx = parseInt(readFileSync(`/sys/class/net/${tapName}/statistics/tx_bytes`, 'utf-8').trim(), 10)
    if (isNaN(rx) || isNaN(tx)) return null
    return { rx, tx }
  } catch {
    return null
  }
}

/** 读取进程 CPU ticks（utime + stime + cutime + cstime + guest） */
export function readProcStat(pid: string): { total: number } | null {
  try {
    const parts = readFileSync(`/proc/${pid}/stat`, 'utf-8').split(' ')
    const utime = parseInt(parts[13] || '0') || 0
    const stime = parseInt(parts[14] || '0') || 0
    const cutime = parseInt(parts[15] || '0') || 0
    const cstime = parseInt(parts[16] || '0') || 0
    const guestTime = parseInt(parts[41] || '0') || 0
    return { total: utime + stime + cutime + cstime + guestTime }
  } catch {
    return null
  }
}

/** 读取进程物理内存占用（VmRSS，字节） */
export function readProcStatus(pid: string): number | null {
  try {
    const match = readFileSync(`/proc/${pid}/status`, 'utf-8').match(/VmRSS:\s+(\d+)\s+kB/)
    return match?.[1] ? parseInt(match[1]) * 1024 : null
  } catch {
    return null
  }
}

/** 读取进程磁盘 IO（read_bytes / write_bytes） */
export function readProcIo(pid: string): { read: number; write: number } | null {
  try {
    const content = readFileSync(`/proc/${pid}/io`, 'utf-8')
    const rm = content.match(/read_bytes:\s+(\d+)/)
    const wm = content.match(/write_bytes:\s+(\d+)/)
    if (!rm?.[1] || !wm?.[1]) return null
    return { read: parseInt(rm[1]), write: parseInt(wm[1]) }
  } catch {
    return null
  }
}
