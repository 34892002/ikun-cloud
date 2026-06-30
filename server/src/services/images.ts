/**
 * 镜像管理服务 - 扫描服务器上的 .raw 文件
 */
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 服务器上的镜像目录
const IMAGES_DIR = '/data/ikun-cloud/images'

export interface ImageInfo {
  name: string
  size_gb: number
  available: boolean
}

/**
 * 扫描服务器上的镜像文件
 */
export function listImages(): ImageInfo[] {
  if (!existsSync(IMAGES_DIR)) {
    return []
  }

  const files = readdirSync(IMAGES_DIR).filter(f => f.endsWith('.raw'))
  const images: ImageInfo[] = []

  for (const file of files) {
    const name = file.replace('.raw', '')
    const filePath = join(IMAGES_DIR, file)
    try {
      const stat = statSync(filePath)
      images.push({
        name,
        size_gb: Math.round(stat.size / (1024 * 1024 * 1024) * 10) / 10,
        available: true,
      })
    } catch {
      images.push({ name, size_gb: 0, available: false })
    }
  }

  return images
}

/**
 * 检查镜像是否存在
 */
export function isImageAvailable(name: string): boolean {
  return existsSync(join(IMAGES_DIR, `${name}.raw`))
}
