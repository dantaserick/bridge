# Bridge architecture

Summary of how Bridge is put together, for whoever's going to touch the
code. Decisions, with context and consequences, live in
[`adr/`](adr/README.md). This document is the map, not the source of
truth.

## Three processes and a shim

```
                 ┌───────────────────────────────────────┐
   Electron      │ shell  (packages/shell)                │
   ──────────    │  window, tray, native toast            │
                 └────────────────┬──────────────────────┘
                                  │ spawn (system Node)
                                  ▼
                 ┌───────────────────────────────────────┐
   Node          │ core   (packages/core)                 │
   ──────────    │  Fastify on 127.0.0.1:<port>           │
                 │  node-pty · SQLite · git/worktree      │
                 └───┬──────────────────┬─────────────────┘
                     │ HTTP /api + /ws  │ HTTP /hooks
                     ▼                  │
         ┌───────────────────────┐      │
         │ ui (packages/ui)      │      │   ┌──────────────────────────┐
         │ React + xterm.js      │      └───┤ shim bridge-hook.cjs     │
         │ served by the core    │          │ called by Claude Code's  │
         └───────────────────────┘          │ hooks, per session       │
                                            └──────────────────────────┘
```

- **core** (`packages/core`) owns all the state: PTY sessions, layout,
  notifications, git. Listens **only** on `127.0.0.1`, with a per-instance
  token stored in `%APPDATA%\bridge\instance.json`. Runs standalone
  (`npm run dev:core`) — the UI opens in a browser tab and works.
- **ui** (`packages/ui`) holds no truth: it draws the snapshot the core
  sends via `GET /api/state` and applies the `/ws` WebSocket events. Every
  mutation is a route.
- **shell** (`packages/shell`) is Electron. It does **not** embed the
  core: it spawns a child Node process (ADR-002), because `node-pty` and
  `better-sqlite3` would need a rebuild for Electron's ABI, which would
  break the core's test suite, which runs on the system's Node. That's
  why the app **requires Node.js 22+ on the machine**.
- **shared** (`packages/shared`) is the contract: domain types, WS events,
  configuration defaults, and the keybinding map. No `node:` here — the
  package goes into the browser bundle.
- **cli** (`packages/cli`) is the `bridge` command, a single-file CJS
  bundle with no runtime dependencies. It speaks the same HTTP API as the
  UI.

## How agent state shows up in the sidebar

Nothing is read from the terminal screen. When opening an agent session,
the core writes a `settings.json` **just for that session** and launches
Claude Code with `--settings <path>`. In that file, every hook and the
`statusLine` point at the shim `packages/core/bin/bridge-hook.cjs`, which
receives `<sessionId> <Event>`, reads the payload on stdin, and POSTs to
`http://127.0.0.1:<port>/hooks/<sessionId>/<Event>`. The adapter
translates the event into state (ADR-004):

| Hook | State | Note |
| --- | --- | --- |
| `SessionStart` | `idle` | zeroes counters |
| `UserPromptSubmit` | `running` | detail "thinking…" |
| `PreToolUse` | `running` | detail = tool + argument summary |
| `PostToolUse` | `running` | clears the tool detail |
| `PermissionRequest` | `needs-input` | + notification |
| `Notification` | `needs-input` or `idle` | depends on the message |
| `Stop` | `done` | + notification; 5 blocked `Stop`s in a row become `stuck` |
| `StatusLine` | (unchanged) | refreshes the session's quota and the usage monitor's windows, and returns the statusline Bridge assembled |
| PTY exit | `exited` | stores the `exitCode`; the panel stays open for you to read |

The shim is plain Node, no dependencies, and always exits with code 0: a
core that's down should never be able to take down the agent someone's
working with.

Besides the hooks, any panel can notify via OSC 9 / 777 / 99 sequences
read from the PTY stream, or via `bridge notify "text"` — agent-agnostic
channels that flag the notification without touching `state`.

## Domain model

```
Repo         { id, path, name, trustFilters, hasFilterDrivers? }
Workspace    { id, name, cwd, repoId?, branch?,
               worktree?: { base, path, baseGuessed? },
               environment?, crossAccess?, createdAt }
Tab          { id, workspaceId, title, kind: 'terminal', order }
Pane         { id, tabId }        # position comes from the tab's layout tree:
                                  # split{ dir: 'v'|'h', ratio, a, b } | leaf{ paneId }
Session      { id, paneId, workspaceId, kind, agent?, state, detail?, tool?,
               lastNotification?, quota?, serverLimit?, resumeRequested?,
               resumeOutcome?, sawOutput?, scopeBlocks?, hosted?,
               pid, exitCode?, startedAt, stateSince }
Notification { id, sessionId, workspaceId, kind, text, at, readAt? }
QuotaSnapshot{ model, contextTokens, contextPct, costUsd, rateLimits[], at }
```

