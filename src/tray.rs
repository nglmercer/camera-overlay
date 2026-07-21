use std::sync::Arc;
use std::time::Duration;

use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, TrayIconBuilder,
};

use crate::camera::CameraController;
use crate::server::AppState;

fn make_icon() -> Icon {
    const ICON_PNG: &[u8] = include_bytes!("../assets/tray-icon.png");
    let image = image::load_from_memory(ICON_PNG)
        .expect("failed to decode embedded tray icon")
        .into_rgba8();
    let (width, height) = image.dimensions();
    Icon::from_rgba(image.into_raw(), width, height).expect("failed to create tray icon")
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

        // Polling at a modest interval keeps the GTK loop responsive without the
        // 100%-CPU idle callback that used to run try_recv() continuously.
        glib::timeout_add_local(Duration::from_millis(100), move || {
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                if event.id() == start_stop_clone.id() {
                    let camera = Arc::clone(&state_clone.camera);
                    if camera.is_stopping() {
                        continue;
                    }

                    if camera.is_running() || camera.is_starting() {
                        log::info!("Tray requested camera stop");
                        std::thread::spawn(move || camera.stop());
                    } else {
                        let frame_tx = state_clone.frame_tx.clone();
                        let snapshot = {
                            let config = state_clone.config.lock();
                            crate::camera::CameraConfigSnapshot {
                                camera_index: config.selected_camera_index.unwrap_or(0),
                                resolution: config.resolution.clone(),
                                target_fps: config.target_fps,
                            }
                        };
                        log::info!("Tray requested camera start");
                        std::thread::spawn(move || {
                            if let Err(error) = camera.start(frame_tx, snapshot) {
                                log::warn!("Camera start did not complete: {error}");
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

            sync_start_stop_item(&start_stop_clone, &state_clone.camera);
            glib::ControlFlow::Continue
        });

        gtk::main();
    });

    Ok(())
}

fn sync_start_stop_item(item: &MenuItem, camera: &CameraController) {
    let (text, enabled) = if camera.is_stopping() {
        ("Stopping Camera…", false)
    } else if camera.is_starting() {
        ("Starting Camera…", true)
    } else if camera.is_running() {
        ("Stop Camera", true)
    } else {
        ("Start Camera", true)
    };

    if item.text() != text {
        item.set_text(text);
    }
    if item.is_enabled() != enabled {
        item.set_enabled(enabled);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn embedded_tray_icon_is_a_valid_png() {
        const ICON_PNG: &[u8] = include_bytes!("../assets/tray-icon.png");
        let icon = image::load_from_memory(ICON_PNG)
            .expect("embedded tray icon should decode")
            .into_rgba8();

        assert_eq!(icon.dimensions(), (64, 64));
    }
}
