use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct MediaStream {
    index: i64,
    codec_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    codec_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codec_long_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avg_frame_rate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_rate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channels: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_layout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bit_rate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disposition: Option<HashMap<String, i64>>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct MediaFormat {
    filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bit_rate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<HashMap<String, String>>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ProbeResult {
    streams: Vec<MediaStream>,
    format: MediaFormat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MuxRequest {
    job_id: String,
    input_path: String,
    output_path: String,
    stream_indexes: Vec<i64>,
    duration_seconds: f64,
    trim_start_seconds: f64,
    trim_end_seconds: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPreview {
    path: String,
    duration_seconds: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MuxResult {
    output_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    percentage: f64,
}

#[derive(Default)]
struct AppState {
    children: Mutex<HashMap<String, CommandChild>>,
    cancelled: Mutex<HashSet<String>>,
    preview_dir: PathBuf,
}

fn validate_mp4(path: &str) -> Result<PathBuf, String> {
    let resolved = PathBuf::from(path);
    match resolved.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("mp4") => Ok(resolved),
        _ => Err("请选择 MP4 文件。".into()),
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_seconds(value: Option<&str>) -> Option<f64> {
    value.and_then(|raw| raw.trim().parse::<f64>().ok())
}

async fn probe(app: &AppHandle, input: &Path) -> Result<ProbeResult, String> {
    let input_str = input.to_string_lossy().to_string();
    let output = app
        .shell()
        .sidecar("binaries/ffprobe")
        .map_err(|error| format!("无法启动 FFprobe：{error}"))?
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            input_str.as_str(),
        ])
        .output()
        .await
        .map_err(|error| format!("无法启动 FFprobe：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            "无法读取该 MP4 文件。".into()
        } else {
            message.to_string()
        });
    }

    let mut result: ProbeResult =
        serde_json::from_slice(&output.stdout).map_err(|_| "无法解析媒体轨道信息。".to_string())?;
    result
        .streams
        .retain(|stream| stream.codec_type == "video" || stream.codec_type == "audio");
    Ok(result)
}

#[tauri::command]
async fn probe_media(app: AppHandle, path: String) -> Result<ProbeResult, String> {
    let input = validate_mp4(&path)?;
    probe(&app, &input).await
}

#[tauri::command]
async fn prepare_audio_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    stream_index: i64,
) -> Result<AudioPreview, String> {
    if stream_index < 0 {
        return Err("音频轨道无效。".into());
    }
    let input = validate_mp4(&path)?;
    let media = probe(&app, &input).await?;
    let meta = std::fs::metadata(&input).map_err(|error| error.to_string())?;
    let stream = media
        .streams
        .iter()
        .find(|stream| stream.index == stream_index && stream.codec_type == "audio")
        .ok_or_else(|| "找不到该音频轨道，请重新载入文件。".to_string())?;

    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis())
        .unwrap_or(0);
    let token = sha256_hex(&format!(
        "{}:{}:{}:{}",
        input.to_string_lossy(),
        meta.len(),
        mtime_ms,
        stream_index
    ));
    let token = &token[..32];
    let output_path = state.preview_dir.join(format!("{token}.m4a"));
    let duration = parse_seconds(stream.duration.as_deref())
        .or_else(|| parse_seconds(media.format.duration.as_deref()))
        .unwrap_or(0.0);

    if let Ok(existing) = std::fs::metadata(&output_path) {
        if existing.len() > 0 {
            return Ok(AudioPreview {
                path: output_path.to_string_lossy().into_owned(),
                duration_seconds: duration,
            });
        }
    }

    std::fs::create_dir_all(&state.preview_dir).map_err(|error| error.to_string())?;
    let can_copy = stream.codec_name.as_deref() == Some("aac");
    // 唯一 part 路径，避免同一 token 的并发请求写入同一临时文件。
    static PART_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = PART_SEQ.fetch_add(1, Ordering::Relaxed);
    let part_path = state
        .preview_dir
        .join(format!("{token}.{}.{seq}.part", std::process::id()));
    let input_str = input.to_string_lossy().to_string();
    let part_str = part_path.to_string_lossy().to_string();
    let map = format!("0:{stream_index}");

    let mut args: Vec<&str> = vec!["-y", "-i", input_str.as_str(), "-map", map.as_str(), "-vn"];
    if can_copy {
        args.extend(["-c:a", "copy"]);
    } else {
        args.extend(["-c:a", "aac", "-b:a", "192k"]);
    }
    args.extend(["-movflags", "+faststart", part_str.as_str()]);

    let output = app
        .shell()
        .sidecar("binaries/ffmpeg")
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?
        .args(args)
        .output()
        .await
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&part_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = tail_lines(stderr.lines().map(String::from), 3);
        return Err(if detail.is_empty() {
            "无法准备该音频轨道。".into()
        } else {
            detail
        });
    }

    std::fs::rename(&part_path, &output_path).map_err(|error| error.to_string())?;
    Ok(AudioPreview {
        path: output_path.to_string_lossy().into_owned(),
        duration_seconds: duration,
    })
}

