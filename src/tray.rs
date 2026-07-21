use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, TrayIconBuilder,
};

use crate::server::AppState;

static CAMERA_RUNNING: AtomicBool = AtomicBool::new(false);

fn make_icon() -> Icon {
    let rgba = vec![0u8, 0, 0, 0];
    Icon::from_rgba(rgba, 1, 1).expect("failed to create tray icon")
}

pub fn create_tray(state: Arc<AppState>, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    std::thread::spawn(move || {
        if let Err(e) = gtk::init() {
            log::warn!("Failed to initialize GTK: {e}");
            return;
        }

        let icon = make_icon();

        let start_stop = MenuItem::new("Start Camera", true, None);
        let open_config = MenuItem::new("Open Config", true, None);
        let restart = MenuItem::new("Restart", true, None);
        let quit = MenuItem::new("Quit", true, None);

        let menu = Menu::new();
        let _ = menu.append(&start_stop);
        let _ = menu.append(&open_config);
        let _ = menu.append(&MenuItem::new("", false, None));
        let _ = menu.append(&restart);
        let _ = menu.append(&MenuItem::new("", false, None));
        let _ = menu.append(&quit);

        let _tray = match TrayIconBuilder::new()
            .with_icon(icon)
            .with_tooltip("Camera Overlay")
            .with_menu(Box::new(menu))
            .build()
        {
            Ok(t) => t,
            Err(e) => {
                log::warn!("Failed to create tray icon: {e}");
                return;
            }
        };

        log::info!("Tray icon created");

        let start_stop_clone = start_stop.clone();
        let open_config_clone = open_config.clone();
        let restart_clone = restart.clone();
        let quit_clone = quit.clone();
        let state_clone = Arc::clone(&state);

        glib::idle_add_local(move || {
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                if event.id() == start_stop_clone.id() {
                    let running = CAMERA_RUNNING.load(Ordering::SeqCst);
                    if running {
                        CAMERA_RUNNING.store(false, Ordering::SeqCst);
                        start_stop_clone.set_text("Start Camera");
                        let camera = Arc::clone(&state_clone.camera);
                        std::thread::spawn(move || {
                            camera.stop();
                        });
                    } else {
                        CAMERA_RUNNING.store(true, Ordering::SeqCst);
                        start_stop_clone.set_text("Stop Camera");
                        let camera = Arc::clone(&state_clone.camera);
                        let frame_tx = state_clone.frame_tx.clone();
                        let snapshot = crate::camera::CameraConfigSnapshot {
                            camera_index: state_clone
                                .config
                                .lock()
                                .selected_camera_index
                                .unwrap_or(0),
                            resolution: state_clone.config.lock().resolution.clone(),
                            target_fps: state_clone.config.lock().target_fps,
                        };
                        std::thread::spawn(move || {
                            if let Err(e) = camera.start(frame_tx, snapshot) {
                                log::error!("Camera start failed: {e}");
                                CAMERA_RUNNING.store(false, Ordering::SeqCst);
                            }
                        });
                    }
                } else if event.id() == open_config_clone.id() {
                    let url = format!("http://localhost:{port}/config");
                    let _ = open::that(url);
                } else if event.id() == restart_clone.id() {
                    let _ = std::process::Command::new(std::env::current_exe().unwrap()).spawn();
                    std::process::exit(0);
                } else if event.id() == quit_clone.id() {
                    std::process::exit(0);
                }
            }
            glib::ControlFlow::Continue
        });

        gtk::main();
    });

    Ok(())
}
