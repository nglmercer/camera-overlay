use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{self, CorsLayer};

use crate::camera::{CameraController, CameraFrame};
use crate::config::CameraConfig;
use crate::rate_limit::{rate_limit_middleware, RateLimiters};

mod embedded_assets {
    include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));
}

pub struct AppState {
    pub config: parking_lot::Mutex<CameraConfig>,
    pub camera: Arc<CameraController>,
    pub frame_tx: broadcast::Sender<CameraFrame>,
    pub overlay_tx: broadcast::Sender<serde_json::Value>,
    pub overlay_state: parking_lot::Mutex<serde_json::Value>,
    pub rate_limiters: RateLimiters,
}

pub fn build_router(state: Arc<AppState>) -> Router {
    let rl = Arc::new(state.rate_limiters.clone());

    Router::new()
        .route("/", get(serve_index))
        .route("/config", get(serve_config))
        .route("/ws", get(ws_stream))
        .route("/settings", get(get_config).post(set_config))
        .route("/cameras", get(list_cameras))
        .route("/status", get(camera_status))
        .route("/start", post(start_camera))
        .route("/stop", post(stop_camera))
        .route("/overlay", get(get_overlay).post(set_overlay))
        .route("/chunks/{*path}", get(serve_chunk))
        .route("/assets/{*path}", get(serve_asset))
        .route("/index.js", get(|| async { serve_embedded("index.js") }))
        .route("/config.js", get(|| async { serve_embedded("config.js") }))
        .route(
            "/camera-overlay.svg",
            get(|| async { serve_embedded("camera-overlay.svg") }),
        )
        .layer(middleware::from_fn_with_state(
            rl.clone(),
            rate_limit_middleware,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(cors::AllowOrigin::predicate(|origin, _| {
                    origin.as_bytes().starts_with(b"http://localhost")
                        || origin.as_bytes().starts_with(b"http://127.0.0.1")
                }))
                .allow_methods(cors::Any)
                .allow_headers(cors::Any),
        )
        .with_state(state)
}

async fn serve_index() -> Response {
    serve_embedded("index.html")
}

async fn serve_config() -> Response {
    serve_embedded("config.html")
}

async fn serve_asset(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    serve_embedded(&format!("assets/{path}"))
}

async fn serve_chunk(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    serve_embedded(&format!("chunks/{path}"))
}

fn serve_embedded(path: &str) -> Response {
    let Some(bytes) = embedded_assets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut response = Response::new(Body::from(Bytes::from_static(bytes)));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(content_type(path)),
    );
    response
}

fn content_type(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

/// WebSocket binary stream handler.
/// Emits raw binary JPEG frames and text overlay-control commands to WebSocket clients.
async fn ws_stream(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    let frame_rx = state.frame_tx.subscribe();
    let overlay_rx = state.overlay_tx.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        let mut frame_rx = frame_rx;
        let mut overlay_rx = overlay_rx;
        loop {
            tokio::select! {
                result = overlay_rx.recv() => {
                    match result {
                        Ok(cmd) => {
                            if let Ok(json) = serde_json::to_string(&cmd) {
                                if socket.send(axum::extract::ws::Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                result = frame_rx.recv() => {
                    match result {
                        Ok(mut latest) => {
                            while let Ok(newer) = frame_rx.try_recv() {
                                latest = newer;
                            }
                            let jpeg_bytes = Bytes::from((*latest.jpeg_data).clone());
                            if socket
                                .send(axum::extract::ws::Message::Binary(jpeg_bytes))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    })
}

async fn get_config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config = state.config.lock().clone();
    (StatusCode::OK, axum::Json(config)).into_response()
}

async fn set_config(
    State(state): State<Arc<AppState>>,
    axum::Json(config): axum::Json<CameraConfig>,
) -> StatusCode {
    let saved = {
        let mut guard = state.config.lock();
        *guard = config;
        guard.clone()
    };
    crate::config::save(&saved);
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

async fn get_overlay(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let state = state.overlay_state.lock().clone();
    (StatusCode::OK, axum::Json(state))
}

async fn set_overlay(
    State(state): State<Arc<AppState>>,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    *state.overlay_state.lock() = payload.clone();
    let _ = state.overlay_tx.send(payload.clone());
    (StatusCode::OK, axum::Json(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn test_state() -> Arc<AppState> {
        let camera = Arc::new(CameraController::new());
        let (frame_tx, _rx) = broadcast::channel(16);
        let (overlay_tx, _overlay_rx) = broadcast::channel::<serde_json::Value>(8);
        Arc::new(AppState {
            config: parking_lot::Mutex::new(CameraConfig::default()),
            camera,
            frame_tx,
            overlay_tx,
            overlay_state: parking_lot::Mutex::new(serde_json::Value::Null),
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
        assert!(body.windows(7).any(|w| w == b"<canvas"));
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

        let json_body = r#"{"port": 8080, "mirror_horizontal": true, "target_fps": 60}"#;

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
        assert_eq!(state.config.lock().port, 8080);
        assert!(state.config.lock().mirror_horizontal);
        assert_eq!(state.config.lock().target_fps, 60);
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

    #[tokio::test]
    async fn test_get_ws() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/ws")
                    .header("connection", "Upgrade")
                    .header("upgrade", "websocket")
                    .header("sec-websocket-version", "13")
                    .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // In hyper/axum oneshot service without IO connection, ws upgrade returns 426 Upgrade Required or 101.
        assert!(
            response.status() == StatusCode::SWITCHING_PROTOCOLS
                || response.status() == StatusCode::UPGRADE_REQUIRED
        );
    }
}