#[tauri::command]
async fn start_mux(
    app: AppHandle,
    state: State<'_, AppState>,
    request: MuxRequest,
) -> Result<MuxResult, String> {
    let input = validate_mp4(&request.input_path)?;
    let output = validate_mp4(&request.output_path)?;
    if same_path(&input, &output) {
        return Err("输出文件不能覆盖源文件。".into());
    }
    if request.stream_indexes.is_empty() {
        return Err("请至少选择一条轨道。".into());
    }
    if state.children.lock().unwrap().contains_key(&request.job_id) {
        return Err("任务已经在运行。".into());
    }

    let media = probe(&app, &input).await?;
    let available: HashSet<i64> = media.streams.iter().map(|stream| stream.index).collect();
    if request
        .stream_indexes
        .iter()
        .any(|index| !available.contains(index))
    {
        return Err("轨道选择已失效，请重新载入文件。".into());
    }

    let source_duration = parse_seconds(media.format.duration.as_deref())
        .filter(|value| *value > 0.0)
        .unwrap_or(request.duration_seconds)
        .max(0.0);
    let trim_start = request.trim_start_seconds.max(0.0);
    let trim_end = request.trim_end_seconds.max(0.0);
    if source_duration > 0.0 && trim_start + trim_end >= source_duration {
        return Err("裁剪的时长已超过视频总长度，请调整前后删除的秒数。".into());
    }
    let keep_duration = if source_duration > 0.0 {
        source_duration - trim_start - trim_end
    } else {
        0.0
    };

    let input_str = input.to_string_lossy().to_string();
    let output_str = output.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["-y".into()];
    if trim_start > 0.0 {
        args.push("-ss".into());
        args.push(format!("{trim_start:.3}"));
    }
    args.push("-i".into());
    args.push(input_str);
    if trim_end > 0.0 && keep_duration > 0.0 {
        args.push("-t".into());
        args.push(format!("{keep_duration:.3}"));
    }
    for index in &request.stream_indexes {
        args.push("-map".into());
        args.push(format!("0:{index}"));
    }
    for flag in [
        "-map_metadata",
        "0",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:2",
        "-nostats",
    ] {
        args.push(flag.into());
    }
    args.push(output_str.clone());

    let progress_duration = if keep_duration > 0.0 {
        keep_duration
    } else {
        request.duration_seconds
    };

    let (mut rx, child) = app
        .shell()
        .sidecar("binaries/ffmpeg")
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?
        .args(args)
        .spawn()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    state
        .children
        .lock()
        .unwrap()
        .insert(request.job_id.clone(), child);

    let mut lines: VecDeque<String> = VecDeque::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.split(['\n', '\r']) {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some((key, value)) = line.split_once('=') {
                        if key.trim() == "out_time_us" && progress_duration > 0.0 {
                            if let Ok(micros) = value.trim().parse::<f64>() {
                                let percentage =
                                    ((micros / 1_000_000.0 / progress_duration) * 100.0).min(99.0);
                                let _ = app.emit(
                                    "mux:progress",
                                    Progress {
                                        job_id: request.job_id.clone(),
                                        percentage,
                                    },
                                );
                            }
                        }
                    }
                    lines.push_back(line.to_string());
                    if lines.len() > 200 {
                        lines.pop_front();
                    }
                }
            }
            CommandEvent::Error(message) => {
                lines.push_back(message);
                if lines.len() > 200 {
                    lines.pop_front();
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    state.children.lock().unwrap().remove(&request.job_id);
    let was_cancelled = state.cancelled.lock().unwrap().remove(&request.job_id);

    if exit_code == Some(0) {
        let _ = app.emit(
            "mux:progress",
            Progress {
                job_id: request.job_id.clone(),
                percentage: 100.0,
            },
        );
        return Ok(MuxResult {
            output_path: output_str,
        });
    }

    let _ = std::fs::remove_file(&output);
    if was_cancelled {
        return Err("任务已取消。".into());
    }
    let detail = tail_lines(lines.into_iter(), 4);
    Err(if detail.is_empty() {
        "合成失败，请检查轨道格式。".into()
    } else {
        detail
    })
}

#[tauri::command]
async fn cancel_mux(state: State<'_, AppState>, job_id: String) -> Result<bool, String> {
    let child = {
        let mut children = state.children.lock().unwrap();
        children.remove(&job_id)
    };
    match child {
        Some(child) => {
            state.cancelled.lock().unwrap().insert(job_id);
            let _ = child.kill();
            Ok(true)
        }
        None => Ok(false),
    }
}

fn tail_lines(lines: impl Iterator<Item = String>, count: usize) -> String {
    let mut kept: Vec<String> = lines.filter(|line| !line.trim().is_empty()).collect();
    let start = kept.len().saturating_sub(count);
    kept.drain(..start);
    kept.join("\n")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let preview_dir =
        std::env::temp_dir().join(format!("trackforge-previews-{}", std::process::id()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            preview_dir: preview_dir.clone(),
            ..Default::default()
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            prepare_audio_preview,
            start_mux,
            cancel_mux
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let mut children = state.children.lock().unwrap();
                for (_, child) in children.drain() {
                    let _ = child.kill();
                }
                let _ = std::fs::remove_dir_all(&state.preview_dir);
            }
        });
}
