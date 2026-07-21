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
use tower_http::cors::CorsLayer;

use crate::camera::{CameraController, CameraFrame};
use crate::config::CameraConfig;

pub struct AppState {
    pub config: parking_lot::Mutex<CameraConfig>,
    pub camera: Arc<CameraController>,
    pub frame_tx: broadcast::Sender<CameraFrame>,
}

const INDEX_HTML: &str = include_str!("../static/index.html");

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/stream", get(mjpeg_stream))
        .route("/snapshot", get(snapshot))
        .route("/config", get(get_config).post(set_config))
        .route("/cameras", get(list_cameras))
        .route("/start", post(start_camera))
        .route("/stop", post(stop_camera))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn serve_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn mjpeg_stream(State(state): State<Arc<AppState>>) -> Response {
    let rx = state.frame_tx.subscribe();

    let stream = BroadcastStream::new(rx).filter_map(|r| {
        match r {
            Ok(frame) => Some(Ok::<Bytes, std::convert::Infallible>(frame.to_mjpeg_part())),
            Err(_) => None,
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
            (headers, f.jpeg_data).into_response()
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
        mirror_h: cfg.mirror_horizontal,
        mirror_v: cfg.mirror_vertical,
    };
    drop(cfg);

    state.camera.start(state.frame_tx.clone(), snapshot);
    StatusCode::OK
}

async fn stop_camera(State(state): State<Arc<AppState>>) -> StatusCode {
    state.camera.stop();
    StatusCode::OK
}
