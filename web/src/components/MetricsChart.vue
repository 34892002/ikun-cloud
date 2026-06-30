<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { createChart, ColorType, AreaSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'

type MetricType = 'traffic' | 'cpu' | 'memory' | 'disk'

interface Sample {
  time: string
  rxBytes: number; txBytes: number
  cpuUsage: number
  memUsed: number; memTotal: number
  diskRead: number; diskWrite: number
}

const props = defineProps<{
  samples: Sample[]
  metric: MetricType
  loading?: boolean
  theme?: 'light' | 'dark'
}>()

const emit = defineEmits<{
  (e: 'update:metric', value: MetricType): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let chart: IChartApi | null = null
let series1: ISeriesApi<'Area'> | null = null
let series2: ISeriesApi<'Area'> | null = null
let resizeObserver: ResizeObserver | null = null

const isDark = computed(() => props.theme === 'dark')

const metricTabs: { key: MetricType; label: string }[] = [
  { key: 'traffic', label: '流量' },
  { key: 'cpu', label: 'CPU' },
  { key: 'memory', label: '内存' },
  { key: 'disk', label: '磁盘IO' },
]

const colors = computed(() => isDark.value ? {
  bg: '#121212', border: '#2a2a2a', text: '#e5e5e5', subText: '#9ca3af',
  muted: '#6b7280', gridLine: '#1e1e1e', crosshair: '#3b3b3b',
  crosshairLabel: '#2a2a2a', markerBg: '#121212',
  s1: '#22d3ee', s1Top: 'rgba(34,211,238,0.25)', s1Bot: 'rgba(34,211,238,0)',
  s2: '#4ade80', s2Top: 'rgba(74,222,128,0.20)', s2Bot: 'rgba(74,222,128,0)',
} : {
  bg: '#ffffff', border: '#e5e7eb', text: '#1f2937', subText: '#6b7280',
  muted: '#9ca3af', gridLine: '#f3f4f6', crosshair: '#d1d5db',
  crosshairLabel: '#f9fafb', markerBg: '#ffffff',
  s1: '#0891b2', s1Top: 'rgba(8,145,178,0.15)', s1Bot: 'rgba(8,145,178,0)',
  s2: '#16a34a', s2Top: 'rgba(22,163,74,0.12)', s2Bot: 'rgba(22,163,74,0)',
})

function formatBytes(bytes: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  if (i < 0 || i >= sizes.length) return '0 B'
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function utcToLocalTs(utcTimeStr: string): number {
  return new Date(utcTimeStr.replace(' ', 'T') + ':00Z').getTime() / 1000
}

// 根据指标类型获取 series 配置
function getSeriesConfig(metric: MetricType) {
  const c = colors.value
  switch (metric) {
    case 'traffic':
      return {
        s1: { color: c.s1, top: c.s1Top, bot: c.s1Bot, title: '入站', formatter: formatBytes },
        s2: { color: c.s2, top: c.s2Top, bot: c.s2Bot, title: '出站', formatter: formatBytes },
        unit: 'MB',
      }
    case 'cpu':
      return {
        s1: { color: '#f59e0b', top: 'rgba(245,158,11,0.20)', bot: 'rgba(245,158,11,0)', title: '使用率', formatter: (v: number) => (v != null ? v.toFixed(1) : '0') + '%' },
        s2: null,
        unit: '%',
      }
    case 'memory':
      return {
        s1: { color: '#8b5cf6', top: 'rgba(139,92,246,0.20)', bot: 'rgba(139,92,246,0)', title: '已用', formatter: formatBytes },
        s2: null,
        unit: 'MB',
      }
    case 'disk':
      return {
        s1: { color: '#ec4899', top: 'rgba(236,72,153,0.20)', bot: 'rgba(236,72,153,0)', title: '读取', formatter: formatBytes },
        s2: { color: '#06b6d4', top: 'rgba(6,182,212,0.15)', bot: 'rgba(6,182,212,0)', title: '写入', formatter: formatBytes },
        unit: 'MB',
      }
  }
}

// 从 samples 提取数据
function extractData(samples: Sample[], metric: MetricType) {
  const timeData = samples.map(s => utcToLocalTs(s.time) as any)
  switch (metric) {
    case 'traffic':
      return {
        s1: samples.map((s, i) => ({ time: timeData[i], value: s.rxBytes || 0 })),
        s2: samples.map((s, i) => ({ time: timeData[i], value: s.txBytes || 0 })),
      }
    case 'cpu':
      return {
        s1: samples.map((s, i) => ({ time: timeData[i], value: s.cpuUsage || 0 })),
        s2: null,
      }
    case 'memory':
      return {
        s1: samples.map((s, i) => ({ time: timeData[i], value: s.memUsed || 0 })),
        s2: null,
      }
    case 'disk':
      return {
        s1: samples.map((s, i) => ({ time: timeData[i], value: s.diskRead || 0 })),
        s2: samples.map((s, i) => ({ time: timeData[i], value: s.diskWrite || 0 })),
      }
  }
}

function initChart() {
  if (!containerRef.value) return
  const c = colors.value
  const config = getSeriesConfig(props.metric)

  chart = createChart(containerRef.value, {
    layout: {
      background: { type: ColorType.Solid, color: c.bg },
      textColor: c.muted,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: c.gridLine, style: 2 },
      horzLines: { color: c.gridLine, style: 2 },
    },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.05 } },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 8,
      tickMarkFormatter: (time: number) => {
        const d = new Date(time * 1000)
        return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })
      },
    },
    crosshair: {
      mode: 0,
      vertLine: { color: c.crosshair, width: 1, style: 2, labelBackgroundColor: c.crosshairLabel },
      horzLine: { color: c.crosshair, width: 1, style: 2, labelBackgroundColor: c.crosshairLabel },
    },
    width: containerRef.value.clientWidth,
    height: 280,
    handleScroll: { vertTouchDrag: false },
    localization: {
      timeFormatter: (time: number) => {
        const d = new Date(time * 1000)
        return d.toLocaleString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
          hour12: false, timeZone: 'Asia/Shanghai',
        })
      },
    },
  })

  series1 = chart.addSeries(AreaSeries, {
    lineColor: config.s1.color,
    topColor: config.s1.top,
    bottomColor: config.s1.bot,
    lineWidth: 2,
    priceFormat: { type: 'custom', formatter: config.s1.formatter },
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBorderColor: config.s1.color,
    crosshairMarkerBackgroundColor: c.markerBg,
    title: config.s1.title,
  })

  if (config.s2) {
    series2 = chart.addSeries(AreaSeries, {
      lineColor: config.s2.color,
      topColor: config.s2.top,
      bottomColor: config.s2.bot,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: config.s2.formatter },
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: config.s2.color,
      crosshairMarkerBackgroundColor: c.markerBg,
      title: config.s2.title,
    })
  }

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === containerRef.value && chart) {
        chart.applyOptions({ width: entry.contentRect.width })
      }
    }
  })
  resizeObserver.observe(containerRef.value)
}

