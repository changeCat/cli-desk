use crate::runtime;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;
pub struct Backend {
    pub root: PathBuf,
    pub script: PathBuf,
    pub node: PathBuf,
    pub node_version: String,
    pub bundled_node: bool,
    pub fixture: bool,
    client: Mutex<Option<Arc<Client>>>,
}
struct Client {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Pending,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
    #[cfg(windows)]
    _job: Job,
}
#[cfg(windows)]
struct Job(isize);
#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                let error = std::io::Error::last_os_error().to_string();
                CloseHandle(handle);
                return Err(error);
            }
            Ok(Self(handle as isize))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        if let Ok(stdin) = self.stdin.get_mut() {
            stdin.take();
        }
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Backend {
    pub fn new(root: PathBuf, script: PathBuf, node: runtime::Runtime, fixture: bool) -> Self {
        Self {
            root,
            script,
            node: node.path,
            node_version: node.version,
            bundled_node: node.bundled,
            fixture,
            client: Mutex::new(None),
        }
    }
    fn connect(&self, app: &AppHandle) -> Result<Arc<Client>, String> {
        let mut slot = self.client.lock().map_err(|e| e.to_string())?;
        if let Some(client) = slot.as_ref() {
            if client.alive.load(Ordering::SeqCst) {
                return Ok(client.clone());
            }
        }
        // Do not silently replace a failed backend while old tasks could still exist.
        if slot.is_some() {
            return Err("后台连接已中断，请退出后重新打开应用。已保存的记录会保留。".into());
        }
        let mut cmd = runtime::command(&self.node);
        // Tauri's Windows resource directory can use a verbatim path (\\?\).
        // Node's entry-point resolver requires the ordinary path when possible.
        cmd.arg(dunce::simplified(&self.script))
            .arg(dunce::simplified(&self.root))
            .arg(app.package_info().version.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if self.fixture {
            cmd.arg("--fixture");
        }
        let mut child = cmd.spawn().map_err(|e| format!("Node 后台启动失败：{e}"))?;
        #[cfg(windows)]
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let stdout = child.stdout.take().ok_or("缺少后台输出管道")?;
        let stdin = child.stdin.take();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let client = Arc::new(Client {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            next: AtomicU64::new(1),
            alive: alive.clone(),
            #[cfg(windows)]
            _job: job,
        });
        let app = app.clone();
        thread::spawn(move || {
            let mut statuses: HashMap<String, String> = HashMap::new();
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(event) = value.get("event") {
                    if event["type"] == "session" {
                        if let (Some(id), Some(status)) = (
                            event["data"]["id"].as_str(),
                            event["data"]["status"].as_str(),
                        ) {
                            let previous = statuses.insert(id.to_string(), status.to_string());
                            let changed = previous.as_deref() != Some(status);
                            let finished = previous
                                .as_deref()
                                .is_some_and(|s| ["running", "waiting", "stopping"].contains(&s))
                                && ["idle", "error"].contains(&status);
                            if changed && (status == "waiting" || finished) {
                                if let Some(win) = app.get_webview_window("main") {
                                    if !win.is_focused().unwrap_or(true) {
                                        let _ = win.request_user_attention(Some(
                                            tauri::UserAttentionType::Informational,
                                        ));
                                    }
                                }
                            }
                        }
                    }
                    let _ = app.emit("desk:event", event);
                } else if let Some(id) = value["id"].as_u64() {
                    if let Some(sender) = pending.lock().unwrap().remove(&id) {
                        let result = if value["ok"] == true {
                            Ok(value["data"].clone())
                        } else {
                            Err(value["error"].as_str().unwrap_or("后台请求失败").into())
                        };
                        let _ = sender.send(result);
                    }
                }
            }
            alive.store(false, Ordering::SeqCst);
            for (_, sender) in pending.lock().unwrap().drain() {
                let _ = sender.send(Err("Node 后台已退出，请重新打开应用".into()));
            }
            let _ = app.emit("desk:event",json!({"type":"backend-disconnected","data":"后台连接已中断，请退出后重新打开应用。已保存的记录会保留；当前未保存的内容请先复制。"}));
        });
        *slot = Some(client.clone());
        Ok(client)
    }
    pub async fn request(&self, app: &AppHandle, method: &str, payload: Value) -> Reply {
        let client = self.connect(app)?;
        let id = client.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        client.pending.lock().unwrap().insert(id, tx);
        let message = json!({"id":id,"method":method,"payload":payload}).to_string() + "\n";
        let written = client
            .stdin
            .lock()
            .unwrap()
            .as_mut()
            .ok_or_else(|| "后台正在退出".to_string())
            .and_then(|stdin| {
                stdin
                    .write_all(message.as_bytes())
                    .map_err(|e| e.to_string())
            });
        if let Err(error) = written {
            client.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let seconds = match method {
            "active" => 3,
            "shutdown" => 6,
            _ => 25,
        };
        let result = tokio::time::timeout(Duration::from_secs(seconds), rx).await;
        client.pending.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("后台连接已关闭".into()),
            Err(_) => Err("后台请求超时，请检查 Claude 配置".into()),
        }
    }
    pub fn started(&self) -> bool {
        self.client.lock().unwrap().is_some()
    }
    pub fn terminate(&self) {
        self.client.lock().unwrap().take();
    }
    pub async fn shutdown(&self, app: &AppHandle) {
        if self.started() {
            let _ = self.request(app, "shutdown", Value::Null).await;
        }
        self.terminate();
    }
}
