//! The published release as electron-updater sees it: `latest.yml` on the
//! GitHub release names the NSIS payload and its sha512 (base64).

pub const RELEASE_BASE_URL: &str = "https://github.com/Octomynd/octomynd-maestro/releases/latest/download";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    pub version: String,
    pub file_name: String,
    pub sha512: String,
    pub size: Option<u64>,
}

impl ReleaseInfo {
    pub fn download_url(&self) -> String {
        format!("{RELEASE_BASE_URL}/{}", self.file_name)
    }
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches(|c| c == '\'' || c == '"').to_owned()
}

/// Reads the top-level `version`, `path` and `sha512` keys, plus the size of
/// the matching entry under `files`. The format is fixed by electron-builder,
/// so a line reader is enough and avoids a YAML dependency.
pub fn parse_latest_yml(text: &str) -> Result<ReleaseInfo, String> {
    let mut version = None;
    let mut path = None;
    let mut sha512 = None;
    let mut sizes: Vec<(String, u64)> = Vec::new();
    let mut current_url: Option<String> = None;
    for line in text.lines() {
        if line.starts_with(' ') || line.starts_with('-') {
            let entry = line.trim_start_matches([' ', '-']);
            if let Some(url) = entry.strip_prefix("url:") {
                current_url = Some(unquote(url));
            } else if let Some(size) = entry.strip_prefix("size:") {
                if let (Some(url), Ok(size)) = (current_url.clone(), size.trim().parse::<u64>()) {
                    sizes.push((url, size));
                }
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            match key.trim() {
                "version" => version = Some(unquote(value)),
                "path" => path = Some(unquote(value)),
                "sha512" => sha512 = Some(unquote(value)),
                _ => {}
            }
        }
    }
    let file_name = path.ok_or("latest.yml não informa o arquivo do instalador")?;
    if file_name.contains(['/', '\\']) || !file_name.to_ascii_lowercase().ends_with(".exe") {
        return Err(format!("latest.yml aponta para um arquivo inesperado: {file_name}"));
    }
    Ok(ReleaseInfo {
        version: version.ok_or("latest.yml não informa a versão")?,
        size: sizes.iter().find(|(url, _)| url == &file_name).map(|(_, size)| *size),
        file_name,
        sha512: sha512.ok_or("latest.yml não informa o sha512")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "version: 0.4.1\nfiles:\n  - url: Maestro-Setup-0.4.1-x64.exe\n    sha512: abc==\n    size: 119737169\npath: Maestro-Setup-0.4.1-x64.exe\nsha512: abc==\nreleaseDate: '2026-09-24T17:54:11.000Z'\n";

    #[test]
    fn parses_electron_builder_latest_yml() {
        let info = parse_latest_yml(SAMPLE).unwrap();
        assert_eq!(info.version, "0.4.1");
        assert_eq!(info.file_name, "Maestro-Setup-0.4.1-x64.exe");
        assert_eq!(info.sha512, "abc==");
        assert_eq!(info.size, Some(119_737_169));
        assert_eq!(info.download_url(), format!("{RELEASE_BASE_URL}/Maestro-Setup-0.4.1-x64.exe"));
    }

    #[test]
    fn rejects_a_path_outside_the_release() {
        let text = SAMPLE.replace("path: Maestro-Setup-0.4.1-x64.exe", "path: ../evil.exe");
        assert!(parse_latest_yml(&text).is_err());
    }

    #[test]
    fn requires_the_hash() {
        let text = "version: 1.0.0\npath: Maestro-Setup-1.0.0-x64.exe\n";
        assert!(parse_latest_yml(text).is_err());
    }
}
