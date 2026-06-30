/**
 * 测试 WS 图表订阅 + 自动更新 + 时区
 * bun run test-ws.js [vmId] [range]
 */
const WS_URL = 'ws://YOUR_SERVER:3000/api/ws'
const TOKEN = 'YOUR_TOKEN'

const VM_ID = process.argv[2] || 'vm-nzunc'
const RANGE = process.argv[3] || '1h'

const ws = new WebSocket(`${WS_URL}?token=${TOKEN}`)
let chartCount = 0

ws.onopen = () => {
  console.log('🔌 已连接\n')
  console.log(`📡 订阅 ${VM_ID} range=${RANGE} ...`)
  ws.send(JSON.stringify({ action: 'subscribe_vm', vmId: VM_ID, range: RANGE }))
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.type !== 'vm_chart') return

  chartCount++
  const d = msg.data
  const now = new Date()
  const serverTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

  console.log(`\n=== [${chartCount}] ${serverTime} ===`)
  console.log(`samples: ${d.samples.length}, range: ${d.range}`)

  if (d.samples.length > 0) {
    const first = d.samples[0]
    const last = d.samples[d.samples.length - 1]

    const firstLocal = new Date(first.time.replace(' ', 'T') + ':00Z')
      .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    const lastLocal = new Date(last.time.replace(' ', 'T') + ':00Z')
      .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

    console.log(`图表起止: ${first.time} (UTC) → ${firstLocal} (本地)`)
    console.log(`         ${last.time} (UTC) → ${lastLocal} (本地)`)
    console.log(`最新 sample: cpu=${last.cpuUsage}% mem=${(last.memUsed/1024/1024).toFixed(1)}MB`)
  }

  if (chartCount >= 2) {
    console.log(`\n✅ 收到 ${chartCount} 次推送，自动更新正常`)
    ws.close()
    process.exit(0)
  } else {
    console.log(`⏳ 等待下一次自动推送 (约 60s)...`)
  }
}

ws.onerror = (err) => { console.error('❌', err.message || err); process.exit(1) }
setTimeout(() => { console.error('❌ 超时 (130s)'); process.exit(1) }, 130000)
