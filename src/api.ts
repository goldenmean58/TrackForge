import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type { MuxRequest, ProbeResult, ProgressEvent } from './types'

const mp4Filter = [{ name: 'MP4 视频', extensions: ['mp4'] }]

function defaultOutputPath(inputPath: string): string {
  const sepIndex = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'))
  const dir = sepIndex >= 0 ? inputPath.slice(0, sepIndex + 1) : ''
  const base = sepIndex >= 0 ? inputPath.slice(sepIndex + 1) : inputPath
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return `${dir}${stem}-remux.mp4`
}

export const api = {
  async chooseInput(): Promise<string | null> {
    const selected = await open({ multiple: false, filters: mp4Filter })
    return typeof selected === 'string' ? selected : null
  },

  async chooseOutput(inputPath: string): Promise<string | null> {
    const selected = await save({ defaultPath: defaultOutputPath(inputPath), filters: mp4Filter })
    return selected ?? null
  },

  probeMedia(filePath: string): Promise<ProbeResult> {
    return invoke<ProbeResult>('probe_media', { path: filePath })
  },

  async prepareAudioPreview(
    filePath: string,
    streamIndex: number,
  ): Promise<{ url: string; durationSeconds: number }> {
    const preview = await invoke<{ path: string; durationSeconds: number }>('prepare_audio_preview', {
      path: filePath,
      streamIndex,
    })
    return { url: convertFileSrc(preview.path), durationSeconds: preview.durationSeconds }
  },

  startMux(request: MuxRequest): Promise<{ outputPath: string }> {
    return invoke<{ outputPath: string }>('start_mux', { request })
  },

  cancelMux(jobId: string): Promise<boolean> {
    return invoke<boolean>('cancel_mux', { jobId })
  },

  showItem(filePath: string): Promise<void> {
    return revealItemInDir(filePath)
  },

  onProgress(callback: (payload: ProgressEvent) => void): () => void {
    let unlisten: (() => void) | null = null
    let cancelled = false
    void listen<ProgressEvent>('mux:progress', (event) => callback(event.payload)).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  },
}
