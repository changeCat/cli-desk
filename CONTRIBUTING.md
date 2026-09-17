# Contributing

See [development setup](docs/DEVELOPMENT.md) before editing. Keep changes focused and include the affected validation results in your pull request.

1. Create a branch for the change.
2. Modify source files and add meaningful tests for changed behavior.
3. Run `npm run build` and `npm test`. Run UI or packaging checks when relevant.
4. Describe the user-visible problem, resulting behavior, and remaining limitations.

Do not include provider credentials, local chat histories, real project content, or user-specific paths in screenshots, logs, issues, or fixtures. Use a temporary test workspace.

Installers and generated outputs should be uploaded as release/CI artifacts rather than committed. The app's code is MIT licensed; dependencies keep their own licenses.
