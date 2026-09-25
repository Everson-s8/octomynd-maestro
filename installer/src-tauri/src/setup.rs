//! The install pipeline. Each stage reports real work: bytes downloaded, the
//! published hash, the NSIS exit code, files on disk, the user PATH.
//!
//! The NSIS payload stays the unit of installation because electron-updater
//! updates the app by running that same installer silently.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter};

use crate::events::{SetupEvent, StageState, Summary, ToolReport, CHANNEL};
use crate::platform;
use crate::release::{self, ReleaseInfo, RELEASE_BASE_URL};

const USER_AGENT: &str = concat!("Maestro-Setup/", env!("MAESTRO_PRODUCT_VERSION"));
const REQUIRED_FREE_BYTES: u64 = 900 * 1024 * 1024;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct Reporter {
    app: AppHandle,
    log: Mutex<Option<std::fs::File>>,
    pub log_path: PathBuf,
}

impl Reporter {
    pub fn new(app: AppHandle) -> Self {
        let dir = platform::setup_data_dir().join("logs");
        let log_path = dir.join(format!("setup-{}.log", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        let file = std::fs::create_dir_all(&dir).ok().and_then(|_| std::fs::File::create(&log_path).ok());
        Self { app, log: Mutex::new(file), log_path }
    }

    fn emit(&self, event: SetupEvent) {
        let _ = self.app.emit(CHANNEL, event);
    }

    pub fn log(&self, line: impl Into<String>) {
        let line = line.into();
        if let Ok(mut guard) = self.log.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = writeln!(file, "{} {line}", chrono::Local::now().format("%H:%M:%S%.3f"));
            }
        }
        self.emit(SetupEvent::Log { line });
    }

    fn stage(&self, name: &'static str, state: StageState, detail: Option<String>, started: Option<Instant>) {
        self.log(format!("[{name}] {state:?}{}", detail.as_deref().map(|d| format!(": {d}")).unwrap_or_default()));
        self.emit(SetupEvent::Stage {
            name,
            state,
            detail,
            duration_ms: started.map(|at| at.elapsed().as_millis() as u64),
        });
    }

    fn progress(&self, name: &'static str, fraction: Option<f64>, detail: String) {
        self.emit(SetupEvent::Progress { name, fraction, detail });
    }

    pub fn finished(&self, result: Result<Summary, String>) {
        let log_path = self.log_path.to_string_lossy().to_string();
        match result {
            Ok(summary) => {
                self.log(format!("Setup finished: Maestro {} in {}", summary.version, summary.install_dir));
                self.emit(SetupEvent::Finished { ok: true, error: None, summary: Some(summary), log_path });
            }
            Err(error) => {
                self.log(format!("Setup failed: {error}"));
                self.emit(SetupEvent::Finished { ok: false, error: Some(error), summary: None, log_path });
            }
        }
    }
}

pub struct SetupOptions {
    pub install_dir: PathBuf,
    /// A local NSIS payload (`--payload` or MAESTRO_SETUP_PAYLOAD) for offline
    /// installs and testing a release candidate before it is published.
    pub payload_override: Option<PathBuf>,
}

fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0).replace('.', ",")
}

fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0).replace('.', ",")
}

