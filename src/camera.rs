use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageBuffer, Rgb};
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
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use crate::config::ResolutionPreference;

static RUNNING: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

#[derive(Clone)]
pub struct CameraFrame {
    pub jpeg_data: Vec<u8>,
}

impl CameraFrame {
    pub fn to_mjpeg_part(&self) -> bytes::Bytes {
        let mut part = Vec::new();
        part.extend_from_slice(b"--frame\r\n");
        part.extend_from_slice(b"Content-Type: image/jpeg\r\n");
        part.extend_from_slice(
            format!("Content-Length: {}\r\n\r\n", self.jpeg_data.len()).as_bytes(),
        );
        part.extend_from_slice(&self.jpeg_data);
        part.extend_from_slice(b"\r\n");
        bytes::Bytes::from(part)
    }
}

pub struct CameraController {
    latest: Arc<Mutex<Option<CameraFrame>>>,
}

#[derive(Clone)]
pub struct CameraConfigSnapshot {
    pub resolution: ResolutionPreference,
    pub mirror_h: bool,
    pub mirror_v: bool,
}

fn select_best_format(
    formats: &[CameraFormat],
    preference: &ResolutionPreference,
) -> CameraFormat {
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
        .map(|&&f| f)
        .unwrap_or_else(|| CameraFormat::new(Resolution::new(640, 480), FrameFormat::MJPEG, 30))
}

fn encode_jpeg(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    let image = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, rgb.to_vec())
        .ok_or("Failed to create image buffer")?;

    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
    encoder
        .encode(&image, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG encode error: {e}"))?;
    Ok(buf)
}

