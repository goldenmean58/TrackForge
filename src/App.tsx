import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  AudioLines,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileOutput,
  Film,
  FolderOpen,
  HardDrive,
  Info,
  Languages,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Sparkles,
  Video,
  X,
} from 'lucide-react'
import { demoFilePath, demoMedia } from './demo'
import { api } from './api'
import type { MediaStream, ProbeResult, ProgressEvent } from './types'

type JobState = 'idle' | 'running' | 'success' | 'error' | 'cancelled'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const languageNames: Record<string, string> = {
  und: '未标注',
  zho: '中文',
  chi: '中文',
  eng: 'English',
  jpn: '日本語',
  kor: '한국어',
  fra: 'Français',
  deu: 'Deutsch',
  spa: 'Español',
}

function baseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath
}

function directoryName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(0, normalized.lastIndexOf('/')) || normalized
}

function formatBytes(raw?: string | number): string {
  const bytes = Number(raw)
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unit
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(raw?: string | number): string {
  const total = Math.max(0, Math.round(Number(raw) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatPlaybackTime(raw?: number): string {
  const total = Math.max(0, Math.floor(raw || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatBitrate(raw?: string): string {
  const value = Number(raw)
  if (!value) return '未知码率'
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1000)} kbps`
}

function frameRate(raw?: string): string {
  if (!raw) return ''
  const [numerator, denominator = 1] = raw.split('/').map(Number)
  const result = numerator / denominator
  return Number.isFinite(result) ? `${Number(result.toFixed(2))} fps` : ''
}

function sanitizeTrim(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const parts = cleaned.split('.')
  const normalized = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : cleaned
  return normalized.replace(/^0+(?=\d)/, '')
}

function errorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '') || fallback
}

function displayLanguage(stream: MediaStream): string {
  const code = stream.tags?.language?.toLowerCase()
  return code ? languageNames[code] || code.toUpperCase() : '未标注'
}

function trackTitle(stream: MediaStream, ordinal: number): string {
  return stream.tags?.title || stream.tags?.handler_name || `${stream.codec_type === 'video' ? '视频' : '音频'}轨道 ${ordinal}`
}

function App() {
  const isDemo = useMemo(() => new URLSearchParams(window.location.search).has('demo'), [])
  const [media, setMedia] = useState<ProbeResult | null>(isDemo ? demoMedia : null)
  const [filePath, setFilePath] = useState(isDemo ? demoFilePath : '')
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(isDemo ? demoMedia.streams.map((stream) => stream.index) : []),
  )
  const [isInspecting, setIsInspecting] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [jobState, setJobState] = useState<JobState>('idle')
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState(0)
  const [outputPath, setOutputPath] = useState('')
  const [error, setError] = useState('')
  const [activeAudioIndex, setActiveAudioIndex] = useState<number | null>(null)
  const [trimStart, setTrimStart] = useState('')
  const [trimEnd, setTrimEnd] = useState('')

  const videoStreams = media?.streams.filter((stream) => stream.codec_type === 'video') ?? []
  const audioStreams = media?.streams.filter((stream) => stream.codec_type === 'audio') ?? []
  const selectedVideoCount = videoStreams.filter((stream) => selected.has(stream.index)).length
  const selectedAudioCount = audioStreams.filter((stream) => selected.has(stream.index)).length

  const sourceDuration = Number(media?.format.duration) || 0
  const trimStartSeconds = Math.max(0, Number(trimStart) || 0)
  const trimEndSeconds = Math.max(0, Number(trimEnd) || 0)
  const keepDuration = sourceDuration - trimStartSeconds - trimEndSeconds
  const hasTrim = trimStartSeconds > 0 || trimEndSeconds > 0
  const trimInvalid = hasTrim && sourceDuration > 0 && keepDuration <= 0

  const inspectFile = useCallback(async (path: string) => {
    if (!path.toLowerCase().endsWith('.mp4')) {
      setError('仅支持 MP4 文件，请重新选择。')
      return
    }
    if (!isTauri) {
      setError('请在 TrackForge 桌面应用中选择本地文件。')
      return
    }
    setIsInspecting(true)
    setError('')
    setJobState('idle')
    setOutputPath('')
    setActiveAudioIndex(null)
    setTrimStart('')
    setTrimEnd('')
    try {
      const result = await api.probeMedia(path)
      if (result.streams.length === 0) throw new Error('没有找到视频或音频轨道。')
      setMedia(result)
      setFilePath(path)
      setSelected(new Set(result.streams.map((stream) => stream.index)))
    } catch (cause) {
      setError(errorMessage(cause, '读取文件失败。'))
    } finally {
      setIsInspecting(false)
    }
  }, [])

  useEffect(() => {
    if (!isTauri) return
    return api.onProgress((event: ProgressEvent) => {
      if (event.jobId === jobId) setProgress(event.percentage)
    })
  }, [jobId])

  const chooseFile = async () => {
    if (!isTauri) return
    const path = await api.chooseInput()
    if (path) await inspectFile(path)
  }

  const toggleStream = (index: number) => {
    if (jobState === 'running') return
    setSelected((current) => {
      const next = new Set(current)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
    setJobState('idle')
    setProgress(0)
  }

  const selectGroup = (streams: MediaStream[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      streams.forEach((stream) => checked ? next.add(stream.index) : next.delete(stream.index))
      return next
    })
  }

  const startMux = async () => {
    if (!media || selectedVideoCount === 0 || !isTauri) return
    if (trimInvalid) {
      setError('裁剪的时长已超过视频总长度，请调整前后删除的秒数。')
      return
    }
    setActiveAudioIndex(null)
    const path = await api.chooseOutput(filePath)
    if (!path) return
    const id = crypto.randomUUID()
    setJobId(id)
    setJobState('running')
    setProgress(0)
    setError('')
    setOutputPath(path)
    try {
      await api.startMux({
        jobId: id,
        inputPath: filePath,
        outputPath: path,
        streamIndexes: media.streams.filter((stream) => selected.has(stream.index)).map((stream) => stream.index),
        durationSeconds: Number(media.format.duration) || 0,
        trimStartSeconds,
        trimEndSeconds,
      })
      setProgress(100)
      setJobState('success')
    } catch (cause) {
      const message = errorMessage(cause, '合成失败。')
      setError(message)
      setJobState(message.includes('已取消') ? 'cancelled' : 'error')
    }
  }

  const cancelMux = async () => {
    if (jobId) await api.cancelMux(jobId)
  }

  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setIsDragging(true)
      } else if (event.payload.type === 'leave') {
        setIsDragging(false)
      } else if (event.payload.type === 'drop') {
        setIsDragging(false)
        const path = event.payload.paths[0]
        if (path) void inspectFile(path)
      }
    })
    return () => {
      disposed = true
      void unlisten.then((fn) => {
        if (disposed) fn()
      })
    }
  }, [inspectFile])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark"><AudioLines size={19} strokeWidth={2.2} /></span>
          <span>TrackForge</span>
          <span className="brand-subtitle">轨道工坊</span>
        </div>
        <div className="header-status"><span className="status-dot" /> 本地处理 · 不上传文件</div>
      </header>

      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content"><FileOutput size={34} /><strong>松开以载入 MP4</strong><span>将读取文件中的视频与音频轨道</span></div>
        </div>
      )}

      {!media ? (
        <main className="empty-workspace">
          <section className={`drop-zone ${isInspecting ? 'is-loading' : ''}`}>
            <div className="empty-icon"><Film size={34} /></div>
            <h1>{isInspecting ? '正在读取媒体信息' : '从一个 MP4 开始'}</h1>
            <p>{isInspecting ? '正在识别视频、语言与声道信息…' : '拖放文件到这里，查看并重新组合其中的全部轨道。'}</p>
            <button className="primary-button" onClick={chooseFile} disabled={isInspecting}>
              {isInspecting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
              选择 MP4 文件
            </button>
            <div className="empty-details">
              <span><Check size={14} /> 原始质量直拷贝</span>
              <span><Check size={14} /> 多语言音轨</span>
              <span><Check size={14} /> 离线 FFmpeg</span>
            </div>
          </section>
          {error && <div className="toast error-toast"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError('')} aria-label="关闭"><X size={16} /></button></div>}
        </main>
      ) : (
        <main className="workspace-grid">
          <aside className="source-panel panel-section">
            <div className="section-heading">
              <div><span className="eyebrow">源文件</span><h2>媒体信息</h2></div>
              <button className="icon-button" onClick={chooseFile} disabled={jobState === 'running'} title="更换文件" aria-label="更换文件"><RotateCcw size={16} /></button>
            </div>

            <div className="source-preview"><Film size={40} /><span>MP4</span></div>
            <div className="file-identity">
              <strong title={baseName(filePath)}>{baseName(filePath)}</strong>
              <span title={directoryName(filePath)}>{directoryName(filePath)}</span>
            </div>

            <dl className="media-facts">
              <div><dt>时长</dt><dd>{formatDuration(media.format.duration)}</dd></div>
              <div><dt>文件大小</dt><dd>{formatBytes(media.format.size)}</dd></div>
              <div><dt>总码率</dt><dd>{formatBitrate(media.format.bit_rate)}</dd></div>
              <div><dt>轨道数</dt><dd>{media.streams.length} 条</dd></div>
            </dl>

            <div className="source-summary">
              <div><span className="summary-icon video"><Video size={15} /></span><span><strong>{videoStreams.length}</strong> 条视频轨</span></div>
              <div><span className="summary-icon audio"><Music2 size={15} /></span><span><strong>{audioStreams.length}</strong> 条音频轨</span></div>
            </div>
            <div className="copy-note"><Sparkles size={15} /><span><strong>无损封装</strong>不会重新编码，速度取决于磁盘读写。</span></div>
          </aside>

          <section className="tracks-panel panel-section">
            <div className="section-heading tracks-heading">
              <div><span className="eyebrow">轨道选择</span><h1>选择要保留的内容</h1></div>
              <span className="selection-count">已选 {selected.size} / {media.streams.length}</span>
            </div>

            <TrackGroup
              title="视频轨道"
              icon={<Video size={17} />}
              streams={videoStreams}
              selected={selected}
              onToggle={toggleStream}
              onSelectAll={(checked) => selectGroup(videoStreams, checked)}
              disabled={jobState === 'running'}
              filePath={filePath}
              durationSeconds={Number(media.format.duration) || 0}
              activeAudioIndex={activeAudioIndex}
              onActivateAudio={setActiveAudioIndex}
            />
            <TrackGroup
              title="音频轨道"
              icon={<Music2 size={17} />}
              streams={audioStreams}
              selected={selected}
              onToggle={toggleStream}
              onSelectAll={(checked) => selectGroup(audioStreams, checked)}
              disabled={jobState === 'running'}
              filePath={filePath}
              durationSeconds={Number(media.format.duration) || 0}
              activeAudioIndex={activeAudioIndex}
              onActivateAudio={setActiveAudioIndex}
            />
          </section>

          <aside className="output-panel panel-section">
            <div className="section-heading"><div><span className="eyebrow">输出</span><h2>新视频</h2></div></div>
            <div className="output-format"><span className="format-icon">MP4</span><div><strong>MP4 容器</strong><span>保持原始编码与元数据</span></div></div>

            <div className="output-composition">
              <span>将要写入</span>
              <div className="composition-row"><Video size={15} /><strong>{selectedVideoCount}</strong><span>条视频轨道</span></div>
              <div className="composition-row"><Music2 size={15} /><strong>{selectedAudioCount}</strong><span>条音频轨道</span></div>
            </div>

            <div className="trim-section">
              <div className="trim-heading"><Scissors size={15} /><strong>剪辑时长</strong><span>可选</span></div>
              <div className="trim-inputs">
                <label>
                  <span>删除开头</span>
                  <div className="trim-field">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="decimal"
                      placeholder="0"
                      value={trimStart}
                      onChange={(event) => setTrimStart(sanitizeTrim(event.target.value))}
                      disabled={jobState === 'running'}
                      aria-label="删除开头秒数"
                    />
                    <span className="trim-unit">秒</span>
                  </div>
                </label>
                <label>
                  <span>删除结尾</span>
                  <div className="trim-field">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="decimal"
                      placeholder="0"
                      value={trimEnd}
                      onChange={(event) => setTrimEnd(sanitizeTrim(event.target.value))}
                      disabled={jobState === 'running'}
                      aria-label="删除结尾秒数"
                    />
                    <span className="trim-unit">秒</span>
                  </div>
                </label>
              </div>
              {trimInvalid ? (
                <div className="trim-note invalid"><CircleAlert size={13} /><span>裁剪时长超过视频总长（{formatDuration(sourceDuration)}）。</span></div>
              ) : hasTrim ? (
                <div className="trim-note"><span>保留时长约 <strong>{formatDuration(keepDuration)}</strong>，按最近关键帧对齐，实际切点可能有微小偏差。</span></div>
              ) : (
                <div className="trim-note muted"><span>留空则保留完整时长。</span></div>
              )}
            </div>

            {selectedVideoCount === 0 && jobState !== 'running' && (
              <div className="inline-warning"><Info size={15} /><span>至少选择一条视频轨道。</span></div>
            )}

            {jobState !== 'idle' && (
              <div className={`job-card ${jobState}`}>
                <div className="job-card-title">
                  {jobState === 'running' && <LoaderCircle className="spin" size={17} />}
                  {jobState === 'success' && <CircleCheck size={17} />}
                  {(jobState === 'error' || jobState === 'cancelled') && <CircleAlert size={17} />}
                  <strong>{jobState === 'running' ? '正在合成' : jobState === 'success' ? '合成完成' : jobState === 'cancelled' ? '任务已取消' : '合成失败'}</strong>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
                {outputPath && <span className="output-name" title={outputPath}>{baseName(outputPath)}</span>}
              </div>
            )}

            {error && media && <div className="panel-error"><CircleAlert size={15} /><span>{error}</span></div>}

            <div className="output-actions">
              {jobState === 'running' ? (
                <button className="secondary-button danger" onClick={cancelMux}><X size={17} />取消任务</button>
              ) : jobState === 'success' ? (
                <>
                  <button className="primary-button" onClick={() => void api.showItem(outputPath)}><FolderOpen size={17} />打开所在文件夹</button>
                  <button className="text-button" onClick={() => { setJobState('idle'); setProgress(0); setError('') }}><RotateCcw size={15} />再次导出</button>
                </>
              ) : (
                <button className="primary-button export-button" onClick={startMux} disabled={selectedVideoCount === 0 || selected.size === 0 || trimInvalid}>
                  <FileOutput size={17} />选择位置并合成<ChevronRight size={16} />
                </button>
              )}
            </div>

            <div className="storage-note"><HardDrive size={14} /><span>输出文件将保存到你选择的位置</span></div>
          </aside>
        </main>
      )}
    </div>
  )
}

type TrackGroupProps = {
  title: string
  icon: React.ReactNode
  streams: MediaStream[]
  selected: Set<number>
  onToggle: (index: number) => void
  onSelectAll: (checked: boolean) => void
  disabled: boolean
  filePath: string
  durationSeconds: number
  activeAudioIndex: number | null
  onActivateAudio: (index: number | null) => void
}

function TrackGroup({ title, icon, streams, selected, onToggle, onSelectAll, disabled, filePath, durationSeconds, activeAudioIndex, onActivateAudio }: TrackGroupProps) {
  const allSelected = streams.length > 0 && streams.every((stream) => selected.has(stream.index))
  return (
    <div className="track-group">
      <div className="track-group-header">
        <div>{icon}<h3>{title}</h3><span>{streams.length}</span></div>
        {streams.length > 0 && <button onClick={() => onSelectAll(!allSelected)} disabled={disabled}>{allSelected ? '取消全选' : '全选'}</button>}
      </div>
      {streams.length === 0 ? (
        <div className="group-empty">未检测到{title}</div>
      ) : streams.map((stream, index) => (
        <TrackRow
          key={`${filePath}:${stream.index}`}
          stream={stream}
          ordinal={index + 1}
          checked={selected.has(stream.index)}
          onToggle={() => onToggle(stream.index)}
          disabled={disabled}
          filePath={filePath}
          durationSeconds={Number(stream.duration) || durationSeconds}
          isActiveAudio={activeAudioIndex === stream.index}
          onActivateAudio={onActivateAudio}
        />
      ))}
    </div>
  )
}

type TrackRowProps = {
  stream: MediaStream
  ordinal: number
  checked: boolean
  onToggle: () => void
  disabled: boolean
  filePath: string
  durationSeconds: number
  isActiveAudio: boolean
  onActivateAudio: (index: number | null) => void
}

function TrackRow({ stream, ordinal, checked, onToggle, disabled, filePath, durationSeconds, isActiveAudio, onActivateAudio }: TrackRowProps) {
  const isVideo = stream.codec_type === 'video'
  return (
    <div className={`track-row ${!isVideo ? 'has-preview' : ''} ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}`} onClick={() => !disabled && onToggle()}>
      <input className="track-select-input" type="checkbox" checked={checked} onChange={onToggle} onClick={(event) => event.stopPropagation()} disabled={disabled} aria-label={`${checked ? '取消选择' : '选择'}${trackTitle(stream, ordinal)}`} />
      <span className="custom-check">{checked && <Check size={14} strokeWidth={3} />}</span>
      <span className={`track-type-icon ${isVideo ? 'video' : 'audio'}`}>{isVideo ? <Video size={17} /> : <Music2 size={17} />}</span>
      <span className="track-main">
        <span className="track-title">
          <strong>{trackTitle(stream, ordinal)}</strong>
          {stream.disposition?.default === 1 && <span className="default-badge">默认</span>}
        </span>
        <span className="track-meta">
          <span>{(stream.codec_name || '未知').toUpperCase()}</span>
          {isVideo ? (
            <><span>{stream.width && stream.height ? `${stream.width} × ${stream.height}` : '未知尺寸'}</span><span>{frameRate(stream.avg_frame_rate)}</span></>
          ) : (
            <><span>{stream.sample_rate ? `${Number(stream.sample_rate) / 1000} kHz` : '未知采样率'}</span><span>{stream.channels ? `${stream.channels} 声道` : '未知声道'}</span></>
          )}
        </span>
      </span>
      <span className="track-side">
        {!isVideo && <span className="language"><Languages size={13} />{displayLanguage(stream)}</span>}
        <span>{formatBitrate(stream.bit_rate)}</span>
      </span>
      {!isVideo && (
        <AudioPreview
          filePath={filePath}
          streamIndex={stream.index}
          durationSeconds={durationSeconds}
          isActive={isActiveAudio}
          onActivate={onActivateAudio}
          disabled={disabled}
        />
      )}
    </div>
  )
}

type AudioPreviewProps = {
  filePath: string
  streamIndex: number
  durationSeconds: number
  isActive: boolean
  onActivate: (index: number | null) => void
  disabled: boolean
}

function AudioPreview({ filePath, streamIndex, durationSeconds, isActive, onActivate, disabled }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const preparationRef = useRef<Promise<void> | null>(null)
  const pendingPlayRef = useRef(false)
  const pendingSeekRef = useRef<number | null>(null)
  const [source, setSource] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationSeconds)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    if (isActive) return
    pendingPlayRef.current = false
    audioRef.current?.pause()
    setIsPlaying(false)
  }, [isActive])

  useEffect(() => () => audioRef.current?.pause(), [])

  const prepare = async () => {
    if (source || preparationRef.current) return preparationRef.current
    if (!isTauri) {
      setPreviewError('请在桌面应用中试听。')
      return
    }
    setIsLoading(true)
    setPreviewError('')
    const task = api.prepareAudioPreview(filePath, streamIndex)
      .then((preview) => {
        setSource(preview.url)
        if (preview.durationSeconds > 0) setDuration(preview.durationSeconds)
      })
      .catch((cause) => {
        const message = errorMessage(cause, '无法准备试听。')
        setPreviewError(message)
        pendingPlayRef.current = false
        onActivate(null)
      })
      .finally(() => {
        setIsLoading(false)
        preparationRef.current = null
      })
    preparationRef.current = task
    return task
  }

  const play = async () => {
    if (disabled) return
    if (isPlaying) {
      audioRef.current?.pause()
      onActivate(null)
      return
    }
    pendingPlayRef.current = true
    onActivate(streamIndex)
    if (source && audioRef.current) {
      pendingPlayRef.current = false
      if (audioRef.current.ended) {
        audioRef.current.currentTime = 0
        setCurrentTime(0)
      }
      await audioRef.current.play().catch(() => setPreviewError('无法播放该音频轨道。'))
      return
    }
    await prepare()
  }

  const seek = (value: number) => {
    const next = Math.min(Math.max(0, value), duration || durationSeconds)
    setCurrentTime(next)
    pendingSeekRef.current = next
    if (audioRef.current && source) {
      audioRef.current.currentTime = next
      pendingSeekRef.current = null
    } else {
      void prepare()
    }
  }

  const onCanPlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (pendingSeekRef.current !== null) {
      audio.currentTime = pendingSeekRef.current
      pendingSeekRef.current = null
    }
    if (pendingPlayRef.current) {
      pendingPlayRef.current = false
      onActivate(streamIndex)
      void audio.play().catch(() => setPreviewError('无法播放该音频轨道。'))
    }
  }

  const maximum = Math.max(duration || durationSeconds, 0.01)
  const percentage = Math.min(100, (currentTime / maximum) * 100)

  return (
    <div className="audio-preview" onClick={(event) => event.stopPropagation()}>
      <audio
        ref={audioRef}
        src={source || undefined}
        preload="metadata"
        onCanPlay={onCanPlay}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration)
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onEnded={() => { setIsPlaying(false); onActivate(null) }}
        onError={() => source && setPreviewError('无法播放该音频轨道。')}
      />
      <button className="audio-play-button" onClick={() => void play()} disabled={disabled || isLoading} title={isPlaying ? '暂停试听' : '播放试听'} aria-label={isPlaying ? '暂停试听' : '播放试听'}>
        {isLoading ? <LoaderCircle className="spin" size={14} /> : isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <span className="audio-time current">{formatPlaybackTime(currentTime)}</span>
      <input
        className="audio-scrubber"
        type="range"
        min="0"
        max={maximum}
        step="0.05"
        value={Math.min(currentTime, maximum)}
        onChange={(event) => seek(Number(event.target.value))}
        onPointerDown={(event) => event.stopPropagation()}
        style={{ '--audio-progress': `${percentage}%` } as React.CSSProperties}
        aria-label="试听进度"
      />
      <span className="audio-time">{formatPlaybackTime(maximum)}</span>
      {previewError && <span className="audio-preview-error" title={previewError}><CircleAlert size={14} /></span>}
    </div>
  )
}

export default App
