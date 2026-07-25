#!/usr/bin/env node
'use strict';

// PreToolUse hook: denies git mutation commands issued via the Bash or
// PowerShell tools. Read-only git and all gh commands pass through.
// Zero dependencies; Node >= 14; portable (Windows / WSL / Linux / iOS).
//
// Contract:
//   stdin  - hook payload JSON; command text at tool_input.command
//   stdout - PreToolUse deny JSON when a mutation is detected, else nothing
//   exit 0 always in hook mode (fail-open on malformed payloads; policy is
//   default-deny for any git subcommand not on the read-only allowlist)
//
// Self-test: node .claude/hooks/block-git-mutations.js --test
// (exits 0 when all cases pass, 1 when any case fails)

const SAFE_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree',
  'ls-remote', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'cat-file',
  'reflog', 'check-ignore', 'diff-tree', 'name-rev', 'merge-base', 'help',
  'version', 'var'
]);

// git global options that consume the following token
const GIT_GLOBAL_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
  '--super-prefix', '--config-env'
]);

const WRAPPERS = new Set(['sudo', 'command', 'env', 'exec', 'nohup', 'time', 'builtin']);
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '--user', '--group', '-p', '--prompt']);
const SHELL_BOUNDARY = new Set([';', '&', '|', '\n', '\r', '(', ')']);
const UNQUOTED_ESCAPABLE = new Set(['"', "'", '$', '`', '\\', ' ', '\t', ';', '&', '|', '<', '>', '(', ')', '\n']);

const BRANCH_SPEC = {
  boolFlags: new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
    '--list', '-l', '--show-current', '--color', '--no-color', '--column',
    '--no-column', '--no-abbrev', '-i', '--ignore-case']),
  valueFlags: new Set(['--contains', '--no-contains', '--merged', '--no-merged',
    '--points-at', '--sort', '--format', '--abbrev', '--color', '--column']),
  listFlags: new Set(['--list', '-l', '--contains', '--merged', '--no-merged', '--points-at'])
};

const TAG_SPEC = {
  boolFlags: new Set(['-l', '--list', '--column', '--no-column', '-i', '--ignore-case']),
  valueFlags: new Set(['--contains', '--no-contains', '--points-at', '--merged',
    '--no-merged', '--sort', '--format', '--column']),
  listFlags: new Set(['-l', '--list', '--contains', '--points-at', '--merged'])
};

const RESTRICTED_SUBCOMMANDS = {
  config: isSafeConfig,
  remote: isSafeRemote,
  branch: isSafeBranch,
  tag: isSafeTag,
  stash: isSafeStash,
  worktree: isSafeWorktree,
  merge: isAbortOnly,
  rebase: isAbortOnly,
  'cherry-pick': isAbortOnly
};

// ---------------------------------------------------------------------------
// Lexer: splits a shell/PowerShell command line into commands (word arrays).
// Quote-aware, chain-aware (&& || ; | & newline), substitution-aware ($(..)
// and backticks), redirection-aware. Conservative by design: ambiguity leans
// toward producing a checkable git invocation, never toward hiding one.
// ---------------------------------------------------------------------------

const MODE_HANDLERS = {
  normal: handleUnquoted,
  subst: handleUnquoted,
  tick: handleUnquoted,
  single: handleSingle,
  double: handleDouble
};

function splitCommands(text) {
  const p = createParser();
  let i = 0;
  while (i < text.length) {
    i = MODE_HANDLERS[currentMode(p)](p, text, i) + 1;
  }
  flushAll(p);
  return p.commands;
}

function createParser() {
  return { commands: [], words: [], word: '', modes: ['normal'], substStack: [], dropWord: false };
}

function currentMode(p) {
  return p.modes[p.modes.length - 1];
}

function endWord(p) {
  if (p.word.length === 0) return;
  if (p.dropWord) {
    p.dropWord = false;
  } else {
    p.words.push(p.word);
  }
  p.word = '';
}

function endCommand(p) {
  endWord(p);
  p.dropWord = false;
  if (p.words.length > 0) {
    p.commands.push(p.words);
    p.words = [];
  }
}

function pushSubst(p, kind) {
  endWord(p);
  p.substStack.push(p.words);
  p.words = [];
  p.modes.push(kind);
}

