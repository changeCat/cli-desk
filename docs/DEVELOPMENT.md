# Development

Requirements: Node.js 22.12+ (24 LTS recommended), Rust stable, and native build tools. Windows needs Microsoft C++ Build Tools with the Desktop development with C++ workload and Windows SDK. macOS needs Xcode command-line tools. See https://v2.tauri.app/start/prerequisites/.

Install with npm ci --omit=optional, then npm run setup:desktop. The latter installs only the host Tauri CLI binary. SDK-distributed Claude binaries stay omitted. Commit package-lock.json and src-tauri/Cargo.lock. Never commit target/, .cache/, profiles or installers.

- npm start: build and open the Tauri development app.
- npm run build: bundle frontend and Node backend.
- npm test: persistence, backend stdio, runtime discovery and SDK protocol tests.
- npm run test:rust: native Rust tests with the committed lockfile.
- node scripts/tauri.mjs build --debug --no-bundle: compile debug desktop for UI tests.
- npm run test:ui: Windows WebView2 interaction and lifecycle fixture checks.
- npm run package: compile release and build the native host installer into release/.
- npm run test:packaged: Windows release executable to external fixture CLI checks.
- npm run verify:installer: all Windows checks, packaging and SHA256 checksums.
- npm run icons: regenerate icon assets from build/icon.svg and review them.

The wrapper scripts/tauri.mjs uses project-local .cache/cargo and .cache/rustup if present, otherwise the system toolchain. These are development paths, never runtime requirements.

Use --profile-dir with an absolute temporary path for tests. --smoke-test is recognized only in debug binaries. Release binaries always call the real SDK and installed CLI. Screenshots stay in test-artifacts; do not commit real account details, chats or machine-specific fixture output.

CI builds Windows x64 and macOS arm64 separately. The macOS job tests backend/Rust and packages the DMG; native Mac UI/installation acceptance remains manual. Windows installers are unsigned; Mac builds use ad-hoc signatures without notarization. Signing secrets do not belong in the repository.
