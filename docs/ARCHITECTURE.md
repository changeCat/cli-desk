# Architecture

CLI Desk 1.0 uses Tauri 2 for its desktop shell, an app-private Node.js runtime for the official Claude Agent SDK, and the system WebView (WebView2 on Windows, WKWebView on macOS). Chromium and Claude binaries are not bundled; the verified Node runtime is private to CLI Desk.

| Layer | Files | Responsibility |
| --- | --- | --- |
| Desktop | src-tauri/src/main.rs | Window, tray, single instance, native dialogs, clipboard and local-only IPC |
| Runtime | src-tauri/src/runtime.rs | Verify and launch the app-private Node runtime |
| Bridge | src-tauri/src/backend.rs | Private JSON-lines stdio, request correlation and process ownership |
| Backend | src/backend/ | Allowlisted requests, store/provider assembly and EOF shutdown |
| Persistence | src/core/store.mjs | Atomic JSON, recovery backups, sessions and drafts |
| Provider | src/providers/ | Official SDK, streaming, approvals, resume and cancellation |
| Platform | src/platform/cli-runtime.mjs | Native/npm Claude discovery and child-process cleanup |
| UI | src/desktop.mjs, renderer.mjs, index.html, style.css | Chinese UI and sanitized Markdown |

## Security and lifecycle

The frontend has no Node integration or general filesystem/shell/process permissions. Tauri capabilities only permit listening to events in the local main window. The command entrypoint checks window/origin. Navigation and new windows are blocked. Native confirmation precedes deletion and external-link opening; export uses a native save picker.

The shell starts the bundled, absolute, version-checked Node executable without a command shell; NODE_OPTIONS and NODE_PATH are removed. Only the bundled backend is launched. Rust and Node validate requests independently. There is no local HTTP server. Closing parent stdin triggers bounded backend shutdown. Windows uses a kill-on-close Job Object for Node and its descendants; the SDK engine owns Claude process groups on macOS.

Closing/minimizing hides the window. Tray click, second-instance launch and macOS activation restore it. Explicit exit confirms active work and saves interrupted replies before stopping children. Backend crashes are reported instead of silently restarting over potentially active tasks.

## Data and distribution

Existing profiles remain at %APPDATA%/CLI Desk on Windows and ~/Library/Application Support/CLI Desk on macOS. Electron-era sessions and settings remain compatible. Legacy runtime.json selections are ignored; credentials remain with the CLI. --profile-dir=<absolute path> isolates both application and WebView data.

The build embeds dist/ui in Tauri and ships dist/backend as native resources. Backend code is not exposed through the web asset protocol. The bundled SDK is always given the user's installed Claude executable. Third-party notices accompany the backend.

Windows NSIS installers reuse WebView2 and download its bootstrapper only if needed. macOS uses WKWebView and an ad-hoc signed arm64 DMG. Both platforms bundle the pinned Node runtime and its license; neither bundles a browser engine.

## Validation

Node tests cover persistence, private stdio, discovery and SDK protocol. Rust tests cover native validation. Windows UI tests attach Playwright to the actual system WebView2 using a test-supplied debugging environment variable. Debug-only fixture hooks exercise native window lifecycle and confirmation responses; release binaries reject them and always use the real SDK. Production tests use an explicitly marked external fixture CLI. Passing fixtures does not verify a real model account.

macOS native UI/installation acceptance requires a Mac. Its CI job tests Node/Rust and builds the DMG; Windows tests do not validate WKWebView.
