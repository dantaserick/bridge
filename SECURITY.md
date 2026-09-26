# Bridge security

Bridge is a **local** app: a Fastify core listening on `127.0.0.1`, a UI
served by it inside Electron, ConPTY terminals, and a CLI. There is no
remote server, no account, and no data of yours leaving the machine. This
document says what Bridge protects, what it deliberately does **not**
protect, and how to report a flaw.

Last security review: **0.10.1 (2026-09-06)** — audit of the usage monitor
and the surfaces new since 0.8.0, with a fix-and-attack-test wave per
finding. The previous phase (**0.8.0**, 2026-09-05) covered the rest of the
app with an audit, five rounds of fixes, and an adversarial re-review. The
plans for both phases and the execution ledgers (audit, fix report, and
rulings) stay out of the public repository, like those of the other phases.

## Versions

Bridge doesn't keep old versions maintained in parallel: the fix ships in
the next version, and the only supported line is the **latest** (today,
0.15.0).

## Threat model

Six attackers considered, each with a concrete path to Bridge:

- **A1 — hostile output from a terminal process.** An agent or a `cat` of
  any file printing OSC sequences: title, notification, text that the UI
  and the Windows toast will render.
- **A2 — another local process of the same user.** Reads `instance.json`,
  grabs the token, talks to the API as if it were the UI.
- **A3 — hostile repository content.** Branch name, worktree name, and
  task name; `.git/config`, `.gitattributes`, `.gitmodules`, and hooks that
  came along in a zip, backup, or flash drive.
- **A4 — malformed or hostile hook payload.** The shim is called by the
  agent with whatever it wants: `session_id`, event, `transcript_path`,
  size.
- **A5 — dependency chain and installer.** `npm audit`, and the install
  path chosen by the user landing in an NSIS PowerShell line.
- **A6 — hostile transcript.** A `.jsonl` under `<claudeHome>\projects`
  written by another process of yours, by an agent running inside a
  session, or restored from a backup: a line tens of MB long, JSON with
  wrong types, `cwd`/`model` with a terminal escape sequence or 10 kB in
  size, `timestamp` from the year 275760, a negative token count or
  `1e308`, a model name equal to a member of `Object.prototype`, a junction
  pointing outside the tree, millions of files. The usage monitor (0.10.0)
  reads these files on its own, every 60 s, without anyone asking — it's
  the only Bridge surface that works on content you didn't type.

**What's declaredly OUT of scope:**

- **Another user of the machine.** The model is **same user = same
  trust**, just like Claude Code's own: whoever already runs code under
  your account can do everything Bridge does, with or without Bridge. The
  only defense here is the `instance.json` ACL (below), and it's against
  *another* user, not against you.
- **External network.** The core only listens on loopback; there's no
  multi-user authentication because there are no multiple users.
- **Physical attack** on the machine.

**Protected assets:** the instance token; command execution in the PTY
(command or argument injection); the user's files (path traversal in
`openPath`, `cwd`, worktrees); UI integrity (XSS via terminal, hook, or
git data); core availability (DoS via WS, hook, or large body); log
privacy (hook payload with conversation content) **and the content of
your conversations with the agent**, which the usage monitor reads and
does not store (below).

## What's in place today