function updateData() {
  if (!series1 || !chart) return
  if (!props.samples.length) {
    series1.setData([])
    if (series2) series2.setData([])
    chart.timeScale().fitContent()
    return
  }
  const data = extractData(props.samples, props.metric)
  series1.setData(data.s1)
  if (series2 && data.s2) series2.setData(data.s2)
  chart.timeScale().fitContent()
}

function rebuildChart() {
  if (chart) { chart.remove(); chart = null; series1 = null; series2 = null }
  initChart()
  // 不在这里调 updateData，等 samples watcher 触发
}

onMounted(() => { initChart(); nextTick(updateData) })
watch(() => props.samples, () => nextTick(updateData), { deep: true })
watch(() => props.metric, () => {
  nextTick(() => {
    rebuildChart()
    // 重建后如果有数据则立即更新
    if (props.samples.length) nextTick(updateData)
  })
})
watch(() => props.theme, () => nextTick(rebuildChart))
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (chart) { chart.remove(); chart = null }
})
</script>

<template>
  <div class="metrics-chart" :class="{ dark: isDark }">
    <div class="chart-header">
      <div class="chart-title-group">
        <div class="chart-tabs">
          <button
            v-for="tab in metricTabs" :key="tab.key"
            class="tab-btn" :class="{ active: metric === tab.key }"
            @click="emit('update:metric', tab.key)"
          >{{ tab.label }}</button>
        </div>
        <div class="chart-legend">
          <span class="legend-item" v-if="metric === 'traffic'">
            <span class="dot" style="background: #22d3ee;"></span> 入站
          </span>
          <span class="legend-item" v-if="metric === 'traffic'">
            <span class="dot" style="background: #4ade80;"></span> 出站
          </span>
          <span class="legend-item" v-if="metric === 'cpu'">
            <span class="dot" style="background: #f59e0b;"></span> 使用率
          </span>
          <span class="legend-item" v-if="metric === 'memory'">
            <span class="dot" style="background: #8b5cf6;"></span> 已用
          </span>
          <span class="legend-item" v-if="metric === 'disk'">
            <span class="dot" style="background: #ec4899;"></span> 读取
          </span>
          <span class="legend-item" v-if="metric === 'disk'">
            <span class="dot" style="background: #06b6d4;"></span> 写入
          </span>
        </div>
      </div>
      <span class="chart-unit">单位: {{ getSeriesConfig(metric).unit }}</span>
    </div>
    <div class="chart-body">
      <div ref="containerRef" class="chart-canvas"></div>
      <div v-if="loading" class="chart-overlay">加载中...</div>
      <div v-else-if="!samples || samples.length === 0" class="chart-overlay">暂无数据</div>
    </div>
  </div>
</template>

<style scoped>
.metrics-chart {
  border-radius: 8px;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #e5e7eb;
}
.metrics-chart.dark {
  background: #121212;
  border-color: #2a2a2a;
}
.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 16px 20px 0;
}
.chart-title-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chart-tabs {
  display: flex;
  gap: 4px;
}
.tab-btn {
  background: none;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
  color: #6b7280;
  transition: all 0.15s;
}
.dark .tab-btn { border-color: #374151; color: #9ca3af; }
.tab-btn:hover { background: #f3f4f6; }
.dark .tab-btn:hover { background: #1f2937; }
.tab-btn.active {
  background: #0891b2;
  color: #fff;
  border-color: #0891b2;
}
.chart-legend {
  display: flex;
  gap: 16px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}
.dark .legend-item { color: #9ca3af; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.chart-unit {
  font-size: 12px;
  color: #9ca3af;
  padding-top: 4px;
}
.dark .chart-unit { color: #6b7280; }
.chart-body {
  position: relative;
  padding: 12px 0 4px;
}
.chart-canvas {
  width: 100%;
  height: 280px;
}
.chart-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #9ca3af;
  pointer-events: none;
  z-index: 10;
}
.dark .chart-overlay { color: #4b5563; }
</style>
