#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backend;
mod runtime;
use backend::Backend;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Lifecycle {
    exiting: AtomicBool,
    confirming: AtomicBool,
}
#[derive(Default)]
struct TestDialogs(std::sync::Mutex<Option<bool>>);
fn text(value: &Value, max: usize) -> Result<&str, String> {
    value
        .as_str()
        .filter(|s| s.len() <= max)
        .ok_or_else(|| "无效的输入".into())
}
fn show(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}
fn confirm(app: &AppHandle, title: &str, message: String, accept: &str) -> bool {
    if cfg!(debug_assertions) {
        if let Some(response) = *app.state::<TestDialogs>().0.lock().unwrap() {
            return response;
        }
    }
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            accept.into(),
            "取消".into(),
        ))
        .blocking_show()
}
fn request_quit(app: &AppHandle) {
    let lifecycle = app.state::<Lifecycle>();
    if lifecycle.exiting.load(Ordering::SeqCst) || lifecycle.confirming.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let backend = app.state::<Backend>();
        let active = if backend.started() {
            backend
                .request(&app, "active", Value::Null)
                .await
                .unwrap_or(json!(0))
                .as_u64()
                .unwrap_or(0)
        } else {
            0
        };
        if active > 0 {
            show(&app);
            if !confirm(
                &app,
                "还有对话正在运行",
                "退出会停止本应用启动的任务，已收到的内容会保存。".into(),
                "停止任务并退出",
            ) {
                app.state::<Lifecycle>()
                    .confirming
                    .store(false, Ordering::SeqCst);
                return;
            }
        }
        app.state::<Lifecycle>()
            .exiting
            .store(true, Ordering::SeqCst);
        backend.shutdown(&app).await;
        app.exit(0);
    });
}

