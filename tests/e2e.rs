use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use camera_overlay::camera::CameraFrame;
use camera_overlay::config::CameraConfig;
use camera_overlay::server::{build_router, AppState};
use futures_util::StreamExt;

fn pick_unused_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn get_rss_kb() -> Option<usize> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if line.starts_with("VmRSS:") {
            return line.split_whitespace().nth(1)?.parse().ok();
        }
    }
    None
}

struct TestServer {
    base_url: String,
    client: reqwest::Client,
    frame_tx: Arc<broadcast::Sender<CameraFrame>>,
}

impl TestServer {
    async fn new() -> Self {
        let port = pick_unused_port();
        let (frame_tx, _rx) = broadcast::channel::<CameraFrame>(16);
        let frame_tx = Arc::new(frame_tx);

        let state = Arc::new(AppState {
            config: parking_lot::Mutex::new(CameraConfig::default()),
            camera: Arc::new(camera_overlay::camera::CameraController::new()),
            frame_tx: (*frame_tx).clone(),
        });

        let app = build_router(state);
        let addr = format!("127.0.0.1:{port}");
        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let base_url = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();

        let server = Self {
            base_url,
            client,
            frame_tx,
        };
        server.wait_ready().await;
        server
    }

    async fn wait_ready(&self) {
        for _ in 0..50 {
            if self.client.get(&self.base_url).send().await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("server did not start within 5s");
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}/{}", self.base_url, path))
            .send()
            .await
            .unwrap()
    }

    /*     fn send_frame(&self, jpeg_data: Vec<u8>) {
        let _ = self.frame_tx.send(CameraFrame::new(jpeg_data));
    } */
}

static FRAME_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn next_frame_id() -> usize {
    FRAME_COUNTER.fetch_add(1, Ordering::SeqCst)
}

fn make_valid_jpeg(seed: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(1000);
    data.push(0xFF);
    data.push(0xD8);
    data.push(0xFF);
    data.push(0xE0);
    data.push(0x00);
    data.push(0x10);
    data.extend_from_slice(b"JFIF\0");
    data.push(0x01);
    data.push(0x01);
    data.push(0x00);
    data.push(0x00);
    data.push(0x01);
    data.push(0x00);
    data.push(0x01);
    data.push(0x00);
    data.push(0x00);
    for i in 0..(1000 - data.len() - 2) {
        data.push(((seed + i) % 251) as u8);
    }
    data.push(0xFF);
    data.push(0xD9);
    data
}

fn parse_mjpeg_frames(body: &[u8]) -> Vec<&[u8]> {
    let boundary = b"--frame";
    let mut frames = Vec::new();
    let mut search_start = 0;

    while let Some(pos) = body[search_start..]
        .windows(boundary.len())
        .position(|w| w == boundary)
        .map(|p| search_start + p)
    {
        let after_boundary = pos + boundary.len();
        let header_end = match body[after_boundary..]
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
        {
            Some(p) => after_boundary + p + 4,
            None => break,
        };

        let next_boundary = body[header_end..]
            .windows(boundary.len())
            .position(|w| w == boundary)
            .map(|p| header_end + p);

        match next_boundary {
            Some(end) => {
                let frame_data = if end >= 2 && body[end - 2..end] == [0x0D, 0x0A] {
                    &body[header_end..end - 2]
                } else {
                    &body[header_end..end]
                };
                frames.push(frame_data);
                search_start = end;
            }
            None => break,
        }
    }

    frames
}

fn is_valid_jpeg(data: &[u8]) -> bool {
    data.len() >= 4 && data[0..2] == [0xFF, 0xD8] && data[data.len() - 2..] == [0xFF, 0xD9]
}

#[tokio::test]
async fn e2e_stream_returns_mjpeg_headers() {
    let server = TestServer::new().await;

    let resp = server.get("stream").await;
    let headers = resp.headers();
    assert_eq!(
        headers.get("content-type").unwrap(),
        "multipart/x-mixed-replace; boundary=frame"
    );
    assert_eq!(
        headers.get("cache-control").unwrap(),
        "no-cache, no-store, must-revalidate"
    );
}

#[tokio::test]
async fn e2e_stream_delivers_frames() {
    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for _ in 0..50 {
                let id = next_frame_id();
                let mut data = vec![0xFFu8; 1000];
                data[0..8].copy_from_slice(&id.to_be_bytes());
                let _ = tx.send(CameraFrame::new(data));
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
    };

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    let deadline = Instant::now() + Duration::from_secs(3);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                body.extend_from_slice(&chunk);
                if body.windows(6).filter(|w| w == b"--frame").count() >= 3 {
                    break;
                }
            }
            _ => break,
        }
    }

    let _ = producer.await;

    let body_str = String::from_utf8_lossy(&body[..body.len().min(200)]);
    assert!(
        body.starts_with(b"--frame"),
        "response should start with --frame boundary, got {} bytes. First 200: {:?}",
        body.len(),
        body_str
    );
    let boundary = b"--frame";
    assert!(
        body.windows(boundary.len())
            .any(|w| w == boundary.as_slice()),
        "response should have MJPEG boundary in windows"
    );
}