fn apply_mirror(rgb: &mut [u8], width: u32, height: u32, h: bool, v: bool) {
    let w = width as usize;
    let hgt = height as usize;
    let row = w * 3;

    if h {
        for y in 0..hgt {
            let s = y * row;
            for x in 0..w / 2 {
                let l = x * 3;
                let r = (w - 1 - x) * 3;
                rgb.swap(s + l, s + r);
                rgb.swap(s + l + 1, s + r + 1);
                rgb.swap(s + l + 2, s + r + 2);
            }
        }
    }

    if v {
        let mut tmp = vec![0u8; row];
        for y in 0..hgt / 2 {
            let top = y * row;
            let bot = (hgt - 1 - y) * row;
            tmp.copy_from_slice(&rgb[top..top + row]);
            rgb.copy_within(bot..bot + row, top);
            rgb[bot..bot + row].copy_from_slice(&tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_mirror_horizontal() {
        // 2x2 RGB image: R G / B W
        let mut rgb = vec![
            255, 0, 0,   0, 255, 0,
            0, 0, 255,   255, 255, 255,
        ];
        apply_mirror(&mut rgb, 2, 2, true, false);
        // After horizontal mirror: G R / W B
        assert_eq!(rgb, vec![
            0, 255, 0,   255, 0, 0,
            255, 255, 255,   0, 0, 255,
        ]);
    }

    #[test]
    fn test_apply_mirror_vertical() {
        // 2x2 RGB image: R G / B W
        let mut rgb = vec![
            255, 0, 0,   0, 255, 0,
            0, 0, 255,   255, 255, 255,
        ];
        apply_mirror(&mut rgb, 2, 2, false, true);
        // After vertical mirror: B W / R G
        assert_eq!(rgb, vec![
            0, 0, 255,   255, 255, 255,
            255, 0, 0,   0, 255, 0,
        ]);
    }

    #[test]
    fn test_apply_mirror_both() {
        // 2x2 RGB image
        let mut rgb = vec![
            255, 0, 0,   0, 255, 0,
            0, 0, 255,   255, 255, 255,
        ];
        apply_mirror(&mut rgb, 2, 2, true, true);
        // After both mirrors: W B / G R
        assert_eq!(rgb, vec![
            255, 255, 255,   0, 0, 255,
            0, 255, 0,   255, 0, 0,
        ]);
    }

    #[test]
    fn test_apply_mirror_no_op() {
        let original = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let mut rgb = original.clone();
        apply_mirror(&mut rgb, 2, 2, false, false);
        assert_eq!(rgb, original);
    }

    #[test]
    fn test_apply_mirror_single_pixel() {
        let mut rgb = vec![100, 150, 200];
        apply_mirror(&mut rgb, 1, 1, true, true);
        assert_eq!(rgb, vec![100, 150, 200]);
    }

    #[test]
    fn test_encode_jpeg_valid() {
        // 2x2 red image
        let rgb = vec![255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0];
        let result = encode_jpeg(&rgb, 2, 2, 80);
        assert!(result.is_ok());
        let jpeg = result.unwrap();
        // JPEG starts with FFD8 and ends with FFD9
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9]);
    }

    #[test]
    fn test_encode_jpeg_wrong_size() {
        // 6 bytes but claiming 2x2 (needs 12)
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
        // Should pick MJPEG even though it's lower resolution
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
    fn test_camera_frame_to_mjpeg_part() {
        let frame = CameraFrame {
            jpeg_data: vec![0xFF, 0xD8, 0xFF, 0xD9],
        };
        let part = frame.to_mjpeg_part();
        let expected = b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xFF\xD8\xFF\xD9\r\n";
        assert_eq!(&part[..], expected);
    }
}

impl CameraController {
    pub fn new() -> Self {
        Self {
            latest: Arc::new(Mutex::new(None)),
        }
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

    pub fn start(&self, frame_tx: broadcast::Sender<CameraFrame>, config: CameraConfigSnapshot) {
        if RUNNING.load(Ordering::SeqCst) {
            return;
        }

        let idx = 0u32;
        let mut temp = match Camera::new(
            CameraIndex::Index(idx),
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
        ) {
            Ok(c) => c,
            Err(e) => {
                log::error!("Failed to open camera: {e}");
                return;
            }
        };

        let formats = match temp.compatible_camera_formats() {
            Ok(f) => f,
            Err(e) => {
                log::error!("Failed to get formats: {e}");
                return;
            }
        };

        let best = select_best_format(&formats, &config.resolution);
        let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Exact(best));
        let mirror_h = config.mirror_h;
        let mirror_v = config.mirror_v;
        drop(temp);

        let latest = Arc::clone(&self.latest);
        RUNNING.store(true, Ordering::SeqCst);

        thread::spawn(move || {
            let mut camera = match Camera::new(CameraIndex::Index(idx), requested) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Failed to create camera: {e}");
                    RUNNING.store(false, Ordering::SeqCst);
                    return;
                }
            };

            if let Err(e) = camera.open_stream() {
                log::error!("Failed to open stream: {e}");
                RUNNING.store(false, Ordering::SeqCst);
                return;
            }

            log::info!("Camera stream started");
            let target = Duration::from_millis(33);
            let mut last = Instant::now();

            while RUNNING.load(Ordering::SeqCst) {
                if last.elapsed() < target {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }

                let frame = match camera.frame() {
                    Ok(f) => f,
                    Err(_) => continue,
                };

                let decoded = match frame.decode_image::<RgbFormat>() {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                let width = decoded.width();
                let height = decoded.height();
                let mut rgb = decoded.into_raw();

                if mirror_h || mirror_v {
                    apply_mirror(&mut rgb, width, height, mirror_h, mirror_v);
                }

                match encode_jpeg(&rgb, width, height, 75) {
                    Ok(jpeg) => {
                        let frame = CameraFrame { jpeg_data: jpeg };
                        *latest.lock() = Some(frame.clone());
                        let _ = frame_tx.send(frame);
                    }
                    Err(e) => log::warn!("Encode failed: {e}"),
                }

                last = Instant::now();
            }

            let _ = camera.stop_stream();
            log::info!("Camera stream stopped");
        });
    }

    pub fn stop(&self) {
        RUNNING.store(false, Ordering::SeqCst);
        *self.latest.lock() = None;
    }

    pub fn latest_frame(&self) -> Option<CameraFrame> {
        self.latest.lock().clone()
    }
}
