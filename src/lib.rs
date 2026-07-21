pub mod camera;
pub mod config;
pub mod logger;
pub mod rate_limit;
pub mod server;
pub mod tray;

use std::sync::Arc;
use tokio::sync::broadcast;

use config::CameraConfig;

const BROADCAST_CAPACITY: usize = 4;

pub async fn run_server(port: u16) -> std::io::Result<Arc<server::AppState>> {
    let camera = Arc::new(camera::CameraController::new());
    let (frame_tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
    let (overlay_tx, _overlay_rx) = broadcast::channel::<serde_json::Value>(8);

    let state = Arc::new(server::AppState {
        config: parking_lot::Mutex::new(CameraConfig::default()),
        camera: Arc::clone(&camera),
        frame_tx,
        overlay_tx,
        overlay_state: parking_lot::Mutex::new(serde_json::Value::Null),
        rate_limiters: crate::rate_limit::RateLimiters::new(),
    });

    let app = server::build_router(Arc::clone(&state));
    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok(state)
}
