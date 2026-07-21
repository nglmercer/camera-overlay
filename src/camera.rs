use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use nokhwa::{
    pixel_format::RgbFormat,
    utils::{
        ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
        Resolution,
    },
    Camera,
};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::config::ResolutionPreference;

static RUNNING: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));
static THREAD_HANDLE: Lazy<Arc<Mutex<Option<thread::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
/// Guards against concurrent `/start` calls: `RUNNING` is only set after a blocking
/// device probe, so without this two parallel starts both pass the running check and
/// spawn duplicate capture threads (only one thread handle is kept — the other leaks).
static STARTING: AtomicBool = AtomicBool::new(false);

/// Clears [`STARTING`] when the start attempt ends on any path (including early
/// returns), so a failed start never blocks future attempts.
struct StartingGuard;

impl Drop for StartingGuard {
    fn drop(&mut self) {
        STARTING.store(false, Ordering::SeqCst);
    }
}

/// JPEG frame shared across subscribers. The MJPEG multipart body is built **once**
/// when the frame is captured and shared as `Bytes` (refcounted), so N stream
/// clients cost zero extra per-frame allocations. Previously every subscriber
/// allocated a fresh frame-sized buffer per frame; that churn is freed into glibc
/// per-thread arenas but rarely returned to the OS, so RSS climbed monotonically
/// and looked exactly like a memory leak.
///
/// Cost: the broadcast ring retains one extra bounded copy per frame.
#[derive(Clone)]
pub struct CameraFrame {
    pub jpeg_data: Arc<Vec<u8>>,
    part: bytes::Bytes,
}

impl CameraFrame {
    pub fn new(jpeg_data: Vec<u8>) -> Self {
        let part = Self::build_mjpeg_part(&jpeg_data);
        Self {
            jpeg_data: Arc::new(jpeg_data),
            part,
        }
    }

    pub fn mjpeg_part(&self) -> bytes::Bytes {
        self.part.clone()
    }

    fn build_mjpeg_part(jpeg_data: &[u8]) -> bytes::Bytes {
        let header = b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ";
        let header_end = b"\r\n\r\n";
        let total = header.len() + 10 + header_end.len() + jpeg_data.len() + 2;
        let mut part = Vec::with_capacity(total);
        part.extend_from_slice(header);
        let mut n = jpeg_data.len();
        let mut buf = [0u8; 10];
        let mut pos = 10;
        if n == 0 {
            pos -= 1;
            buf[pos] = b'0';
        } else {
            while n > 0 {
                pos -= 1;
                buf[pos] = b'0' + (n % 10) as u8;
                n /= 10;
            }
        }
        part.extend_from_slice(&buf[pos..]);
        part.extend_from_slice(header_end);
        part.extend_from_slice(jpeg_data);
        part.extend_from_slice(b"\r\n");
        bytes::Bytes::from(part)
    }
}

pub struct CameraController {
    latest: Arc<Mutex<Option<CameraFrame>>>,
}

#[derive(Clone)]
pub struct CameraConfigSnapshot {
    pub camera_index: u32,
    pub resolution: ResolutionPreference,
    pub target_fps: u32,
}

fn select_best_format(formats: &[CameraFormat], preference: &ResolutionPreference) -> CameraFormat {
    let mjpeg: Vec<&CameraFormat> = formats
        .iter()
        .filter(|f| matches!(f.format(), FrameFormat::MJPEG))
        .collect();

    let candidates: Vec<&CameraFormat> = if mjpeg.is_empty() {
        formats.iter().collect()
    } else {
        mjpeg
    };

    let mut sorted = candidates;
    match preference {
        ResolutionPreference::Highest => sorted.sort_by(|a, b| {
            let pa = (a.width() as u64) * (a.height() as u64);
            let pb = (b.width() as u64) * (b.height() as u64);
            pb.cmp(&pa)
                .then_with(|| b.frame_rate().cmp(&a.frame_rate()))
        }),
        ResolutionPreference::Lowest => sorted.sort_by(|a, b| {
            let pa = (a.width() as u64) * (a.height() as u64);
            let pb = (b.width() as u64) * (b.height() as u64);
            pa.cmp(&pb)
                .then_with(|| b.frame_rate().cmp(&a.frame_rate()))
        }),
        ResolutionPreference::Medium => {
            let target = 1280u64 * 720u64;
            sorted.sort_by(|a, b| {
                let pa = (a.width() as u64) * (a.height() as u64);
                let pb = (b.width() as u64) * (b.height() as u64);
                let da = (pa as i64 - target as i64).abs();
                let db = (pb as i64 - target as i64).abs();
                da.cmp(&db)
                    .then_with(|| b.frame_rate().cmp(&a.frame_rate()))
            });
        }
    }

    sorted
        .first()
        .copied()
        .copied()
        .unwrap_or_else(|| CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, 30))
}

