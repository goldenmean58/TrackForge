// 将 ffmpeg-static / @ffprobe-installer 提供的二进制复制为 Tauri sidecar，
// 并按目标平台的 target-triple 重命名，供 tauri.conf.json 的 externalBin 解析。
import { execSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const binariesDir = join(scriptDir, '..', 'src-tauri', 'binaries')

function resolveTargetTriple() {
  // 允许通过 CLI 参数或环境变量显式指定（交叉编译场景）；否则取 rustc 宿主 triple。
  const explicit = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE
  if (explicit) return explicit.trim()
  const info = execSync('rustc -vV', { encoding: 'utf8' })
  const match = /^host:\s*(.+)$/m.exec(info)
  if (!match) throw new Error('无法从 rustc -vV 解析 host target triple。')
  return match[1].trim()
}

function ffmpegSource() {
  const path = require('ffmpeg-static')
  if (typeof path !== 'string' || !path) throw new Error('ffmpeg-static 未提供二进制路径。')
  return path
}

function ffprobeSource() {
  const { path } = require('@ffprobe-installer/ffprobe')
  if (typeof path !== 'string' || !path) throw new Error('@ffprobe-installer/ffprobe 未提供二进制路径。')
  return path
}

function main() {
  const triple = resolveTargetTriple()
  const ext = process.platform === 'win32' ? '.exe' : ''
  mkdirSync(binariesDir, { recursive: true })

  const targets = [
    { name: 'ffmpeg', source: ffmpegSource() },
    { name: 'ffprobe', source: ffprobeSource() },
  ]

  for (const { name, source } of targets) {
    if (!existsSync(source)) {
      throw new Error(`找不到 ${name} 二进制：${source}。请先执行 npm install --include=optional。`)
    }
    const dest = join(binariesDir, `${name}-${triple}${ext}`)
    copyFileSync(source, dest)
    if (process.platform !== 'win32') chmodSync(dest, 0o755)
    console.log(`已复制 ${name} → ${dest}`)
  }
}

main()
