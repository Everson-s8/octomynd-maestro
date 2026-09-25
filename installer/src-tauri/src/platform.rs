//! Windows helpers: install locations, the user's PATH, disk space and
//! process checks. Everything here is per-user; nothing needs elevation.

use std::path::{Path, PathBuf};

/// Hidden console for helper processes (tasklist, reg, git --version).
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// electron-builder's per-user NSIS default: %LOCALAPPDATA%\Programs\Maestro.
pub fn default_install_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Programs").join("Maestro")
}

pub fn setup_data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Maestro-Setup")
}

pub fn download_cache_dir() -> PathBuf {
    std::env::temp_dir().join("Maestro-Setup")
}

/// The packaged app ships with `asar: false`, so its package.json is on disk.
pub fn installed_version(install_dir: &Path) -> Option<String> {
    let manifest = install_dir.join("resources").join("app").join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_owned)
}

pub fn is_maestro_running() -> bool {
    let mut command = std::process::Command::new("tasklist");
    command.args(["/FI", "IMAGENAME eq Maestro.exe", "/FO", "CSV", "/NH"]);
    hide_window(&mut command);
    command
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_ascii_lowercase().contains("\"maestro.exe\""))
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn hide_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_window(_command: &mut std::process::Command) {}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Free bytes on the volume that will hold `path` (walks up to an existing ancestor).
#[cfg(windows)]
pub fn free_space_bytes(path: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let target = wide(&probe.to_string_lossy());
    let mut available: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(target.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
pub fn free_space_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(windows)]
fn expand_environment(value: &str) -> String {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    let source = wide(value);
    let needed = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), std::ptr::null_mut(), 0) };
    if needed == 0 {
        return value.to_owned();
    }
    let mut buffer = vec![0u16; needed as usize];
    let written = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), buffer.as_mut_ptr(), needed) };
    if written == 0 {
        return value.to_owned();
    }
    String::from_utf16_lossy(&buffer[..(written as usize).saturating_sub(1)])
}

#[cfg(windows)]
fn read_path_value(root: winreg::HKEY, subkey: &str) -> String {
    winreg::RegKey::predef(root)
        .open_subkey(subkey)
        .and_then(|key| key.get_value::<String, _>("Path"))
        .unwrap_or_default()
}

/// The PATH a *new* terminal will see: machine + user entries from the
/// registry, expanded. This process's own PATH is stale after the install.
#[cfg(windows)]
pub fn fresh_path_dirs() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let machine = read_path_value(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
    let user = read_path_value(HKEY_CURRENT_USER, "Environment");
    format!("{machine};{user}")
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| PathBuf::from(expand_environment(entry)))
        .collect()
}

#[cfg(not(windows))]
pub fn fresh_path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|value| std::env::split_paths(&value).collect()).unwrap_or_default()
}

pub fn find_on_path(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    const EXTENSIONS: [&str; 4] = ["exe", "cmd", "bat", "com"];
    dirs.iter().find_map(|dir| {
        EXTENSIONS
            .iter()
            .map(|extension| dir.join(format!("{name}.{extension}")))
            .find(|candidate| candidate.is_file())
    })
}

fn same_dir(left: &str, right: &Path) -> bool {
    let normalize = |value: &str| value.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    normalize(left) == normalize(&right.to_string_lossy())
}

/// Makes sure the user PATH contains `dir`. The NSIS payload already adds it;
/// this repairs installs where that step was skipped. Returns true if changed.
#[cfg(windows)]
pub fn ensure_user_path_contains(dir: &Path) -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    let raw = read_path_value(HKEY_CURRENT_USER, "Environment");
    if raw.split(';').any(|entry| same_dir(&expand_environment(entry), dir)) {
        return Ok(false);
    }
    let dir_text = dir.to_string_lossy();
    let updated = if raw.trim().is_empty() { dir_text.to_string() } else { format!("{};{}", raw.trim_end_matches(';'), dir_text) };
    let mut command = std::process::Command::new("reg");
    command.args(["add", r"HKCU\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", &updated, "/f"]);
    hide_window(&mut command);
    let status = command.status().map_err(|error| format!("não foi possível atualizar o PATH: {error}"))?;
    if !status.success() {
        return Err("não foi possível atualizar o PATH do usuário".into());
    }
    broadcast_environment_change();
    Ok(true)
}

#[cfg(not(windows))]
pub fn ensure_user_path_contains(_dir: &Path) -> Result<bool, String> {
    Ok(false)
}

/// Tells Explorer (and new terminals) that the environment changed.
#[cfg(windows)]
fn broadcast_environment_change() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
    let area = wide("Environment");
    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, area.as_ptr() as isize, SMTO_ABORTIFHUNG, 2000, &mut result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_dir_ignores_case_and_trailing_separator() {
        assert!(same_dir(r"C:\Users\Ana\AppData\Local\Programs\Maestro\", Path::new(r"c:\users\ana\appdata\local\programs\maestro")));
        assert!(!same_dir(r"C:\Programs\Maestro2", Path::new(r"C:\Programs\Maestro")));
    }

    #[test]
    fn find_on_path_prefers_listed_extensions() {
        let dir = std::env::temp_dir().join(format!("maestro-setup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("codex.cmd"), "").unwrap();
        assert_eq!(find_on_path("codex", &[dir.clone()]), Some(dir.join("codex.cmd")));
        assert_eq!(find_on_path("claude", &[dir.clone()]), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