The 0.11.0 session fields (`serverLimit`, `resumeRequested`/
`resumeOutcome`, `sawOutput`, `scopeBlocks`) and the 0.12.0 `hosted` field
only exist in MEMORY: they're facts about that process's run, and the
process doesn't survive a restart. `environment` and `crossAccess` belong
to the workspace and go to SQLite — they're decisions made by the owner.

`hosted` (`{ agent, since }`) marks a SHELL session that has a Claude Code
open inside it. `kind` stays `'shell'` and `agent` stays absent: what
answers "which agent is this" is `hosted.agent`, and it's the
`hosted?.agent ?? agent` rule the UI uses for the label — see the
`adapters/hosted.ts` module in the table below.

**Panel ↔ session is 1:1** (ADR-005): a panel hosts at most one live
session. Requesting a second returns `409`; if the one there already
exited (`exited`), the new one replaces it. It's the rule that makes
"pressing Enter in a dead panel reopens a shell" work with no ambiguity.

## A task is a `git worktree`

`POST /api/tasks` creates `<repo>/.worktrees/<name>` on a branch of the
same name, and the workspace is born pointing there (ADR-009).
`.worktrees/` goes into the repo's `.git/info/exclude`, not the versioned
`.gitignore`. The sidebar shows `+N` (commits ahead of the base) and `~M`
(dirty files) from a poller that only runs while the window has had
recent focus. Merge and removal go through the same routes, with explicit
refusals — dirty worktree, already-merged branch, missing base — instead
of "figuring something out."

## The usage monitor

How much you've already spent today, this week, and this month — in
tokens and in estimated cost — and how much room is left in the account's
limit windows. All local, all from what Claude Code already writes
(ADR-012, which supersedes ADR-008).

**Two sources, neither of them remote:**

| What | Where from | Who feeds it |
| --- | --- | --- |
| Limit windows (5 h, week, whatever else the payload brings) | `rate_limits` from the `StatusLine` hook payload | `api/hooks.ts` → `usage.noteLimits()` |
| Consumption (tokens, cost, by day/model/project) | sweep of the `*.jsonl` transcripts | `usagePoller.ts` → `usage.scan()` |

**The sweep is incremental and yields the event loop.**
`usage/transcripts.ts` walks `<claudeHome>\projects` recursively (≤ 8
levels, without following a symbolic link), classifies each file as
`main` (loose in the project folder) or `subagents` (nested), and reads
each one **from its stored offset**, in 256 KB slices, yielding the loop
between them — the core hosts every PTY, and a multi-megabyte `readSync`
would stall the terminals. What comes out of the read are **counts**:
tokens, model id, `cwd`, and timestamp. Message content is not extracted
and therefore can't be stored.

**What the database stores:** `usage_files` (the read marker per
transcript: size, mtime, offset, last dedupe key, and a fingerprint of
the first 512 bytes), `usage_daily` (counts by day × model × project ×
origin, with an upsert that ADDS), and `usage_limits` (the latest window
snapshot).

**Three decisions that explain the rest of the module:**

- **subagents count.** In a sample from the author's machine, 62.8% of
  tokens came from subagent transcripts. Counting only the main
  conversation isn't a simplification, it's an error by a whole factor;
- **cost is an estimate, and `null` isn't `0`.** The table
  (`usage/pricing.json`) has an `asOf` and a source; a model not in it
  counts in tokens and drops out of the cost, with a warning naming it. A
  low total because half the models had no price can't look like good
  news;
- **the 1 h cache write is its own column.** It costs 2 × input (the 5
  min one, 1.25 ×), and the payload brings both summed into
  `cache_creation_input_tokens`, with the breakdown in `cache_creation`.

Who consumes it: `GET /api/usage` (the panel and the CLI),
`GET /api/usage/limits` (the sidebar bar), `POST /api/usage/rescan` (the
"Rescan transcripts" button), and the `usage.changed` event, which
carries the windows, the days touched, and the sweep's progress (at most
one per second — the windows too, since 0.10.1).