/// Encode an RGB buffer to JPEG.
///
/// `JpegEncoder::encode` accepts a raw `&[u8]` and internally wraps it in a
/// *borrowed* image view, so we feed it `rgb` directly. The previous
/// implementation did `ImageBuffer::from_raw(width, height, rgb.to_vec())`,
/// which copied the entire (often multi-MB) frame into an owned buffer on every
/// single frame — a full memcpy + allocation that added per-frame latency and
/// allocation churn (visible as RSS growth). `&mut Vec<u8>` is already `Write`,
/// so the `Cursor` wrapper was also unnecessary.
fn encode_jpeg(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    // Validate dimensions up front. `JpegEncoder::encode` asserts (panics) on a
    // buffer/size mismatch; the previous `ImageBuffer::from_raw` path returned
    // `Err` instead, so we preserve that contract here.
    let expected = (width as u64)
        .checked_mul(height as u64)
        .and_then(|n| n.checked_mul(3))
        .ok_or("Image dimensions overflow")?;
    if rgb.len() as u64 != expected {
        return Err(format!(
            "Invalid buffer length: expected {expected} got {} for {width}x{height} image",
            rgb.len()
        ));
    }

    let mut buf = Vec::with_capacity(expected as usize / 4);
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .encode(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG encode error: {e}"))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
    use tokio_stream::wrappers::BroadcastStream;
    use tokio_stream::StreamExt;

    #[test]
    fn test_encode_jpeg_valid() {
        let rgb = vec![255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0];
        let result = encode_jpeg(&rgb, 2, 2, 80);
        assert!(result.is_ok());
        let jpeg = result.unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9]);
    }

    #[test]
    fn test_encode_jpeg_wrong_size() {
        let rgb = vec![255, 0, 0, 255, 0, 0];
        let result = encode_jpeg(&rgb, 2, 2, 80);
        assert!(result.is_err());
    }

    #[test]
    fn test_select_best_format_highest() {
        let formats = vec![
            CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, 30),
            CameraFormat::new(Resolution::new(1920, 1080), FrameFormat::MJPEG, 30),
            CameraFormat::new(Resolution::new(1280, 720), FrameFormat::MJPEG, 60),
        ];
        let best = select_best_format(&formats, &ResolutionPreference::Highest);
        assert_eq!(best.width(), 1920);
        assert_eq!(best.height(), 1080);
    }

    #[test]
    fn test_select_best_format_lowest() {
        let formats = vec![
            CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, 30),
            CameraFormat::new(Resolution::new(1920, 1080), FrameFormat::MJPEG, 30),
            CameraFormat::new(Resolution::new(1280, 720), FrameFormat::MJPEG, 60),
        ];
        let best = select_best_format(&formats, &ResolutionPreference::Lowest);
        assert_eq!(best.width(), 640);
        assert_eq!(best.height(), 480);
    }

    #[test]
    fn test_select_best_format_medium() {
        let formats = vec![
            CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, 30),
            CameraFormat::new(Resolution::new(1920, 1080), FrameFormat::MJPEG, 30),
            CameraFormat::new(Resolution::new(1280, 720), FrameFormat::MJPEG, 60),
        ];
        let best = select_best_format(&formats, &ResolutionPreference::Medium);
        assert_eq!(best.width(), 1280);
        assert_eq!(best.height(), 720);
    }

    #[test]
    fn test_select_best_format_prefers_mjpeg() {
        let formats = vec![
            CameraFormat::new(Resolution::new(1920, 1080), FrameFormat::YUYV, 30),
            CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, 30),
        ];
        let best = select_best_format(&formats, &ResolutionPreference::Highest);
        assert!(matches!(best.format(), FrameFormat::MJPEG));
    }

    #[test]
    fn test_select_best_format_empty() {
        let formats: Vec<CameraFormat> = vec![];
        let best = select_best_format(&formats, &ResolutionPreference::Medium);
        assert_eq!(best.width(), 640);
        assert_eq!(best.height(), 480);
    }

    #[test]
    fn test_camera_frame_new_builds_mjpeg_part() {
        let frame = CameraFrame::new(vec![0xFF, 0xD8, 0xFF, 0xD9]);
        let expected =
            b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xFF\xD8\xFF\xD9\r\n";
        assert_eq!(&frame.mjpeg_part()[..], expected);
    }

    #[test]
    fn test_camera_frame_clone_is_cheap() {
        let frame = CameraFrame::new(vec![0xFF, 0xD8, 0xFF, 0xD9]);
        let clone = frame.clone();
        assert!(Arc::ptr_eq(&frame.jpeg_data, &clone.jpeg_data));
        assert_eq!(frame.mjpeg_part(), clone.mjpeg_part());
    }

    #[test]
    fn test_camera_frame_from_raw_rgb() {
        let rgb = vec![255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0];
        let jpeg = encode_jpeg(&rgb, 2, 2, 80).unwrap();
        let frame = CameraFrame::new(jpeg);
        assert_eq!(&frame.jpeg_data[..2], &[0xFF, 0xD8]);
        assert_eq!(&frame.jpeg_data[frame.jpeg_data.len() - 2..], &[0xFF, 0xD9]);
    }

    #[test]
    fn test_broadcast_pipeline_no_memory_spike() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let start_rss = get_rss_kb();

            let (frame_tx, _keepalive) = broadcast::channel::<CameraFrame>(8);
            let producer_tx = frame_tx.clone();

            let sub1 = frame_tx.subscribe();
            let sub2 = frame_tx.subscribe();
            let sub3 = frame_tx.subscribe();

            let h1 = tokio::spawn(consume_stream(sub1, 500));
            let h2 = tokio::spawn(consume_stream(sub2, 500));
            let h3 = tokio::spawn(consume_stream(sub3, 500));

            let producer = tokio::spawn(async move {
                let jpeg = vec![0xFFu8; 100_000];
                for _ in 0..500 {
                    let frame = CameraFrame::new(jpeg.clone());
                    let _ = producer_tx.send(frame);
                }
            });

            let _ = producer.await;
            let _ = h1.await;
            let _ = h2.await;
            let _ = h3.await;

            drop(frame_tx);

            let end_rss = get_rss_kb();
            match (start_rss, end_rss) {
                (Some(start), Some(end)) => {
                    let growth_kb = end.saturating_sub(start);
                    assert!(
                        growth_kb < 50_000,
                        "RSS grew by {growth_kb} kb — likely a leak (start={start}, end={end})"
                    );
                }
                _ => {} // /proc not available (non-Linux), skip assertion
            }
        });
    }

    #[test]
    fn test_clone_does_not_deep_copy() {
        let jpeg = vec![0xFFu8; 1_000_000];
        let frame = CameraFrame::new(jpeg);
        let mut clones: Vec<CameraFrame> = Vec::new();
        for _ in 0..100 {
            clones.push(frame.clone());
        }
        for c in &clones {
            assert!(Arc::ptr_eq(&frame.jpeg_data, &c.jpeg_data));
        }
        let final_size = std::mem::size_of::<CameraFrame>() * 101;
        assert!(
            final_size < 10_000,
            "CameraFrame size exploded: {final_size} bytes for 101 references"
        );
    }

    /// Lagged subscribers must skip frames — never emit empty multipart parts.
    #[test]
    fn test_lagged_subscriber_skips_without_empty_parts() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (tx, rx) = broadcast::channel::<CameraFrame>(2);

            // Flood the channel before the consumer reads.
            for i in 0..50 {
                let _ = tx.send(CameraFrame::new(vec![i as u8; 64]));
            }

            let mut stream = BroadcastStream::new(rx);
            let mut parts: Vec<Bytes> = Vec::new();
            let mut lagged = 0u64;

            // Drain what we can with timeouts so an idle stream cannot hang the suite.
            for _ in 0..20 {
                match tokio::time::timeout(Duration::from_millis(50), stream.next()).await {
                    Ok(Some(Ok(frame))) => {
                        let part = frame.mjpeg_part();
                        assert!(!part.is_empty(), "mjpeg part must never be empty");
                        assert!(
                            part.windows(7).any(|w| w == b"--frame"),
                            "part must be a valid mjpeg boundary chunk"
                        );
                        parts.push(part);
                    }
                    Ok(Some(Err(BroadcastStreamRecvError::Lagged(n)))) => {
                        lagged += n;
                        // Do not push empty bytes — same policy as the HTTP handler.
                    }
                    Ok(None) | Err(_) => break,
                }
            }

            // Producer still alive: send a fresh frame after lag.
            let _ = tx.send(CameraFrame::new(vec![0xFF, 0xD8, 0xFF, 0xD9]));
            for _ in 0..10 {
                match tokio::time::timeout(Duration::from_millis(100), stream.next()).await {
                    Ok(Some(Ok(frame))) => {
                        let part = frame.mjpeg_part();
                        assert!(!part.is_empty());
                        parts.push(part);
                        break;
                    }
                    Ok(Some(Err(BroadcastStreamRecvError::Lagged(_)))) => continue,
                    _ => break,
                }
            }

            assert!(
                lagged > 0 || !parts.is_empty(),
                "expected lag and/or recoverable frames"
            );
            assert!(
                parts.iter().all(|p| !p.is_empty()),
                "no empty mjpeg parts allowed"
            );
        });
    }

    #[test]
    fn test_is_running_false_by_default() {
        // Other tests may leave RUNNING true if they open a camera; only assert API exists.
        let c = CameraController::new();
        let _ = c.is_running();
    }
}