function popSubst(p) {
  endCommand(p);
  p.words = p.substStack.length > 0 ? p.substStack.pop() : [];
  const mode = currentMode(p);
  if (mode === 'subst' || mode === 'tick') p.modes.pop();
}

function flushAll(p) {
  while (p.substStack.length > 0) popSubst(p);
  endCommand(p);
}

function handleUnquoted(p, text, i) {
  const ch = text[i];
  if (ch === "'") { p.modes.push('single'); return i; }
  if (ch === '"') { p.modes.push('double'); return i; }
  if (ch === '\\') return consumeUnquotedEscape(p, text, i);
  if (ch === '`') return handleTick(p, i);
  if (ch === '$' && text[i + 1] === '(') { pushSubst(p, 'subst'); return i + 1; }
  if (ch === '>' || ch === '<') return consumeRedirect(p, text, i);
  if (ch === ')' && currentMode(p) === 'subst') { popSubst(p); return i; }
  if (SHELL_BOUNDARY.has(ch)) { endCommand(p); return i; }
  if (ch === ' ' || ch === '\t') { endWord(p); return i; }
  p.word += ch;
  return i;
}

function handleTick(p, i) {
  if (currentMode(p) === 'tick') {
    popSubst(p);
  } else {
    pushSubst(p, 'tick');
  }
  return i;
}

// Backslash escapes shell-special characters only; elsewhere it stays a
// literal so Windows paths (C:\Users\...) survive intact.
function consumeUnquotedEscape(p, text, i) {
  const next = text[i + 1];
  if (next === undefined) return i;
  if (UNQUOTED_ESCAPABLE.has(next)) {
    p.word += next;
    return i + 1;
  }
  p.word += '\\';
  return i;
}

function handleDouble(p, text, i) {
  const ch = text[i];
  if (ch === '"') { p.modes.pop(); return i; }
  if (ch === '\\') return consumeDoubleEscape(p, text, i);
  if (ch === '$' && text[i + 1] === '(') { pushSubst(p, 'subst'); return i + 1; }
  if (ch === '`') { pushSubst(p, 'tick'); return i; }
  p.word += ch;
  return i;
}

// Inside double quotes bash only escapes " $ ` and backslash.
function consumeDoubleEscape(p, text, i) {
  const next = text[i + 1];
  if (next === '"' || next === '$' || next === '`' || next === '\\') {
    p.word += next;
    return i + 1;
  }
  p.word += '\\';
  return i;
}

function handleSingle(p, text, i) {
  if (text[i] === "'") {
    p.modes.pop();
    return i;
  }
  p.word += text[i];
  return i;
}

// Consumes redirection operators (>, >>, 2>&1, 2>$null, < file) and marks
// the target word for dropping so filenames are not mistaken for arguments.
function consumeRedirect(p, text, i) {
  if (/^\d+$/.test(p.word)) p.word = '';
  endWord(p);
  let j = i;
  let targetConsumed = false;
  while (j + 1 < text.length && isRedirectChar(text[j + 1])) {
    j += 1;
    if (text[j] === '&') targetConsumed = true;
  }
  p.dropWord = !targetConsumed;
  return j;
}

function isRedirectChar(ch) {
  return ch === '>' || ch === '<' || ch === '&' || (ch >= '0' && ch <= '9');
}

// ---------------------------------------------------------------------------
// Git invocation extraction and policy
// ---------------------------------------------------------------------------

// Returns git args (tokens after the git word) when the command invokes git,
// else null. Skips env-var prefixes (FOO=bar git ...) and common wrappers.
function extractGitInvocation(words) {
  const idx = skipPrefixes(words, 0);
  if (idx >= words.length) return null;
  if (!isGitWord(words[idx])) return null;
  return words.slice(idx + 1);
}

function skipPrefixes(words, start) {
  let i = start;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    if (!WRAPPERS.has(w.toLowerCase())) break;
    i = skipWrapperFlags(words, i + 1);
  }
  return i;
}

function skipWrapperFlags(words, start) {
  let i = start;
  while (i < words.length && words[i].startsWith('-')) {
    i += WRAPPER_VALUE_FLAGS.has(words[i]) ? 2 : 1;
  }
  return i;
}