**Attacker A7, and the single sanitizer (0.10.1).** This is the **only**
Bridge module that works on its own, every 60 s, on content the owner
didn't type: a `.jsonl` under `<claudeHome>\projects` may have been
written by another process of theirs, by an agent running inside a
session, or restored from a backup. The 2026-09-06 security phase added
this attacker to the threat model and hardened the module against it:
line cap (4 MiB, with the line skipped and COUNTED instead of locking the
file's offset), range checks on token counts and the timestamp's day, a
prototype-less pricing table looked up via `Object.hasOwn`, an
asynchronous listing with a file cap, and caps on the statusline payload
(windows, key size, `resets_at`).

The cross-cutting piece is `sanitizeDisplay`, in `@bridge/shared`: **one**
pure function for all outside text headed to the SCREEN — the statusline
the core returns to Claude Code, the human-readable output of
`bridge usage`, and the panel's `title`/`aria-label`. It lives in
`shared` for the same reason as `formatUsd`: three spots writing the same
data with three different rules is how one of them ends up out of sync on
the next change. The CLI's `--json` and the API body stay **raw**, on
purpose: they're data, not screen, and trimming them would lie about
what's on disk.

## The four verified pain points (0.11.0)

Five new modules, all in the core, all in the same shape: the decision
lives in a module **with no I/O**, and whoever holds state (`core.ts`)
calls it. It's the same pattern as `usage/aggregate.ts` — it's what keeps
the rule under test without a PTY, a database, or `wsl.exe`.

| Module | What it decides | Who calls it, and what comes out |
| --- | --- | --- |
| `serverLimit.ts` | does the terminal output match a SERVER limit phrase? A 4 KB rolling window per session, ANSI stripped, four exact patterns | `core.ts`'s `bus.on('pty.data')` → `sessions.markServerLimited` → `session.state` with `serverLimit`. Cleared on the first `Stop`/`UserPromptSubmit` (in `api/hooks.ts`) or after 5 min |
| `launcher.ts` | can this agent launch right now? (`slots` \| `jitter` \| `backoff`) — a pure class, with clock, RNG, and scheduler injectable | `POST /api/sessions` (**201** or **202** with the position), `GET /api/launcher`, `POST /api/launcher/launch-now`, `DELETE /api/launcher/pending/:id`, `launcher.changed` event |
| `environments.ts` | what environments does this machine have, and how to translate cwd/`settings.json` into a distro (`wslpath`), with a 60 s cache | `GET /api/environments`; `resolveEnvContext` feeds the adapters' `LaunchCtx` (`adapters/shell.ts` and `adapters/claude.ts` assemble the `wsl.exe` call) |
| `recap.ts` | did `--resume` come back empty? (`resumeOutcomeOf`) and the deterministic summary of the old transcript (`readRecap`/`buildRecap`, tail read) | `api/hooks.ts` on `SessionStart` → `session.updated` with `resumeOutcome`; `POST /api/sessions/:id/recap` → `{ text }` |
| `scopeGuard.ts` | is this path inside the session's root? (`resolveTarget`, `scopeRootOf`, `checkScope`, `scopeDenyReply`) | `api/hooks.ts` on `PreToolUse`, **before** `adapter.onHook`: outside the root, the response IS the `deny`, and the adapter isn't even consulted. `sessions.noteScopeBlock` → `session.updated` with `scopeBlocks` |

Two things worth reading in the code before touching it:

- **`PreToolUse` has two owners.** The guard decides first and, when it
  refuses, `return`s before the adapter — the tool won't run, so marking
  `session.tool` would show work in the sidebar that never happened;
- **hooks for a WSL session run through WINDOWS's `node.exe`**, via
  interop, even when the distro has its own `node`: WSL2's NAT loopback
  isn't shared, and the shim needs to reach the core at
  `127.0.0.1:<port>` on the host
  ([ADR-013](adr/013-hooks-de-wsl-pelo-node-do-windows.md)).

## Claude Code opened inside a shell (0.12.0)

One new module, in the same shape as the five above — the decision in an
I/O-free file, and whoever holds state calling it:

| Module | What it decides | Who calls it, and what comes out |
| --- | --- | --- |
| `adapters/hosted.ts` | what's the REAL `claude` on this machine (`resolveHostedTarget`/`hostedTargetFrom`), the exact CONTENT of each shell session's wrappers (`hostedFiles`: `settings.json` + `bin/claude.cmd` + `bin/claude`, or the distro wrapper on WSL) and how `bin` gets into PATH (`prependPath`, `WSL_HOSTED_SHELL_COMMAND`) | `adapters/shell.ts` (`shellLaunch`) assembles the `files` and `env`; `core.ts` (`createSessionReserved`) resolves the target BEFORE the prepend and puts `hosted` in the `LaunchCtx` when `sessions.hostedAgents` is on and `kind` is `shell` |

Three things you only see in the code:

- **the `.cmd` wrapper is pure ASCII, and that's mandatory**: cmd.exe
  reads a batch file in the console's OEM codepage, not UTF-8, so a path
  with an accented character written there arrives mangled at Claude. The
  target travels in the environment (`BRIDGE_CLAUDE_BIN`), and
  `settings.json` comes from `%~dp0`;
- **the promotion lives in the route, not the adapter** (`api/hooks.ts`):
  when a hook arrives for a `kind: 'shell'` session that isn't hosting
  yet, the route calls `core.noteHosted` and follows the SAME path as an
  agent session (`adapters.claude`). `SessionEnd` with an exit reason is
  diverted BEFORE the adapter, to `core.noteHostedEnd` — otherwise the UI
  would draw an `exited` for a shell that's still alive;
- **`sessions.setHosted`/`clearHosted`** are the pair that holds the
  mark: `setHosted` is idempotent (the first promotion's `since` stays
  put) and `clearHosted` returns the session to `idle` without touching
  `agentSessionId`, `quota`, `scopeBlocks`, or `exitCode` — the shell
  didn't die, only the Claude that was inside it.

## The language (0.13.0)

Every piece of text a person reads comes from **one** catalog, in
`@bridge/shared`. Four files:

| File | What it is |
| --- | --- |
| `shared/src/i18n/pt-BR.ts` | the **source of the keys**: an `as const` object, and `MessageKey = keyof typeof ptBR` |
| `shared/src/i18n/en.ts` | the SAME keys, pinned by `satisfies Record<MessageKey, string>` — a missing **or extra** key is a type error, not a runtime one |
| `shared/src/i18n/index.ts` | `t(lang, key, params?)` (interpolates `{name}`, no new dependency), `resolveLanguage`, `systemLanguage`, `currentSystemLocale`, `LANGUAGES`, `INTL_LOCALE` |
| `shared/src/i18n/guard.ts` | `findUncataloguedLiterals(source, opts)` — the pure sweep each package's guard test runs. It's **not** re-exported from the package root: only tests use it, and there's no reason for it to enter the UI bundle |

`shared/src/format.ts` (cost, tokens, count, relative time) takes `lang`
as a **required** argument and uses `Intl` with `INTL_LOCALE[lang]`.
Relative time comes from the catalog, not `Intl.RelativeTimeFormat`:
"há 1 min" and "1 min ago" fit in two keys and don't pay for building a
formatter per sidebar row.

**How the language reaches each process.** Whoever resolves `'system'` is
the **core**, once, in `updateConfig` (`core.ts`, `language()`): the
machine's locale doesn't change while the app is open, and resolving it
on every notification would make each one pay for an
`Intl.DateTimeFormat()`. Everyone else consumes its result,
`configSnapshot().languageResolved`, and **no one resolves it again**:

| Process | How it gets it | Fallback before the first response |
| --- | --- | --- |
| core | `core.language()`, read **live** on every message, notification, statusline, and `deny` reason | — |
| UI | `languageResolved` from `GET /api/config` and `/ws`'s `config.changed`; `LanguageProvider` → `useT()`/`useLang()` (`ui/src/i18n.tsx`) | `navigator.language` (`browserLanguage()`), only until config arrives |
| shell (main) | `readCoreLanguage()` at boot + the `config.changed` event (`shell/src/language.ts`, `tShell`) | `app.getLocale()` (`bootLanguage`), because the "core didn't start" dialog is, by definition, for someone who couldn't ask it anything |
| CLI | `languageResolved` from the ONE call it makes to `/api/config` (`cli/src/lang.ts`) | `BRIDGE_LANG`, then the machine's locale — that's what makes `bridge --help` work with Bridge closed |

**The switch is live, and that's why there's no text constant.** A
`const RECAP_BANNER = 'resuming…'` gets evaluated at module import and
would freeze the language at first mount; a whole family of these became
functions of `lang` (`environmentLabel`, `detail*`, `recapBannerText`,
`tableColumns`, …). In Electron's `main` the exception is the **tray**,
the only text that stays ON SCREEN between two events: the `Menu` is
immutable once built, so `TrayHandles.setLanguage` rebuilds the template —
and `setShellLanguage` only returns `true` when the language ACTUALLY
CHANGED, otherwise every `config.changed` (terminal font, scheduler cap)
would rebuild the menu for nothing.

**Two things travel as a KEY, not a sentence**, because the producer has
no language and the consumer does: `LoginItemState.status` (main → IPC →
the UI's `settingsModel`, translated with the window's language) and
`CoreExit.fatal`/`CoreStartError.key` (`sidecar.ts` → `main.ts`,
translated the instant `showErrorBox` opens). The bonus is for support:
`shell.fatal.semNode` in `shell.log` says more than the sentence in the
reporter's language.

**The guard.** One test per package (`i18n-guard-shared.test.ts`,
`i18n-guard-core.test.ts`, `i18n-guard-ui.test.ts`,
`i18n-guard-shell.test.ts`, and the final block of
`cli/test/i18n-cli.test.ts`) sweeps that package's `src/` looking for an
accented literal or a common pt-BR word outside the catalog, and fails
listing `file:line`. It's the lock against a new string slipping in
without a key. Each test has a **per-family regex allowlist** (log,
`debug`, `appendShellLog`), and the code can carry a `// i18n-ignore` on
the line, with the reason next to it — family-wide pardon lives in the
test, single-line pardon lives on the line. The UI's allowlist is
**empty**, and a second test in the file is what keeps it that way.

**The declared blind spot:** the guard looks for ACCENTS in literals.
`Todos`, `Base`, `Msg`, `Total` — pt-BR without an accent, and on top of
that inside JSX text — slip through. It was the eyeball sweep, not the
test, that found these. Whoever adds copy in a `.tsx` needs to account for
this (see `CONTRIBUTING.md`).

## Persistence

Everything lives in the profile, `%APPDATA%\bridge` (or
`BRIDGE_PROFILE_DIR`):

| File | What it is |
| --- | --- |
| `config.json` | port, shell, git poll, toasts, terminal font, restoration, `usage` (cost and pricing table), and `ui` (the language, 0.13.0). Written atomically. |
| `keybindings.json` | the keybinding map, read on every request |
| `bridge.db` | SQLite: repos, workspaces, tabs, panels, layout, notifications, session quota, and the usage monitor's three tables (`usage_files`, `usage_daily`, `usage_limits`) |
| `instance.json` | port + live instance token (mode `0600`) |
| `logs\core.log`, `logs\shell.log` | logs |
| `sessions\<id>\` | that session's `settings.json`; disappears when the session dies |

**A session isn't persisted.** On reopening, Bridge restores the
*layout* and decides per panel: whoever had a live Claude Code comes back
with `claude --resume <id>` (if `restore.resumeAgents` is on), the rest
comes back as a shell.

**Restoration × a workspace being born.** Restoration happens per
activated workspace, and creating a workspace changes the layout BEFORE
the `POST` responds with the id — so there's no way to tell from the id
who's being born. The `App` keeps a registry of in-flight creations
(`restore.ts`), one entry per creation, holding the workspaces that
ALREADY existed when that request began: whoever was already there
restores normally, the suspect is skipped **without** being marked as
restored, and the end of a creation re-examines the active workspace. The
entry is closed by IDENTITY (the function `begin` returns, idempotent),
not by position — two creations crossing and finishing out of order would
remove the wrong one.

**Temp file hygiene.** Bridge doesn't write outside the profile: each
session's `settings.json` lives in `sessions\<id>\` and disappears with
it, and the hook dump goes to `logs\`, confined by prefix, with a name
derived from `basename()` and an 8 MB per-file cap. Whoever creates
folders in `%TEMP%` is the TEST SUITE, not the app: vitest's
`globalSetup` and e2e work in `bridge-*` folders and delete them
afterward — an interrupted run (or an e2e scenario that fails while
holding the `cwd`) can leave one behind, and the following
`globalSetup`'s 1-hour cutoff is what sweeps it up.

**Trust model, in one sentence.** Bridge treats the machine and whoever's
logged into it as trusted, and **treats everything coming from outside as
hostile** — terminal output, hook payloads, and the **git repository**,
which is third-party code capable of running a command via `filter.*` on
every `git status`: that's why the core detects the drivers and **asks**
(`Repo.trustFilters`) instead of neutralizing them. The whole threat
model, with what was accepted, is in [`../SECURITY.md`](../SECURITY.md).

## Packaging

`npm run dist` produces a per-user NSIS x64 installer. The core goes
**outside** the `asar` (ADR-010), in `resources/`: `core/dist/index.mjs`,
`core/bin/*.cjs`, `core/node_modules/` (runtime only, installed with
`npm ci` from a `package.json`+lockfile pair versioned under
`packages/shell/stage/`), `ui/` (the Vite build, which the core serves at
`/`), and `cli/`. Native modules keep the **system Node**'s prebuilds —
no `@electron/rebuild`.

## Tests

- **vitest per package** for everything that's a pure function or a
  route: the standard is extracting the decision into an I/O-free module
  (`settingsModel.ts`, `sidebarModel.ts`, `usage/aggregate.ts`) and
  testing that, not the component.
- **Playwright + real Electron** (`packages/shell/test/e2e.spec.ts`,
  `npm run e2e`): 17 scenarios with a real core, PTY, and window; at the
  end of each one it checks that no process was left behind. Only the
  `resume` scenario spins up a real Claude Code; the others that need an
  agent use a fake `claude.cmd` at the front of the `PATH`, because
  what's under test is the data path, not the binary.
- `npm run typecheck` is part of the contract:
  `packages/ui/test/types-contract.test.ts` imports the core's types and
  breaks the UI's typecheck if the two diverge.

## Where to look for what

| Want to touch… | Start with |
| --- | --- |
| agent state, hooks | `packages/core/src/adapters/claude.ts` |
| HTTP routes | `packages/core/src/api/routes.ts` + `schemas.ts` |
| PTY, scrollback, backpressure | `packages/core/src/pty.ts` |
| panel tree | `packages/core/src/layout.ts` |
| worktree and git | `packages/core/src/git.ts`, `gitPoller.ts` |
| usage monitor | `packages/core/src/usage/` + `usagePoller.ts`; in the UI, `usageModel.ts` + `components/usage/` |
| server limit, launch queue | `packages/core/src/serverLimit.ts` + `launcher.ts`; in the UI, `sidebarModel.ts` (`serverLimitBadge`, `launcherQueueLine`) |
| session environment (pwsh/Git Bash/WSL) | `packages/core/src/environments.ts` + `adapters/{shell,claude}.ts`; in shared, `environment.ts` |
| empty resume and the recap | `packages/core/src/recap.ts`; in the UI, `recap.ts` + `components/Pane.tsx` |
| scope guard | `packages/core/src/scopeGuard.ts` + the `PreToolUse` block of `api/hooks.ts` |
| each shell's `claude` wrapper | `packages/core/src/adapters/hosted.ts` + `adapters/shell.ts` (`shellLaunch`) |
| promoting a shell session to host | the `kind === 'shell'` branch of `packages/core/src/api/hooks.ts` + `core.ts` (`noteHosted`, `noteHostedEnd`) and `sessions.ts` (`setHosted`, `clearHosted`) |
| a host's `claude` label on screen | `packages/ui/src/sidebarModel.ts` (`sessionLabel`, `sessionDetail`, `runsAgent`) + `paneModel.ts` (`paneDetail`) |
| sidebar | `packages/ui/src/sidebarModel.ts` + `components/sidebar/` |
| keybindings | `packages/shared/src/protocol.ts` (`DEFAULT_KEYBINDINGS`) |
| any screen's text, in any language | `packages/shared/src/i18n/pt-BR.ts` + `en.ts` (the key is by SURFACE: `sidebar.rodape.novaTarefa`, `uso.painel.total`) |
| how the language reaches each process | `packages/core/src/core.ts` (`language()`), `packages/ui/src/i18n.tsx`, `packages/shell/src/language.ts`, `packages/cli/src/lang.ts` |
| the language selector | `packages/ui/src/settingsModel.ts` (`languageOptions`) + the `appearance` branch of `components/SettingsDialog.tsx` |
| window, tray, toast | `packages/shell/src/main.ts`, `tray.ts` |
| who sends `resize` to the PTY when there are two xterms in the same session | `packages/ui/src/terminalGrid.ts` (`gridAfterSync`) + the `readOnly`/`onFitted` props of `components/Terminal.tsx` |
| panel restoration mark (who ended it) | `packages/core/src/core.ts` (`createSessionReserved`, the `session.exited` listener and `stop()`) + `layout.ts` (`setPaneEnded`) and the `db.ts` migration (`rescueOrphanAgentPanes`); in the UI, `restore.ts` (`panesToRestore`) |
| shutting down the core (normal exit and Windows session end) | `packages/shell/src/shutdown.ts` + the `before-quit`/`will-quit`/`session-end` listeners in `main.ts` |
| packaging | `packages/shell/electron-builder.yml`, `scripts/stage-core.mjs` |