#[cfg(test)]
async fn consume_stream(
    rx: tokio::sync::broadcast::Receiver<CameraFrame>,
    expected: usize,
) -> usize {
    use tokio_stream::wrappers::BroadcastStream;
    use tokio_stream::StreamExt;
    let mut stream = BroadcastStream::new(rx);
    let mut count = 0;
    while let Some(Ok(frame)) = stream.next().await {
        let _ = frame.mjpeg_part();
        count += 1;
        if count >= expected {
            break;
        }
    }
    count
}

#[cfg(test)]
fn get_rss_kb() -> Option<usize> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if line.starts_with("VmRSS:") {
            let num = line.split_whitespace().nth(1)?;
            return num.parse().ok();
        }
    }
    None
}

impl Default for CameraController {
    fn default() -> Self {
        Self::new()
    }
}

impl CameraController {
    pub fn new() -> Self {
        Self {
            latest: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_running(&self) -> bool {
        RUNNING.load(Ordering::SeqCst)
    }

    pub fn list_cameras(&self) -> Vec<serde_json::Value> {
        let devices = match nokhwa::query(ApiBackend::Auto) {
            Ok(d) => d,
            Err(_) => return vec![],
        };

        devices
            .into_iter()
            .enumerate()
            .map(|(i, d)| {
                serde_json::json!({
                    "index": i,
                    "name": d.human_name(),
                })
            })
            .collect()
    }

    /// Start capture. Returns `Ok(())` once the device is open and streaming, or an error
    /// if the camera cannot be opened. Already-running is treated as success.
    pub fn start(
        &self,
        frame_tx: broadcast::Sender<CameraFrame>,
        config: CameraConfigSnapshot,
    ) -> Result<(), String> {
        if RUNNING.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Serialize concurrent starts: `RUNNING` is only set after the blocking
        // device probe below, so without this guard two parallel /start requests
        // both pass the check above and spawn duplicate capture threads.
        if STARTING.swap(true, Ordering::SeqCst) {
            return Err("Camera start already in progress".to_string());
        }
        let _starting = StartingGuard;

        // Ensure any previous thread has fully exited before starting a new one.
        self.join_camera_thread();

        let idx = config.camera_index;
        let mut temp = Camera::new(
            CameraIndex::Index(idx),
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
        )
        .map_err(|e| format!("Failed to open camera {idx}: {e}"))?;

        let formats = temp
            .compatible_camera_formats()
            .map_err(|e| format!("Failed to get formats for camera {idx}: {e}"))?;

        let best = select_best_format(&formats, &config.resolution);
        let target_fps = config.target_fps.clamp(1, 120);
        drop(temp);

        let latest = Arc::clone(&self.latest);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        RUNNING.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Exact(best));

            let mut camera = match Camera::new(CameraIndex::Index(idx), requested) {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("Failed to create camera {idx}: {e}");
                    log::error!("{msg}");
                    RUNNING.store(false, Ordering::SeqCst);
                    let _ = ready_tx.send(Err(msg));
                    return;
                }
            };

            if let Err(e) = camera.open_stream() {
                let msg = format!("Failed to open stream on camera {idx}: {e}");
                log::error!("{msg}");
                RUNNING.store(false, Ordering::SeqCst);
                let _ = ready_tx.send(Err(msg));
                return;
            }

            log::info!(
                "Camera {idx} stream started ({}x{} @ target {target_fps} fps)",
                best.width(),
                best.height()
            );
            let _ = ready_tx.send(Ok(()));

            let frame_interval = Duration::from_micros(1_000_000 / target_fps as u64);
            let mut last = Instant::now();
            // Give up after ~5s of consecutive failures at the target fps.
            let max_consecutive_errors = target_fps.saturating_mul(5).max(30);
            let mut consecutive_errors = 0u32;

            while RUNNING.load(Ordering::SeqCst) {
                let elapsed = last.elapsed();
                if elapsed < frame_interval {
                    thread::sleep(frame_interval - elapsed);
                }
                // Update the pacer *before* capture so error `continue`s still
                // sleep — otherwise persistent failures spin at 100% CPU.
                last = Instant::now();

                let frame = match camera.frame() {
                    Ok(f) => f,
                    Err(e) => {
                        consecutive_errors += 1;
                        if consecutive_errors == 1 || consecutive_errors.is_multiple_of(target_fps)
                        {
                            log::warn!(
                                "Frame capture failed ({consecutive_errors} consecutive): {e}"
                            );
                        }
                        if consecutive_errors >= max_consecutive_errors {
                            log::error!(
                                "Camera {idx} failed {consecutive_errors} times in a row, stopping capture"
                            );
                            RUNNING.store(false, Ordering::SeqCst);
                            break;
                        }
                        continue;
                    }
                };
                consecutive_errors = 0;

                let camera_frame = if matches!(frame.source_frame_format(), FrameFormat::MJPEG) {
                    CameraFrame::new(frame.buffer().to_vec())
                } else {
                    let decoded = match frame.decode_image::<RgbFormat>() {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    let width = decoded.width();
                    let height = decoded.height();
                    let rgb = decoded.into_raw();
                    match encode_jpeg(&rgb, width, height, 75) {
                        Ok(jpeg) => CameraFrame::new(jpeg),
                        Err(e) => {
                            log::warn!("Encode failed: {e}");
                            continue;
                        }
                    }
                };

                *latest.lock() = Some(camera_frame.clone());
                // Lagged receivers are fine — broadcast drops old frames for them.
                let _ = frame_tx.send(camera_frame);
            }

            let _ = camera.stop_stream();
            log::info!("Camera stream stopped");
        });

        *THREAD_HANDLE.lock() = Some(handle);

        match ready_rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                self.join_camera_thread();
                Err(e)
            }
            Err(_) => {
                RUNNING.store(false, Ordering::SeqCst);
                self.join_camera_thread();
                Err(format!(
                    "Timed out waiting for camera {idx} to start streaming"
                ))
            }
        }
    }

    pub fn stop(&self) {
        RUNNING.store(false, Ordering::SeqCst);
        self.join_camera_thread();
        *self.latest.lock() = None;
    }

    fn join_camera_thread(&self) {
        let handle = THREAD_HANDLE.lock().take();
        if let Some(h) = handle {
            let _ = h.join();
        }
    }

    pub fn latest_frame(&self) -> Option<CameraFrame> {
        self.latest.lock().clone()
    }
}
