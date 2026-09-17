# Project status

CLI Desk 1.0 uses Tauri 2, a verified private Node.js runtime and the system WebView. Claude Code is implemented; Codex and other providers remain planned.

Preserved features: separate conversations and work folders, streaming Markdown, code copying, export, approvals and AskUserQuestion, drafts, resume, cancellation, three concurrent conversations, default and editable per-conversation model IDs, configurable Enter/Shift+Enter sending, managed local archives with restore and permanent deletion, tray lifecycle and backups.

Windows upgrades install over the existing current-user copy while keeping the stable application identity and data directory. Desktop shortcut creation is opt-in on the installer finish page.

The configured default work folder is an existing project directory used directly by new conversations; multiple conversations may share it, and generated files belong to that project rather than to individual conversations. The sidebar uses second-precision timestamps, conversation actions can open the validated work directory, and sending remains disabled while a response is active.

The desktop uses private stdio to a bundled JavaScript backend. The packaged Node runtime is checksum-pinned at build time and version-checked at startup, so end users do not configure Node. Credentials and CLI settings remain with Claude. Existing CLI Desk profiles are reused.

Automated fixtures establish software/protocol behavior only. Real-provider acceptance must check normal conversation, disposable file reads/edits, approval decisions, cancellation and restart/resume. macOS installation/UI checks require an Apple Silicon Mac.

This is not a terminal emulator. CLI maintenance stays in the terminal. Windows ARM64, Intel Mac distribution, WSL-only installations, custom batch wrappers and automatic import of CLI conversations remain outside the supported distribution scope.
