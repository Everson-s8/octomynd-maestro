//! Events streamed from Rust to the setup window on the `setup` channel.
//! The `type` field discriminates; the UI renders stages from these alone.

use serde::Serialize;

pub const CHANNEL: &str = "setup";

#[derive(Debug, Clone, Serialize)]
pub struct StageInfo {
    pub name: &'static str,
    pub title: &'static str,
}

/// The fixed plan shown before anything runs. Order is execution order.
pub const STAGES: [StageInfo; 7] = [
    StageInfo { name: "system", title: "Verificando o computador" },
    StageInfo { name: "release", title: "Buscando a versão mais recente" },
    StageInfo { name: "download", title: "Baixando o Maestro" },
    StageInfo { name: "verify", title: "Conferindo a integridade" },
    StageInfo { name: "install", title: "Instalando o aplicativo" },
    StageInfo { name: "cli", title: "Registrando o comando maestro" },
    StageInfo { name: "tools", title: "Procurando Git e agentes" },
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StageState {
    Running,
    Done,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolReport {
    pub id: &'static str,
    pub label: &'static str,
    pub found: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub version: String,
    #[serde(rename = "installDir")]
    pub install_dir: String,
    pub tools: Vec<ToolReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SetupEvent {
    Stage {
        name: &'static str,
        state: StageState,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    /// Live detail for the running stage; `fraction` is None when the work
    /// has no measurable size (the NSIS copy, for example).
    Progress {
        name: &'static str,
        fraction: Option<f64>,
        detail: String,
    },
    Log {
        line: String,
    },
    Finished {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<Summary>,
        #[serde(rename = "logPath")]
        log_path: String,
    },
}
