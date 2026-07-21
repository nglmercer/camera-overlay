use std::sync::Arc;
use std::time::Duration;
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

struct TestServer {
    base_url: String,
    client: reqwest::Client,
}

impl TestServer {
    async fn new() -> Self {
        let port = pick_unused_port();
        let (frame_tx, _rx) = broadcast::channel::<CameraFrame>(32);
        let (overlay_tx, _overlay_rx) = broadcast::channel::<serde_json::Value>(8);

        let state = Arc::new(AppState {
            config: parking_lot::Mutex::new(CameraConfig::default()),
            camera: Arc::new(camera_overlay::camera::CameraController::new()),
            frame_tx,
            overlay_tx,
            overlay_state: parking_lot::Mutex::new(serde_json::Value::Null),
            rate_limiters: camera_overlay::rate_limit::RateLimiters::new(),
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

        let server = Self { base_url, client };
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
}

#[tokio::test]
async fn e2e_status_reports_not_running() {
    let server = TestServer::new().await;
    let resp = server.get("status").await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let json: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(json["running"], false);
    assert_eq!(json["has_frame"], false);
}

#[tokio::test]
async fn e2e_serves_all_web_assets_from_the_binary() {
    let server = TestServer::new().await;

    for (path, content_type) in [
        ("", "text/html"),
        ("config", "text/html"),
        ("index.js", "application/javascript"),
        ("config.js", "application/javascript"),
        ("chunks/overlay.js", "application/javascript"),
        ("assets/index.css", "text/css"),
        ("assets/config.css", "text/css"),
        ("camera-overlay.svg", "image/svg+xml"),
    ] {
        let response = server.get(path).await;
        assert_eq!(response.status(), reqwest::StatusCode::OK, "GET /{path}");
        assert_eq!(
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default(),
            content_type,
            "content type for /{path}"
        );
        assert!(
            !response.bytes().await.unwrap().is_empty(),
            "GET /{path} was empty"
        );
    }
}

#[tokio::test]
async fn e2e_settings_post_and_get() {
    let server = TestServer::new().await;
    let resp = server.get("settings").await;
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let body = r#"{"port": 8080, "target_fps": 60, "mirror_horizontal": true}"#;
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
    assert_eq!(json["port"], 8080);
    assert_eq!(json["target_fps"], 60);
    assert_eq!(json["mirror_horizontal"], true);
}

#[tokio::test]
async fn e2e_start_missing_camera_returns_error_body() {
    let server = TestServer::new().await;

    let body = r#"{"selected_camera_index": 99999, "target_fps": 30, "port": 8080}"#;
    let resp = server
        .client
        .post(format!("{}/settings", server.base_url))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let resp = server
        .client
        .post(format!("{}/start", server.base_url))
        .send()
        .await
        .unwrap();

    let status = resp.status();
    let json: serde_json::Value = resp.json().await.unwrap();
    assert!(json.get("ok").is_some());
    assert!(json.get("running").is_some());
    if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        assert_eq!(json["ok"], false);
        assert!(
            json["error"]
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            "error message required on failure"
        );
        assert_eq!(json["running"], false);
    }
}
