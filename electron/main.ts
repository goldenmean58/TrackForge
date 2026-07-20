import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
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
}

const jobs = new Map<string, ChildProcessWithoutNullStreams>()

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

    const args = ['-y', '-i', inputPath]
    for (const index of request.streamIndexes) args.push('-map', `0:${index}`)
    args.push(
      '-map_metadata', '0',
      '-c', 'copy',
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

      process.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        stderr = (stderr + text).slice(-12000)
        progressBuffer += text
        const lines = progressBuffer.split(/\r?\n/)
        progressBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const [key, value] = line.split('=', 2)
          if (key === 'out_time_us' && request.durationSeconds > 0) {
            const percentage = Math.min(99, (Number(value) / 1_000_000 / request.durationSeconds) * 100)
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
