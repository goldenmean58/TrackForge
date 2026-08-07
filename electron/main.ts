import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import ffmpegPath from 'ffmpeg-static'
import ffprobe from '@ffprobe-installer/ffprobe'

type MediaStream = {
  index: number
  codec_type: 'video' | 'audio' | string
  codec_name?: string
  codec_long_name?: string
  profile?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  sample_rate?: string
  channels?: number
  channel_layout?: string
  bit_rate?: string
  duration?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

type ProbeResult = {
  streams: MediaStream[]
  format: {
    filename: string
    format_name?: string
    duration?: string
    size?: string
    bit_rate?: string
    tags?: Record<string, string>
  }
}

type MuxRequest = {
  jobId: string
  inputPath: string
  outputPath: string
  streamIndexes: number[]
  durationSeconds: number
  trimStartSeconds: number
  trimEndSeconds: number
}

const jobs = new Map<string, ChildProcessWithoutNullStreams>()
const previewFiles = new Map<string, string>()
const previewTasks = new Map<string, Promise<AudioPreview>>()
const previewProcesses = new Set<ChildProcessWithoutNullStreams>()
let previewDirectory = ''

type AudioPreview = {
  url: string
  durationSeconds: number
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'trackforge-media',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}])

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function unpackedBinary(binaryPath: string): string {
  return app.isPackaged ? binaryPath.replace('app.asar', 'app.asar.unpacked') : binaryPath
}

function validateMp4(filePath: string): string {
  const resolved = path.resolve(filePath)
  if (path.extname(resolved).toLowerCase() !== '.mp4') {
    throw new Error('请选择 MP4 文件。')
  }
  return resolved
}

async function probeMedia(filePath: string): Promise<ProbeResult> {
  const inputPath = validateMp4(filePath)
  await fs.access(inputPath)

  return new Promise((resolve, reject) => {
    const process = spawn(unpackedBinary(ffprobe.path), [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      inputPath,
    ])
    let stdout = ''
    let stderr = ''

    process.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    process.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    process.on('error', (error) => reject(new Error(`无法启动 FFprobe：${error.message}`)))
    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || '无法读取该 MP4 文件。'))
        return
      }
      try {
        const result = JSON.parse(stdout) as ProbeResult
        result.streams = result.streams.filter((stream) =>
          stream.codec_type === 'video' || stream.codec_type === 'audio')
        resolve(result)
      } catch {
        reject(new Error('无法解析媒体轨道信息。'))
      }
    })
  })
}

async function createAudioPreview(filePath: string, streamIndex: number): Promise<AudioPreview> {
  const binaryPath = ffmpegPath
  if (!binaryPath) throw new Error('当前平台没有可用的 FFmpeg。')
  if (!Number.isInteger(streamIndex) || streamIndex < 0) throw new Error('音频轨道无效。')

  const inputPath = validateMp4(filePath)
  const [media, sourceStat] = await Promise.all([probeMedia(inputPath), fs.stat(inputPath)])
  const stream = media.streams.find((item) => item.index === streamIndex && item.codec_type === 'audio')
  if (!stream) throw new Error('找不到该音频轨道，请重新载入文件。')

  const token = createHash('sha256')
    .update(`${inputPath}:${sourceStat.size}:${sourceStat.mtimeMs}:${streamIndex}`)
    .digest('hex')
    .slice(0, 32)
  const existingTask = previewTasks.get(token)
  if (existingTask) return existingTask

  const outputPath = path.join(previewDirectory, `${token}.m4a`)
  const result = async (): Promise<AudioPreview> => {
    const existingFile = await fs.stat(outputPath).catch(() => null)
    if (!existingFile || existingFile.size === 0) {
      await fs.mkdir(previewDirectory, { recursive: true })
      const canCopy = stream.codec_name === 'aac'
      const args = [
        '-y',
        '-i', inputPath,
        '-map', `0:${streamIndex}`,
        '-vn',
        ...(canCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
        '-movflags', '+faststart',
        outputPath,
      ]

      await new Promise<void>((resolve, reject) => {
        const process = spawn(unpackedBinary(binaryPath), args)
        previewProcesses.add(process)
        let stderr = ''
        process.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000) })
        process.on('error', (error) => reject(new Error(`无法启动 FFmpeg：${error.message}`)))
        process.on('close', async (code) => {
          previewProcesses.delete(process)
          if (code === 0) {
            resolve()
            return
          }
          await fs.rm(outputPath, { force: true }).catch(() => undefined)
          const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join('\n')
          reject(new Error(detail || '无法准备该音频轨道。'))
        })
      })
    }

    previewFiles.set(token, outputPath)
    return {
      url: `trackforge-media://audio/${token}`,
      durationSeconds: Number(stream.duration || media.format.duration) || 0,
    }
  }

  const task = result().finally(() => previewTasks.delete(token))
  previewTasks.set(token, task)
  return task
}