/// Runs one stage: `Running` first, then `Done` with the returned detail or
/// `Failed` with the error. A detail starting with "skip:" marks it skipped.
async fn stage<T, F>(rep: &Reporter, name: &'static str, work: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<(T, String), String>>,
{
    let started = Instant::now();
    rep.stage(name, StageState::Running, None, None);
    match work.await {
        Ok((value, detail)) => {
            let (state, detail) = match detail.strip_prefix("skip:") {
                Some(rest) => (StageState::Skipped, rest.to_owned()),
                None => (StageState::Done, detail),
            };
            rep.stage(name, state, Some(detail), Some(started));
            Ok(value)
        }
        Err(error) => {
            rep.stage(name, StageState::Failed, Some(error.clone()), Some(started));
            Err(error)
        }
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("Instalação cancelada.".into())
    } else {
        Ok(())
    }
}

pub async fn run(rep: Arc<Reporter>, options: SetupOptions, cancel: Arc<AtomicBool>) -> Result<Summary, String> {
    let install_dir = options.install_dir.clone();
    rep.log(format!("Maestro Setup {} · destino {}", env!("MAESTRO_PRODUCT_VERSION"), install_dir.display()));

    stage(&rep, "system", async {
        if !cfg!(windows) {
            return Err("Este instalador é para Windows.".into());
        }
        if platform::is_maestro_running() {
            return Err("O Maestro está aberto. Feche o Maestro e tente de novo.".into());
        }
        let free = platform::free_space_bytes(&install_dir);
        if let Some(free) = free {
            if free < REQUIRED_FREE_BYTES {
                return Err(format!("Espaço insuficiente: {} livres, são necessários {}.", gigabytes(free), gigabytes(REQUIRED_FREE_BYTES)));
            }
        }
        let installed = platform::installed_version(&install_dir);
        let detail = match (installed, free) {
            (Some(version), Some(free)) => format!("Maestro {version} já instalado · {} livres", gigabytes(free)),
            (None, Some(free)) => format!("Windows pronto · {} livres", gigabytes(free)),
            (Some(version), None) => format!("Maestro {version} já instalado"),
            (None, None) => "Windows pronto".into(),
        };
        Ok(((), detail))
    })
    .await?;
    check_cancel(&cancel)?;

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Não foi possível preparar a conexão: {error}"))?;

    let release: Option<ReleaseInfo> = stage(&rep, "release", async {
        if let Some(payload) = &options.payload_override {
            if !payload.is_file() {
                return Err(format!("Arquivo local não encontrado: {}", payload.display()));
            }
            let sibling = payload.with_file_name("latest.yml");
            let info = std::fs::read_to_string(&sibling).ok().and_then(|text| release::parse_latest_yml(&text).ok());
            let detail = match &info {
                Some(info) => format!("skip:Arquivo local · Maestro {}", info.version),
                None => "skip:Arquivo local, sem latest.yml ao lado".into(),
            };
            return Ok((info, detail));
        }
        let url = format!("{RELEASE_BASE_URL}/latest.yml");
        rep.log(format!("GET {url}"));
        let response = client
            .get(&url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("Não foi possível consultar a versão publicada. Verifique a internet. ({error})"))?;
        let text = response.text().await.map_err(|error| format!("Resposta incompleta do GitHub: {error}"))?;
        let info = release::parse_latest_yml(&text)?;
        let size = info.size.map(|size| format!(" · {}", megabytes(size))).unwrap_or_default();
        let detail = format!("Maestro {}{size}", info.version);
        Ok((Some(info), detail))
    })
    .await?;
    check_cancel(&cancel)?;

    // Never downgrade: a local build or an update newer than the published
    // release is kept, and only the PATH and tool checks run.
    let installed = platform::installed_version(&install_dir);
    if let (None, Some(info), Some(current)) = (&options.payload_override, &release, &installed) {
        if !is_older(current, &info.version) {
            let reason = format!("skip:A versão instalada ({current}) já é igual ou mais nova que a publicada ({})", info.version);
            for name in ["download", "verify", "install"] {
                stage(&rep, name, async { Ok(((), reason.clone())) }).await?;
            }
            return finish(&rep, &install_dir, release.as_ref(), false).await;
        }
    }

    let payload: PathBuf = stage(&rep, "download", async {
        if let Some(payload) = &options.payload_override {
            return Ok((payload.clone(), "skip:Usando o arquivo local".to_owned()));
        }
        let info = release.as_ref().ok_or("Versão publicada desconhecida")?;
        let dir = platform::download_cache_dir();
        std::fs::create_dir_all(&dir).map_err(|error| format!("Não foi possível criar {}: {error}", dir.display()))?;
        let target = dir.join(&info.file_name);
        if target.is_file() && info.size.is_some_and(|size| std::fs::metadata(&target).map(|m| m.len() == size).unwrap_or(false)) {
            return Ok((target, "skip:Já estava baixado; a integridade é conferida a seguir".to_owned()));
        }
        download(&rep, &client, &info.download_url(), &target, info.size, &cancel).await?;
        let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        Ok((target, megabytes(size)))
    })
    .await?;
    check_cancel(&cancel)?;

    stage(&rep, "verify", async {
        let Some(info) = release.as_ref() else {
            return Ok(((), "skip:Sem hash publicado para o arquivo local".to_owned()));
        };
        let expected = info.sha512.clone();
        let path = payload.clone();
        let actual = tokio::task::spawn_blocking(move || sha512_base64(&path))
            .await
            .map_err(|error| format!("Falha ao calcular o hash: {error}"))??;
        if actual != expected {
            if options.payload_override.is_none() {
                let _ = std::fs::remove_file(&payload);
            }
            return Err("O arquivo baixado não confere com a versão publicada. Tente de novo.".into());
        }
        Ok(((), "sha512 confere com o latest.yml".to_owned()))
    })
    .await?;
    check_cancel(&cancel)?;

    // From here on the NSIS payload is changing files; cancelling mid-copy
    // would leave a half-installed app, so the UI hides Cancel.
    stage(&rep, "install", async {
        run_nsis(&rep, &payload, &install_dir).await?;
        let exe = install_dir.join("Maestro.exe");
        if !exe.is_file() {
            return Err(format!("O instalador terminou, mas {} não existe.", exe.display()));
        }
        let version = platform::installed_version(&install_dir).unwrap_or_else(|| "?".into());
        Ok(((), format!("Maestro {version} em {}", install_dir.display())))
    })
    .await?;

    finish(&rep, &install_dir, release.as_ref(), true).await
}

/// Numeric dotted comparison ("0.4.10" > "0.4.9"); pre-release tags are ignored.
fn is_older(installed: &str, published: &str) -> bool {
    let parts = |version: &str| -> Vec<u64> {
        version
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (left, right) = (parts(installed), parts(published));
    for index in 0..left.len().max(right.len()) {
        let (a, b) = (left.get(index).copied().unwrap_or(0), right.get(index).copied().unwrap_or(0));
        if a != b {
            return a < b;
        }
    }
    false
}

async fn finish(rep: &Reporter, install_dir: &Path, release: Option<&ReleaseInfo>, updated: bool) -> Result<Summary, String> {
    stage(rep, "cli", async {
        if !install_dir.join("maestro.cmd").is_file() {
            return Ok(((), "skip:Esta versão não inclui o comando maestro".to_owned()));
        }
        let changed = platform::ensure_user_path_contains(install_dir)?;
        Ok(((), if changed { "Adicionado ao PATH; abra um terminal novo".to_owned() } else { "Disponível em terminais novos".to_owned() }))
    })
    .await?;

    let tools = stage(rep, "tools", async {
        let tools = detect_tools();
        let found: Vec<&str> = tools.iter().filter(|tool| tool.found).map(|tool| tool.label).collect();
        let detail = if found.is_empty() { "Nenhum encontrado ainda".to_owned() } else { format!("{} encontrado{}", found.join(", "), if found.len() > 1 { "s" } else { "" }) };
        for tool in &tools {
            rep.log(format!("  {} · {}", tool.label, tool.detail.as_deref().unwrap_or(if tool.found { "encontrado" } else { "não encontrado" })));
        }
        Ok((tools, detail))
    })
    .await?;

    Ok(Summary {
        version: platform::installed_version(install_dir)
            .or_else(|| release.map(|info| info.version.clone()))
            .unwrap_or_else(|| "?".into()),
        updated,
        install_dir: install_dir.to_string_lossy().to_string(),
        tools,
    })
}

async fn download(
    rep: &Reporter,
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    expected_size: Option<u64>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    rep.log(format!("GET {url}"));
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("O download não começou. Verifique a internet. ({error})"))?;
    let total = response.content_length().or(expected_size);
    let partial = target.with_extension("partial");
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|error| format!("Não foi possível gravar {}: {error}", partial.display()))?;
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let started = Instant::now();
    let mut last_report = Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            return Err("Instalação cancelada.".into());
        }
        let chunk = chunk.map_err(|error| format!("O download foi interrompido. Tente de novo. ({error})"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| format!("Falha ao gravar o download: {error}"))?;
        received += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(120) {
            last_report = Instant::now();
            let speed = received as f64 / started.elapsed().as_secs_f64().max(0.1);
            let speed_text = format!("{}/s", megabytes(speed as u64));
            let (fraction, detail) = match total {
                Some(total) if total > 0 => (Some(received as f64 / total as f64), format!("{} de {} · {speed_text}", megabytes(received), megabytes(total))),
                _ => (None, format!("{} · {speed_text}", megabytes(received))),
            };
            rep.progress("download", fraction, detail);
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await.map_err(|error| format!("Falha ao gravar o download: {error}"))?;
    drop(file);
    if let Some(total) = total {
        if received != total {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(format!("Download incompleto: {} de {}.", megabytes(received), megabytes(total)));
        }
    }
    tokio::fs::rename(&partial, target)
        .await
        .map_err(|error| format!("Falha ao finalizar o download: {error}"))?;
    rep.log(format!("Downloaded {} in {:.1}s", megabytes(received), started.elapsed().as_secs_f64()));
    Ok(())
}

fn sha512_base64(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| format!("Não foi possível ler {}: {error}", path.display()))?;
    let mut hasher = Sha512::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("Falha ao ler o instalador: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(hasher.finalize()))
}

async fn run_nsis(rep: &Reporter, payload: &Path, install_dir: &Path) -> Result<(), String> {
    let mut command = tokio::process::Command::new(payload);
    command.arg("/S");
    // NSIS requires /D= last and unquoted. Only pass it for a non-default
    // location so updates keep electron-builder's remembered path.
    if install_dir != platform::default_install_dir() {
        command.arg(format!("/D={}", install_dir.display()));
    }
    #[cfg(windows)]
    command.creation_flags(platform::CREATE_NO_WINDOW);
    rep.log(format!("Running {} /S", payload.display()));
    let started = Instant::now();
    let mut child = command.spawn().map_err(|error| format!("Não foi possível iniciar o instalador: {error}"))?;
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|error| format!("O instalador falhou: {error}"))?,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                let seconds = started.elapsed().as_secs();
                if started.elapsed() > INSTALL_TIMEOUT {
                    let _ = child.kill().await;
                    return Err("O instalador não terminou em 15 minutos.".into());
                }
                rep.progress("install", None, format!("Copiando os arquivos do app · {seconds} s"));
            }
        }
    };
    rep.log(format!("NSIS exited with {status}"));
    if status.success() {
        Ok(())
    } else {
        Err(format!("O instalador terminou com código {}.", status.code().map(|code| code.to_string()).unwrap_or_else(|| "desconhecido".into())))
    }
}