**Authentication and HTTP surface.** Every route requires
`Authorization: Bearer` — the classification is **default-deny**: anything
not recognized as public (the static UI at `BRIDGE_UI_DIR`) is treated as
protected. The path is classified by the union of the RAW form with the
normalized one, and any `%2F`, `%5C`, or `\` in the path is **400** before
any decision — an encoded separator doesn't exist in any legitimate
client. A request-target that doesn't start with `/` (absolute form,
`CONNECT`, `OPTIONS *`) is **400** before classification: that's where auth
was breached in the re-review. `Origin` outside loopback is refused, and
`/hooks/*` always requires the token.

**Ids by regex.** `sessionId`, hook event, `resume`, and ref names go
through strict input regex (`^[A-Za-z0-9_-]{1,64}$` for ids,
`^[A-Za-z]{1,40}$` for events, ref form for branch/base) — nothing starting
with `-` gets to become a process argument, and nothing with `..` or a
slash gets to become a file path. The **distro name** of the WSL
environment (0.11.0) follows the same discipline: `isValidDistro` rejects
an empty name, one with a control character, or one starting with `-`
**before** it becomes an argument to `wsl.exe -d <distro>`. The argv is
passed separately (no new execution goes through a shell), so what's
avoided there isn't command injection, but ARGUMENT injection into
`wsl.exe`'s own parser — the same reason behind `--resume`.

**Git containment and trust model for filters (A3).** Every git command
runs with `-c core.fsmonitor=false -c core.useBuiltinFSMonitor=false
-c core.pager=cat`; **passive** reads (the sidebar poller, repo detection)
also run with `core.hooksPath` pointing at an empty folder in the profile,
with `--ignore-submodules=all`, and with `--` before any ref. `filter.*`
drivers are **not** neutralized — disabling them would break `git-crypt`,
`nbstripout`, and `git-lfs` — they're **detected**: a repository that
declares a driver and hasn't been trusted yet doesn't receive a command
that touches content, the sidebar shows **⚠ filters**, and "New task",
"Merge", and "Remove worktree" respond **409 `filters-untrusted`** until
you trust it from the workspace menu. Detection enumerates the `--local`
and `--worktree` scopes (with `--includes`), at the root and in **every
worktree**, and descends into submodules — via the `.gitmodules` paths
(read with `-z`, so a name with a space doesn't fool the parser) **and**
via the index gitlinks, with **double** path containment: the declared one
(`path` empty, absolute, or with `..` is not followed) and the **real**
one — the submodule's folder and the gitdir git resolves it to
(`rev-parse --absolute-git-dir`) both have to sit under the repository's
`realpath`, which closes off the junction and the `.git` that's a file
`gitdir: <path outside>`. An enumeration failure counts as "has a driver"
(fail-closed). Usage details are in the README, "Git filters and trust"
section.

**Scope guard between worktrees (A3).** A process's `cwd` is a suggestion,
not a fence: task A's agent could open and rewrite a file in the sibling
worktree with an absolute path, and no one would know. `PreToolUse` is the
only Claude Code hook that accepts a permission decision in its response,
and that's where Bridge judges: `Read`, `Edit`, `Write`, `MultiEdit`,
`NotebookEdit`, `Glob`, `Grep`, and `LS` have their
`file_path`/`notebook_path`/`path` resolved against the **session's**
`cwd` (with `.`, `..`, mixed slashes, and symlink/junction undone via
`realpath`) and compared against the allowed root — the worktree, in a
task workspace; the whole repository, in a repo workspace; the `cwd`,
outside a repository. Outside it, the response is
`permissionDecision: "deny"` with the reason in English (or the user's
chosen UI language), and the session gets a counter with the last five
paths (all through `sanitizeDisplay`, like any text that comes from
outside and goes to the screen). UNC and the device namespace (`\\?\`,
`\\.\`) are rejected without comparison, and an unresolvable path counts
as outside (**fail-closed**). A root that vanished from disk turns off the
guard for that session instead of blocking everything. And releasing it
per workspace (`crossAccess`) is **total**, not "access to the sibling
worktree": once on, that workspace's sessions can once again read and
write anywhere on disk, like in any version before 0.11.0.

**Who it exists against, and who it does NOT.** It's a protection against
**agent error** and against **hostile repository content** (A3) — a
`CLAUDE.md`, a README, or a code comment instructing the agent to "read
file `X` from the folder next door." It's **not** a barrier against the
machine's owner or against another process of theirs (A2): whoever
controls the terminal turns off the guard in Settings → Sessions, releases
the workspace from the "⋯" menu
(`PATCH /api/workspaces/:id { crossAccess: true }`), edits `config.json`,
or simply runs `git` by hand — and that's accepted risk item 1, not a
hole. The guard holds for exactly as long as the owner wants it to, and
the off switch is theirs, in plain sight, in the menu.

**The per-shell `claude` wrapper (0.12.0).** Every shell session is born
with a `bin` folder inside the SESSION's own folder, in the profile
(`%APPDATA%\bridge\sessions\<id>\bin`), and that folder is prepended to
the `PATH` **only of that session's PTY** — nothing is written outside the
profile, no user or machine environment variable is touched, and the
Windows `PATH` stays as it was for any process not born inside a Bridge
panel. It's the same profile folder that holds `instance.json` — with the
caveat that the ACL described below is applied to the token FILE, not the
folder: what protects the rest of the profile is the Windows user
profile's default permission, and the model remains "same user = same
trust." **A3 doesn't reach this**: a hostile repository writes to the
repository, not to the profile — and none of the wrapper's content comes
from the repo. The target comes from the core process's `where.exe`; the
`claude.cmd` doesn't cite any literal path (the target comes from the
environment, and the settings from `%~dp0`), and the POSIX shell wrappers
quote both paths with the same `shQuote` (single quotes) as the rest of
the core. The `settings.json` the wrapper passes is the SAME one used by
agent sessions, with the same hooks pointing at the shim.

The wrapper's target travels in the session environment
(`BRIDGE_CLAUDE_BIN`, a codepage decision: cmd.exe reads a batch file in
OEM, and a path with an accented character written there arrives
corrupted). Said out loud, this means: **any process running INSIDE that
shell can redirect that session's subsequent `claude` calls** — by
changing the variable, or by putting another `claude` earlier in the
`PATH`. This is **outside** A2/A3 for the same reason as risk 1: whoever
already executes code inside your terminal, under your account, doesn't
need Bridge to do this — they'd just type whatever path they wanted. What
Bridge guarantees is the INITIAL state of the shell it opened.

**Promotion via hook (0.12.0).** Since this version, **any authenticated
POST to `/hooks/<sid of a shell session>/<Event>` promotes that panel to
host** — the row starts saying `claude`, the session starts counting
toward the agent cap, and subsequent hooks go through the Claude adapter.
It's the SAME trust the hooks route already granted to agent sessions (the
`instance.json` token, A2), but the **surface is larger**: before, only
agent sessions responded to it; now every shell panel does too. Whoever
can call it already has the token, and with the token could already
create a session, kill a session, and read state — the damage from a fake
promotion is a sidebar row saying `claude` and a scheduler slot occupied
until the shell closes.

**The hook payload's `cwd` doesn't widen the fence (A4).** With the scope
guard now also applying to the host session, `PreToolUse` started
resolving a RELATIVE path against the `cwd` that comes in the payload (the
person may have `cd`'d before opening Claude in there), and no longer only
against the session's `cwd`. The **allowed root still comes exclusively
from the workspace** — the payload chooses where the relative path starts
from, never how far it can reach, so a lying `cwd` only makes the path
point somewhere else, and pointing outside the root is refused like any
other. Only an absolute `cwd` is accepted. An absolute path WITHOUT a
drive letter (`/foo`, which is what a WSL session would write) inherits
the core process's drive in `win32` resolution — the worst case of that is
a wrongful refusal, never an escape: the comparison is still against the
workspace's root.

**`instance.json` ACL.** On Windows, `mode: 0o600` is a no-op — it
generates no ACE at all. After writing the file that carries the token,
the core runs
`icacls <file> /inheritance:r /grant:r "<DOMAIN\user>:(R,W)"`. If this
fails (group policy, `icacls` missing from PATH), the core **still starts
up** — crashing the app over this would be worse — but the failure becomes
an `error` in the log, the `instanceAclApplied: false` field in state, and
a **persistent banner** in the UI: "Couldn't restrict instance.json's
permission — another user on this machine may be able to read the token."
The banner only disappears once a later core manages to apply the ACL (or
when you dismiss it).

**Limits (DoS).** Request body at 1 MiB (Fastify); WS with a `maxPayload`
of 1 MiB and at most 32 connections; `resize` between 1 and 1000
rows/columns; notification text at 2000 characters, with a limit of 10
notifications per second per session and periodic pruning of the database
(which also reaches old **unread** ones — a session that dumps OSC and is
never read doesn't grow forever); scrollback capped at 512 KB per session;
transcript reading only at the tail (1 MB), refusing a relative path, UNC,
and a file above 64 MB.

**UI and toast (A1).** No `dangerouslySetInnerHTML`/`innerHTML` anywhere;
text coming from the terminal is a React node child. The native toast
truncates title and body (200/1000). The UI ships with
`Content-Security-Policy` (`script-src 'self'`, no `unsafe-inline` and no
`eval`; `object-src`, `frame-ancestors`, `base-uri`, and `form-action` set
to `'none'`), `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`.

**Transcripts: read to COUNT, never stored (0.10.0).** The usage monitor
(ADR-012) reads the `*.jsonl` files Claude Code writes to
`<claudeHome>\projects\**` to add up tokens. Three guarantees, in this
order:

- **what comes out of the read are numbers.** The parser returns the four
  token counts, the model id, the line's `cwd`, and the timestamp. Message
  text, a cited file name, tool output — none of that is extracted, and so
  none of it can be stored. The database tables (`usage_daily`,
  `usage_files`, `usage_limits`) have no content column;
- **nothing leaves the machine.** The core keeps listening only on
  `127.0.0.1`, and the monitor doesn't talk to any network: prices are a
  table BUILT INTO the package, not a lookup;
- **you choose the folder.** The root is `BRIDGE_CLAUDE_HOME` →
  `CLAUDE_CONFIG_DIR` → `~/.claude`, in that order. The variable exists
  for tests and for e2e (no test in the repository reads the `~/.claude`
  of whoever runs the suite) and it's there to point the monitor
  elsewhere — or at an empty folder, if you don't want it reading
  anything. `claudeHome` shows up in `GET /api/config` as **read-only**:
  changing it via API would change what the app reads from disk based on
  an HTTP request, and that decision stays in the environment.

What the monitor does NOT protect: it reads the folder the variable
points to, entirely and recursively (up to 8 levels, without following a
symbolic link — on Windows a `mklink /J` junction is also skipped). If you
point `BRIDGE_CLAUDE_HOME` at a folder with `*.jsonl` files from something
else, it'll open those files looking for assistant lines. Accepted risk
item 1 still applies: whoever already runs code under your account could
already read all of that.

**Hostile transcript (A6), 0.10.1.** What the monitor does with a
`.jsonl` that didn't come from Claude Code:

- **a line bigger than 4 MiB is SKIPPED**, counted, and warned about once
  per file. The offset ALWAYS advances: before this, a line bigger than
  the read chunk would lock up that file forever and silently vanish,
  along with all consumption after it. And the count doesn't stay only in
  the log: when some line gets skipped — or when the tree exceeds the file
  cap — the "Usage" panel, **Settings → Usage**, and `bridge usage` write
  how many there were and say the number shown is LOWER than actual
  consumption;
- **a token count outside `[0, 1e12]` counts as zero**, and a timestamp
  outside `[2020-01-01, today + 2 days]` discards the line — numbers from
  the payload don't enter the database no matter their size;
- **model name is looked up with `Object.hasOwn` on a table with no
  prototype**: a `model: "constructor"` doesn't "find a price" up the
  `Object.prototype` chain nor turn the cost of the whole slice into
  `NaN`;
- **the tree listing is asynchronous**, yields the event loop every 500
  entries or 5 ms, and stops at 50,000 files with a warning. On a
  20,000-file tree the largest measured pause is 3 to 8 ms, versus the
  3.78 s of the synchronous version;
- **all text that came from outside and goes to the SCREEN goes through a
  single sanitizer** (`sanitizeDisplay`, in `@bridge/shared`): the
  statusline returned to the terminal, `bridge usage`, and the panel's
  `title`/`aria-label`. It strips escape sequences (OSC, CSI, loose ESC),
  C0/C1, DEL, **and the invisible Trojan Source format characters**
  (`U+202E` and the rest of the bidi ones, the zero-width ones, the BOM) —
  a `cwd` with an RLO renders a path that isn't the path —, collapses
  whitespace, and truncates at the field cap. The CLI's `--json` and the
  API body stay RAW on purpose: they're data, not screen;
- **the statusline payload has caps**: at most 16 `rate_limits` windows,
  window key at 64 characters, `resets_at` only within ±10 years.

**The recap is the second consumer of hostile transcripts (0.11.0).** The
usage monitor reads `.jsonl` to COUNT; `recap.ts` reads the same kind of
file to extract TEXT, and the extracted text ends up typed into the
restored agent's PTY. Two locks hold this down:

- **the path is checked against the `projects/` root even when the id
  comes from SQLite** (`recap.ts:106` on the direct path, `recap.ts:117`
  in the folder sweep): the `agentSessionId` already went through the
  hook's `AGENT_SESSION_ID` before being stored, but a tampered database
  can't turn into an arbitrary file read — it's the same discipline as
  the hooks dump;
- **the text comes out on ONE line, via `sanitizeDisplay`** — per snippet
  (`recap.ts:185`) and again on the already-assembled summary
  (`recap.ts:222`). That's what stops this consumer's specific attack: a
  `\n` injected into a transcript message would become an **Enter** in
  the agent's prompt, i.e., the transcript choosing what Claude Code runs
  when resumed. Without a line break there's no submission — what's left
  is text the owner reads before sending.

**What the monitor STORES about you (privacy).** Besides "no message
content," it's worth stating what IS stored, because a project path is
personal data (client name, product name not yet announced):

- `usage_daily.project` stores the `cwd` of each transcript line;
- `usage_files.path` stores the absolute path of every `.jsonl` already
  read;
- both live in `%APPDATA%\bridge\bridge.db`, and transcript paths also
  show up in warnings in `%APPDATA%\bridge\logs\core.log`.

None of this leaves the machine. To erase it: empty (or point elsewhere)
the transcripts folder and click **Rescan transcripts** (`POST
/api/usage/rescan`), or simply delete `bridge.db` — it's derived, and
Bridge rebuilds it.

**Installer (A5).** The install path chosen by the user is no longer
interpolated raw into the PowerShell line: the single quote is doubled
beforehand (`WordReplace` in `installer.nsh`), and the rule lives as a
pure, tested function.

**Dependencies.** `npm audit --omit=dev` and full: **0 vulnerabilities**
in 0.8.0 (`@fastify/static` went from 8.3.0 to 10.1.3, closing four
advisories, one of them High).

## Accepted risks (and why)

None of these is unknown: each was measured, discussed, and left standing
with a reason. If any of them is unacceptable for your use, Bridge isn't
the tool.

1. **Any process of yours controls Bridge.** `instance.json` is readable
   by your account, and the token comes with it. It's the same model as
   Claude Code, and it's the direct consequence of "same user = same
   trust." There's no possible defense that isn't theater.
2. **Filter driver in the GLOBAL or SYSTEM config.** Detection only
   enumerates what belongs to the repository (`--local`, `--worktree`,
   and the submodules). A driver in your `~/.gitconfig` doesn't show up —
   and it shouldn't: that's you configuring your own machine, not a
   repository bringing in an outside command.
3. **`--ignore-submodules=all` hides submodule dirtiness.** It was the
   price of stopping the superproject's `status` from descending into
   the submodule (where there could be an invisible driver): **a
   submodule with uncommitted changes stops counting in the sidebar's
   `~M`**.
4. **Reading an arbitrary `*.jsonl` via `transcript_path`.** (This is the
   hook; the usage monitor's sweep is a different thing and is described
   above.) The hook payload (A4) chooses which transcript to read; Bridge
   requires an absolute path with a drive letter, `.jsonl` extension, a
   file under 64 MB, and reads only the last 1 MB. It's still a file
   chosen by whoever called the hook — and whoever calls the hook is the
   agent **you** opened, under **your** account.
5. **Token in the query string of `/ws` and the shim.** Switching to a
   header would change the contract for UI, shell, CLI, and shim all at
   once. The audit measured that the token doesn't leak: Fastify starts
   with `logger: false`, no log call carries a URL or token, and the
   channel is loopback with no proxy.
6. **`LOOPBACK_ORIGIN` accepts any loopback port.** A page served by you
   yourself at `http://127.0.0.1:<another port>` passes the origin check —
   but it still needs the **token**, which it doesn't have. The regex is
   anchored (`http://localhost.evil.com` is rejected).
7. **Token in `localStorage` in web dev mode.** In Electron — which is
   the product — the token comes through `preload` and never touches
   `localStorage` or the URL. This only applies to someone running the UI
   through Vite by hand.
8. **Electron fuses not yet applied.** `RunAsNode`,
   `EnableNodeCliInspectArguments`, `EnableEmbeddedAsarIntegrityValidation`,
   and `OnlyLoadAppFromAsar` require the `@electron/fuses` package, which
   isn't in the lockfile — and the security phase ran under the rule of
   **not** installing a new dependency. It's logged in the owner's internal
   backlog, pending authorization. Without the fuses, whoever can already
   run a program under your account can use `Bridge.exe` as a generic
   Node (`ELECTRON_RUN_AS_NODE`) — which, again, is item 1.
9. **No generic route rate limit.** `POST /api/tasks` in a loop creates
    worktrees until disk runs out. Whoever can call it already has the
    token (A2). The only path **without** a token (OSC notification, A1)
    has its own limit. The exception is `POST /api/usage/rescan`, which
    got its own limit in 0.10.1 (**409** with a rescan already in flight,
    **429** within 30 s of the last one): its cost is proportional to your
    ENTIRE history, not to the request. Since 0.11.0 the scheduler queue
    has its own cap: agent `POST /api/sessions` accumulates at most **64**
    pending and responds **429 `queue-full`** past that — the queue is
    in-memory, and letting it grow unbounded would trade the cost of
    starting agents for the cost of holding onto them.
10. **Git hooks run on the actions you request.** `worktree add` and
    `merge` run the repository's hooks — that's git's contracted
    behavior, and disabling them would break the flow for anyone with a
    legitimate hook. The **passive** path (the poller, which runs on its
    own every 15 s) is the one that was closed.
11. **`bridge usage --json` shows your project paths.** It's JSON, it's
    local, and it's you who runs the command. The HUMAN path of the same
    command comes out sanitized and truncated; `--json` comes out raw
    because it's the route body.
12. **`usage.pricingFile` reads a file YOU pointed at.** Since 0.10.1 it
    requires `.json`, a regular file, and at most 1 MiB, and any failure
    becomes a generic warning — no content excerpt, no key name, and no
    path, anywhere (response, screen, or log). What's left is what you
    configured yourself.
13. **Lower-than-real count on an out-of-spec transcript.** A line bigger
    than 4 MiB is skipped on purpose (the alternative was locking up
    reading that file forever). The panel, `bridge usage`, and
    **Settings → Usage** say how many there were, and `core.log` says
    which file — but consumption from those lines isn't recovered.
14. **The `pricingFile` warning counts the invalid entries.** It says "N
    entries ignored" and never their names, precisely so it doesn't
    become an oracle for the keys in the pointed-at file — but the COUNT
    is still a bit of information about a file you chose. It's the price
    of warning you that your price table has an error.
15. **The `pricingFile` cap is checked before reading (`stat` → `read`).**
    Between the two calls the file could be swapped for another one;
    whoever can do that already runs code under your account (item 1).
    What the lock closes is the accidental path and the payload-chosen
    target, not a race by someone already inside.
16. **The 50,000-file cap cuts by walk order, not by date.** In a tree
    above the cap, what's left out is the tail of the alphabetical sweep,
    not the oldest. The panel warns that the list was cut; the way out is
    pointing `BRIDGE_CLAUDE_HOME` at a smaller tree.
17. **The scope guard doesn't cover `Bash`.** A shell command doesn't
    declare a path — it declares text, and the target depends on `cwd`,
    `PATH`, variables, and the shell. Judging a path inside a command
    string would err both ways (the `..` of a `--exclude=../x` would
    become a wrongful refusal; a `powershell -EncodedCommand` would slip
    through), and a guard that errs both ways teaches the owner to turn
    it off. The same goes for `Glob`/`Grep`'s `pattern` (it's a search
    pattern, and the result is already filtered by `path`) and for what
    happens AFTER the decision: the guard judges what the tool
    DECLARES, not what the process does — an approved `Read` that
    follows a symlink created between the decision and the read is the
    same race as item 15, and whoever can do that already runs code
    under your account (item 1).
18. **The scope guard doesn't cover a WSL session.** In a workspace with
    a `wsl:<distro>` environment the agent runs INSIDE the distro and
    declares a POSIX path (`/mnt/d/repo/.worktrees/a/x.ts`), while the
    allowed root stored on the workspace is a Windows path. These are two
    different namespaces: on `win32`, `resolve` glues `/mnt/d/…` onto the
    `cwd`'s drive and `realpath` climbs up to its root, so comparing one
    against the other would reject **every** tool that has a path —
    including reading the task's own file. In 0.11.0 the guard simply
    **doesn't apply** to those workspaces: no `deny`, no counter, no 🛡
    badge, and the "⋯" menu doesn't offer "Allow access outside the
    worktree" (there's no fence to release). It's the same state as
    0.10.x for those sessions. The obvious fix — translating the root
    into POSIX space and comparing there — didn't go in because without
    `realpath` **inside** the distro it would reopen the symlink escape
    the guard exists to close, and a false sense of protection is worse
    than a declared limit. The follow-up (root and `cwd` translated at
    launch, via `resolveEnvContext`) is logged in the owner's internal
    backlog.

19. **A Bridge shell's `claude` can be redirected from inside that same
    shell.** The wrapper calls the target in `BRIDGE_CLAUDE_BIN`, and that
    variable (like `PATH`) belongs to the shell process — whoever runs a
    command in there can change both. It's item 1 again, on the terminal
    side: whoever types in your shell already chooses what to run. What
    the wrapper guarantees is that the `claude` the SESSION opened was
    born with Bridge's `--settings`.
20. **The hooks route promotes a shell panel (0.12.0).** An authenticated
    POST to `/hooks/<sid>/<Event>` on a shell session marks the panel as
    a host and occupies a slot in the agent cap until `SessionEnd` or
    until the shell closes. There's no heartbeat: a Claude killed with
    `taskkill`, without a `SessionEnd`, leaves the session marked as a
    host. It's screen and counter state, not permission — no new route
    becomes reachable because of it —, and whoever can call it already
    has the token (item 1). It's logged in the owner's internal backlog.
21. **The Bridge token is in the environment of EVERY Bridge PTY.**
    `BRIDGE_TOKEN`, `BRIDGE_PORT`, and `BRIDGE_SHIM` go into every
    session's env (that's how the CLI's `bridge` and the hook shim know
    who to talk to), so any process opened in a Bridge terminal —
    including the hosted `claude` and everything it runs — can call the
    whole API with your authorization. It's item 1 inside the terminal:
    it predates 0.12.0, the CLI depends on it, and stripping the
    variables would disable `bridge` from inside the panel without
    closing anything (whoever's at the terminal reads `instance.json`
    just the same).

## Manual checks still pending

These can't be automated here, and are logged in the owner's internal
backlog:

- **Installer at a path with a single quote.** Install into something
  like `C:\Programs\O'Brien\Bridge` and check that the install finishes,
  that the user's PATH received `...\resources\cli` with its type intact
  (`REG_EXPAND_SZ`), and that uninstalling undoes only that. The escaping
  is tested as a pure function; the installer actually running through
  it isn't.
- **Windows native toast escaping.** The toast is built by Electron
  (`new Notification`), which generates the Windows XML internally. That
  it escapes the title and body hasn't been verified by experiment —
  only truncation (200/1000 characters) and the OSC scanner's ~4 KB cap.
- **Electron 44.1.1 CVEs** — not checked online during the audit session.

## How to report a flaw

If you found something, **don't open a public issue with the
step-by-step**. Write to `<author's email>` or open a **private issue**
(security advisory) on the repository. Include: Bridge version, the
minimal steps to reproduce, what you managed to do with it, and which of
the attackers above describes your position (or why it isn't on the
list).

There's no bounty program. What there is is response: a one-person
project, on a local app, answering as fast as it can.