#[tauri::command]
async fn desk_request(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let origin = window.url().map_err(|e| e.to_string())?;
    if window.label() != "main" || !local_url(&origin) {
        return Err("拒绝未知窗口请求".into());
    }
    let payload = payload.unwrap_or(Value::Null);
    if payload.to_string().len() > 1200000 {
        return Err("请求过大".into());
    }
    match method.as_str() {
        "state" => {
            let mut state = backend.request(&app, "state", payload).await?;
            state["runtime"] = json!({"path":backend.node,"version":backend.node_version,"bundled":backend.bundled_node});
            Ok(state)
        }
        "get" | "create" | "rename" | "model" | "draft" | "send" | "stop" | "answer"
        | "settings" | "check" | "archives" | "restore" => {
            backend.request(&app, &method, payload).await
        }
        "delete" => {
            let s = backend.request(&app, "get", payload.clone()).await?;
            if ["running", "waiting", "stopping"].contains(&s["status"].as_str().unwrap_or("")) {
                return Err("请先停止任务再归档对话".into());
            }
            backend.request(&app, "delete", payload).await
        }
        "purge" => backend.request(&app, "purge", payload).await,
        "folder" => Ok(app
            .dialog()
            .file()
            .set_title("选择工作文件夹")
            .blocking_pick_folder()
            .map(|p| json!(p.to_string()))
            .unwrap_or(Value::Null)),
        "cli" => Ok(app
            .dialog()
            .file()
            .set_title("选择 Claude 程序")
            .blocking_pick_file()
            .map(|p| json!(p.to_string()))
            .unwrap_or(Value::Null)),
        "copy" => {
            app.clipboard()
                .write_text(text(&payload, 1000000)?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "data" => {
            app.opener()
                .open_path(backend.root.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openCwd" => {
            let session = backend.request(&app, "get", payload).await?;
            let cwd = PathBuf::from(text(&session["cwd"], 32768)?);
            if !cwd.is_absolute() || !cwd.is_dir() {
                return Err("当前工作文件夹不存在".into());
            }
            if backend.fixture {
                return Ok(json!(cwd.to_string_lossy()));
            }
            app.opener()
                .open_path(cwd.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "link" => {
            let input = text(&payload, 10000)?;
            let url = tauri::Url::parse(input).map_err(|_| "无效的链接")?;
            if !["http", "https"].contains(&url.scheme()) {
                return Err("只允许打开 HTTP 或 HTTPS 链接".into());
            }
            if confirm(&app, "打开外部链接？", url.to_string(), "在浏览器打开") {
                app.opener()
                    .open_url(url.to_string(), None::<&str>)
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "export" => {
            let data = backend.request(&app, "export", payload).await?;
            if let Some(file) = app
                .dialog()
                .file()
                .set_file_name(data["name"].as_str().unwrap_or("对话.md"))
                .add_filter("Markdown", &["md"])
                .blocking_save_file()
            {
                let file = file.into_path().map_err(|e| e.to_string())?;
                fs::write(file, data["body"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
                Ok(json!(true))
            } else {
                Ok(json!(false))
            }
        }
        _ => Err("不支持的操作".into()),
    }
}

// Deterministic desktop test hooks exist only in debug builds; production rejects them.
#[tauri::command]
fn test_desktop(app: AppHandle, action: String, response: Option<bool>) -> Result<Value, String> {
    if !cfg!(debug_assertions) || !app.state::<Backend>().fixture {
        return Err("测试接口不可用".into());
    }
    let win = app.get_webview_window("main").ok_or("窗口不存在")?;
    match action.as_str() {
        "close" => win.close().map_err(|e| e.to_string())?,
        "minimize" => win.minimize().map_err(|e| e.to_string())?,
        "show" => show(&app),
        "wide" => win
            .set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: 1500.0,
                height: 900.0,
            }))
            .map_err(|e| e.to_string())?,
        "confirm" => *app.state::<TestDialogs>().0.lock().unwrap() = response,
        "quit" => request_quit(&app),
        "status" => return Ok(json!({"visible":win.is_visible().unwrap_or(false)})),
        _ => return Err("未知测试操作".into()),
    }
    Ok(Value::Null)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Lifecycle::default())
        .manage(TestDialogs::default())
        .invoke_handler(tauri::generate_handler![desk_request, test_desktop])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let profile = args
                .iter()
                .find_map(|s| s.strip_prefix("--profile-dir="))
                .map(PathBuf::from)
                .filter(|p| p.is_absolute());
            let root = profile.unwrap_or(app.path().config_dir()?.join("CLI Desk"));
            fs::create_dir_all(&root)?;
            let resources = app.path().resource_dir()?;
            let node = runtime::resolve(&resources).map_err(std::io::Error::other)?;
            let script = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/backend/worker.mjs")
            } else {
                resources.join("backend/worker.mjs")
            };
            let fixture = cfg!(debug_assertions) && args.iter().any(|s| s == "--smoke-test");
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(root.join("webview"))
                .on_navigation(local_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            app.manage(Backend::new(root, script, node, fixture));
            let open = MenuItem::with_id(app, "open", "打开窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let icon = if cfg!(target_os = "macos") {
                tauri::image::Image::from_bytes(include_bytes!("../../build/trayTemplate.png"))?
            } else {
                app.default_window_icon().unwrap().clone()
            };
            TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("CLI Desk · 点击打开，右键退出")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => request_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{PredefinedMenuItem, Submenu};
                let quit = MenuItem::with_id(app, "quit", "退出 CLI Desk", true, Some("Cmd+Q"))?;
                let app_menu = Submenu::with_items(app, "CLI Desk", true, &[&quit])?;
                let edit = Submenu::with_items(
                    app,
                    "编辑",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;
                app.set_menu(Menu::with_items(app, &[&app_menu, &edit])?)?;
                app.on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        request_quit(app)
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|win, event| {
            let exiting = win.state::<Lifecycle>().exiting.load(Ordering::SeqCst);
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } if !exiting => {
                    api.prevent_close();
                    let _ = win.hide();
                }
                tauri::WindowEvent::Resized(_)
                    if !exiting && win.is_minimized().unwrap_or(false) =>
                {
                    let _ = win.hide();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 CLI Desk");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. }
            if !app.state::<Lifecycle>().exiting.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
            request_quit(app);
        }
        tauri::RunEvent::Exit => app.state::<Backend>().terminate(),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}

fn local_url(url: &tauri::Url) -> bool {
    url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (["http", "https"].contains(&url.scheme())
                && url.host_str() == Some("tauri.localhost")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn ipc_only_accepts_bundled_pages() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(super::local_url(&tauri::Url::parse(url).unwrap()));
        }
        for url in [
            "https://example.com/",
            "http://localhost/",
            "file:///etc/passwd",
            "http://tauri.localhost:8000/",
            "http://user@tauri.localhost/",
        ] {
            assert!(!super::local_url(&tauri::Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn native_payloads_require_bounded_strings() {
        assert!(super::text(&serde_json::json!(false), 80).is_err());
        assert!(super::text(&serde_json::json!("abc"), 2).is_err());
        assert_eq!(super::text(&serde_json::json!("abc"), 3).unwrap(), "abc");
    }
}
