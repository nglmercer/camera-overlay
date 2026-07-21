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

    #[allow(dead_code)]
    fn send_frame(&self, jpeg_data: Vec<u8>) {
        let _ = self.frame_tx.send(CameraFrame::new(jpeg_data));
    }
}

static FRAME_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn next_frame_id() -> usize {
    FRAME_COUNTER.fetch_add(1, Ordering::SeqCst)
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
        body.windows(boundary.len()).any(|w| w == boundary.as_slice()),
        "response should have MJPEG boundary in windows"
    );
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
