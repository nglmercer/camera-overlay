use tray_icon::TrayIconBuilder;

pub fn setup() -> Option<tray_icon::TrayIcon> {
    TrayIconBuilder::new()
        .with_tooltip("Camera Overlay")
        .build()
        .ok()
}
