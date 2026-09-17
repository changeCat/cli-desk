#[cfg(debug_assertions)]
use std::env;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub struct Runtime {
    pub path: PathBuf,
    pub version: String,
    pub bundled: bool,
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("ELECTRON_RUN_AS_NODE");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn version(file: &Path) -> Result<String, String> {
    let mut child = command(file)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map_err(|e| e.to_string())?;
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if status.success() && supported(&value) {
                    return Ok(value);
                }
                return Err("需要 Node.js 22.12 或更新版本".into());
            }
            Ok(None) if Instant::now() < end => thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Node 检测超时".into());
            }
        }
    }
}

pub fn supported(value: &str) -> bool {
    let parts: Vec<u32> = value
        .strip_prefix('v')
        .unwrap_or("")
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect();
    parts.len() == 3 && (parts[0] > 22 || (parts[0] == 22 && parts[1] >= 12))
}

pub fn resolve(resources: &Path) -> Result<Runtime, String> {
    let bundled = resources
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.is_file() {
        let value =
            version(&bundled).map_err(|e| format!("应用自带的 Node 运行环境不可用：{e}"))?;
        return Ok(Runtime {
            path: bundled,
            version: value,
            bundled: true,
        });
    }
    // Development-only fallback for `cargo run` before Tauri stages resources.
    #[cfg(debug_assertions)]
    for file in candidates() {
        if file.is_absolute() && file.is_file() {
            if let Ok(value) = version(&file) {
                return Ok(Runtime {
                    path: file,
                    version: value,
                    bundled: false,
                });
            }
        }
    }
    Err("应用运行组件缺失或损坏，请重新安装 CLI Desk。".into())
}

#[cfg(debug_assertions)]
fn candidates() -> Vec<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|value| {
            env::split_paths(&value)
                .filter(|item| item.is_absolute())
                .map(|item| item.join(name))
                .collect()
        })
        .unwrap_or_default();
    if cfg!(windows) {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(value) = env::var_os(key) {
                paths.push(PathBuf::from(value).join("nodejs/node.exe"));
            }
        }
        if let Some(value) = env::var_os("NVM_SYMLINK") {
            paths.push(PathBuf::from(value).join(name));
        }
    } else {
        paths.extend(
            [
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
            .map(PathBuf::from),
        );
    }
    paths
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_unsupported_or_invalid_versions() {
        for value in ["v18.20.0", "v22.11.0", "unknown", "22.12.0"] {
            assert!(!super::supported(value));
        }
        for value in ["v22.12.0", "v24.14.1"] {
            assert!(super::supported(value));
        }
    }
}