// Matches git, git.exe, and any path-qualified form of either.
function isGitWord(word) {
  const segments = word.toLowerCase().split(/[\\/]/);
  const base = segments[segments.length - 1];
  return base === 'git' || base === 'git.exe';
}

function findSubcommand(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith('-')) return { name: a, rest: args.slice(i + 1) };
    i += GIT_GLOBAL_VALUE_OPTS.has(a) ? 2 : 1;
  }
  return null;
}

// Returns null when allowed, or a blocked-descriptor when denied.
function evaluateGitCommand(gitArgs) {
  const parsed = findSubcommand(gitArgs);
  if (parsed === null) return null; // bare git / --version / --help
  const name = parsed.name.toLowerCase();
  if (SAFE_SUBCOMMANDS.has(name)) return null;
  const restricted = RESTRICTED_SUBCOMMANDS[name];
  if (restricted && restricted(parsed.rest)) return null;
  return { subcommand: name, display: 'git ' + gitArgs.map(quoteArg).join(' ') };
}

// Re-quotes an argument for the copy-paste block; the lexer stripped the
// original quotes, so anything with whitespace/specials gets double-quoted.
function quoteArg(arg) {
  if (!/[\s"'$`;&|<>()\\]/.test(arg)) return arg;
  return '"' + arg.replace(/(["\\$`])/g, '\\$1') + '"';
}

function isSafeConfig(rest) {
  const readFlags = ['--get', '--get-all', '--get-regexp', '--list', '-l'];
  if (rest.some(function (a) { return readFlags.indexOf(a) !== -1; })) return true;
  const sub = rest.find(function (a) { return !a.startsWith('-'); });
  return sub === 'list' || sub === 'get';
}

function isSafeRemote(rest) {
  const sub = rest.find(function (a) { return !a.startsWith('-'); });
  if (sub === undefined) return true; // bare or flags-only (e.g. -v)
  return sub === 'show' || sub === 'get-url';
}

function isSafeBranch(rest) {
  return scanListingArgs(rest, BRANCH_SPEC);
}

function isSafeTag(rest) {
  return scanListingArgs(rest, TAG_SPEC);
}

function isSafeStash(rest) {
  const sub = rest.find(function (a) { return !a.startsWith('-'); });
  return sub === 'list' || sub === 'show';
}

function isSafeWorktree(rest) {
  const sub = rest.find(function (a) { return !a.startsWith('-'); });
  return sub === 'list';
}

function isAbortOnly(rest) {
  return rest.length === 1 && rest[0] === '--abort';
}

// Listing-style commands (branch/tag): every flag must be a known read-only
// flag; bare positionals (create/delete targets) only pass in list mode.
function scanListingArgs(rest, spec) {
  let listMode = false;
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    const name = arg.split('=')[0];
    if (!arg.startsWith('-')) {
      if (!listMode) return false;
      i += 1;
      continue;
    }
    if (spec.listFlags.has(name)) listMode = true;
    const known = spec.boolFlags.has(name) || spec.valueFlags.has(name) || /^-n\d*$/.test(name);
    if (!known) return false;
    i += spec.valueFlags.has(name) && arg.indexOf('=') === -1 ? 2 : 1;
  }
  return true;
}

function analyzeCommand(commandText) {
  const blocked = [];
  const commands = splitCommands(commandText);
  for (const words of commands) {
    const gitArgs = extractGitInvocation(words);
    if (gitArgs === null) continue;
    const verdict = evaluateGitCommand(gitArgs);
    if (verdict !== null) blocked.push(verdict);
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Deny output
// ---------------------------------------------------------------------------

function buildDenyReason(blocked) {
  const names = blocked.map(function (b) { return "'git " + b.subcommand + "'"; });
  const cmds = blocked.map(function (b) { return b.display; }).join('\n');
  return [
    'Blocked: ' + uniqueList(names).join(', ') + ' is a git mutation; this repo is read-only git for agents.',
    'Do NOT retry or work around this. Instead, present the command(s) to the user',
    'verbatim so they can run them, formatted like:',
    '',
    'Here are the git cmds:',
    '',
    '```bash',
    '# git cmds below',
    cmds,
    '```',
    '',
    'Then continue with any work that does not depend on the mutation having run.'
  ].join('\n');
}

function uniqueList(items) {
  return Array.from(new Set(items));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  if (process.argv.indexOf('--test') !== -1) {
    process.exit(runSelfTest());
  }
  readStdin(handlePayload);
}

function readStdin(onDone) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) { raw += chunk; });
  process.stdin.on('end', function () { onDone(raw); });
}

function handlePayload(raw) {
  let command = null;
  try {
    const payload = JSON.parse(raw);
    command = payload && payload.tool_input ? payload.tool_input.command : null;
  } catch (err) {
    process.exit(0); // fail-open: a malformed payload must not brick the session
  }
  if (typeof command !== 'string') process.exit(0);
  const blocked = analyzeCommand(command);
  if (blocked.length === 0) process.exit(0);
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildDenyReason(blocked)
    }
  };
  console.log(JSON.stringify(output));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

const TEST_CASES = [
  // allowed: read-only git
  ['git status', false],
  ['git diff', false],
  ['git log --oneline -5', false],
  ['git log | head -5', false],
  ['git --version', false],
  ['git branch', false],
  ['git branch --show-current', false],
  ['git branch --list "feat*"', false],
  ['git tag', false],
  ['git tag -l "v*"', false],
  ['git stash list', false],
  ['git stash show -p', false],
  ['git worktree list', false],
  ['git config --get user.name', false],
  ['git config --list', false],
  ['git remote -v', false],
  ['git remote get-url origin', false],
  // allowed: abort carve-out
  ['git merge --abort', false],
  ['git rebase --abort', false],
  ['git cherry-pick --abort', false],
  // allowed: not git invocations
  ['echo "git commit"', false],
  ['echo legit push', false],
  ['gh pr comment 1 --body hi', false],
  ['gh pr edit 1 --title x', false],
  ['gh api repos/o/r/pulls', false],
  // denied: mutations
  ['git add -A', true],
  ['git commit -m "x"', true],
  ['git push', true],
  ['git push origin main --force', true],
  ['git pull', true],
  ['git fetch', true],
  ['git checkout -b x', true],
  ['git switch main', true],
  ['git restore .', true],
  ['git reset --hard HEAD', true],
  ['git clean -fd', true],
  ['git merge main', true],
  ['git rebase main', true],
  ['git rebase --continue', true],
  ['git merge --continue', true],
  ['git cherry-pick abc123', true],
  ['git stash', true],
  ['git stash pop', true],
  ['git branch -d foo', true],
  ['git branch foo', true],
  ['git tag v1.0', true],
  ['git config user.name x', true],
  ['git remote add origin url', true],
  ['git worktree add ../x', true],
  // denied: evasion and indirection
  ['git -C sub commit -m x', true],
  ['git -c user.name=x commit', true],
  ['git --git-dir=.git commit', true],
  ['npm test && git commit -m x', true],
  ['git status > /dev/null && git commit -m x', true],
  ['$(git push)', true],
  ['echo "before $(git push) after"', true],
  ['`git push`', true],
  ['FOO=bar git commit', true],
  ['sudo git push', true],
  ['"git" commit', true],
  ['git.exe commit', true],
  ['/usr/bin/git push', true],
  ['& "C:\\Program Files\\Git\\bin\\git.exe" commit', true],
  ['git commit; Write-Host done', true]
];

function runSelfTest() {
  let failures = 0;
  for (const pair of TEST_CASES) {
    const blocked = analyzeCommand(pair[0]).length > 0;
    const pass = blocked === pair[1];
    if (!pass) failures += 1;
    console.log((pass ? 'PASS' : 'FAIL') + ' [' + (pair[1] ? 'deny ' : 'allow') + '] ' + pair[0]);
  }
  console.log(failures === 0
    ? 'All ' + TEST_CASES.length + ' cases passed.'
    : failures + ' of ' + TEST_CASES.length + ' case(s) failed.');
  return failures === 0 ? 0 : 1;
}

module.exports = {
  analyzeCommand: analyzeCommand,
  splitCommands: splitCommands,
  buildDenyReason: buildDenyReason
};

if (require.main === module) {
  main();
}
