#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use sysinfo::Networks;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewWindow,
};

/// Bytes per second, summed over every non-loopback interface, plus the raw
/// byte totals counted since the app started.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetSpeed {
    down: f64,
    up: f64,
    down_total: f64,
    up_total: f64,
}

/// The last progress JSON the page stored; written to disk on exit.
#[derive(Default)]
struct SavedProgress(Mutex<String>);

fn progress_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("progress.json"))
}

fn write_progress(app: &AppHandle, json: &str) -> Result<(), String> {
    let path = progress_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Contents of progress.json in the app data directory, or empty.
#[tauri::command]
fn load_progress(app: AppHandle) -> String {
    progress_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Keeps the string in memory (for the exit write) and writes the file.
#[tauri::command]
fn save_progress(app: AppHandle, state: State<SavedProgress>, json: String) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = json.clone();
    write_progress(&app, &json)
}

/// Cursor position in CSS pixels relative to the overlay window.
/// The page polls this because a click-through window receives no mouse events.
#[tauri::command]
fn cursor_pos(window: WebviewWindow) -> Option<(f64, f64)> {
    let cursor = window.cursor_position().ok()?;
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().ok()?;
    Some((
        (cursor.x - origin.x as f64) / scale,
        (cursor.y - origin.y as f64) / scale,
    ))
}

#[tauri::command]
fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}

/// Height of the strip the fighters live in, in CSS pixels.
const BAND_HEIGHT: f64 = 240.0;

/// Where the window sits inside the work area, in CSS pixels.
#[derive(Serialize)]
struct View {
    top: f64,
    width: f64,
    height: f64,
}

/// The work area ends at the top of the Windows taskbar or the macOS Dock;
/// its bottom edge is the fighters' floor. A transparent window is
/// recomposited in full on every frame, so it stays a thin strip along that
/// floor and only covers the whole work area while a fighter is dragged or
/// thrown.
fn apply_view(window: &WebviewWindow, full: bool) -> Result<View, String> {
    let err = |e: tauri::Error| e.to_string();
    let monitor = window
        .primary_monitor()
        .map_err(err)?
        .ok_or_else(|| "no primary monitor".to_string())?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let band = ((BAND_HEIGHT * scale) as u32).min(area.size.height);
    let (y, height) = if full {
        (area.position.y, area.size.height)
    } else {
        (area.position.y + (area.size.height - band) as i32, band)
    };
    window
        .set_position(PhysicalPosition::new(area.position.x, y))
        .map_err(err)?;
    window
        .set_size(PhysicalSize::new(area.size.width, height))
        .map_err(err)?;
    Ok(View {
        top: (y - area.position.y) as f64 / scale,
        width: area.size.width as f64 / scale,
        height: area.size.height as f64 / scale,
    })
}

#[tauri::command]
fn set_view(window: WebviewWindow, full: bool) -> Result<View, String> {
    apply_view(&window, full)
}

/// Debug: NETBATTLE_SHOWCASE selects a test mode for checking the animations.
/// "fight" runs the normal fight with fixed fake traffic; any other value plays
/// every move in a fixed order. Empty when unset.
#[tauri::command]
fn showcase() -> String {
    std::env::var("NETBATTLE_SHOWCASE").unwrap_or_default()
}

/// Debug: NETBATTLE_BUILD gives the test fighters skill points, for example
/// "red=10,0,0;blue=0,10,5" (speed, stamina, strength). See docs/leveling-spec.md.
#[tauri::command]
fn test_build() -> String {
    std::env::var("NETBATTLE_BUILD").unwrap_or_default()
}

/// Debug: log when a showcase move starts, with wall-clock milliseconds, so a
/// screen recording can be cut into one piece per move.
#[tauri::command]
fn showcase_mark(label: String) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("SHOWMARK {ms} {label}");
}

/// Loopback and virtual adapters (WSL, Hyper-V, Docker, VPN tunnels) carry
/// traffic that also passes through the physical adapter, so counting them
/// would double the numbers.
fn is_ignored(name: &str) -> bool {
    let name = name.to_lowercase();
    name == "lo"
        || name.contains("loopback")
        || ["lo0", "vethernet", "utun", "bridge", "awdl", "llw", "docker", "veth", "vmnet", "vbox"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn spawn_net_monitor(app: AppHandle) {
    thread::spawn(move || {
        let mut networks = Networks::new_with_refreshed_list();
        #[cfg(debug_assertions)]
        for (name, _) in &networks {
            eprintln!("interface: {name}");
        }
        let mut last = Instant::now();
        let (mut down_total, mut up_total) = (0u64, 0u64);
        loop {
            thread::sleep(Duration::from_millis(500));
            networks.refresh(true);
            let secs = last.elapsed().as_secs_f64().max(0.001);
            last = Instant::now();
            let (mut down, mut up) = (0u64, 0u64);
            for (name, data) in &networks {
                if is_ignored(name) {
                    continue;
                }
                down += data.received();
                up += data.transmitted();
            }
            down_total += down;
            up_total += up;
            let _ = app.emit(
                "net",
                NetSpeed {
                    down: down as f64 / secs,
                    up: up as f64 / secs,
                    down_total: down_total as f64,
                    up_total: up_total as f64,
                },
            );
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .manage(SavedProgress::default())
        .invoke_handler(tauri::generate_handler![cursor_pos, set_click_through, set_view, showcase, showcase_mark, test_build, load_progress, save_progress])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window is defined in tauri.conf.json");
            apply_view(&window, false)?;
            window.set_ignore_cursor_events(true)?;
            window.show()?;

            let quit = MenuItem::with_id(app, "quit", "Quit NetBattle", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("NetBattle")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            spawn_net_monitor(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building NetBattle");

    // The tray Quit item (app.exit) and closing the last window both end here.
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<SavedProgress>();
            let json = state.0.lock().map(|g| g.clone()).unwrap_or_default();
            if !json.is_empty() {
                let _ = write_progress(handle, &json);
            }
        }
    });
}
