export type MediaStream = {
  index: number
  codec_type: 'video' | 'audio'
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

export type ProbeResult = {
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

export type MuxRequest = {
  jobId: string
  inputPath: string
  outputPath: string
  streamIndexes: number[]
  durationSeconds: number
}

export type ProgressEvent = {
  jobId: string
  percentage: number
}

export type TrackForgeApi = {
  chooseInput: () => Promise<string | null>
  chooseOutput: (inputPath: string) => Promise<string | null>
  getPathForFile: (file: File) => string
  probeMedia: (filePath: string) => Promise<ProbeResult>
  startMux: (request: MuxRequest) => Promise<{ outputPath: string }>
  cancelMux: (jobId: string) => Promise<boolean>
  showItem: (filePath: string) => Promise<void>
  onProgress: (callback: (payload: ProgressEvent) => void) => () => void
}

declare global {
  interface Window {
    trackforge?: TrackForgeApi
  }
}
