# Project instructions

## Scope

CLI Desk is a local Windows and macOS desktop UI for AI coding CLIs. Currently only Claude Code is implemented; Codex and other providers are planned. Keep the product small: a conversation list, transcript, composer, and essential connection settings. Use Chinese for user-facing interface text.

## Development

- JavaScript source is in `src/`; the Tauri desktop shell is in `src-tauri/`. `scripts/build.mjs` creates `dist/ui/` and `dist/backend/`. Never edit generated bundles as the source of truth.
- Use the installed Claude CLI via the official SDK. Preserve `user`, `project`, and `local` settings. Do not silently enable permission bypass or save API credentials in this app.
- Keep Tauri capabilities restricted to the local main window. Expose narrow IPC methods, validate their inputs, sanitize model-generated Markdown, and keep backend communication on private stdio. Bundle a verified private Node runtime, use the system WebView, and continue calling the user-installed Claude CLI.
- Keep sessions separate, retain interrupted replies, and preserve atomic writes plus recovery backups.
- Never commit `node_modules/`, app profiles, test outputs, installers, secrets, or personal machine paths. Installer binaries belong in release attachments, not Git history.
- All fixtures must be clearly marked. A passing fixture test is not proof that a real account or provider works.

## Validation

- After code changes, run `npm run verify:installer` locally before handing over an installer or pushing changes. Fix failures before delivery.
- Keep repository content product-related. Never commit local conversation history, personal account details, machine-specific configuration, or temporary handoff notes.

- `npm ci --omit=optional` installs dependencies. `npm run setup:desktop` installs the host Tauri CLI without downloading bundled Claude binaries. Rust and the native platform build tools are required.
- `npm run build` builds the app; `npm test` runs unit and SDK protocol tests.
- For UI/lifecycle changes, run `npm run test:ui` after building.
- For packaging/runtime changes, run `npm run package` and `npm run test:packaged`.
- See `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md` and `docs/PROJECT_STATUS.md` for architecture and known gaps.
