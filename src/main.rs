mod camera;
mod config;
mod logger;
mod server;
mod trayicon;

use std::sync::Arc;
use tokio::sync::broadcast;

fn main() {
    logger::init();

    let config = config::load();
    let camera = Arc::new(camera::CameraController::new());
    let (frame_tx, _rx) = broadcast::channel(2);

    let state = Arc::new(server::AppState {
        config: parking_lot::Mutex::new(config.clone()),
        camera: Arc::clone(&camera),
        frame_tx: frame_tx.clone(),
    });

    let state_clone = Arc::clone(&state);

    let port = config.port;
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async {
            let app = server::build_router(state_clone);
            let addr = format!("0.0.0.0:{port}");
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    log::error!("Failed to bind to {addr}: {e}");
                    return;
                }
            };
            log::info!("Camera server running at http://localhost:{port}");
            log::info!("Add http://localhost:{port} as a Browser Source in OBS");
            if let Err(e) = axum::serve(listener, app).await {
                log::error!("Server error: {e}");
            }
        });
    });

    let _tray = trayicon::setup();

    log::info!("Server running. Press Ctrl+C to stop.");
    log::info!(
        "Open http://localhost:{}/ in your browser or add it as an OBS Browser Source",
        config.port
    );

    loop {
        std::thread::park();
    }
}
