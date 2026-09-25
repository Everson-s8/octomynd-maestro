mod events;
mod platform;
mod release;
mod setup;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

struct AppState {
    running: AtomicBool,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    last_log: Mutex<Option<PathBuf>>,
    payload_override: Option<PathBuf>,
}

#[derive(Serialize)]
struct SetupInfo {
    stages: Vec<events::StageInfo>,
    #[serde(rename = "installDir")]
    install_dir: String,
    #[serde(rename = "installedVersion")]
    installed_version: Option<String>,
    #[serde(rename = "setupVersion")]
    setup_version: &'static str,
    #[serde(rename = "localPayload")]
    local_payload: Option<String>,
}

#[tauri::command]
fn setup_info(state: State<'_, Arc<AppState>>) -> SetupInfo {
    let install_dir = platform::default_install_dir();
    SetupInfo {
        stages: events::STAGES.to_vec(),
        installed_version: platform::installed_version(&install_dir),
        install_dir: install_dir.to_string_lossy().to_string(),
        setup_version: env!("CARGO_PKG_VERSION"),
        local_payload: state.payload_override.as_ref().map(|path| path.to_string_lossy().to_string()),
    }
}

#[tauri::command]
fn start_setup(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A instalação já está em andamento.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = Some(cancel.clone());
    let reporter = Arc::new(setup::Reporter::new(app.clone()));
    *state.last_log.lock().unwrap() = Some(reporter.log_path.clone());
    let options = setup::SetupOptions {
        install_dir: platform::default_install_dir(),
        payload_override: state.payload_override.clone(),
    };
    let shared = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = setup::run(reporter.clone(), options, cancel).await;
        reporter.finished(result);
        shared.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
fn cancel_setup(state: State<'_, Arc<AppState>>) {
    if let Some(cancel) = state.cancel.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn launch_maestro() -> Result<(), String> {
    let exe = platform::default_install_dir().join("Maestro.exe");
    if !exe.is_file() {
        return Err("O Maestro não foi encontrado na pasta de instalação.".into());
    }
    std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap_or(&exe))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Não foi possível abrir o Maestro: {error}"))
}

/// Shows the latest setup log in Explorer. Only the log this process wrote.
#[tauri::command]
fn open_log(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let path = state.last_log.lock().unwrap().clone().ok_or("Ainda não há log.")?;
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(format!("/select,{}", path.display()));
    command.spawn().map(|_| ()).map_err(|error| format!("Não foi possível abrir o log: {error}"))
}

fn payload_override() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--payload" {
            return args.next().map(PathBuf::from);
        }
        if let Some(value) = arg.strip_prefix("--payload=") {
            return Some(PathBuf::from(value));
        }
    }
    std::env::var_os("MAESTRO_SETUP_PAYLOAD").map(PathBuf::from)
}

pub fn run() {
    let state = Arc::new(AppState {
        running: AtomicBool::new(false),
        cancel: Mutex::new(None),
        last_log: Mutex::new(None),
        payload_override: payload_override(),
    });
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![setup_info, start_setup, cancel_setup, launch_maestro, open_log])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Maestro Setup");
}