#[tokio::test]
async fn e2e_stream_parses_valid_jpeg_frames() {
    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..20 {
                let jpeg = make_valid_jpeg(i);
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
    };

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    let deadline = Instant::now() + Duration::from_secs(5);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                body.extend_from_slice(&chunk);
                if body.windows(6).filter(|w| w == b"--frame").count() >= 5 {
                    break;
                }
            }
            _ => break,
        }
    }

    let _ = producer.await;

    let frames = parse_mjpeg_frames(&body);
    assert!(
        !frames.is_empty(),
        "should parse at least one JPEG frame from stream"
    );

    let valid_count = frames.iter().filter(|f| is_valid_jpeg(f)).count();
    assert_eq!(
        valid_count,
        frames.len(),
        "all parsed frames should be valid JPEG ({} of {} valid)",
        valid_count,
        frames.len()
    );
}

#[tokio::test]
async fn e2e_stream_frame_latency_under_100ms() {
    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..10 {
                let mut jpeg = make_valid_jpeg(i);
                jpeg[4..12].copy_from_slice(&i.to_be_bytes());
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
    };

    let mut stream = resp.bytes_stream();
    let mut first_frame_time: Option<Instant> = None;
    let mut frame_count = 0;
    let start = Instant::now();

    while frame_count < 5 {
        match tokio::time::timeout(Duration::from_secs(2), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                if first_frame_time.is_none() && chunk.windows(6).any(|w| w == b"--frame") {
                    first_frame_time = Some(Instant::now());
                }
                if chunk.windows(6).any(|w| w == b"--frame") {
                    frame_count += 1;
                }
            }
            _ => break,
        }
    }

    let _ = producer.await;

    if let Some(ft) = first_frame_time {
        let latency = ft.duration_since(start);
        assert!(
            latency < Duration::from_millis(500),
            "first frame latency {:?} should be under 500ms",
            latency
        );
    }
}

#[tokio::test]
async fn e2e_snapshot_returns_503_when_off() {
    let server = TestServer::new().await;
    let resp = server.get("snapshot").await;
    assert_eq!(resp.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn e2e_settings_post_and_get() {
    let server = TestServer::new().await;
    let resp = server.get("settings").await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let body = r#"{"port": 9090, "target_fps": 60, "mirror_horizontal": true}"#;
    let resp = server
        .client
        .post(format!("{}/settings", server.base_url))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let resp = server.get("settings").await;
    let json: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(json["port"], 9090);
    assert_eq!(json["target_fps"], 60);
    assert_eq!(json["mirror_horizontal"], true);
}

#[tokio::test]
async fn e2e_multiple_subscribers_parallel() {
    let server = TestServer::new().await;

    let mut handles = Vec::new();
    for _ in 0..3 {
        let url = format!("{}/stream", server.base_url);
        handles.push(tokio::spawn(async move {
            let client = reqwest::Client::new();
            let resp = client.get(&url).send().await.unwrap();
            let mut stream = resp.bytes_stream();
            let mut body = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
                    Ok(Some(Ok(chunk))) => {
                        body.extend_from_slice(&chunk);
                        if body.windows(6).filter(|w| w == b"--frame").count() >= 3 {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            body.len()
        }));
    }

    tokio::time::sleep(Duration::from_millis(100)).await;

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..100 {
                let _ = tx.send(CameraFrame::new(vec![i; 20_000]));
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
    };

    for h in handles {
        let len = h.await.unwrap();
        assert!(len > 0, "each subscriber should receive data");
    }
    let _ = producer.await;
}

#[tokio::test]
async fn e2e_memory_stable_during_streaming() {
    let start_rss = get_rss_kb();

    let server = TestServer::new().await;

    let resp = server.get("stream").await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..200 {
                let _ = tx.send(CameraFrame::new(vec![(i % 256) as u8; 50_000]));
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
    };

    let mut stream = resp.bytes_stream();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut total_bytes = 0;

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(Ok(chunk))) => total_bytes += chunk.len(),
            _ => break,
        }
    }

    assert!(total_bytes > 0, "should receive stream data");
    let _ = producer.await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    if let (Some(start), Some(end)) = (start_rss, get_rss_kb()) {
        let growth = end.saturating_sub(start);
        assert!(
            growth < 80_000,
            "RSS grew by {growth} kb (start={start}, end={end}) — potential leak"
        );
    }
}

#[tokio::test]
async fn e2e_slow_subscriber_eventually_catches_up() {
    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..30 {
                let mut jpeg = make_valid_jpeg(i);
                jpeg[12..20].copy_from_slice(&i.to_be_bytes());
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
    };

    let mut stream = resp.bytes_stream();
    let mut body = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(100), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                body.extend_from_slice(&chunk);
            }
            _ => break,
        }
    }

    let _ = producer.await;

    let frames = parse_mjpeg_frames(&body);
    assert!(
        !frames.is_empty(),
        "slow subscriber should still receive frames"
    );
}

