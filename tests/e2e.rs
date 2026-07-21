use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

use camera_overlay::camera::CameraFrame;
use camera_overlay::config::CameraConfig;
use camera_overlay::server::{build_router, AppState};

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
        let (frame_tx, _rx) = broadcast::channel::<CameraFrame>(2);
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
            .timeout(Duration::from_secs(5))
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

    fn send_frame(&self, jpeg_data: Vec<u8>) {
        let _ = self.frame_tx.send(CameraFrame::new(jpeg_data));
    }
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

    server.send_frame(vec![0xFFu8; 1000]);
    server.send_frame(vec![0xAAu8; 1000]);

    let resp = server.get("stream").await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let start = Instant::now();
    let body = tokio::time::timeout(Duration::from_secs(3), resp.bytes())
        .await
        .expect("timeout waiting for stream")
        .unwrap();

    assert!(
        body.windows(6).any(|w| w == b"--frame"),
        "should contain MJPEG boundary"
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "should receive frames quickly"
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

    for i in 0..10 {
        server.send_frame(vec![i; 20_000]);
    }

    let mut handles = Vec::new();
    for _ in 0..3 {
        let url = format!("{}/stream", server.base_url);
        handles.push(tokio::spawn(async move {
            let client = reqwest::Client::new();
            let resp = client.get(&url).send().await.unwrap();
            let bytes = tokio::time::timeout(Duration::from_secs(3), resp.bytes())
                .await
                .unwrap()
                .unwrap();
            bytes.len()
        }));
    }

    for h in handles {
        let len = h.await.unwrap();
        assert!(len > 0, "each subscriber should receive data");
    }
}

#[tokio::test]
async fn e2e_memory_stable_during_streaming() {
    let start_rss = get_rss_kb();

    let server = TestServer::new().await;

    for i in 0..300 {
        server.send_frame(vec![(i % 256) as u8; 50_000]);
    }

    let resp = server.get("stream").await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let body = tokio::time::timeout(Duration::from_secs(5), resp.bytes())
        .await
        .unwrap()
        .unwrap();
    assert!(body.len() > 0);

    drop(body);
    tokio::time::sleep(Duration::from_millis(300)).await;

    if let (Some(start), Some(end)) = (start_rss, get_rss_kb()) {
        let growth = end.saturating_sub(start);
        assert!(
            growth < 80_000,
            "RSS grew by {growth} kb (start={start}, end={end}) — potential leak"
        );
    }
}
