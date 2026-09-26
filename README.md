# Bridge

> **Português:** a documentação completa está em [`README.pt-BR.md`](README.pt-BR.md).

A Windows desktop app that runs **several coding agents side by side**. Each
Claude Code session lives in a terminal pane, Bridge reads that session's
*hooks* and shows in a sidebar what each one is doing — thinking, waiting for
permission, done, stuck — and fires a native toast when one needs you. It is
the Windows answer to [cmux](https://github.com/manaflow-ai/cmux), which only
exists on macOS.

![Demo: agents change state in the sidebar, a task finishes, another asks for permission and the usage panel opens](docs/img/demo.gif)

What it does, one line each:

- **Sidebar with per-session state** — a colored ring per agent, the last
  notification, and the quota strip: context, model, cost and the 5 h and
  weekly windows, all from the payload Claude Code sends to its status line.
- **Workspaces with tabs and splits** — several terminals per folder, a layout
  that persists, keyboard shortcuts for everything.
- **Real Claude Code integration** — a per-session `settings.json` where every
  hook and the status line point at a local HTTP shim; no terminal
  screen-scraping.
- **One task = one `git worktree`** — branch and worktree created together,
  `+N ~M` in the sidebar, merge and removal from the menu.
- **`bridge` CLI** — `list`, `notify`, `send`, `open`, `resume`… An agent can
  call `bridge notify "done"` from inside its own session.
- **Resume where it left off** — on reopen, each pane comes back with
  `claude --resume <id>` for the conversation that was there.

Everything is local: the core listens only on `127.0.0.1`, with a
per-instance token, and nothing leaves the machine.

## Who it's for

For anyone working on Windows with command-line agents who got tired of
losing track between five open terminals. If you run two or three Claude Code
sessions at once, switch between them all day, and want to know which one
stopped to ask for permission without checking them one by one, this is it.

It is not: an editor, a cloud service, or a multi-user app. It's a
single-person tool, on that person's machine.

## Screens

These are from the public build running with demo data: the projects are
made up and the "agents" only fire Claude Code's hooks. The UI in them is in
Portuguese.

![Bridge with three projects, a worktree task and agents running, waiting for permission, stuck and done](docs/img/bridge.png)

| Notifications | New task (worktree) | Settings |
|---|---|---|
| ![Notifications panel](docs/img/notificacoes.png) | ![New task dialog](docs/img/tarefa.png) | ![Settings](docs/img/configuracoes.png) |

## Requirements

- **Windows 11** (x64). Not tested on Windows 10 or other systems.
- **Node.js 22 or newer, on `PATH`.** The core runs as a separate Node
  process and the installer does **not** bundle a Node runtime. Without it,
  the app opens a dialog saying exactly that.
- Whichever agent you plan to use, installed on your own — today the tested
  adapter is **Claude Code**'s (`claude` on `PATH`).

## Install

The installer ships on **[GitHub Releases](https://github.com/dantaserick/bridge/releases)**:
download the latest release's `Bridge Setup <version>.exe` and run it.
Per-user install (no administrator needed), with a folder picker; the CLI
folder is added to your account's `PATH` automatically.

> **SmartScreen warning.** The installer is **not code-signed** (a
> code-signing certificate is expensive and this is a personal project), so
> Windows shows a blue screen saying "Windows protected your PC" /
> "unknown publisher". To continue: **More info → Run anyway**. If you would
> rather not trust an unsigned binary — a legitimate stance — build from
> source (right below): the result is the same `.exe`.

Verify the download by comparing the SHA-256 published on the release:

```powershell
Get-FileHash "$HOME\Downloads\Bridge Setup 0.15.0.exe" -Algorithm SHA256
```

## Build from source

```
git clone https://github.com/dantaserick/bridge
cd bridge
npm install
npm run dist
```

The installer lands in `packages\shell\release\`. To just run it without
packaging, `npm run dev:app` boots Electron with the core and the built UI.
Build, packaging and test details are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

**0.15.0 — pre-release.** It is what the author uses every day, on his own
machine, and it works; but it is a recent public build, with no signed
installer and no test suite run on other people's machines. Expect rough
edges, and open an issue when you find one.

What each version shipped is in [`CHANGELOG.md`](CHANGELOG.md) — from 0.1.0
(core and status) through 0.15.0, passing through 0.13.0 (**the whole app in
Portuguese or in English**, switching instantly), 0.12.2 (the sidebar with
every workspace open by default, the 🛡 badge that disappears when access is
unlocked, and the status line outside the terminal), 0.12.1 (restoration that
survives an unclean app death), 0.12.0 (Claude Code opened inside a shell,
recognized as an agent in the sidebar) and 0.11.0 (the four verified pains of
running several Claude Code sessions: the server limit and the launcher, the
per-workspace session environment, resume coming back empty, and the scope
guard between worktrees).

License: [FSL-1.1-MIT](LICENSE) — use it, modify it and run it at work
freely; you just can't offer Bridge (or an equivalent built from it) as a
competing commercial product. Each version becomes MIT two years after it is
published. This is the full documentation, in English — the Portuguese
version is [`README.pt-BR.md`](README.pt-BR.md) — but **the app itself speaks
both languages** since 0.13.0: `Ctrl+,` → Appearance → Language (see
"Language" below).

---

The rest of this file is the technical documentation: how each part works,
the routes, the shortcuts, the CLI and troubleshooting.

## Three-process architecture

Packages: `packages/core` (the server), `packages/shared` (types and
protocol), `packages/ui` (React + xterm) and `packages/shell` (the Electron
app). A local **core** (Fastify + node-pty + SQLite) owns the sessions and
the state; the **UI** talks to it over HTTP (`/api/*`) and WebSocket (`/ws`);
the Electron **shell** adds the window, native toasts and the tray. The UI
runs both on the Vite dev server (proxying to the core) and served by the
core itself inside Electron. See `docs/adr/001-electron-sobre-core-node.md`.
The threat model, the protections in place and the accepted risks are in
[`SECURITY.md`](SECURITY.md).

## Running just the core + UI in the browser (no Electron)

1. Install the dependencies at the root (workspaces): `npm install`.
2. Start the core: `npm run dev:core` — it writes the token to
   `%APPDATA%\bridge\instance.json` and prints the port (default `4560`).
3. In another terminal, start the UI: `npm run dev:ui` — Vite comes up on
   `http://127.0.0.1:5173` and proxies `/api` and `/ws` to the core
   (`/hooks` does not go through Vite: it's a route only the local shim
   uses).
4. Open `http://127.0.0.1:5173` in the browser. Paste the token from
   `%APPDATA%\bridge\instance.json` on the opening screen and click
   "Connect".
5. Click "New workspace" and point it at a code folder
   (`C:\projetos\meu-repo`).
6. In the new workspace, click "＋ Claude" — a session should appear with an
   `idle` ring. Send it any prompt in the terminal: the ring should turn
   `running` with the `detail` showing the tool in use, then `done` (with a
   toast, if "Enable alerts" was clicked and permission granted).
7. Click "＋ shell" in the same workspace and confirm it opens a plain shell
   (no agent `BRIDGE_SESSION` — it doesn't react to hooks).
8. To exercise `needs-input` for real: in the Claude terminal, ask for
   something that requires permission (e.g. running a command outside the
   allowlist) and confirm the ring turns `needs-input` (pulsing) until the
   permission is answered in the terminal itself.

It's the shortest path to seeing the core work without packaging anything.

## The Electron app (`packages/shell`, Phase 2)

The shell does **not** bundle the core: `node-pty` and `better-sqlite3` would
need a rebuild for Electron's ABI, which would break the core's test suite
(which runs on the system's Node). The main process launches the core as a
**child Node process** (`BRIDGE_NODE` or the `node` on `PATH`), discovers the
port and token by reading the profile's `instance.json`, and passes the
token to the renderer through the preload (`window.bridge.token()`) — never
through the URL. The UI comes from `http://127.0.0.1:<port>` (the core
itself serves the static build); `file://` is out of the question, `/ws`
refuses that origin.

- **Dev** — `npm run dev:ui` in one terminal (Vite **has to be up**: the
  shell doesn't start it) and `npm run dev:app` in another. The window loads
  `http://127.0.0.1:5173`.
- **Packaged form** — `npm run build:ui` and then `npm run dev -w @bridge/shell`
  without `BRIDGE_DEV`. The window loads `http://127.0.0.1:<port>/`, served
  by the core from `packages/ui/dist` (or from `BRIDGE_UI_DIR`).
- Closing the window shuts down the core and the sessions: first
  `POST /api/shutdown` (graceful shutdown, 1.5 s grace period — it's the one
  that kills the sessions, deletes `instance.json` and writes the last batch
  of logs), and if the core doesn't exit on its own, `taskkill /t /f` on the
  tree. The shell's log lives at `%APPDATA%\bridge\logs\shell.log` (5 MB,
  rotates to `shell.log.1`); the core's, in `core.log` next to it (5 × 5 MB).
- If the app opens and finds a core from the same profile **still up** (the
  window was force-closed and the agents kept running), it **adopts** that
  core — same port, same token, sessions intact — as long as the API answers
  within 2 s. If it doesn't answer, the tree is killed and a new core comes
  up.
- If the core dies within the first 30 s, the shell retries once; on the
  second failure it shows a dialog and exits. With no Node on `PATH`, the
  message is "Bridge precisa do Node.js 22+ no PATH (ou
  BRIDGE_NODE=&lt;caminho&gt;)".

## Building and packaging

Requires **Node.js 22+ on `PATH`** — including on the machine where Bridge
will be installed: the core runs as a separate Node process (see above), so
the installer does **not** carry a bundled Node. Without Node, the app opens
a dialog saying "Bridge precisa do Node.js 22+ no PATH (ou
BRIDGE_NODE=&lt;caminho&gt;)".

```
npm install          # at the root (workspaces)
npm run build        # UI (Vite) + core (esbuild -> dist/index.mjs) + CLI + shell (esbuild)
npm run dist         # build + stage the core's deps + electron-builder (NSIS x64)
```

`npm run dist` leaves in `packages/shell/release/`:

- `Bridge Setup 0.9.0.exe` — NSIS installer (~120 MB), per-user, with an
  install folder picker and the CLI folder going onto the user's PATH
  (`installer.nsh` — see "The `bridge` CLI" below);
- `win-unpacked/Bridge.exe` — the app already unpacked, useful for testing
  without installing.

The installer/`.exe` icon (`packages/shell/build/icon.ico`, 16 to 256 px) is
the `BridgeMark` from `packages/ui/src/components/icons.tsx` over a rounded
`--bg-elevated` square, generated by `packages/shell/scripts/make-icon.mjs`
— no new dependency, pure segment-distance drawing (`src/iconMark.ts`) + PNG
via `zlib` (`src/png.ts`), the same mark as the tray (`src/tray.ts`) and the
UI's favicon (`packages/ui/index.html`). It's already generated in the repo;
only run it again
(`npm run build -w @bridge/shell && node scripts/make-icon.mjs`) if the mark
changes — it's idempotent.

Inside the app, the core lives **outside** the `asar`, under `resources/`:
`core/dist/index.mjs` (the core bundle, no `tsx`), `core/bin/bridge-hook.cjs`
(the hooks shim), `core/node_modules/` (only the runtime dependencies), `ui/`
(the Vite build, which the core serves at `/`) and `cli/` (`bridge.cjs` +
`bridge.cmd`, the command-line binary). Native modules (`node-pty`,
`better-sqlite3`) keep the **system Node**'s prebuilds — no
`@electron/rebuild` here.

The packaged tree is **reproducible**: `packages/shell/scripts/stage-core.mjs`
installs with `npm ci` from the versioned pair
`packages/shell/stage/core.package.json` + `core.package-lock.json`, so the
transitive dependencies aren't re-resolved on every build. After touching
`packages/core`'s `dependencies` (or running `npm update` at the root),
regenerate that pair — otherwise the next `npm run dist` fails saying
exactly that:

```
npm run stage:refresh-lock -w @bridge/shell
```

`node packages/shell/scripts/stage-core.mjs --help` lists the two flags
without staging anything — the help text prints before the script deletes
`.stage/core`, so a mistyped command costs nothing.

## A task = a worktree (Phase 3)

A **task** is a `git worktree` plus the workspace that lives inside it. The
worktree is always born at `<repo>/.worktrees/<name>`, on a branch with the
same name; `.worktrees/` goes into the repo's `.git/info/exclude`
(idempotent, and never into `.gitignore`: Bridge doesn't touch the user's
versioned files). The name is normalized the same way on both sides
(`normalizeTaskName`, in `packages/shared`): lowercase, only `[a-z0-9._-]`,
spaces become `-`, 1–60 characters — "Mailbox do Chefe!" becomes the branch
`mailbox-do-chefe`.

**The flow.** `Ctrl+Shift+Alt+N` (or "New task" at the bottom of the
sidebar) opens the dialog: repository (the list from `GET /api/repos`, the
repos Bridge has already seen, plus "Choose folder…"), task name with the
predicted branch shown below it, base (default = the repo's current branch)
and "Start Claude Code in the first pane", checked. Enter creates the
worktree, the workspace, the tab, the pane and — if asked — the agent
session already inside the new folder. If Claude doesn't come up, the
**task still exists** (the core returns `201` with no `session`) and the
footer warns: trying again would create a second task.

**In the sidebar.** The workspace row shows the branch and, when it's a
task, two indicators: `+N` = commits ahead of the base (`git rev-list
--count <base>..HEAD`) and `~M` = lines from `git status --porcelain
--untracked-files=all` (`~M > 0` shows in amber). The numbers come from the
core — the UI never computes git itself — and are recalculated every
`gitPollSeconds` (`config.json`, default 15 s) **while the window is
visible with the UI connected** — a `/ws` client that receives
`workspace.git` (the Electron main process filters that prefix and doesn't
count) plus a `POST /api/focus` with `windowFocused: true` in the last 60 s.
Outside of that the core launches no `git` at all. There is an immediate
refresh when a session in that workspace gets a `Stop`, and when a task is
created.

The branch shown is the one **on disk** (it comes from the core's
`GitStatus`): switching branches inside the worktree from the terminal shows
up in the sidebar on the next poll, and it's that branch that "Merge into
base" and "Remove worktree" act on. A worktree whose folder disappeared from
disk shows **"(pasta sumiu)"** and the menu is left with only "Close
workspace".

**Deduced base.** A task created by Bridge knows its base (it's the `base`
from `worktree add`). An **adopted** worktree — the folder already existed
when you opened the workspace — doesn't: the base comes from the branch's
upstream (`origin/main`) and, failing that, from the main repo's current
branch, marked **"(base deduzida)"** in the tooltip and in confirmations.
The "⋯" menu has **Set base…** to fix it (`PATCH /api/workspaces/:id/worktree`,
which refuses a ref that doesn't exist).

**The row's "⋯" menu** (shows on hover and on focus):

- **View diff** — opens `git --no-pager diff <base>...HEAD` in a free pane
  of the workspace (splitting the focused one if there is none). It's a
  plain shell with an `initialCommand`: once you've read the diff, you keep
  the prompt.
- **Merge into base** — `--ff-only` first; if it's not a fast-forward, the
  core answers `409 { code: 'not-ff' }` and the UI asks whether it can merge
  with a commit instead (`no-ff`, message `Merge task/<branch>`). Disappears
  when the worktree is on a detached checkout (branch `HEAD`).
- **Remove worktree** — deletes the folder and the branch (`git worktree
  remove` + `git branch -d`).
- **Set base…** — swaps the worktree's base for another ref (useful when it
  was deduced).
- **Open in Explorer** and **Close workspace** (this one only takes it off
  the screen; it doesn't touch the disk).

### The refusals (spec §7/§10)

Bridge doesn't undo work without warning. Every refusal comes with
`{ error, code, detail? }` and the full text goes into the status strip.
`409` is repo state the user resolves; `422` is a request git couldn't
execute:

**The `code` is the contract** — the UI and the CLI decide by it, never by
the text or by `detail` (which is only human support: the dirty worktree's
`--porcelain`, the branch the main worktree is on). Git's raw `stderr`, when
there was one, goes into the message.

| Action | HTTP | `code` | When | What to do |
|---|---|---|---|---|
| Merge | 409 | `dirty-base` | the MAIN worktree has an uncommitted change | commit or stash it first (Bridge doesn't stash) |
| Merge | 409 | `base-not-checked-out` | the main repo is on another branch | `git checkout <base>` yourself — Bridge does **not** switch your repo's checkout |
| Merge | 409 | `base-in-use` | the base is checked out in ANOTHER worktree | close that worktree, or merge from there |
| Merge `ff-only` | 409 | `not-ff` | the base moved on since the task was created | accept the commit-merge the UI offers |
| Merge `no-ff` | 409 | `conflict` | conflict | the core runs `merge --abort` and leaves the repo as it was; resolve it in the terminal |
| Remove | 409 | `dirty-worktree` | the worktree has a changed/new file | commit or discard it (`detail` lists the `--porcelain`) |
| Remove | 409 | `not-merged` | the branch doesn't show up in `git branch --merged <base>` | merge first, or delete the branch by hand |
| Create task | 409 | `exists` | a folder or branch with that name already exists | pick another name |
| Create task | 422 | `no-commits` | the repository has no commits at all | make the first commit (a `worktree add` has nothing to start from) |
| Create task | 422 | `not-a-repo` / `invalid-name` | the folder isn't a repo, or the name comes out empty/invalid after normalizing (`..` in the middle and reserved Windows names — `con`, `nul`, `com1`… — are refused) | pick another folder / another name |
| Set base | 422 | `unknown-ref` | the typed ref doesn't exist in the repo | check the name (`git branch -a`) |

Removal's two refusals are checked **before** anything irreversible — the
core only kills the workspace's sessions once it knows the removal will go
through. Deliberately out of scope: PR/GitHub, automatic stashing and
rebase.

## Scope guard between worktrees

Two tasks of the same repository run in `.worktrees/a` and `.worktrees/b`.
A process's `cwd` is a **suggestion**, not a fence: nothing stops task A's
Claude Code from opening — and rewriting — a file belonging to B through an
absolute path. The `git worktree` isolation exists for git; for the agent,
it didn't. The scope guard is that fence, and it lives where Bridge already
was: in the hook.

**How it works.** `PreToolUse` is the only Claude Code hook that accepts a
permission decision in its response. On every tool call Bridge resolves the
declared path and, if it falls outside the session's root, answers:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Bridge: outside this task worktree (…)…" } }
```

The full text the agent receives is:

> Bridge: outside this task worktree (`<path>`). This session can only
> read and write inside `<root>`. Allow it in ⋯ → "Allow access outside
> the worktree".

In a repository workspace the wording changes to "outside this workspace
repository"; in a workspace outside any repo, "outside this workspace
folder" — and the item named at the end becomes "Allow access outside the
repository", which is the exact label the menu draws in those two cases.
The sentence names the EXACT menu item on purpose: it's the agent that reads
the refusal, and it's the agent that's going to repeat it to you; pointing
you at a menu item that doesn't exist would be worse than saying nothing.
When the refusal is about a UNC path, the sentence "UNC paths and `\\?\`
are always refused" is appended too. The reason is written **for the
agent to read**, because it's the agent that reports it back in the
conversation — hence it saying where the session is stuck and how you lift
it.

**Which root.** A **task** workspace → the worktree's folder (the isolation
you asked for when you created the task). A **repository** workspace (the
root, no worktree) → the **whole repository**: whoever opens the repo at
its root is working on the repo, and fencing them to a single pane's `cwd`
would be a fence nobody asked for. A workspace outside any repository → its
own `cwd`. A root that vanished from disk (a disconnected drive) **turns
the guard off** for that session instead of blocking everything — "I don't
know" can't become "deny everything".

**What is judged**, and only this: `Read`, `Edit`, `Write`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep` and `LS`, through the `file_path`,
`notebook_path` and `path` fields of `tool_input`. The `pattern` of
`Glob`/`Grep` does **not** count: it's a search pattern, not a path, and its
results are already filtered by `path`.

**`Bash` is NOT blocked**, on purpose. A shell command doesn't declare a
path: it declares text (`npm test`, `git log -- ../outro`, a pipeline with
`cd`), and the real target depends on the `cwd`, the `PATH`, variables and
the shell itself. Judging paths inside a command string would get it wrong
in both directions at once — false positives (every `..` in a
`--exclude=../x` would become a refusal, and a legitimate `npm test` would
stop running) and false negatives (a `powershell -EncodedCommand` would
sail through) — and a guard that's wrong both ways teaches you to switch it
off. `SECURITY.md` says this outright.

**How the path is resolved**, before any comparison: a relative path
resolves against the **session's** `cwd`; `.`, `..` and mixed `/`/`\` are
collapsed; symlinks and junctions are unmasked with `realpath` — including
for a file that does **not** yet exist (resolution climbs up to the first
ancestor the disk actually knows, otherwise every `Write` of a new file
would be blocked). A **UNC** path (`\\servidor\share`) and the device
namespace (`\\?\`, `\\.\`) are rejected without any comparison at all: `\\?\`
turns off Windows' own path normalization, so comparing a prefix there
would give an answer the filesystem doesn't honor — and a network path is
never inside a local worktree. A path that doesn't resolve at all counts as
**outside**: the guard is fail-closed. The root itself counts as inside
(an `LS` of the worktree is legitimate), and the comparison ignores case on
Windows.

**The 🛡 badge.** The refusal is answered to the agent, which moves on by
itself; with no signal on screen, you'd only find out from Claude's odd
behavior. The session's row in the sidebar gets a blue **🛡 N** badge (`N`
is that session's total refusals), and the tooltip lists the **last five**
paths, most recent first, after the sentence "The scope guard blocked
these paths (outside this session root). Allow it in ⋯ → Allow access
outside the worktree." The badge accumulates while the guard applies: it
doesn't disappear when the session goes back to normal, because the attempt
happened. **Unlocking the workspace clears the badge** (0.12.2): turning on
"Allow access outside the worktree" makes the core zero that workspace's
sessions' counter and the row goes back to normal — the badge describes a
fence, and the fence stopped existing. Restricting again doesn't bring the
number back — it restarts from zero on the next new refusal (the history of
each refusal stays in the core's log, not in this counter). Every path goes
through `sanitizeDisplay` before reaching the tooltip or the message — the
`tool_input` comes from the agent, and the agent reads other people's
repository files.

**Unlocking a workspace.** In the workspace row's "⋯" menu: **"Permitir
acesso fora do worktree"** (or **"Allow access outside the repository"**,
depending on the root), which becomes **"Restrict to the worktree"** /
**"Restrict to the repository"** once it's on. It's the
`PATCH /api/workspaces/:id` route with `{ "crossAccess": true }` (or
`false`), which returns the updated workspace and takes effect **right
away**, on the very next `PreToolUse` — no need to reopen the session. The
decision is persisted on the workspace and survives a restart. The item
stays in the menu when the worktree's folder has disappeared (it's a
decision about the workspace, not a git operation) and disappears when the
guard is off in the configuration — offering to lift a fence that doesn't
exist would be a lie.

**Unlocking is TOTAL, not "access to the sibling worktree".** With
`crossAccess` on, that workspace's sessions can read and write **anywhere
on disk** again — not just the worktree next door, and not just the
repository. It's the same freedom the agent had in every version before
0.11.0, which is exactly why it's per workspace and explicit, in a menu
item that says what it does.

**Turning it all off.** In **Settings → Sessions**, the option "Scope guard
between worktrees" (`sessions.scopeGuard`) is the master switch, and it's
born **on**. Off, Bridge doesn't judge any path at all. The difference
between the two: `sessions.scopeGuard` is global, `crossAccess` unlocks
**one** workspace.

**Who it protects against.** Against **agent error** and against **hostile
repository content** — the case where nobody wanted that file touched and
nobody found out. It is **not** a barrier against you: whoever controls the
terminal can turn the guard off, edit `config.json` or run `git` by hand.
See [`SECURITY.md`](SECURITY.md).

## Git filters and trust

Git executes commands declared in the **repository's own** `.git/config`.
One of them is the filter driver:

```ini
# .gitattributes            # .git/config
*.txt filter=exemplo        [filter "exemplo"]
                                clean  = <comando>
                                smudge = <comando>
```

`clean` runs on every `git status` that needs to compare **content** —
which happens whenever a tracked file has the same size and a new mtime,
i.e. an edited file. And Bridge runs `git status` on its own: the sidebar's
poller reads every worktree every 15 s to keep `+N ~M` up to date. In a
repository of unknown origin (a zip, a backup, a USB drive — anything that
preserves the `.git/`, unlike a `git clone`, which doesn't bring the
config) that's repeated command execution, without you clicking anything.

Turning filters off doesn't help: `git-crypt`, `nbstripout` and `git-lfs`
are exactly the same mechanism, and a neutered `clean` makes every filtered
file look modified forever — `~M` stuck and "Merge"/"Remove worktree"
refusing with `dirty-worktree` even though you haven't touched anything.

So Bridge **detects and asks**:

- Repository **without** a filter driver: nothing changes. This is the vast
  majority of cases.
- Repository **with** a driver and **without** declared trust: the sidebar
  shows **⚠ filtros** instead of `+N ~M`, and the core **does not run** any
  git command that touches content there. The branch still shows up (it
  comes from `HEAD`, which doesn't go through a filter). "Merge into base"
  and "Remove worktree" answer **409 `filters-untrusted`**.
- Repository **trusted**: everything works as before — including the
  filters, which run again. It's your choice, made on purpose.

The block also applies to **"New task"**: `git worktree add` does a
checkout, and a checkout runs the driver's `smudge`. In an untrusted repo
the route answers **409 `filters-untrusted`** and no file is written. That's
why the menu item shows up in **any** workspace of the repository, worktree
or root — without it there would be no way to grant trust before creating
the first task.

To grant trust: the workspace's **"⋯"** menu → **"Trust this repository's
git filters"**. The dialog states exactly what starts being executed.
To undo it, the same menu becomes **"Stop trusting the filters"**.

Trust belongs to the **repository**, not the workspace: it applies to all
of its worktrees, is stored in the profile's `bridge.db` and survives a
restart. A freshly opened repo is **never** born trusted.

Through the API:

```
PATCH /api/repos/:id   { "trustFilters": true }   → the updated repo
GET   /api/repos/:id/filters                      → { "drivers": ["exemplo"] }
```

Implementation details that matter:

- Detection uses `git config --local --includes --name-only --list` **and**
  the `--worktree` scope, at the root **and in every worktree** of the
  repository. `--includes` is mandatory: without it, an
  `include.path = outro.cfg` hides the driver from the listing.
- **Submodules** are counted too. A submodule's config lives in
  `.git/modules/<sub>/config`, which the superproject's enumeration can't
  see — Bridge descends into every initialized submodule (up to 3 levels)
  and merges whatever it finds. It only descends where it's safe: the
  folder and the gitdir git resolves for it must, by `realpath`, stay
  **inside** the repository. A declared path with `..`, an absolute path, a
  folder that's a junction pointing outward, or a `.git` that's a file
  saying `gitdir: <outside>` are not visited — they count as suspicious.
- Passive reads run with `--ignore-submodules=all`. An accepted side effect:
  a **dirty submodule no longer counts** toward the sidebar's `~M`.
- When enumeration fails for any reason — including an unreadable
  `.gitmodules` — the repo is treated as "has a driver" (fail-closed).

## States of a session

The ring in the sidebar is the session's `state` on the core. What decides
the transition is the agent's adapter, driven by the hooks; a `shell`
session stays `idle` until the PTY dies.

| State | Ring | When it starts | How it ends |
|---|---|---|---|
| `idle` | gray | `SessionStart`; an idle-wait `Notification`; the user focusing a `done` session | a new prompt (`UserPromptSubmit`) |
| `running` | blue | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`. The `detail` shows the tool and its argument (`Bash · npm test`), or `pensando…` between tools | `Stop`, `PermissionRequest`, `Notification` |
| `needs-input` | pulsing amber | `PermissionRequest`, or a `Notification` that isn't an idle one. Fires a `needs-input` notification | only by hook (answering the permission in the terminal); the user's focus does **not** clear it |
| `done` | green | a clean `Stop`. Fires a `done` notification | the user focusing the session (with the window focused) → `idle`; a new prompt → `running` |
| `stuck` | red | 5 blocked `Stop`s in a row (`stop_hook_active: true`). Fires a `stuck` notification | a new prompt resets the counter |
| `server-limited` | orange | the PTY output matched one of the SERVER limit phrases ("Server is temporarily limiting requests", "not your usage limit", `overloaded_error`, `API Error: 529`) | the next `Stop`/`UserPromptSubmit`, or 5 min |
| `exited` | struck-through gray | the PTY died, or `SessionEnd` with an exit reason (`exit`, `prompt_input_exit`, `logout` — `clear` does **not** end it) | the pane stays open with the exit; creating a new session there replaces the dead one |

Cardinality: **one pane hosts at most one session**. Creating a session in a
pane that already has a live one returns `409`; if its session is `exited`,
the new one replaces the old. `DELETE /api/sessions/:id` removes the pane
along with it, unless it's the only one in the tab.

## The Claude Code you open inside a shell

Until 0.11.x, typing `claude` in a shell pane gave you a Claude Code that
Bridge couldn't see: no `--settings`, so no hook ever reached the core, and
the sidebar row kept saying `shell` while a whole agent worked in there.
From **0.12.0** on it says `claude`.

How it works: every shell Bridge opens is born with a folder of its own at
the front of its `PATH`, holding a `claude` shim that calls the REAL Claude
Code with `--settings <session folder>\settings.json` added — the very same
settings file (hooks and status line) an agent session gets. You type
`claude` normally, with whatever arguments you want; they're passed through
untouched.

When the first hook arrives, the session becomes a **host**:

- the sidebar row and the pane header start showing `claude`, with a real
  state ring (`running`, `esperando você`, `terminei`) and the detail
  `no shell` when nothing is happening;
- notifications, the status line, usage accounting, the server-limit badge
  and the scope guard all apply — as in an agent session;
- when you leave Claude (`/exit`, `Ctrl+D`) the row goes back to `shell` and
  **the shell stays alive**, same pane, same scrollback.

What does **not** change: the session's `kind` stays `shell` from beginning
to end. It never becomes an agent session — which is why reopening Bridge
brings the pane back as a plain shell, without resuming the conversation.
On a pane that **has already held an agent session**, though, the
**"Reopen with context"** button does reach it: `POST /api/panes/:id/resume`
resumes the last `lastAgentSessionId` that pane saw, and a Claude opened
inside the shell records its own there. On a pane that only ever held a
shell the route still answers `422 nothing-to-resume` — there's no
`lastAgent`.

A host session **counts** toward `sessions.maxConcurrentAgents` (it's a real
Claude Code taking a slot), but it never goes through the launcher's queue
— Bridge didn't launch it, so there's nothing to queue.

Turning it off: `Ctrl+,` → **Sessions** → "Recognize Claude Code started
inside a shell" (or
`PATCH /api/config { "sessions": { "hostedAgents": false } }`). Turning it
on or off applies to the **next** shell you open; a hosting already under
way finishes on its own, the normal way. On a machine with no `claude` on
the PATH none of this happens: with no target, there's no shim and no PATH
change.

## Server limit vs. usage limit, and the launcher

Both show up as "limit" in the terminal and they are not the same thing.
Confusing one for the other is the most common pain of running several
Claude Code sessions side by side — and it's what motivated this part of
Bridge.

| | **Usage** limit | **Server** limit |
|---|---|---|
| Whose it is | yours (your account's 5 h / weekly windows) | Anthropic's shared infrastructure |
| Scales with the plan? | yes | **no** |
| What the terminal says | the quota reached 100 % | `Server is temporarily limiting requests (not your usage limit)`, `API Error: 529`, `overloaded_error` |
| How Bridge shows it | a **red** badge in the sidebar, with the reset time | an **orange** ring and badge (`⏳ servidor`) on the session row, with the sentence it read in the tooltip |
| How it clears | waiting for the reset | on its own, in seconds to minutes |

### What Bridge does about it

**It detects.** Every bit of PTY output goes through a scanner with a
rolling 4 KB window per session (ANSI stripped, case-insensitive). If one of
the phrases matches, the session enters `server-limited` with the phrase
kept as proof. The session leaves the state on the next normal turn (`Stop`
or `UserPromptSubmit` hook) or after **5 minutes** — whichever comes first.

The match requires the whole Claude Code sentence (or the token that only
exists in the API error body). A `// TODO: tratar rate limit` in a diff, an
`if (err.status === 529)` in a file open in the terminal, and an
`HTTP 429` fire nothing: a false positive here is worse than no detection at
all, because it teaches you to ignore the indicator.

**It paces launches.** On by default (Settings → **Sessions**):

- a **ceiling of simultaneous agents** (`sessions.maxConcurrentAgents`,
  default `4`). A request beyond the ceiling enters a queue and
  `POST /api/sessions` answers `202 { queued: true, position }` instead of
  `201`;
- **300–900 ms of jitter** between launches requested in a burst — restoring
  a workspace with several panes is exactly that kind of burst;
- a **5 s to 60 s backoff** (doubling on every launch) while **any** session
  is `server-limited`: with the server throttling, bringing up one more
  agent at the same pace is pouring on fuel.

None of this kills, pauses or queues a session that already exists — once
it's up, the agent is yours. And two paths do **not** go through the queue,
because they are one deliberate click on a single session:
`POST /api/panes/:id/resume` (`bridge resume`) and the agent born together
with a new task.

**It shows the queue.** With someone waiting, the sidebar gets the line
`2 sessões aguardando slot` and a **Lançar agora** button, which releases the
next one, ignoring the launcher once.

### Routes

| Route | What it does |
|---|---|
| `GET /api/launcher` | `{ enabled, maxConcurrent, active, serverLimited, spacingMs, nextAt?, pending[], lastError? }` |
| `POST /api/sessions` | `201` with the session, or `202 { queued: true, id, position, reason }` (`reason`: `slots` \| `jitter` \| `backoff`). A missing pane (`404`) and a busy pane (`409`) still respond immediately — nothing enters the queue only to fail later |
| `POST /api/launcher/launch-now` | `{ id? }` — releases the pending one (without `id`, the first in the queue). `404` `queue-empty` / `launch-not-found` |
| `DELETE /api/launcher/pending/:id` | removes it from the queue without starting anything |

The `launcher.changed` event carries the whole status over `/ws` on every
queue change; `session.state` now carries `serverLimit`
(`{ since, phrase, pattern }`) alongside the state.

### Turning it off

Settings → **Sessions** → *Schedule agent launches*. Off, every request
comes up right away and the ceiling stops applying — server-limit detection
keeps working (it only informs; it doesn't hold anything back).

## Sidebar groups

The sidebar groups workspaces by git repository; ones with no repository
fall into the **"Sem repositório"** group, which comes last. Every group
header is a control:

- **clicking the title collapses and expands** the group (the chevron shows
  which). Collapsed, the workspace rows disappear and the header shows the
  workspace count on the right and the **ring of the group's worst state**
  — a session getting stuck inside a collapsed group still lights up the
  warning;
- the **"⋯"** that appears on hover has "Fixar no topo" / "Desafixar".
  Pinned groups come first, in the order they were pinned; then repository
  groups by name, and "Sem repositório" last — unless it is itself pinned.

Pinned and collapsed are machine preferences, not core state: they live in
`localStorage`, under the key `bridge.sidebar.groups`
(`{ pinned: string[], collapsed: string[], collapsedWorkspaces: string[] }`
— the first two keyed by group id, which is the repository's id or
`__loose__` for "Sem repositório", and the third by workspace id). A
missing or corrupted value is read as an empty preference.

### Workspaces open by default (0.12.2)

**Every workspace is born expanded**: every workspace's sessions are all
visible at the same time. Each workspace row has a **chevron** on the left
that collapses and expands only that one — and it's the only thing that
does. Clicking the workspace's name only **activates** it (that's what
switches the content area); activating one no longer collapses the others.
The active workspace still gets the background highlight.

Collapsed, a workspace keeps the **ring of the worst state among its
sessions**, like a collapsed group header: closing a row hides the
sessions, never the warning that one got stuck. From the keyboard, the
chevron is a real button with `aria-expanded` and the label "Recolher
workspace" / "Expandir workspace"; ↑/↓ still walks between group headers,
workspaces and sessions, without stopping on it.

*History: up through 0.12.1 the sidebar was an accordion — only the ACTIVE
workspace stayed expanded, and opening one closed the previous one.*

### Keyboard and screen reader support in the sidebar (0.9.0)

The sidebar's three row types — group header, workspace and session — are
real controls: they take Tab focus, activate with `Enter`/`Space`, and
**move with ↑/↓** in the order they're drawn. At the ends, the arrow goes
back to being the page's (the list scrolls instead of wrapping around), and
with focus on a row's "⋯" the arrow keys still belong to the menu.

Every row also carries an `aria-label` that says in text what the color
says on screen: `"Workspace exemplo, 2 sessões, esperando você"`, `"Sessão
claude, travada, editando, em foco"`, `"Grupo forja, 3 workspaces, travada,
recolhido"`. Without it, the colored ring and the blue focus strip simply
didn't exist for someone using a screen reader. Keyboard focus also reveals
a row's `✕` and `⋯`, which used to appear only on hover.

## Closing a pane

`Ctrl+Shift+X` closes the target pane (the focused one, or the active tab's
first one). The same path has two mouse doors: the **✕** that appears in the
pane header when the pointer is over it (like the tab's ✕) and the empty
pane's **"Close pane"** button.

Works on an empty, exited or live pane. What erases it is the core
(`DELETE /api/panes/:id`): it ends the pane's session if there is one, and
when it was the **last pane in the tab**, closes the tab too. The UI only
asks when there's a live **agent** session to lose ("Fechar este painel
encerra a sessão claude. Continuar?"); a live shell closes directly, because
reopening a shell costs one `Enter`. After closing, focus goes to the
neighboring pane (the core answers `GET /api/panes/:id/neighbor?dir=`) or,
if there isn't one, to the tab's first pane.

The empty pane also has **"Open shell"** and **"Open Claude Code"**
buttons — `Enter` still opens the shell, and each button's shortcut is in
its tooltip. And the hints on the right of the tab bar (**divide**,
**← → navega**, **uso**, **fecha painel**) are buttons: clicking one fires
exactly the same action as the shortcut.

Since 0.11.2 the bar shows the **name** of each action, not the key
combination: with five hints, every `<kbd>` cluttered the whole bar. The
key is still one step away — it's in each button's tooltip and in the
**Settings → Shortcuts** table — and it's read from the `keybindings.json`
in effect, not from literals: rebinding `pane.close` updates the tooltip
too, and an action with no binding in the file warns "(sem atalho)" with
the button still clickable.

Navigation has been **two separate actions** since 0.9.0: `←` goes to the
pane on the left (`pane.left`) and `→` to the one on the right
(`pane.right`) — the arrows there name the direction, not the key.

## Terminal: font

The terminal pane is xterm 5.5 on the **DOM** renderer (no
`@xterm/addon-canvas`, no `@xterm/addon-webgl`), so **every glyph comes from
the font** — xterm's own box-drawing and block glyph rendering
(`customGlyphs`) only exists in the canvas/WebGL renderers. If the font is
missing a glyph, Chromium falls back to the next font in the list, glyph by
glyph, and the result is a cell with a different width than the one xterm
measured: the Claude Code logo shattered, the status line jumbled.

The default lives in `packages/shared/src/model.ts`
(`DEFAULT_STORED_CONFIG`) — the single source both the core (`DEFAULT_CONFIG`)
and the UI (`TERMINAL_DEFAULTS`, in `packages/ui/src/terminalPrefs.ts`)
derive from:

```
'Cascadia Mono', Consolas, 'Geist Mono', ui-monospace, monospace
```

- **Cascadia Mono** ships with Windows Terminal and registers in
  DirectWrite's font collection (it doesn't show up in `C:\Windows\Fonts`,
  but Electron sees it). It covers box-drawing 128/128, blocks 32/32,
  geometric shapes 96/96 and braille 256/256, all at the same advance as
  `W` — that's what makes a symbol and a cell share the same width.
- **Consolas** is the safety net if Windows Terminal isn't installed. It
  has full box-drawing, but only 8/32 of the blocks: it's missing the
  quadrant glyphs (U+2596–259F) the Claude logo needs.
- **Geist Mono** (the `.woff2` bundled with the app) is a 225-codepoint
  subset, Latin-1 and little more. Nice for text, useless for a terminal —
  which is why it's last.

The emoji an agent prints in the terminal need more than a font. Without
the addon, xterm uses the **Unicode 6** width table, where U+1F300–U+1F9FF
counts as width 1 — and the emoji, which Segoe UI Emoji draws over more
than two cells, overlapped the next letter. `@xterm/addon-unicode11` (the
**only** dependency added for this) is loaded with
`term.unicode.activeVersion = '11'` and fixes it. It's xterm's proposed API,
so `XTerm` has to be born with `allowProposedApi: true`: without the flag
the addon throws on mount and the whole renderer goes blank.

What still falls back to a system font, because no monospace font on the
machine has it: `✻` (U+273B, the Claude Code spinner), `❄` (U+2744) and
`⛔` (U+26D4).

Installing a **Nerd Font** (Cascadia Code NF, JetBrainsMono NF) would fix
the remaining symbols and bring powerline glyphs along — it's a download,
so it stays a suggestion, not a default. And the whole stack depends on
**Windows Terminal being installed** for Cascadia Mono to exist: without
it, it degrades to Consolas, which is a partial fix (missing the Claude
logo's quadrant glyphs, so the logo breaks again).

## Terminal: copy and paste

The convention is Windows Terminal's and VS Code's terminal:

| Key | What it does |
| --- | --- |
| `Ctrl+V` | pastes the clipboard into the terminal |
| `Ctrl+Shift+V` | same |
| `Shift+Insert` | same |
| `Ctrl+C` **with a selection** | copies the selection and clears it |
| `Ctrl+C` **without a selection** | still `^C` (SIGINT) — that's what it's for in a terminal |
| `Ctrl+Insert` | copies the selection |
| **Right-click** | copies with a selection, pastes without one (no context menu) |

A multi-line paste goes in as **one** entry: `term.paste` wraps the text in
*bracketed paste* when the program on the other side turned on mode 2004 —
Claude Code does.

Two combinations are deliberately left out. **`Ctrl+Shift+C` stays "open
Claude"** (it's the app's shortcut; if you'd rather it copy, rebind
`agent.claude` in `keybindings.json`). And **`Ctrl+Alt+V` / `Ctrl+Alt+C` go
to the terminal**, because on an ABNT2 keyboard `AltGr` arrives as
`Ctrl+Alt`, and hijacking it would break normal typing.

### Mouse clicks in Claude Code

Claude Code accepts clicks — picking an option, switching between agent
tabs — only in its **fullscreen** UI, and it's Claude itself that decides
whether to start in it (version, gradual rollout, `settings.tui`). Bridge
has always forwarded the mouse: a click becomes an SGR sequence in xterm,
crosses the WebSocket and ConPTY and reaches the program byte by byte. What
was missing was Claude asking for it.

Settings → Sessions → **"Mouse clicks in Claude Code"**
(`sessions.mouseClicks`, on by default) fixes it on both ends: on, every
new session is born with `CLAUDE_CODE_NO_FLICKER=true` (your own value of
that variable wins if you've already set it) and the terminal forwards the
mouse; off, the session is born with `CLAUDE_CODE_DISABLE_MOUSE=1` and the
terminal ignores any mouse-tracking request — dragging always selects text,
like a terminal without mouse support. Applies to sessions opened after the
change; ones already up stay as they were born. In the fullscreen UI,
scrolling belongs to Claude itself (it keeps its own virtual scrollback;
the mouse wheel walks it), not the terminal. Regardless of the option, the
modes a program turned on (mouse, bracketed paste, application cursor
keys) survive a core reconnection: the terminal snapshots them before
redrawing from the scrollback and reapplies them afterward.

## Language (0.13.0)

Bridge speaks **Brazilian Portuguese** and **English**. The choice is a
single one and covers the whole app: the interface, the API error
messages, the notifications, the status line, the launcher queue texts, the
scope guard's refusal reason (the one the agent reads), the tray, the
native toasts, the Windows dialogs and the `bridge` CLI.

**Where to change it:** `Ctrl+,` → **Appearance** → **Language**, with
three options — *Português (Brasil)*, *English* and *System*. The switch
takes effect **immediately, without reopening the window**: no save
button, no reload, no "restart the app". The two language names always
show in their own language (whoever is looking for English looks for
"English", even on a screen that's in Portuguese); only *System* is a
phrase and gets translated.

**The default is `System`** (`ui.language: "system"` in `config.json`),
and the rule is simple: a locale of `pt`, `pt-…` or `pt_…` (`pt`, `pt-BR`,
`pt-PT`, `pt_BR`) becomes Portuguese; **anything else** becomes English. On
a Portuguese-language machine you don't have to configure anything, and
whoever installs Bridge outside Brazil gets English without hunting for the
option. What resolves `system` is the **core**, using its own process
locale (`Intl.DateTimeFormat().resolvedOptions().locale`) — the UI, the
shell and the CLI receive the language already resolved, so two parts of
the same app never speak different languages on the same machine.

The resolved language shows up in `GET /api/config` as
**`languageResolved`** (read-only: to change it, send `ui.language`).

**In the CLI.** `bridge` asks the core for the language, and the core
decides. With Bridge **closed** — `bridge --help`, `bridge --version`, or
any command before the instance is found — the **`BRIDGE_LANG`** variable
(`pt-BR` or `en`) applies and, without it, the machine's locale:

```powershell
$env:BRIDGE_LANG = "en"
bridge --help          # English help, with Bridge closed
```

With Bridge **open**, `BRIDGE_LANG` does not override the app:
`bridge list` comes out in whatever language Bridge is set to. That's
deliberate — two terminals on the same machine shouldn't answer in
different languages about the same core.

**What is NOT translated**, by design:

- **the agents' and shells' output** — the text inside the terminal belongs
  to whoever is running in there, not to Bridge (a `claude` in English
  stays in English);
- **the notifications the agent writes** (`Notification` with a `message`,
  and `bridge notify "texto"`) — they come out as they arrived. The ones
  **Bridge** writes ("Aguardando você", "Terminou o turno") are translated;
- **the file logs** (`logs\core.log`, `logs\shell.log`) — they stay in
  pt-BR: they're for the owner and for support, and a log line in whoever
  opened the issue's language is harder to search, not easier;
- **the NSIS installer** — the install screen stays in whatever language
  electron-builder uses;
- **the documentation** — this file is the English documentation, and the
  Portuguese version is [`README.pt-BR.md`](README.pt-BR.md);
- **proper names and identifiers** — `Ctrl+Shift+C`, `wsl:Ubuntu`, `pwsh`,
  session and workspace ids, the `kind` of the state rows.

An **already-recorded notification is not rewritten** when you switch
languages: it's the record of what happened, in the language of that
moment. What changes is the next one. For the same reason, the sidebar's
**session detail** ("pensando…", "escrevendo arquivo") stays in the
language of the hook that produced it until the next hook arrives: it's
the last observed state, not a phrase Bridge redraws.

## Settings

Bridge's configuration lives in `%APPDATA%\bridge\config.json`
(`BRIDGE_PROFILE_DIR` changes the folder). Two routes touch it — both
require the instance's bearer token, like the rest of the API:

| Route | What it does |
| --- | --- |
| `GET /api/config` | Returns the whole configuration in effect. |
| `PATCH /api/config` | Takes a subset, validates it, applies it and returns the whole merged configuration. |

Fields `PATCH` accepts:

| Field | Type / range | When it applies |
| --- | --- | --- |
| `shell` | `pwsh` \| `powershell` \| `gitbash` | **New** sessions (live ones stay in the shell they were born in). |
| `gitPollSeconds` | integer, 5–120 | Right away: the git poller is rescheduled in flight. |
| `toast.enabled` | boolean | Right away, on the next notification. |
| `toast.quietWhenFocused` | boolean | Right away, on the next notification. |
| `terminal.fontFamily` | text, 1–200 chars | Right away (the UI applies it to open terminals). |
| `terminal.fontSize` | integer, 8–24 | Right away (the UI applies it to open terminals). |
| `restore.resumeAgents` | boolean | On the app's **next launch** (it decides whether an agent pane comes back as an agent or as a shell). |
| `sessions.maxConcurrentAgents` | integer, 1–16 | Right away: the launcher re-reads the ceiling and releases queued sessions if it went up. |
| `sessions.scheduleLaunches` | boolean | Right away (off, every request comes up immediately and the queue stops existing). |
| `sessions.autoRecap` | boolean | On the next resume that comes back empty. |
| `sessions.scopeGuard` | boolean | On the next `PreToolUse` — no session needs to be reopened. |
| `sessions.hostedAgents` | boolean | On the **next shell** you open (it's the one born with the `claude` wrapper and the PATH change). A hosting already in progress isn't interrupted: it ends on its own at `SessionEnd`. |
| `ui.language` | `pt-BR` \| `en` \| `system` | Right away, everywhere: the window switches language through the WS's `config.changed`, without reopening, and the core starts writing in the new language. See "Language". |

`toast`, `terminal`, `restore`, `sessions`, `usage` and `ui` are merged
**key by key**: sending `{ "toast": { "enabled": false } }` doesn't reset
`quietWhenFocused` to default, and `{ "sessions": { "scopeGuard": false } }`
doesn't touch the agent ceiling.

A field that fails validation is **ignored**, and the rest of the file
keeps applying — a `"shell": "zsh"` doesn't bring the app down or wipe your
port. But the whole file being **unreadable** (JSON broken by a hand edit,
or a top level that isn't an object) makes Bridge boot with the **default**
configuration and log the reason in `core.log`, at `warn`, with the file's
path: `config.json: JSON inválido (…); usando a configuração padrão`. This
used to happen silently, and the configuration looked like it had
vanished on its own. Mind the order: a `PATCH /api/config` (or a change
through the settings dialog) overwrites the file — fix the JSON **before**
touching settings through the UI.

`port` is **read-only through the API** — the only way to change it is
editing `config.json` with Bridge stopped. Changing the port with the
server up wouldn't reopen the socket (and would invalidate the token
recorded in `instance.json`).

### Usage and limits (`usage`)

Bridge counts your token usage **itself**, by reading the transcripts
Claude Code already writes. Before 0.10.0 this part of the screen came from
an external quota tool; now it's Bridge's own code (ADR-012, which replaces
ADR-008).

**What counts.** Every assistant line from the transcripts under
`<claudeHome>\projects`, from both sources: the conversation you typed
(`main`) **and the subagents it launched** (`subagents`, the nested
`*.jsonl` files under the session's folder). The two ALWAYS add up into the
total — the split exists so the panel can say "includes subagents", never
to hide half the usage behind a filter. On the author's machine subagents
are most of a day's usage; a panel that showed only the main conversation
would be wrong by a factor, not by a detail.

**Where the day starts.** At **local midnight** — your machine's clock, not
UTC. A late-night session counts on the day you were actually working.
`semana` runs Monday through Sunday, local; `mês` is the local calendar
month.

**The cost is an ESTIMATE, not an invoice.** It comes from a bundled
list-price table (`packages/core/src/usage/pricing.json`), which carries
the date it was checked against the official documentation — the API's
response returns that date as `pricingAsOf` and the Settings → Usage
section writes it on screen. The four token types are billed separately,
with the **1-hour** cache write counted apart from the 5-minute one: it
costs double the input price (the 5-minute one, 1.25 ×), and lumping them
into a single column used to understate the bill.

**Privacy.** Bridge reads the transcripts only to ADD THEM UP. No message
content ever leaves that reading: what goes into the database is token
counts, the model id, the working folder (`cwd`) and the day's timestamp.
See `SECURITY.md`.

**While it's still reading.** The first scan of a large history is a long
job (on the author's machine, 8,431 transcripts and 12.8 GB). It runs in
the background, resumes where it left off and reports progress: the panel
shows "ainda lendo as transcrições (N de M arquivos)" instead of "nenhuma
transcrição encontrada" — which would be false — and the "Reler
transcrições" button shows the fraction while it runs and the result
(`{ arquivos, mensagens, dias }`) once it's done.

The `usage` block of `config.json` configures the monitor:

| Field | What it does |
| --- | --- |
| `dayBoundary` | Only accepts `'local'`: the day starts at the machine's local midnight. |
| `showCost` | Show the estimated cost in the strip, the panel and the status line. |
| `terminalStatusLine` | Draw the status line **inside** the Claude Code terminal. Born `false` (0.12.2): the sidebar already shows the same numbers, and the hook keeps running regardless. |
| `pricingFile` | Path to a JSON `{ model: { input, output, cacheWrite, cacheRead } }` (USD per million). |
| `pricing` | The same map, inline — wins over the file, which wins over the bundled table. |

Each price entry has `input`, `output`, `cacheWrite` (5-minute write) and
`cacheRead`, all in USD per million, plus an **optional** `cacheWrite1h`:
without it, the official rule applies, `2 × input`, so a table you wrote
before this version keeps working.

The lookup by model gets **two tries and no more**: the exact id and the id
without the date suffix (`claude-haiku-4-5-20251001` →
`claude-haiku-4-5`). There's no prefix fallback — it used to make
`claude-opus-5` inherit an earlier generation's price, a wrong number with
the same look as a right one.

A model that's in none of the three tables still counts normally in
**tokens** and is simply left out of the **cost**: the slice returns
`cost: null` (or `costPartial: true`) plus a warning in `pricingWarnings`
naming the model. A guessed cost would be worse than no cost at all — it
would look like an answer.

`GET /api/config` also returns a `claudeHome`, read-only: the folder
transcripts are read from (`BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` →
`~/.claude`). It's derived, it doesn't live in `config.json`.

The `GET` also returns a `profileDir`: the profile folder's **absolute**
path (`BRIDGE_PROFILE_DIR`, or `%APPDATA%\bridge`). It's also read-only,
for a stronger reason than the other two — it isn't in `config.json` and is
never written there. It's derived from WHERE the file is, and storing it
inside the file itself would be a truth with an expiration date: moving
the folder would be enough to break it. It exists because the UI needs a
real path to open in Explorer.

Errors:

| Situation | Response |
| --- | --- |
| Body carries `port`, `profileDir` or `claudeHome` | `403 { code: 'read-only', fields: [...] }` |
| Out-of-range value, wrong type or unknown field | `400 { code: 'invalid-config' }` |
| No bearer | `401` |

An accepted `PATCH` writes `config.json` atomically (writes
`config.json.tmp` and renames over it), applies it in memory and emits
`config.changed { config }` on `/ws` — that's how the UI updates without
reloading. The write happens before the apply: if the disk refuses, nothing
changes in memory and the app keeps behaving the way the file describes.

### The "Usage" panel (0.10.0)

![The Usage panel with limits, cost per day and breakdown by model and project](docs/img/uso.png)

`Ctrl+Shift+Y`, the **uso** hint on the tab bar, or "Uso…" in the sidebar's
"⋯" menu open the panel. `Esc` (or clicking the overlay) closes it. There's
no OK or Cancel because there's nothing to confirm: it's a read-only
screen.

Top to bottom follows the order of the question:

1. **can I keep going right now** — a meter per live limit window (5 h,
   weekly, and whatever else the payload brings), with a percentage, a bar
   colored by tier (`ok < 60 <= warn < 85 <= bad`), and "reseta em 2h15" /
   "reseta na segunda". The bars are **frozen** (0.18.0): Claude Code only
   sends `rate_limits` while it has a recent API response, so with every
   Claude idle the last snapshot stays on screen — and a window whose reset
   already passed shows as 0 %, because it renewed. An **API key** account
   never receives `rate_limits`: instead of the grid, a card says so,
   never two zeroed bars — which would read as an intact quota;
2. **how much I've already spent** — input, output, cache (split into
   write and read), estimated cost and message count. The message line
   says how many models and projects went into the slice, and how many
   came from **subagents**;
3. **how it was spread over time** — cost per day for the last 30 days, in
   pure CSS. Bars **outside** the chosen range go gray: the selection in
   the foreground, the context still visible. Every column is keyboard
   focusable and the value goes in the tooltip, the `title` and the
   `aria-label` — nothing is written inside the bar, which wouldn't pass
   contrast;
4. **on what** — one table by model and one by project (the 8 biggest +
   `outros (N projetos)`), with a share bar on the project one.
   **Project is the Claude Code session's working folder**, not Bridge's
   workspace: two tasks in the same folder add up into the same project;
5. **how much of this is an estimate** — the warning about models with no
   price, and the footer saying the cost comes from the table, not from an
   invoice.

The header holds the slice (`dia | semana | mês`); "meia-noite local" only
shows in the **day** slice, which is where the boundary decides whether
the small hours count today or yesterday. With no transcript scanned yet,
the body becomes an empty state with the folder the core is reading and a
single button, "Rescan transcripts".

With `usage.showCost` **off**, the panel doesn't write money anywhere: the
card and the cost columns disappear and the chart switches to counting
tokens per day.

#### In the sidebar

The limits belong to the **account**, not the workspace — which is why
they sit in a single block right below the sidebar's header (two compact
bars, percentage and reset), not repeated inside every expanded workspace.
When the sidebar narrows, the reset text shrinks (`reseta em 2h15` →
`2h15` → disappears) before the bar and the percentage; the whole phrase
stays in the `title`.

Inside an expanded workspace, only the focused session's line shows:
`70k ctx · Fable 5.1 · US$ 0,74`. Under pressure, the **model** is the
first to drop: context and cost are the two numbers that drive the
decision to keep going or run `/clear`.

Money is always `US$ 0,74`, everywhere — panel, sidebar and the status
line returned to Claude Code. A pt-BR app showing `$0.74` would be showing
another language's format.

#### In the Claude Code terminal

The same line can be drawn in the footer of Claude Code's TUI — it's the
`statusLine` Bridge injects into the session's `settings.json`. Since
0.12.2 it's **off** by default: the sidebar already shows the exact same
numbers right next to it, and having both on the same screen was saying
everything twice. To turn it on, check **"Show the status line in the
Claude Code terminal"** in Settings → Usage (`usage.terminalStatusLine`).

What does **not** change with the switch: the `StatusLine` hook keeps
being injected and called on every redraw, and it's what produces the
context, model, cost and 5 h/weekly windows the sidebar shows. Off, Bridge
answers the hook with an empty line — measured on Claude Code 2.1.266: the
TUI draws no footer at all, not even a blank bar.

#### Settings → Usage

| Field | What it does |
| --- | --- |
| **Show the estimated cost** | `usage.showCost`. Applies in the panel, the sidebar and the status line. |
| **Show the status line in the Claude Code terminal** | `usage.terminalStatusLine`, **off** by default. Off, the TUI's footer stays clean and the sidebar keeps showing the same numbers. |
| **Price file** | `usage.pricingFile`. Empty goes back to the bundled table; a missing or malformed file becomes a warning in the panel, never an error. |
| **Rescan transcripts** | `POST /api/usage/rescan`: zeroes the counts and rereads everything from scratch. It's the fix for the two cases the incremental read doesn't cover — a transcript rewritten from outside, and a price table corrected after the fact. |

Below them, the section lists the current table's **models with no
price** and shows the expected JSON shape. It exists because the bundled
table only carries public list prices it can actually vouch for, and the
newest models — precisely the ones in use — usually arrive with none;
without the list and the example on screen, "fill in `usage.pricing`"
would be an instruction that requires reading the code. The supporting
line says when the table in effect is from (`pricingAsOf`).

### The dialog

`Ctrl+,`, the gear icon in the sidebar's header, or "Settings…" in the
"⋯" menu open the dialog. Sections in a column on the left:

| Section | What it holds |
| --- | --- |
| **Terminal** | Font (a text field with suggestions of known monospace fonts — accepts a fallback list, like in CSS), size (8–24), default shell, and a three-line preview with box-drawing, blocks and a status line in the chosen font. |
| **Sessions** | "On reopen, resume Claude Code sessions automatically" (`restore.resumeAgents`, on by default) — see "Resuming Claude Code on reopen" —, the launcher (`sessions.scheduleLaunches` and the agent ceiling), the recap injection (`sessions.autoRecap`), the scope guard (`sessions.scopeGuard`) and **"Recognize Claude Code started inside a shell"** (`sessions.hostedAgents`, on by default, 0.12.0) — see "The Claude Code you open inside a shell"; and **"Mouse clicks in Claude Code"** (`sessions.mouseClicks`, on by default) — see "Mouse clicks in Claude Code". |
| **Notifications** | Toasts on; silence while the window is focused. |
| **Usage** | Show the estimated cost, the price file's path, the "Rescan transcripts" button, and the list of models with no price, with the expected table format — see "The 'Usage' panel". |
| **Git** | Poll interval (5–120 s). |
| **Shortcuts** | A read-only table of actions × the keys in effect (the ones from the loaded `keybindings.json`), with a **warning strip** when the file has a shortcut that won't fire, and "Open profile folder" — the button opens the folder in Explorer (that's where `keybindings.json` lives). In the browser, and while `profileDir` hasn't arrived yet, the full path shows as selectable text instead of the button. |
| **Appearance** | **Language** (`ui.language`: *Português (Brasil)* / *English* / *System*, 0.13.0) — the switch applies right away, across the whole window; see "Language". And "Theme: Dark", still disabled: the light theme needs design direction before it can exist. |
| **System** | Automatic startup with Windows (see the section below). The only section that does **not** go through `PATCH /api/config`. |

**There's no OK or Cancel.** Every field sends its own `PATCH` — on change
(select, checkbox, number) or on blur (the font text field) — and the
configuration that comes back is already in effect. What exists is
"Restore defaults" per section. An out-of-range value turns into a red
strip inside the dialog, and nothing is sent; the number field snaps back
to the value in effect when you leave it.

"Restore defaults" appeared under **Appearance** in 0.13.0 — the section
got a field `PATCH` actually touches, and its button returns the language
to **`System`**. That's its only effect there: the theme isn't
editable.

Changing the font or its size applies to terminals **already open**, right
away: xterm swaps `fontFamily`/`fontSize`, remeasures the grid and notifies
ConPTY when `cols`/`rows` actually changed.

The font preview shows the three symbols no Windows monospace font has
(`✻ ❄ ⛔`) **outside** the frame on purpose: they always come from a
fallback font with its own width, and inside the box they threw off the
alignment even with the right font installed. Inside the frame is only
what a terminal monospace font needs to draw at cell width.

### When the "Shortcuts" section warns (0.9.0)

The core accepts any non-empty string in `keybindings.json` — it only
rejects a non-string value and an unknown action, and in both cases it
keeps that action's default and writes a warning to the log. The result
used to be: an impossible line reached the table looking like a real
shortcut, and you'd keep pressing a key that would never fire. The section
now checks the received table with the **same parser** that decides
whether a key matches, and shows a yellow strip, one line per problem,
marking the affected rows with ⚠:

- **a combination Bridge can't parse** — `"Ctrl+"` (only a modifier),
  `"Ctrl+Shift+xyz"` (a key name that doesn't exist). The shortcut never
  fires;
- **two actions on the same combination** — whichever matches first in
  table order keeps the key, and the one below becomes unreachable from
  the keyboard. The warning says which of the two won.

The SAME strip carries the problems only the core sees, because they
happen while READING the file and never reach the table — they come in
the `problems` field of `GET /api/keybindings` (see "Routes"), and are
listed first, because they explain why the table below shows the factory
shortcuts:

- **broken JSON** or a **top level that isn't an object** — the WHOLE file
  was discarded and the defaults apply;
- **a key that isn't an action** (typo) — that line of the file was
  ignored;
- **a value that isn't a combination string** — that action's default
  still applies.

Each sentence says what the core DID, not just what it saw: with the whole
file discarded, knowing Bridge fell back to defaults is the missing piece
of information. Up through 0.8.0 none of this showed on screen — the
warning only went to `core.log`, and the dialog showed the factory
shortcuts as if they were your own choice.

## Start with Windows

`Ctrl+,` → **System** has two checkboxes:

| Option | What it does |
| --- | --- |
| **Start Bridge with Windows** | Creates an entry in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` pointing at the installed `Bridge.exe`. |
| **Start minimized in the tray** | Adds `--hidden` to that entry: Bridge comes up with the core and the sessions running, but **with no window**. |

Both are **off** by default, and Bridge never turns itself on.

With `--hidden`, the window is born with `show: false` and appears by
clicking the tray icon, the tray menu's **Mostrar** item, or clicking a
notification — the same paths as always. Without the argument, boot is
normal.

The state does **not** live in `config.json`: the Windows registry is what
decides. The UI reads (`app.getLoginItemSettings()`) and writes
(`app.setLoginItemSettings()`) through Electron's main process, over two
origin-validated IPC channels like the others (`bridge:getLoginItem` /
`bridge:setLoginItem`). The reason is that this entry can be removed from
outside — Task Manager's **Startup apps**, or a `reg delete` — and a copy
in the config file would become a second source of truth: the checkbox
would say "on" with the registry empty. Every read goes to Windows, and
every write re-reads from there before answering.

Checking by hand (the **value name** is the app's `APP_ID` — today
`com.erickdantas.bridge`):

```
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
```

On, with "start minimized", the line reads
`"C:\...\Bridge.exe" --hidden`; without it, just the executable's path.

Two Electron traps the read code has to work around — both hardened
against Electron 44, with the true entry taken from the registry, not
deduced from the docs (see `packages/shell/src/loginItem.ts`):

- **`launchItems[].args` always comes back empty.** Electron returns
  Chromium's `base::CommandLine::GetArgs()` there, which only lists
  positional arguments — `--hidden` counts as a *switch* and disappears.
  Reading "minimized" from there gave `false` even with the entry recorded
  correctly.
- **`openAtLogin` doesn't mean "starts with Windows".** It means "an entry
  exists that matches the executable **and the `args` of this query**".
  With `--hidden` recorded, a `getLoginItemSettings()` with no arguments
  returns `false`.

So the shell makes **two** queries: `executableWillLaunchAtLogin` (from
either one) answers whether it's **on**, and the `openAtLogin` from the
query made **with** `--hidden` answers whether it's **minimized**.

**In dev the option is a no-op, with an on-screen warning.** Running from
the checkout (`npm run dev:app`), `process.execPath` is the
`node_modules`'s `electron.exe`: writing that to `Run` would make Windows
open a raw Electron on the next login, and the entry would point at a
folder that vanishes on the next `npm ci`. In that case the checkboxes are
locked and the section shows why — the feature only works in the installed
app. In the browser (UI in a tab) the section says the same thing.

## How the hook and the shim work

The core doesn't talk to Claude Code over an API: it configures Claude
itself to call back.

1. When creating an agent session, the core writes
   `%APPDATA%\bridge\sessions\<sessionId>\settings.json` with one hook per
   event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
   `Notification`, `PermissionRequest`, `Stop`, `SubagentStart`,
   `SubagentStop`, `SessionEnd`) and a `statusLine`, all pointing at the
   same command:
   `"<absolute node>" "<...>\bin\bridge-hook.cjs" <sessionId> <Event>`.
2. The PTY starts `claude --settings <that file>` (through `cmd.exe /c`,
   because `claude.cmd` doesn't run directly), with `BRIDGE_PORT`,
   `BRIDGE_TOKEN` and `BRIDGE_SESSION` in the environment.
3. On every event, Claude runs the shim. It reads the payload on stdin and
   does `POST http://127.0.0.1:<port>/hooks/<sessionId>/<Event>?token=…`.
4. The core translates the payload into a state change plus a notification
   (`adapters/claude.ts`) and returns the JSON the hook expects. For
   `StatusLine`, it returns Bridge's line — which the shim prints to
   stdout and Claude draws in the footer.
5. **The shim never brings the agent down**: a 5 s timeout, and any
   failure (closed port, wrong token, 4xx/5xx, broken JSON) becomes `{}` —
   an empty line in the StatusLine — and `exit 0`.

Route security: `/hooks/*` requires the token in the query string **and**
refuses any request carrying an `Origin` header (only a local process hits
it, never a browser). `/api/*` and `/ws` require `Bearer <token>`, and
`/ws` only accepts an `Origin` of `http://127.0.0.1:*` /
`http://localhost:*`.

## Windows, Git Bash and WSL: the session environment

On Windows, "open Claude Code in the project folder" doesn't say *where*
it will run. With Git Bash picked as the shell, the terminal lands in a
MINGW64: a `PATH` with no Linux toolchain, a `node` that isn't the
distro's, and network paths (`\wsl.localhost\...`) where `/home` should
be. Someone working inside a WSL distro wants the WHOLE session in there —
the shell and the agent — not a Windows agent staring at a mounted folder.

That's why the environment belongs to the **workspace**, not the global
configuration: the same machine can have one repository that only builds
on Ubuntu and another that only runs under `pwsh`.

### What each choice changes

| Environment | Terminal session | Claude Code |
| --- | --- | --- |
| Bridge default | the `shell` from the configuration | Windows |
| `pwsh` / `powershell` / `gitbash` | the chosen shell | **Windows, as always** |
| `wsl:<distro>` | the distro's `$SHELL` | **inside the distro** |

This matters and isn't obvious: choosing **Git Bash doesn't move where
Claude Code runs**. The adapter resolves `claude.cmd` from the Windows
`PATH` and the PTY starts it directly, without going through the chosen
shell. Only `wsl:<distro>` moves both.

### Where to choose it

- **New workspace dialog** (`Ctrl+Shift+N`): the "Environment" field,
  listing the environments detected on this machine. The default is
  "Bridge default (shell from settings)" — the behavior you always had.
- **The workspace row's "⋯" menu**: the `Environment: …` entries. The
  environment in effect is marked with `•`, and "Environment: Bridge
  default" undoes the choice. A change applies **from the next session on**:
  a terminal already open stays in the shell it started in (killing it
  would throw away the work in there).
- **CLI**: `bridge new --env wsl:Ubuntu`, `bridge new --env gitbash`,
  `bridge new --env padrao`. The flag writes the environment to the
  workspace and only then opens the session; if the session fails to
  start, the environment goes back to what it was.
- **Tasks** (`bridge task new`, "Nova tarefa"): the worktree **inherits**
  the environment from the same repository's workspaces. `POST /api/tasks`
  accepts `environment` to send it somewhere else.

The workspace row then shows a `wsl:Ubuntu` badge (or `gitbash`, `pwsh`)
next to the branch. It only appears when a choice was made.

### What Bridge detects

`GET /api/environments` answers with `pwsh`, `powershell`, Git Bash (if Git
for Windows' `bash.exe` exists) and **one entry per distro** from
`wsl.exe -l -q`. For each distro, Bridge asks inside it:

```
command -v claude; command -v node; \
  [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ] \
  && echo __bridge_interop__; echo __bridge_ok__
```

Three answers: does **`claude`** exist? (decides whether an agent session
can start there), does **`node`** exist? (informational — the hooks don't
use it) and is **interop** on? The last marker (`__bridge_ok__`) is the
sentinel saying the distro came up: without it, a live distro with neither
`claude` nor `node` would read as "didn't answer". The list is cached for
60 s.

A distro **without `claude`** is still selectable (you may just want a
shell in there), but the workspace row lights up **⚠ sem claude** and an
agent session there is refused with a 422 before a pane is spent. A distro
that doesn't answer becomes **⚠ ambiente sumiu**.

### How the session starts inside WSL

```
wsl.exe -d <distro> --cd <translated cwd> -- sh -lc 'exec "${SHELL:-/bin/sh}" -l'
wsl.exe -d <distro> --cd <translated cwd> -- sh -lc 'exec claude "$@"' claude --settings <...>
```

Three decisions worth recording:

1. **`--cd` gets the path translated by `wslpath -a`**, not the Windows
   one. Passing an accented path (or a network drive) would work by
   accident in some cases and fail silently in others — exactly the pain
   point. The agent's `--settings` also travels as `/mnt/c/...`, even
   though the FILE itself is still written by the core at the Windows
   path.
2. **The shell is the distro user's `$SHELL`** (bash, zsh, fish), and the
   agent starts through a login shell (`sh -lc`) — the same path detection
   walks. Without that, the sidebar would say "claude is here" and the
   launch would fail anyway, because `~/.local/bin`/nvm only enter the
   `PATH` at login.
3. **The hooks run through WINDOWS' Node, via interop.** The generated
   `settings.json` points at the same `bridge-hook.cjs`, and what executes
   it inside the distro is Windows' `node.exe` (`/mnt/c/.../node.exe`,
   derived from `process.execPath` by `wslpath` itself) — **never the
   distro's `node`, even when it has one**.

The reason for item 3 is the only one that matters: the shim has to POST
to the core at `127.0.0.1:<port>`, and **WSL2's loopback is not shared
with Windows** in the default networking mode (NAT) — from inside the
distro, `127.0.0.1` is the distro itself. (Mirrored mode,
`networkingMode=mirrored`, would share it, but it's optional and Bridge
can't depend on a setting that might not exist on the machine.) Run by
`node.exe`, the shim is a Windows process and its `127.0.0.1` is always
the host's.

Two consequences of that:

- **the shim's path travels in Windows form** (`C:\...\bridge-hook.cjs`),
  and so does `BRIDGE_SHIM`: interop passes the argv through untranslated,
  and a `/mnt/c/...` would reach `node.exe` as a nonexistent file;
- **it requires interop on** (`/proc/sys/fs/binfmt_misc/WSLInterop`).
  Turned off, Bridge warns in the environment list and in the workspace
  menu: the session does start, but no hook ever arrives and it sits at
  "ociosa" in the sidebar.

`BRIDGE_PORT`, `BRIDGE_TOKEN`, `BRIDGE_SESSION` and `BRIDGE_SHIM` cross the
boundary through `WSLENV` (yours is preserved).

The distro name is validated before becoming an argument: nothing
starting with `-` gets through. The argv is passed separately (never a
shell line), but `-d --alguma-coisa` would be argument injection into
`wsl.exe`'s own parser.

### Known limits of a WSL session

- **The scope guard doesn't apply to a WSL session** in this version: the
  agent declares POSIX paths (`/mnt/d/...`) while the workspace's allowed
  root is in Windows form, so the "⋯" menu doesn't even offer "Permitir
  acesso fora do worktree" — there's no fence to lift (`SECURITY.md`,
  risk 18).
- **The usage monitor and "Retomar a conversa" can't see WSL sessions**: a
  Claude Code launched through `wsl.exe` writes its transcript to the
  DISTRO's own `~/.claude/projects`, while Bridge reads the Windows one —
  that session's cost is missing from the totals, and the resume recap
  comes back empty.
- **A login shell that RESETS `PATH` disables the hosted `claude`**
  (0.12.0): the session's wrapper is put on the `PATH=` of the `exec` line
  itself, before the distro reads `/etc/profile` and `~/.profile`. A
  profile that APPENDS to `$PATH` (the normal case) keeps the wrapper; one
  that rewrites `PATH` from scratch erases it, and `claude` typed in there
  goes back to starting without Bridge's hooks. The file is still on disk
  — what's lost is the path to it.
- **An `/etc/wsl.conf` with `metadata` and a restrictive `fmask` also
  disables it** (0.12.0): Bridge writes the wrapper from the Windows side
  and does **not** run `chmod`. On the default DrvFs that's enough — every
  file shows up as `0777` in there — but a distro configured with
  `options = "metadata"` and an `fmask` that strips the execute bit makes
  the session's `claude` answer "Permission denied". The way out is a
  `chmod +x` on the wrapper, or a looser `fmask`.

### Manual verification still pending

The machine this feature was built on **has no WSL distro** (`wsl -l -q`
comes back empty, 06/09/2026). The whole command assembly, the UTF-16LE
parsing of `wsl.exe -l -q`, the `wslpath` translation and the shim's path
are covered by tests **against a simulated `wsl.exe`**. What's missing, on
a machine with a distro installed:

1. `GET /api/environments` listing the distro with the right
   `claude`/`node`/`interop`;
2. opening a workspace with `--env wsl:<distro>` and seeing the shell come
   up in `/home`, not in `/mnt/c`, including with a space or an accent in
   the project path;
3. starting Claude Code in that workspace and confirming that **the hooks
   arrive** (the sidebar leaves "ociosa" and the status line shows up) —
   including on a distro **without `node`**, since the shim never uses the
   node in there;
4. checking the warning on a distro with interop turned off.

It's noted in the owner's internal backlog as a manual verification.

## Resuming Claude Code on reopen

The layout comes back when Bridge reopens, and the Claude Code session
comes back with it: the pane starts with `claude --resume <id>`, in the
same conversation it was in.

How the core knows this:

- **Which conversation it was.** Every Claude Code hook carries its
  `session_id`. The core records that id on the session
  (`Session.agentSessionId`, in memory) and on the pane
  (`Pane.lastAgentSessionId`, SQLite — the one that survives a shutdown).
  Since 0.7.0 the id **also survives a shell in the pane**: what decides
  whether to resume on its own is still `lastKind`/`lastEndedBy`, but a
  pane that came back as a shell keeps track of which conversation it
  was — that's what `bridge resume` reads later.
- **Who ended it.** `Pane.lastEndedBy` is `'app'` when the pane had an
  agent and Bridge is what ended it, and `'user'` when the process exited
  with the core still up — `/exit`, ✕, closing the pane, a crash. Only the
  `'app'` case gets resumed: whoever typed `/exit` closed the conversation
  on purpose, and their pane comes back as a shell with the usual hint.
  Since **0.12.1** the `'app'` mark is written when the agent COMES UP
  (it means "if the app dies right now, resume this"), so **resuming no
  longer depends on a clean shutdown**: an installer that kills Bridge
  without warning, a Windows shutdown, and a core that simply dies all
  leave the pane just as resumable.
- **How it comes up.** `POST /api/sessions { paneId, kind: 'agent', agent:
  'claude', resume: '<id>' }` — the adapter adds `--resume <id>` right
  after `--settings`. With no id there's no fallback to `--continue`: with
  two Claudes in the same folder it's ambiguous and would resume the wrong
  pane's conversation; in that case a clean Claude comes up instead.

What you see on screen: the pane comes back labeled **claude** (not
`shell`), and the terminal opens with a gray line — `retomando a sessão
anterior do Claude Code · 9f1a2b3c` — before the agent's first draw. The
eight characters are the start of the conversation's id, the same prefix
`claude --resume` shows in its own list. If Claude doesn't come up (binary
missing from PATH, folder that disappeared), the pane falls back to a
shell with the old hint, and the footer states the reason: "Não deu pra
retomar o Claude Code: …".

And `Ctrl+Shift+C` no longer turns into two terminals: the shortcut splits
the pane when it already has a live session, and before 0.6.0 the pane
came back as a shell — whoever pressed the shortcut to get Claude back
ended up with a split. Now the pane already comes back as Claude and
there's nothing left to press.

To turn it off: **Settings → Sessions → "On reopen, resume Claude Code
sessions automatically"** (`restore.resumeAgents` in `config.json`, on by
default). Off, an agent pane comes back as a shell with the hint "previous
session was Claude Code", which is 0.5.0's behavior.

A database from an earlier version comes up normally: the new columns
(`last_agent_session_id`, `last_ended_by`) come in through an idempotent
migration and stay null — a pane with no id and no mark resumes nothing.

### Restoration vs. a workspace being born (0.9.0)

Restoration runs **once per workspace**, the first time it becomes the
active one. It has to stay quiet while a workspace is being BORN: the core
emits `layout.changed` on creation, before answering the `POST`, so the
new workspace becomes the active one with its pane still empty — and the
Claude the dialog asked for takes seconds to come up. Reopening a shell
there would be a `pwsh` on top of what the user asked for.

What changed in 0.9.0: that silence became **scoped to the workspace that
might be being born**, and stopped being permanent.

- Every creation in flight records the workspaces that **already existed**
  when it started. A workspace that was already there can't be the one
  being born, and restores normally — before, any creation in flight
  silenced any workspace that became active in that window.
- A silenced workspace **isn't marked as restored**: when the creation
  finishes, it's re-examined on its own, without you having to leave it and
  come back. Before, the mark was written even mid-flight, and the
  workspace lost restoration for the rest of that run of the app (only
  reopening panes by hand, one by one, fixed it).
- Two creations can overlap and finish out of order (the workspace dialog
  gets an `Escape` mid-`POST` and the task one answers first): each has its
  own identity, so one finishing never releases the other's silence.

The workspace the creation actually created still gets no automatic
restoration: it's already born the way you asked, with or without Claude in
the first pane.

## When the resume comes back empty

`claude --resume <id>` (and `--continue`) sometimes starts with no error
at all and opens a **new** conversation: the pane lights up, the agent
answers, and the accumulated context simply isn't there. You only find out
when you ask something that depends on what had already been said. It's
one of the most commonly reported pains of running Claude Code in the same
project for a long time, and Bridge is in a privileged position to see it
happen.

**How Bridge notices.** Every Claude Code hook carries the `session_id`
the agent adopted, and `SessionStart` also carries the `source` (`resume`,
`startup`, `clear`, `compact`). When the pane asked for one conversation
and the first `SessionStart` comes back with **another id** — or with a
`source` that isn't `resume` — Bridge marks the session as
`resumeOutcome: 'fresh'` and the pane shows a strip:

> A conversa anterior não foi retomada (o Claude abriu uma sessão nova).
> **[Reopen with context]** **[Dismiss]**

If the payload carries neither the id nor the `source`, there's no verdict
and the strip doesn't show: a false alarm here would teach you to ignore
the warning.

**What "Reopen with context" does.** Bridge reads the old conversation's
transcript (`<claudeHome>/projects/<encoded cwd>/<id>.jsonl`, the same
place the usage monitor reads from) and builds a **deterministic** recap —
no model is called for this:

- your **last prompt** and the agent's **last three text replies**;
- `tool_use`, `tool_result`, subagents and metadata lines are left out;
- each excerpt is truncated at 600 characters and the whole recap at
  **2,500**;
- everything goes through `sanitizeDisplay` and comes out as a **single
  line** — the text is written into the agent's prompt, and a line break
  in there would be an Enter in the middle of the recap.

Then it writes it into the terminal, with one Enter at the end:

```
Contexto da sessão anterior (resumo automático do Bridge): Último pedido seu: … · Últimas respostas do agente: … — Continue de onde parou.
```

**This is not the context coming back**, and the strip doesn't promise
that. It's enough for the new agent to know what you were talking about;
the detailed history stayed in the old transcript.

**Ignorar** dismisses the warning for that session without writing
anything. The mark is per session, not per pane: an empty resume in the
same pane half an hour later warns again.

**Doing it automatically.** In **Settings → Sessions**, the option *"Ao
falhar o resume, injetar o resumo automaticamente"* (`sessions.autoRecap`)
makes the injection happen with no click. It's born **off**: writing into
the agent's prompt is the only thing here that touches your terminal on
its own.

**The three "it didn't work" answers**, all legitimate:

| answer | what happened |
| --- | --- |
| `no-resume` (422) | this session didn't ask to resume any conversation |
| `transcript-not-found` (404) | that conversation's `.jsonl` is no longer on disk |
| `recap-empty` (422) | the transcript exists, but only holds tool calls |

The route is `POST /api/sessions/:id/recap` and it returns `{ "text": "…" }`.
It only builds the recap — the UI is what writes to the PTY, with a
`POST /api/sessions/:id/input`. Which means: **nothing is written into your
terminal without a click of yours** (or without the option above turned
on).

## Task and git routes (Phase 3)

All under `/api`, with `Authorization: Bearer <token>`.

| Route | What it does |
|---|---|
| `GET /api/repos` | the repositories Bridge has already detected (`{ id, path, name }`) — the dialog's list |
| `GET /api/git/detect?cwd=<pasta>` | `RepoInfo \| null`, creating nothing: `{ root, branch, isWorktree, base?, worktreePath?, mainPath }`. It's what tells the dialog whether the chosen folder works |
| `POST /api/tasks` | `{ repoId? \| repoPath?, name, base?, agent?: 'claude' }` → `201 { workspace, tab, pane, session? }`. Creates the worktree, the branch and the workspace |
| `GET /api/workspaces/:id/git` | the current `GitStatus` `{ branch, base, ahead, dirty, at, error? }`; `404 { code: 'not-worktree' }` on a plain workspace. `error: 'missing'` = the worktree's folder disappeared from disk |
| `POST /api/workspaces/:id/git/refresh` | recalculates right now (204). Needs no body — and `content-type: application/json` with an empty body is accepted (true for every API route) |
| `PATCH /api/workspaces/:id/worktree` | `{ base }` → the updated workspace. Changes the worktree's base; refuses with `422 { code: 'unknown-ref' }` if the ref doesn't exist |
| `POST /api/workspaces/:id/merge` | `{ mode: 'ff-only' \| 'no-ff' }` → `{ mode, message? }` |
| `DELETE /api/workspaces/:id/worktree` | 204; kills the sessions, removes the folder and the branch, drops the workspace from the layout |

`POST /api/sessions` accepts **`initialCommand`** (string, ≤ 2000 chars):
the core writes `initialCommand + '\r'` to the PTY after the **first byte
the shell prints** (a 200 ms floor, a 3 s ceiling) — waiting for the prompt
to appear is what keeps pwsh from swallowing the start of the line on a
loaded machine. It's how "View diff" opens `git diff` in a pane without
needing a whole new session type. That route's errors also come with a
`code` (`pane-not-found` 404, `pane-busy` 409,
`agent-unavailable`/`unknown-agent`/`cwd-missing` 422); any other failure
is a Bridge bug and comes out as 500.

Errors: `409` for repo state the user resolves (`exists`, `dirty-base`,
`dirty-worktree`, `not-merged`, `not-ff`, `conflict`,
`base-not-checked-out`, `base-in-use`) and `422` for a request git didn't
execute (`not-a-repo`, `invalid-name`, `no-commits`, `unknown-ref`,
`git-failed`). The body is always `{ error, code, detail? }` — the UI
decides by `code`, never by the text.

**`GET /api/keybindings`** returns the shortcut table in effect (the spec
§6 defaults with the profile's `keybindings.json` layered on top, action
by action). When the file has a problem, the response gets a sibling
`problems` field, a list of `{ kind, action? }`: `json-invalido` and
`nao-e-objeto` (the whole file was discarded), `acao-desconhecida` (a key
that isn't an action — typo) and `atalho-invalido` (a value that isn't a
non-empty string). A flawless or missing file answers **without** the
field — exactly what the route answered before. The same problems still go
to `core.log` at `warn`; the field exists because `warn` doesn't reach
someone with the settings dialog open.

**A session that won't die.** Closing a tab (`DELETE /api/tabs/:id`),
closing a workspace (`DELETE /api/workspaces/:id`) and removing a task
(`DELETE /api/workspaces/:id/worktree`) end their sessions **before**
touching the layout. The attempt happens for all of them: a stuck session
doesn't abort the batch, its siblings die the same way. If one resists,
the response is
`500 { error, code: 'kill-failed', killed, failed, failedIds }` — the
outcome on both sides, with the id of whoever's still standing — and the
layout **stays** (removing it on top of a live PTY would orphan the
process, with no pane left to show it). Repeating the call is safe: the
second attempt only finds the stubborn ones.

## Two routes that are not for the UI

- **`POST /api/shutdown`** (bearer) — graceful shutdown: answers `202`
  and, on the next tick, runs the core's `stop()` (kills the sessions,
  deletes `instance.json`, flushes the log) and exits with code 0. It's
  what the shell calls before resorting to `taskkill`.
- **`GET /ws?events=<prefixos>`** — an event filter by `type` prefix,
  comma-separated (e.g. `events=notification,session,layout`). The server
  only sends events that match; the `hello` always goes out. Without the
  parameter, everything goes (that's what the UI uses — it needs
  `pty.data`). The filter is used by Electron's main process, which
  decides on toasts and badges without drawing any terminal and has no use
  for the volume of `pty.data` — and by the CLI's `bridge watch --events
  …`, which is the same parameter from the command line. A client that
  isn't a browser (the CLI, the shim, Electron's main process) doesn't
  send a custom header on the handshake, so `/ws` also accepts the token
  via `?token=`. The `workspace.git` event (the `+N ~M` badges) falls
  under the `workspace` prefix — and whoever filters that prefix does
  **not** count as "someone watching" for the git poller: the core only
  runs `git` when there's a client that would receive the result.

## The `bridge` CLI (Phase 4)

A thin command-line client for the core (`packages/cli`, `@bridge/cli`) —
zero runtime dependencies: it only uses Node 22+'s `fetch`.

**Instance discovery.** First `BRIDGE_PORT`/`BRIDGE_TOKEN` from the
environment — every pane Bridge opens already has both (it's the env
inside a terminal of the app itself, the shell's `baseEnv`); without them,
it reads `%APPDATA%\bridge\instance.json` (or
`%BRIDGE_PROFILE_DIR%\instance.json`) and confirms the recorded `pid` is
still alive. With no core running (missing file, corrupted, or a dead
process), any command exits with code `1` and

```
Bridge não está aberto (instance.json não encontrado ou core morto)
```

— and the CLI never prints the token, nor accepts one as an argument.

**"The current session".** `bridge notify` with no `--session` and
`bridge new` with no `--workspace` use the session from the environment's
`BRIDGE_SESSION` — the same variable Bridge injects into every PTY it
creates (spec §3). Without `BRIDGE_SESSION` or the flag, `bridge notify`
exits with `1` and "sem sessão: use --session ou rode de dentro de um
painel do Bridge".

### Commands

```
bridge notify "texto" [--session <id>]
bridge list [--json]                                     # id, workspace, estado, detail, há quanto tempo
bridge focus <sessionId|workspace>                        # leva a janela até a sessão: workspace, aba, painel
bridge new [--agent claude] [--cwd <pasta>] [--workspace <id>] [--split v|h]
bridge task new <repo> <nome> [--base <branch>] [--no-agent]   # <repo> = id conhecido ou pasta
bridge task merge <workspace> [--no-ff]                   # default ff-only; --no-ff se recusar com not-ff
bridge task rm <workspace>
bridge resume [paneId]                                    # retoma a conversa do agente daquele painel
bridge send <sessionId> "texto"                           # escreve no stdin (a CLI põe o \r)
bridge status [--json]
bridge usage [--range dia|semana|mes|ano] [--anchor AAAA-MM-DD] [--json]  # consumo, custo estimado e limites em tabela de texto
bridge usage --de AAAA-MM-DD --ate AAAA-MM-DD [--json]    # período personalizado (até 366 dias)
bridge usage --rescan [--json]                            # relê todas as transcrições do zero
bridge watch [--events notification,session] [--json]     # os eventos do core, um por linha, até Ctrl+C
bridge --help | --version                                 # stdout, código 0, sem precisar do core
```

`bridge` with no argument at all, `bridge help` and `bridge --help` print
the same help text to **stdout** and exit with `0` — even with Bridge
closed, which is exactly when someone goes looking for the command list.
`--version` prints just the number.

`<workspace>` (in `focus`/`new`/`task merge`/`task rm`) accepts an id
**or** a name — resolved against `GET /api/state`. A name isn't unique: if
more than one workspace shares the name, the CLI exits with `1`, listing
the ids to disambiguate (`nome ambíguo: 2 workspaces chamados 'x' — use o
id: ws_a (C:\...), ws_b (C:\...)`). `--json` works on **every** command: it
prints the raw body instead of the pt-BR sentence/table.

**Resuming the conversation.** `bridge resume [paneId]` brings back, **in
the pane**, the agent that was running there, with `claude --resume
<conversa>` — the same path the UI's restoration takes (spec §10), just
requested from the command line. What chooses the agent, the folder and
the conversation is the pane (`lastAgent` / `lastAgentSessionId`), not the
command line. With no `paneId`, it's the current session's pane
(`BRIDGE_SESSION`) or, outside a Bridge session, the focused pane.

**A live shell in the pane gives way to the agent**: with
`restore.resumeAgents` off (or with the boot-time resume having failed),
the pane comes back as a shell — but remembering which conversation was
running there — and it's from inside that shell that the command gets
typed; the core ends that shell and starts the agent in its place. A live
**agent**, though, blocks it: exits with `1` and "este painel já está com
um agente" (`409 { code: 'pane-busy' }`), and then the way out is passing
another `paneId`. A pane that never had an agent exits with `1` and "Este
painel não tem conversa pra retomar" (`422 { code: 'nothing-to-resume' }`).

The shell only goes down **after** everything checked out: the core
validates the agent (`claude --version`), the folder and the conversation
first, and only then ends whatever was in the pane. A refused request — no
stored conversation, Claude missing from PATH, the pane's folder gone —
leaves the terminal you had exactly where it was. `--json` returns the
created session plus `resumedFrom`, the resumed conversation's id.

One consequence of ending the shell: run FROM INSIDE the pane being
resumed, `bridge` dies along with the PTY and the "Retomando a conversa…"
sentence (or the `--json` output) may not show. The visible result is the
pane turning into the agent; from another pane
(`bridge resume <paneId>`), the output comes out normally.

**Usage from the command line.** `bridge usage` prints the same report as
the panel, as text: totals (input, output, cache split into
write/write-1h/read, messages and the estimated cost with the table's
date), the "inclui subagentes: N% dos tokens" line, the table by model,
the **5 biggest projects** (the rest becomes a `outros (N projetos)` line,
summed and not hidden) and the limit windows. `--range` accepts the pt-BR
names (`dia`, `semana`, `mes`, `ano`) and also the API's (`day`, `week`,
`month`, `year`); without the flag, it's `dia`. `--anchor AAAA-MM-DD`
picks WHICH day, week, month or year (whichever contains that date; without
it, the current one) — `bridge usage --range mes --anchor 2026-08-01` is
all of August. `--de AAAA-MM-DD --ate AAAA-MM-DD` (or `--from`/`--to`) is
a custom period, inclusive, up to 366 days and starting from 01/01/2020;
it doesn't combine with `--anchor`. In the panel, `Ctrl+Shift+Y` offers the
same slices, with ‹ › to move between periods and two dates in
"personalizado".

It talks to the SAME route as the screen (`GET /api/usage`), so there's no
chance of the terminal's number diverging from the panel's — there's no
second tally. With `usage.showCost` off, no line writes money. If the scan
is still running, the first line warns ("varredura em andamento: N de M
transcrições lidas — os números ainda vão subir"), because a low total
from an incomplete read looks just like a genuinely low total.

`bridge usage --rescan` zeroes the counts and rereads everything (it's the
same `POST /api/usage/rescan` as the Settings button) and answers when
done: `Releitura concluída: 8.431 transcrições, 184.000 mensagens, 96 dias
com consumo.` It **refuses** `--range`, `--anchor`, `--de` and `--ate`
together — a rescan has no slice, and silently ignoring the flag would
leave you thinking you'd reread "the month".

**Watching events.** `bridge watch` connects to the core's `WS /ws` and
prints **one line per event** until you press `Ctrl+C`. With no flag it
prints the time, the `type` and the id the event carries (`12:03:41
notification.new ntf_ab12`); with `--json` it prints the event's raw body,
one JSON per line — ready to pipe to `jq`, because the status line
("# ligado em 127.0.0.1:…") goes to **stderr**.

`--events` takes `type` **prefixes**, comma-separated, the same filter
Electron's main process uses via `?events=`: `--events notification`
catches `notification.new` and `notification.read`; `--events
session,workspace` catches session state and the `+N ~M` of worktrees.
Without the flag, everything comes through, `pty.data` included — which in
an active pane is a lot. The first line is always the `hello` (the
snapshot that opens the connection); it ignores the filter on purpose,
otherwise a client would start with no state at all. The token is
**not** printed.

**A session that doesn't exist.** `bridge notify` and `bridge send`
against a nonexistent (or already-ended) session exit with `1` and
"sessão não encontrada" — the route answers `404 { code:
'session-not-found' }`. Before this, the call used to say "avisado"/"enviado"
without anything having happened. The agents' hooks (`/hooks/*`) stay
lenient on purpose: an agent can't break just because Bridge already ended
its session.

**Flags.** `--flag valor` and `--flag=valor` are equivalent; `--flag` alone
is boolean (`--no-agent`, `--no-ff`). A flag a command doesn't recognize
exits with `1` and "flag desconhecida: --x". `--` ends the flag parser:
everything after it becomes text, even if it starts with `--` — it's how
you send `notify`/`send` a text that starts with `--` without it becoming
a (would-be) flag — `bridge notify -- "--urgente: build quebrou"`. Without
quotes, `notify`/`send` join the remaining positionals with a space
(`bridge send <id> echo duas palavras` sends `echo duas palavras`).

### In the installed app

`npm run dist` packages the CLI too: the installed app gets `bridge.cjs`
and `bridge.cmd` in

```
%LOCALAPPDATA%\Programs\bridge\resources\cli
```

and `installer.nsh` (NSIS) **puts that folder on the user's PATH** during
install — and removes it on uninstall. The write happens **in the
registry** (`HKCU\Environment`), reading the raw value
(`GetValue(..., DoNotExpandEnvironmentNames)`, so a `%VAR%` in PATH doesn't
get frozen at whatever it resolves to today) and writing it back always as
`REG_EXPAND_SZ` (`Set-ItemProperty -Type ExpandString`), the canonical type
for that key; then a `WM_SETTINGCHANGE` notifies Windows. A terminal
opened AFTER installation sees the command:

```
where bridge          # ...\resources\cli\bridge.cmd
bridge status
```

Why not `[Environment]::SetEnvironmentVariable(…, 'User')`: it writes
`REG_SZ` when the value has no `%`, and changing the user PATH's type would
make a `%JAVA_HOME%\bin` that was already there stop expanding. Why not
NSIS's `ReadRegStr`: it truncates at `NSIS_MAX_STRLEN`, and rewriting the
truncated value would silently erase the rest of PATH.

**If it doesn't work** (PowerShell blocked by policy at install time, or
the app was installed before this version), you can set it by hand — the
install isn't undone because of it. **Don't use `setx`**: it truncates at
1024 characters and writes `REG_SZ`, which can destroy your account's
PATH. In PowerShell, at the user scope:

```powershell
$k = 'HKCU:\Environment'
$p = (Get-Item $k).GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$d = "$env:LOCALAPPDATA\Programs\bridge\resources\cli"
if (($p -split ';') -notcontains $d) {
  Set-ItemProperty -Path $k -Name Path -Value (($p.TrimEnd(';') + ';' + $d)) -Type ExpandString
}
```

…or through the Control Panel → "Edit environment variables for your
account" → `Path` → New (which does the right thing on its own). Either
way, open a NEW terminal afterward. What Windows resolves as `bridge` is
the **`.cmd`**, not the `.cjs` — that's why the two files sit side by
side. The `.cmd` honors `BRIDGE_NODE` (the path to `node.exe`) before
PATH, and with neither one, it says "Bridge precisa do Node.js 22+ no PATH
(ou BRIDGE_NODE=&lt;caminho&gt;)" instead of cmd.exe's `'node' não é
reconhecido`.

> The NSIS PATH write is only exercised by a real install (`npm run dist`
> generates the `.exe`, it doesn't run it).

### Using it in dev (without installing)

```
npm run build:cli            # esbuild -> packages\cli\bin\bridge.cjs (single file)
```

With no PATH at all, you can call it directly:
`node packages/cli/bin/bridge.cjs list` — that's how the e2e suite runs the
CLI, and it's what gets used as a session's `initialCommand`
(`node "<caminho>\bridge.cjs" notify oi`). To turn it into the `bridge`
command inside the checkout, add `packages\cli\bin` to the user's PATH —
the `bridge.cmd` next to the `.cjs` is what Windows resolves (`where
bridge` has to find the `.cmd`, not the `.cjs`).

With no build at all, `npx tsx packages/cli/src/index.ts status` also
works: the version comes out as `dev`, because what stamps the real
number is esbuild's `define`.

## Troubleshooting

**`npm install` complains about node-pty / the session won't start with a
native module error.** node-pty is compiled against the Node version.
Switched Node, you need to rebuild:

```
npm rebuild node-pty
```

If it fails, you're missing Windows' build tools (Visual Studio Build
Tools with "Desktop development with C++" and Python 3). The
`AttachConsole failed` that shows up on stderr on every `kill()` is **not**
that problem: it's known node-pty noise, with no functional effect.

**"Token inválido" (401) in the UI.** The token is regenerated on every
core boot: whatever is in the browser's localStorage is the previous
instance's. Grab the new one from `%APPDATA%\bridge\instance.json` (the
`token` field) and paste it again on the opening screen. The file
disappears on a clean shutdown; if it exists but the core doesn't answer,
it's an orphaned `instance.json` from a dead process.

**"porta 4560 ocupada — outra instância do Bridge?"** A core is already
up (or another program is on that port). Check the `pid` in
`instance.json` and end the old instance, or change the port in
`%APPDATA%\bridge\config.json` (`{ "port": 4570 }`) — remembering to
adjust the proxy target in `packages/ui/vite.config.ts`.

**The sidebar shows `0k ctx`.** The core was launched from inside a Claude
Code session and the child inherited the child-session markers — see the
smoke-test warning below. Bridge already strips those markers; if it
persists, check whether the session really has Bridge's `statusLine` in
its `settings.json`.

## Notes from the real smoke test (03/09/2026)

- **Folder trust dialog.** The first time Claude Code opens in a folder, it
  shows "Is this a project you created or one you trust?" with the cursor
  on **"No, exit"**. A plain Enter ends the session (the ring goes to
  `exited`). Use **↓ then Enter** to trust it. This is Claude Code's
  behavior, not Bridge's.
- **`needs-input` only shows up if Claude actually asks for permission.**
  An account in automatic mode (or a tool on the allowlist) runs without
  asking, so the ring goes straight from `running` to `done`. To see the
  pulsing amber, use a session in the default permission mode and ask for
  something outside the allowlist.
- Bridge's status line combines context, model, cost and the windows into
  one line; the sidebar shows the second one and turns the first into
  badges.
- If the core is launched from inside a Claude Code session, Bridge strips
  the child-session markers (`CLAUDE_CODE_CHILD_SESSION` etc.) from the
  PTY's env; without that the child Claude turns off its transcript and
  the status line shows `0k ctx`.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the map of the code: the
  three processes, the hooks shim, the domain model, where to look for
  each thing.
- [`SECURITY.md`](SECURITY.md) — threat model, protections in place,
  accepted risks and how to report a flaw.
- `CHANGELOG.md` — what each version shipped, from 0.1.0 on.
- `docs/adr/` — architecture decisions (sidecar, per-session hooks, 1:1
  pane, UI served by the core, toasts, worktrees, packaging, usage
  monitor, WSL hooks via interop, the `claude` wrapper on the shell's
  PATH).
- `CONTRIBUTING.md` — how to run, test, package and send a PR.

> The execution ledgers (`.superpowers/sdd/`) and the visual direction
> material (`design/`) stay **outside** this repository, via `.gitignore`.
> Some documents under `docs/` reference those paths: the decisions that
> matter were promoted into the ADRs and into `CHANGELOG.md`.
