# Repository Guidelines

## Project Structure and Module Organization

This repository contains a TypeScript VS Code extension. Runtime code lives in `src/`: `extension.ts` registers commands and activation behavior, `blogExplorer.ts` and `blogSearch.ts` provide views, and `mapStore.ts` manages the JSON entry index. Shared interfaces belong in `src/types.ts`.

Tests are under `src/test/`. Keep fast, VS Code-independent tests beside `mapStore.test.ts`; place Extension Host tests in `src/test/suite/`. TypeScript compiles to the generated `out/` directory. The activity-bar icon is in `resources/`, while `dogfood/` is sample journal data used by the workspace configuration.

## Build, Test, and Development Commands

- `npm install`: install the locked development dependencies.
- `npm run compile`: type-check and compile `src/` into `out/`.
- `npm run watch`: recompile continuously during development.
- `npm run lint`: run ESLint against all TypeScript source files.
- `npm run test:unit`: run the compiled Mocha unit tests.
- `npm run test:integration`: launch VS Code Electron and run Extension Host tests.
- `npm test`: compile, lint, then run both test suites.

Press F5 in VS Code to start an Extension Development Host. The configured task installs dependencies and starts the compiler watcher first.

## Coding Style and Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, semicolons, trailing commas in multiline constructs, and explicit types at module boundaries. The compiler uses `strict` mode. Use `camelCase` for variables and functions, `PascalCase` for classes and interfaces, and `UPPER_CASE` only for constants. Run `npm run lint` before submitting changes. Do not edit generated files in `out/`.

## Testing Guidelines

Tests use Mocha's TDD interface with Node's `assert` module. Name files `*.test.ts` and write behavior-focused test names, for example `test("upsertEntry replaces a legacy path", ...)`. Add unit coverage for storage and path logic; add integration coverage when behavior depends on VS Code commands, activation, or views. No numeric coverage threshold is configured, but bug fixes should include a regression test.

## Commit and Pull Request Guidelines

Recent commits use short, imperative subjects such as `Fix auto-install of dependencies before F5 launch`. Keep each commit focused. Pull requests should explain the user-visible change, list verification commands, and link the relevant issue. Include screenshots for tree-view or other UI changes, and call out configuration or journal-format compatibility impacts.

## Issue Classification

Apply exactly one of `bug`, `feature`, or `chore` to every issue. Add `agent-origin` when an automated agent authored the issue; never infer origin from writing style.