async function serveAudioPreview(request: Request): Promise<Response> {
  const token = new URL(request.url).pathname.slice(1)
  const filePath = previewFiles.get(token)
  if (!filePath) return new Response('Not found', { status: 404 })

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return new Response('Not found', { status: 404 })
  const range = request.headers.get('range')
  let start = 0
  let end = stat.size - 1
  let status = 200

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    if (match[1]) start = Number(match[1])
    if (match[2]) end = Number(match[2])
    if (!match[1] && match[2]) start = Math.max(0, stat.size - Number(match[2]))
    end = Math.min(end, stat.size - 1)
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    status = 206
  }

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': 'audio/mp4',
    'Cache-Control': 'private, max-age=3600',
  })
  if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)

  if (request.method === 'HEAD') return new Response(null, { status, headers })

  const stream = createReadStream(filePath, { start, end })
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'TrackForge',
    backgroundColor: '#f7f8f6',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  previewDirectory = path.join(app.getPath('temp'), `trackforge-previews-${process.pid}`)
  protocol.handle('trackforge-media', serveAudioPreview)

  ipcMain.handle('file:choose-input', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 MP4 文件',
      properties: ['openFile'],
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('file:choose-output', async (_event, inputPath: string) => {
    const parsed = path.parse(validateMp4(inputPath))
    const result = await dialog.showSaveDialog({
      title: '保存合成视频',
      defaultPath: path.join(parsed.dir, `${parsed.name}-remux.mp4`),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('media:probe', async (_event, filePath: string) => probeMedia(filePath))

  ipcMain.handle('media:prepare-audio-preview', async (_event, filePath: string, streamIndex: number) =>
    createAudioPreview(filePath, streamIndex))

  ipcMain.handle('mux:start', async (event, request: MuxRequest) => {
    const binaryPath = ffmpegPath
    if (!binaryPath) throw new Error('当前平台没有可用的 FFmpeg。')
    const inputPath = validateMp4(request.inputPath)
    const outputPath = validateMp4(request.outputPath)
    if (path.normalize(inputPath) === path.normalize(outputPath)) {
      throw new Error('输出文件不能覆盖源文件。')
    }
    if (!request.streamIndexes.length) throw new Error('请至少选择一条轨道。')
    if (jobs.has(request.jobId)) throw new Error('任务已经在运行。')

    const media = await probeMedia(inputPath)
    const available = new Set(media.streams.map((stream) => stream.index))
    if (request.streamIndexes.some((index) => !available.has(index))) {
      throw new Error('轨道选择已失效，请重新载入文件。')
    }

    const sourceDuration = Number(media.format.duration) || request.durationSeconds || 0
    const trimStart = Math.max(0, Number(request.trimStartSeconds) || 0)
    const trimEnd = Math.max(0, Number(request.trimEndSeconds) || 0)
    if (sourceDuration > 0 && trimStart + trimEnd >= sourceDuration) {
      throw new Error('裁剪的时长已超过视频总长度，请调整前后删除的秒数。')
    }
    const keepDuration = sourceDuration > 0 ? sourceDuration - trimStart - trimEnd : 0

    const args = ['-y']
    if (trimStart > 0) args.push('-ss', trimStart.toFixed(3))
    args.push('-i', inputPath)
    if (trimEnd > 0 && keepDuration > 0) args.push('-t', keepDuration.toFixed(3))
    for (const index of request.streamIndexes) args.push('-map', `0:${index}`)
    args.push(
      '-map_metadata', '0',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      outputPath,
    )

    return new Promise<{ outputPath: string }>((resolve, reject) => {
      const process = spawn(unpackedBinary(binaryPath), args)
      jobs.set(request.jobId, process)
      let stderr = ''
      let progressBuffer = ''
      const progressDuration = keepDuration > 0 ? keepDuration : request.durationSeconds

      process.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        stderr = (stderr + text).slice(-12000)
        progressBuffer += text
        const lines = progressBuffer.split(/\r?\n/)
        progressBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const [key, value] = line.split('=', 2)
          if (key === 'out_time_us' && progressDuration > 0) {
            const percentage = Math.min(99, (Number(value) / 1_000_000 / progressDuration) * 100)
            event.sender.send('mux:progress', { jobId: request.jobId, percentage })
          }
        }
      })

      process.on('error', (error) => {
        jobs.delete(request.jobId)
        reject(new Error(`无法启动 FFmpeg：${error.message}`))
      })

      process.on('close', async (code, signal) => {
        jobs.delete(request.jobId)
        if (code === 0) {
          event.sender.send('mux:progress', { jobId: request.jobId, percentage: 100 })
          resolve({ outputPath })
          return
        }
        if (signal) {
          await fs.rm(outputPath, { force: true }).catch(() => undefined)
          reject(new Error('任务已取消。'))
          return
        }
        await fs.rm(outputPath, { force: true }).catch(() => undefined)
        const usefulError = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join('\n')
        reject(new Error(usefulError || '合成失败，请检查轨道格式。'))
      })
    })
  })

  ipcMain.handle('mux:cancel', (_event, jobId: string) => {
    const process = jobs.get(jobId)
    if (!process) return false
    process.kill('SIGTERM')
    return true
  })

  ipcMain.handle('shell:show-item', (_event, filePath: string) => {
    shell.showItemInFolder(path.resolve(filePath))
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const process of jobs.values()) process.kill('SIGTERM')
  for (const process of previewProcesses) process.kill('SIGTERM')
  if (previewDirectory) void fs.rm(previewDirectory, { recursive: true, force: true })
})
