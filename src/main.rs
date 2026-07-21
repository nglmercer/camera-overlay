mod camera;
mod config;
mod logger;
mod server;

use std::sync::Arc;
use tokio::sync::broadcast;

#[tokio::main]
async fn main() {
    logger::init();

    let config = config::load();
    let camera = Arc::new(camera::CameraController::new());
    let (frame_tx, _rx) = broadcast::channel(2);

    let state = Arc::new(server::AppState {
        config: parking_lot::Mutex::new(config.clone()),
        camera: Arc::clone(&camera),
        frame_tx: frame_tx.clone(),
    });

    let port = config.port;
    let addr = format!("0.0.0.0:{port}");

    log::info!("Camera server running at http://localhost:{port}");
    log::info!("Overlay:  http://localhost:{port}/");
    log::info!("Config:   http://localhost:{port}/config");
    log::info!("Stream:   http://localhost:{port}/stream");
    log::info!("Add the overlay or stream URL as a Browser Source in OBS");

    let app = server::build_router(state);
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
