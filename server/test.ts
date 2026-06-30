import { readFileSync, statSync, existsSync } from 'node:fs'

const p = '/opt/ikun-cloud/web/dist/assets/index-BIkOnzRP.js'
console.log('exists:', existsSync(p))
if (existsSync(p)) {
  const s = statSync(p)
  console.log('size:', s.size)
  const buf = readFileSync(p)
  console.log('read:', buf.length)
}
