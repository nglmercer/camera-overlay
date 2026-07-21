use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;

use crate::camera::{CameraController, CameraFrame};
use crate::config::CameraConfig;
use crate::rate_limit::{RateLimiters, rate_limit_middleware};

pub struct AppState {
    pub config: parking_lot::Mutex<CameraConfig>,
    pub camera: Arc<CameraController>,
    pub frame_tx: broadcast::Sender<CameraFrame>,
    pub rate_limiters: RateLimiters,
}

const INDEX_HTML: &str = include_str!("../static/index.html");
const CONFIG_HTML: &str = include_str!("../static/config.html");

pub fn build_router(state: Arc<AppState>) -> Router {
    let rl = Arc::new(state.rate_limiters.clone());

    Router::new()
        .route("/", get(serve_index))
        .route("/config", get(serve_config))
        .route("/stream", get(mjpeg_stream))
        .route("/snapshot", get(snapshot))
        .route("/settings", get(get_config).post(set_config))
        .route("/cameras", get(list_cameras))
        .route("/status", get(camera_status))
        .route("/start", post(start_camera))
        .route("/stop", post(stop_camera))
        .layer(middleware::from_fn_with_state(rl.clone(), rate_limit_middleware))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn serve_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn serve_config() -> Html<&'static str> {
    Html(CONFIG_HTML)
}

/// MJPEG stream with a "skip-to-latest" latency strategy.
///
/// A dedicated task per connection consumes the broadcast channel and always
/// emits the *newest* frame: after `recv()`ing a frame it drains any newer
/// frames already queued (a `try_recv` loop) and emits only the last one.
/// Intermediate frames are dropped instead of buffered, so a slow client
/// (throttled tab, congested socket, OBS re-sync) never renders a backlog of
/// stale frames — which was the source of the "high delay" preview. The handoff
/// to the HTTP body is a capacity-2 mpsc, so backpressure drops to latest
/// rather than accumulating latency. On broadcast lag we simply continue (the
/// next `recv` returns a recent frame); no empty multipart parts and no forced
/// disconnect, so browsers keep a valid multipart stream.
async fn mjpeg_stream(State(state): State<Arc<AppState>>) -> Response {
    let rx = state.frame_tx.subscribe();

    // Capacity 2: a tiny buffer lets the body writer stay one frame ahead
    // without letting latency build up. Under backpressure the task keeps
    // draining the broadcast channel to the latest frame.
    let (tx, rx_out) = tokio::sync::mpsc::channel::<Result<Bytes, std::convert::Infallible>>(2);

    tokio::spawn(async move {
        let mut rx = rx;
        loop {
            // Use select so a stalled recv (camera idle) still notices when
            // the HTTP body is dropped (client disconnect) and exits promptly.
            tokio::select! {
                result = rx.recv() => {
                    match result {
                        Ok(mut latest) => {
                            while let Ok(newer) = rx.try_recv() {
                                latest = newer;
                            }
                            let part = latest.mjpeg_part();
                            if part.is_empty() {
                                continue;
                            }
                            if tx.send(Ok(part)).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            log::debug!("Subscriber lagged by {n} frames, skipping to latest");
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = tx.closed() => {
                    // HTTP body dropped (client disconnected or response aborted)
                    break;
                }
            }
        }
    });

    let body = Body::from_stream(ReceiverStream::new(rx_out));

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("multipart/x-mixed-replace; boundary=frame"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));

    (headers, body).into_response()
}

async fn snapshot(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let frame = state.camera.latest_frame();
    match frame {
        Some(f) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("image/jpeg"),
            );
            (headers, (*f.jpeg_data).clone()).into_response()
        }
        None => (StatusCode::SERVICE_UNAVAILABLE, "Camera not running").into_response(),
    }
}

async fn get_config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config = state.config.lock().clone();
    (StatusCode::OK, axum::Json(config)).into_response()
}

async fn set_config(
    State(state): State<Arc<AppState>>,
    axum::Json(config): axum::Json<CameraConfig>,
) -> StatusCode {
    *state.config.lock() = config;
    crate::config::save(&state.config.lock());
    StatusCode::OK
}

async fn list_cameras(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cameras = state.camera.list_cameras();
    (StatusCode::OK, axum::Json(cameras)).into_response()
}