fn detect_tools() -> Vec<ToolReport> {
    let dirs = platform::fresh_path_dirs();
    let candidates: [(&'static str, &'static str, &'static str); 4] = [
        ("git", "Git", "git"),
        ("codex", "Codex", "codex"),
        ("claude", "Claude Code", "claude"),
        ("gemini", "Gemini CLI", "gemini"),
    ];
    candidates
        .into_iter()
        .map(|(id, label, binary)| {
            let found = platform::find_on_path(binary, &dirs);
            let detail = match (&found, id) {
                (Some(path), "git") => git_version(path).or_else(|| Some("encontrado".into())),
                (Some(_), _) => Some("encontrado".into()),
                (None, _) => None,
            };
            ToolReport { id, label, found: found.is_some(), detail }
        })
        .collect()
}

fn git_version(path: &Path) -> Option<String> {
    let mut command = std::process::Command::new(path);
    command.arg("--version");
    platform::hide_window(&mut command);
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace().nth(2).map(|version| version.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_sizes_in_portuguese() {
        assert_eq!(megabytes(119_737_169), "114,2 MB");
        assert_eq!(gigabytes(900 * 1024 * 1024), "0,9 GB");
    }

    #[test]
    fn never_treats_a_newer_install_as_older() {
        assert!(is_older("0.4.0", "0.4.1"));
        assert!(is_older("0.4.9", "0.4.10"));
        assert!(!is_older("0.4.2", "0.4.1"));
        assert!(!is_older("0.4.1", "0.4.1"));
        assert!(!is_older("v1.0.0", "0.9.9"));
        assert!(!is_older("0.5.0-beta.1", "0.4.9"));
    }

    #[test]
    fn hashes_like_electron_builder() {
        let path = std::env::temp_dir().join(format!("maestro-setup-hash-{}", std::process::id()));
        std::fs::write(&path, b"maestro").unwrap();
        let expected = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(b"maestro"));
        assert_eq!(sha512_base64(&path).unwrap(), expected);
        std::fs::remove_file(&path).unwrap();
    }
}
