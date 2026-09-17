# Changelog

## 1.0.0 — 2026-09-17

- Publish the first standalone CLI Desk release for Windows x64 and macOS Apple Silicon.
- Use Tauri 2 with the system WebView and a checksum-verified private Node.js runtime; continue calling the user's installed Claude CLI through the official Agent SDK.
- Provide separate conversations, streaming Markdown, tool approvals, questions, cancellation, resume, drafts, search and Markdown export.
- Support existing project work folders, per-conversation model IDs, configurable Enter/Shift+Enter sending and bounded concurrent conversations.
- Store local history with atomic writes and recovery backups; manage archived conversations with restore and permanent deletion.
- Include tray lifecycle, secure private stdio IPC, restricted Tauri capabilities and Windows/macOS installer builds.