#[derive(Serialize)]
struct StatusResponse {
    running: bool,
    has_frame: bool,
    /// Resident set size of this process in KiB (from Linux `/proc`, `null`
    /// elsewhere). Exposed so memory growth can be watched with a curl loop.
    memory_rss_kb: Option<usize>,
}

fn memory_rss_kb() -> Option<usize> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

async fn camera_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(StatusResponse {
        running: state.camera.is_running(),
        has_frame: state.camera.latest_frame().is_some(),
        memory_rss_kb: memory_rss_kb(),
    })
}

#[derive(Serialize)]
struct StartResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    running: bool,
}

async fn start_camera(State(state): State<Arc<AppState>>) -> (StatusCode, Json<StartResponse>) {
    // Scope the lock so the non-Send guard is dropped before any .await.
    let snapshot = {
        let cfg = state.config.lock();
        crate::camera::CameraConfigSnapshot {
            camera_index: cfg.selected_camera_index.unwrap_or(0),
            resolution: cfg.resolution.clone(),
            target_fps: cfg.target_fps,
        }
    };

    // start() may block briefly waiting for the capture thread to open the device.
    let camera = Arc::clone(&state.camera);
    let tx = state.frame_tx.clone();
    let result = tokio::task::spawn_blocking(move || camera.start(tx, snapshot)).await;

    match result {
        Ok(Ok(())) => (
            StatusCode::OK,
            Json(StartResponse {
                ok: true,
                error: None,
                running: state.camera.is_running(),
            }),
        ),
        Ok(Err(e)) => {
            log::error!("Start camera failed: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(StartResponse {
                    ok: false,
                    error: Some(e),
                    running: false,
                }),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(StartResponse {
                ok: false,
                error: Some(format!("Start task failed: {e}")),
                running: false,
            }),
        ),
    }
}

#[derive(Serialize)]
struct StopResponse {
    ok: bool,
    running: bool,
}

async fn stop_camera(State(state): State<Arc<AppState>>) -> Json<StopResponse> {
    let camera = Arc::clone(&state.camera);
    let _ = tokio::task::spawn_blocking(move || camera.stop()).await;
    Json(StopResponse {
        ok: true,
        running: state.camera.is_running(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn test_state() -> Arc<AppState> {
        let camera = Arc::new(CameraController::new());
        let (frame_tx, _rx) = broadcast::channel(16);
        Arc::new(AppState {
            config: parking_lot::Mutex::new(CameraConfig::default()),
            camera,
            frame_tx,
            rate_limiters: crate::rate_limit::RateLimiters::new(),
        })
    }

    #[tokio::test]
    async fn test_get_index() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(body.windows(4).any(|w| w == b"<img"));
    }

    #[tokio::test]
    async fn test_get_config_page() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert!(body.windows(5).any(|w| w == b"<h1>C"));
    }

    #[tokio::test]
    async fn test_get_settings() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["port"], 8080);
    }

    #[tokio::test]
    async fn test_post_settings() {
        let state = test_state();
        let app = build_router(state.clone());

        let json_body = r#"{"port": 9090, "mirror_horizontal": true, "target_fps": 60}"#;

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/settings")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(state.config.lock().port, 9090);
        assert!(state.config.lock().mirror_horizontal);
        assert_eq!(state.config.lock().target_fps, 60);
    }

    #[tokio::test]
    async fn test_get_snapshot_when_off() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/snapshot")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_start_without_camera_returns_error_json() {
        let state = test_state();
        // Point at a ridiculous index so open fails quickly when no such device.
        state.config.lock().selected_camera_index = Some(9999);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/start")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Either 503 (open failed) or 200 if a device somehow exists — must be JSON either way.
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.get("ok").is_some());
        assert!(json.get("running").is_some());
        if status == StatusCode::SERVICE_UNAVAILABLE {
            assert_eq!(json["ok"], false);
            assert!(json["error"].as_str().is_some());
        }
    }

    #[tokio::test]
    async fn test_get_status() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["running"], false);
        assert_eq!(json["has_frame"], false);
    }

    #[tokio::test]
    async fn test_get_cameras() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/cameras")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.is_array());
    }

    #[tokio::test]
    async fn test_get_stream() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap(),
            "multipart/x-mixed-replace; boundary=frame"
        );
    }

    #[tokio::test]
    async fn test_stop_returns_json() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/stop")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["running"], false);
    }
}
