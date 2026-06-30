/**
 * WebSocket 数据订阅
 */
import { ref, onMounted } from 'vue'
import { useUserStore } from '@/stores/user'

export interface VmChartData {
  vmId: string
  range: string
  samples: Array<{
    time: string
    rxBytes: number; txBytes: number
    cpuUsage: number
    memUsed: number; memTotal: number
    diskRead: number; diskWrite: number
  }>
  total: {
    rxBytes: number; txBytes: number
    cpuAvg: number; cpuMax: number
    memAvg: number; memMax: number
    diskRead: number; diskWrite: number
  }
  monthRx: number
  monthTx: number
}

export interface DashboardData {
  vms: { total: number; running: number; stopped: number; error: number }
  host: {
    cpu: { usage: number; cores: number }
    memory: { total: number; used: number; usage: number }
    swap: { total: number; used: number; usage: number }
    disk: { total: number; used: number; usage: number }
    network: { rxBytes: number; txBytes: number }
  }
}

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0

// 待发消息队列（WS 未连接时缓存）
const pendingMessages: object[] = []

// 回调
let vmChartCallback: ((data: VmChartData) => void) | null = null
let dashboardCallback: ((data: DashboardData) => void) | null = null

function connect() {
  const userStore = useUserStore()
  if (!userStore.token) return

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${location.host}/api/ws?token=${userStore.token}`

  ws = new WebSocket(url)

  ws.onopen = () => {
    retryCount = 0
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift()!
      try { ws!.send(JSON.stringify(msg)) } catch {}
    }
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'vm_chart' && vmChartCallback) {
        vmChartCallback(msg.data as VmChartData)
      } else if (msg.type === 'dashboard' && dashboardCallback) {
        dashboardCallback(msg.data as DashboardData)
      }
    } catch {}
  }

  ws.onclose = () => {
    ws = null
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000)
    retryCount++
    reconnectTimer = setTimeout(connect, delay)
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (ws) { ws.close(); ws = null }
}

function sendMessage(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    pendingMessages.push(msg)
  }
}

function subscribeVmChart(vmId: string, range: string, callback: (data: VmChartData) => void) {
  vmChartCallback = callback
  sendMessage({ action: 'subscribe_vm', vmId, range })
}

function unsubscribeVmChart() {
  vmChartCallback = null
  sendMessage({ action: 'unsubscribe_vm' })
}

function subscribeDashboard(callback: (data: DashboardData) => void) {
  dashboardCallback = callback
  sendMessage({ action: 'subscribe_dashboard' })
}

function unsubscribeDashboard() {
  dashboardCallback = null
  sendMessage({ action: 'unsubscribe_dashboard' })
}

export function useLiveMetrics() {
  onMounted(() => { if (!ws) connect() })

  return {
    subscribeVmChart,
    unsubscribeVmChart,
    subscribeDashboard,
    unsubscribeDashboard,
  }
}
