# Branch ruleset payloads

These files are prepared updates for GitHub repository rulesets. GitHub does
not apply them from the repository; they are kept here so the exact change is
reviewable in a pull request before a maintainer applies it with the API.

## `main-branch-required-check.json`

Adds one `required_status_checks` rule to the active `main` ruleset
(`19746505`) requiring only the `CI Required` aggregate context from
`.github/workflows/ci.yml`. The three existing rules (`deletion`,
`non_fast_forward`, `pull_request`) are reproduced verbatim so the `PUT`
replaces the ruleset without dropping them.

Apply only after the CI workflow has run on GitHub and the `CI Required`
check context has been confirmed on a pull request:

```bash
gh api --method PUT repos/jsldvr/vscode-journal/rulesets/19746505 \
  --input .github/rulesets/main-branch-required-check.json
```

Verify the current ruleset first:

```bash
gh api repos/jsldvr/vscode-journal/rulesets/19746505 \
  --jq '{name,enforcement,conditions,rules}'
```
