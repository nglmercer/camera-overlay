use std::sync::Arc;
use tokio::sync::broadcast;

/// Bounded ring of recent frames. The MJPEG handler drains to the *latest*
/// frame on every emit, so capacity only bounds memory/transient jitter — it
/// no longer controls latency. 4 keeps RSS low while tolerating brief stalls.
const BROADCAST_CAPACITY: usize = 4;

#[tokio::main]
async fn main() {
    camera_overlay::logger::init();

    let config = camera_overlay::config::load();
    let camera = Arc::new(camera_overlay::camera::CameraController::new());
    let (frame_tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);

    let state = Arc::new(camera_overlay::server::AppState {
        config: parking_lot::Mutex::new(config.clone()),
        camera: Arc::clone(&camera),
        frame_tx: frame_tx.clone(),
        rate_limiters: camera_overlay::rate_limit::RateLimiters::new(),
    });

    let port = config.port;
    let addr = format!("0.0.0.0:{port}");

    log::info!("Camera server running at http://localhost:{port}");
    log::info!("Overlay:   http://localhost:{port}/");
    log::info!("Config:    http://localhost:{port}/config");
    log::info!("WS Stream: ws://localhost:{port}/ws");
    log::info!("Add the overlay URL as a Browser Source in OBS");

    if config.auto_start {
        let snapshot = camera_overlay::camera::CameraConfigSnapshot {
            camera_index: config.selected_camera_index.unwrap_or(0),
            resolution: config.resolution.clone(),
            target_fps: config.target_fps,
        };
        match camera.start(frame_tx.clone(), snapshot) {
            Ok(()) => log::info!("Auto-start: camera running"),
            Err(e) => log::error!("Auto-start failed: {e}"),
        }
    }

    let app = camera_overlay::server::build_router(state);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind to {addr}: {e}");
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        log::error!("Server error: {e}");
    }
}
