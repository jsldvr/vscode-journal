# Test system

All test code, test configuration, fixtures, orchestration scripts, compiled
test output, and reports belong under this directory. Generated files are
written to `test/results/`, which is ignored by Git and created by the test
commands when needed.

## Fast and ordinary checks

- `npm run test:unit` compiles and runs deterministic unit tests.
- `npm run test:property` checks generated path, frontmatter, and grouping
  invariants with reproducible `fast-check` failures.
- `npm run test:release` checks SemVer classification, changelog extraction,
  contributor attribution, and generated GitHub release metadata.
- `npm run test:acceptance` launches a disposable VS Code Extension Host and
  exercises activation, indexing, and registered commands.
- `npm run test:qa` runs compile, lint, unit, property, release-metadata, and
  acceptance checks.
- `npm test` is an alias for the QA gate.

`VSCODE_TEST_VERSION` selects the VS Code build for acceptance tests. It
defaults to `stable`; set it to a specific version such as `1.74.3` when
checking the minimum supported engine.

## Expensive and diagnostic checks

- `npm run test:torture` indexes 250 deterministic entries and reconciles the
  journal five times. Its bounds are constants in the torture test so results
  can be reproduced.
- `npm run test:mutation` mutates the isolated path, frontmatter, and grouping
  helpers. HTML and JSON reports are written to `test/results/mutation/`.

Mutation testing reports the current score but deliberately has no failing
score threshold. This provides a baseline before the project chooses a policy
that will not reward low-value assertion inflation.

## Layout

- `acceptance/`: VS Code Extension Host tests and their runner.
- `property/`: generated invariant tests.
- `scripts/`: tracked test orchestration utilities.
- `torture/`: bounded stress tests excluded from the ordinary QA gate.
- `unit/`: VS Code-independent unit tests.
- `results/`: ignored compiled output, downloaded test runtime data, and
  reports.
