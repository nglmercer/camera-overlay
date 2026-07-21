use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use bytes::Bytes;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tower_http::cors::CorsLayer;

use crate::camera::{CameraController, CameraFrame};
use crate::config::CameraConfig;

const MAX_LAGGED_FRAMES: u64 = 10;

pub struct AppState {
    pub config: parking_lot::Mutex<CameraConfig>,
    pub camera: Arc<CameraController>,
    pub frame_tx: broadcast::Sender<CameraFrame>,
}

const INDEX_HTML: &str = include_str!("../static/index.html");
const CONFIG_HTML: &str = include_str!("../static/config.html");

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/config", get(serve_config))
        .route("/stream", get(mjpeg_stream))
        .route("/snapshot", get(snapshot))
        .route("/settings", get(get_config).post(set_config))
        .route("/cameras", get(list_cameras))
        .route("/start", post(start_camera))
        .route("/stop", post(stop_camera))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn serve_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn serve_config() -> Html<&'static str> {
    Html(CONFIG_HTML)
}

async fn mjpeg_stream(State(state): State<Arc<AppState>>) -> Response {
    let rx = state.frame_tx.subscribe();

    let stream = BroadcastStream::new(rx).filter_map(|r| match r {
        Ok(frame) => Some(Ok::<Bytes, std::convert::Infallible>(frame.mjpeg_part.clone())),
        Err(BroadcastStreamRecvError::Lagged(n)) if n <= MAX_LAGGED_FRAMES => {
            log::debug!("Subscriber lagged by {n} frames, continuing");
            Some(Ok::<Bytes, std::convert::Infallible>(Bytes::new()))
        }
        Err(BroadcastStreamRecvError::Lagged(n)) => {
            log::warn!("Subscriber lagged by {n} frames, disconnecting");
            None
        }
    });

    let body = Body::from_stream(stream);

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
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Camera not running",
        )
            .into_response(),
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

async fn start_camera(State(state): State<Arc<AppState>>) -> StatusCode {
    let cfg = state.config.lock();
    let snapshot = crate::camera::CameraConfigSnapshot {
        resolution: cfg.resolution.clone(),
        target_fps: cfg.target_fps,
    };
    drop(cfg);

    state.camera.start(state.frame_tx.clone(), snapshot);
    StatusCode::OK
}

async fn stop_camera(State(state): State<Arc<AppState>>) -> StatusCode {
    state.camera.stop();
    StatusCode::OK
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
        let (frame_tx, _rx) = broadcast::channel(2);
        Arc::new(AppState {
            config: parking_lot::Mutex::new(CameraConfig::default()),
            camera,
            frame_tx,
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
    async fn test_start_stop_camera() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/start")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // Give the camera thread a moment to produce a frame
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let response = app
            .clone()
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
}