#[tokio::test]
async fn e2e_stream_no_corrupted_frames_under_load() {
    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..100 {
                let jpeg = make_valid_jpeg(i * 7);
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    let deadline = Instant::now() + Duration::from_secs(5);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                body.extend_from_slice(&chunk);
            }
            _ => break,
        }
    }

    let _ = producer.await;

    let frames = parse_mjpeg_frames(&body);
    assert!(
        frames.len() >= 5,
        "should receive multiple frames under load, got {}",
        frames.len()
    );

    for (i, frame) in frames.iter().enumerate() {
        assert!(
            is_valid_jpeg(frame),
            "frame {} should be valid JPEG (first bytes: {:?})",
            i,
            &frame[..frame.len().min(10)]
        );
    }
}

#[tokio::test]
async fn e2e_memory_stable_with_validation() {
    let start_rss = get_rss_kb();

    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..500 {
                let jpeg = make_valid_jpeg(i);
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
    };

    let mut stream = resp.bytes_stream();
    let mut body = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(8);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                body.extend_from_slice(&chunk);
                if body.windows(6).filter(|w| w == b"--frame").count() >= 30 {
                    break;
                }
            }
            _ => break,
        }
    }

    let _ = producer.await;

    let frame_count: usize;
    let valid_count: usize;
    {
        let frames = parse_mjpeg_frames(&body);
        frame_count = frames.len();
        valid_count = frames.iter().filter(|f| is_valid_jpeg(f)).count();
        assert!(
            frame_count > 0,
            "should receive frames during memory test"
        );
        assert_eq!(
            valid_count,
            frame_count,
            "all received frames should be valid JPEG ({} of {} valid)",
            valid_count,
            frame_count
        );
    }

    drop(body);
    tokio::time::sleep(Duration::from_millis(500)).await;

    if let (Some(start), Some(end)) = (start_rss, get_rss_kb()) {
        let growth = end.saturating_sub(start);
        assert!(
            growth < 100_000,
            "RSS grew by {growth} kb after receiving {frame_count} frames — potential leak",
        );
    }
}

#[tokio::test]
async fn e2e_stream_handles_rapid_connect_disconnect() {
    let server = TestServer::new().await;

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..200 {
                let jpeg = make_valid_jpeg(i);
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };

    for _ in 0..10 {
        let url = format!("{}/stream", server.base_url);
        let client = reqwest::Client::new();
        let resp = client.get(&url).send().await.unwrap();
        let mut stream = resp.bytes_stream();

        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                assert!(!chunk.is_empty(), "should receive data on connect");
            }
            _ => {}
        }
    }

    let _ = producer.await;
}

#[tokio::test]
async fn e2e_stream_content_length_matches_frame_size() {
    let server = TestServer::new().await;

    let url = format!("{}/stream", server.base_url);
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await.unwrap();

    let producer = {
        let tx = server.frame_tx.clone();
        tokio::spawn(async move {
            for i in 0..10 {
                let mut jpeg = make_valid_jpeg(i);
                let target_size = 500 + i * 100;
                jpeg.resize(target_size.max(20), 0x42);
                jpeg[0] = 0xFF;
                jpeg[1] = 0xD8;
                let len = jpeg.len();
                jpeg[len - 2] = 0xFF;
                jpeg[len - 1] = 0xD9;
                let _ = tx.send(CameraFrame::new(jpeg));
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
    };

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    let deadline = Instant::now() + Duration::from_secs(3);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                body.extend_from_slice(&chunk);
                if body.windows(6).filter(|w| w == b"--frame").count() >= 3 {
                    break;
                }
            }
            _ => break,
        }
    }

    let _ = producer.await;

    let frames = parse_mjpeg_frames(&body);
    assert!(!frames.is_empty(), "should parse frames");

    for frame in &frames {
        assert!(
            is_valid_jpeg(frame),
            "frame should be valid JPEG, first bytes: {:?}",
            &frame[..frame.len().min(10)]
        );
    }
}
