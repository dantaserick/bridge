# Changelog — Bridge

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Single version at the root (`package.json`), mirrored across the packages. Entries from 0.1.0 to 0.9.0 **predate the first public commit** (see ADR-003): the dates are of verified delivery, not of a tag. From 0.9.0 onward, each version is a tag and a release.

## [0.18.2] — 2026-09-23 — build fixes

### Fixed

- Internal changes, no effect on the public edition.
- SHA-256 of `Bridge Setup 0.18.2.exe` (122,332,789 bytes):
  `1c2ac8bbedea8a2f272c947fac841209dc2235e498631b4dd279a53b55704f5b`.

## [0.18.1] — 2026-09-23 — `bridge focus` brings the window to the session

### Fixed

- **`bridge focus <session>` now changes what is on screen.** The command
  only marked the focus on the core (clearing `done`, reading the
  notifications), and the UI never found out: the main window stayed on
  whatever workspace it already had open. Now the CLI sends `reveal: true`
  in `POST /api/focus`, the core emits `session.reveal`, and the main window
  goes to the session through the same path as clicking a toast: workspace,
  tab, pane, and window. The focus the UI sends on its own still has no
  `reveal`, or its own click would bounce back to it. A nonexistent session
  with `reveal` responds 404 instead of "focused".

## [0.18.0] — 2026-09-16 — fixed limit bars

### Fixed

- **The 5-hour and weekly bars no longer disappear when you stop using the
  app.** Claude Code only sends `rate_limits` in the status line while it has
  a recent API response; idle, the payload comes without the key. The core
  treated this, after ten minutes, as "the account no longer has limits" and
  cleared the windows — which is why the bars vanished on every pause and
  came back on the next turn. Now a payload without `rate_limits` never
  clears anything: the last snapshot stays pinned in the sidebar, in the
  Usage panel, in the status line, and in `bridge usage`. What changes over
  time is only what the window actually does: once `resets_at` has passed,
  it shows as 0% with no reset time — it renewed — and the next status line
  with real data replaces the number (it also clears the red "limit reached"
  badge on its own). Accepted cost: whoever swaps a subscription for an API
  key ends up with bars at 0% instead of no bar at all.

## [0.17.0] — 2026-09-14 — the fake focus

### Fixed

- **Leaked cursor and a dead space bar until you switched screens.** Letters
  went through, space did not, and the Claude Code cursor lost its fill — the
  portrait of a terminal that sent "I lost focus" (`ESC[O`, mode `?1004`) and
  never sent "I got it back": the xterm text box's `blur` fired (background
  window, a dialog) and the `focus` coming back was never re-emitted, because
  Chromium does not repeat `focus` on an element that is already active. Now
  the terminal checks, on every keystroke and every time the window regains
  focus, whether the text box is the active element while xterm still thinks
  it is unfocused — and redoes the `blur`/`focus` pair right there, so the
  very key you pressed already lands correctly. When the fix fires, a warning
  appears in the renderer console, to confirm the trigger next time.

## [0.16.0] — 2026-09-13 — usage periods and a resume that doesn't get lost

### Added

- **Usage monitor with more periods.** The Usage panel (`Ctrl+Shift+Y`) no
  longer looks only at today: besides day, week, and month, there is now
  **year** and **custom**, with ‹ › to step through earlier periods and a
  "Today" to come back. Custom takes two dates (up to 366 days, starting
  01/01/2020). The chart now shows the days of the chosen period when it
  spans 30 days or more — a past month shows that month, not the last 30
  days —; a short period still shows the 30 days ending on it. In the API,
  `GET /api/usage?range=day|week|month|year&anchor=YYYY-MM-DD` and
  `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`, with 400 `invalid-anchor`
  and `invalid-period`; `?range=day` alone still responds as before. In the
  CLI, `bridge usage --range year`, `--anchor YYYY-MM-DD`, and
  `--from YYYY-MM-DD --to YYYY-MM-DD`.

### Fixed

- **A Claude Code that exits on its own no longer loses the resume.** In the
  early hours of 09/13, the Claude in a pane exited without `/exit` (a minute
  before a Claude Code auto-update), and the Windows Update reboot, 25
  minutes later, brought back a shell instead of the conversation. The
  reason: any process death with the core still alive stamped the pane as
  `lastEndedBy: 'user'`, and a `'user'` pane is not resumed. Now a PTY death
  stamps nothing — the pane keeps the `'app'` it was born with when the agent
  started — and `'user'` only comes from a declared intent: the `SessionEnd`
  hook with reason `prompt_input_exit`/`exit`/`logout`, or Bridge's own
  shutdown (✕, `DELETE /api/sessions/:id`, closing a tab or workspace). A
  `SessionEnd` with no reason, with `other`, or from `/clear` leaves the pane
  resumable.
- **The restored-pane banner no longer disappears under the prompt.** It was
  written inside the xterm, and ConPTY opens every session with `ESC[2J
  ESC[H` (measured on `pwsh -NoLogo` output): the folder path got drawn over
  the hint before anyone could read it. The banner became a pane row, right
  below the header, with a ✕ to dismiss it; "previous session was Claude
  Code" appears on its own when Claude is opened inside the shell, and
  "resuming…" appears when the core judges the resume.

## [0.15.0] — 2026-09-12 — mouse clicks in Claude Code, and live subagents

### Added

- **Mouse clicks in Claude Code** (`sessions.mouseClicks`, on by default;
  Settings → Sessions). Claude Code only accepts clicks (picking an option,
  switching tabs between agents) in its **fullscreen** UI, and whether it
  comes up in that UI is Claude's own call — by version, by staged rollout,
  by `settings.tui`. On, every new session is born with
  `CLAUDE_CODE_NO_FLICKER=true` (the owner's own variable, if set, wins) and
  the xterm forwards the mouse to the program; off, `CLAUDE_CODE_DISABLE_MOUSE=1`
  and the xterm **swallows** the mouse-tracking requests (`CSI ?
  1000/1002/1003/1005/1006/1015 h`), so dragging always selects text. The
  diagnosis that led here: the whole path already worked (xterm → WS →
  ConPTY → Claude, measured byte by byte) — what was missing was Claude
  asking for the mouse.
- **A session with a live subagent no longer shows as "finished".** Claude
  Code's main conversation fires `Stop` when ITS OWN turn ends, even with a
  subagent (`general-purpose`, for instance) still working in the
  background — and the sidebar said "finished", toast and all. The adapter
  now listens for `SubagentStart`/`SubagentStop` and counts live subagents
  (`Session.subagents`, memory only): `SubagentStart` puts the session in
  `running` ("N subagents running"); the main conversation's `Stop` with a
  live subagent becomes `running` ("waiting for N subagents") **without** a
  notification; the last `SubagentStop` with the main conversation waiting
  leaves it `running` — Claude picks back up on its own, and the real `done`
  (with the toast) comes from that turn's `Stop`.
- **Terminal modes survive reconnection.** `Terminal` rebuilds the screen
  from scrollback on every WS reconnect with a `reset()`, which used to zero
  out the private modes the program had turned on (mouse, bracketed paste,
  application cursor keys) — clicking stayed dead until Claude resent
  `?1000h`. Now `terminalModes.ts` snapshots `term.modes` (plus the mouse
  encoding, which xterm does not expose and `Terminal` tracks through the
  DECSET sequences that pass through) before the `reset()` and reapplies the
  sequences after scrollback.

### Notes

- SHA-256 of `Bridge Setup 0.15.0.exe` (120,320,342 bytes):
  `2a2fe77dea57be42bb4d5fcc6fcea59b539a9bc914e58c2319f4fd824b9efdc8`

## [0.14.0] — 2026-09-11 — always-visible bell, tab shortcuts, and splitting with an existing tab

Three UI adjustments the owner asked for on the same day, all in flows that
already existed:

**The bell now stays in the sidebar.** It only got drawn when there was an
unread notification, so anyone who had never received an alert didn't know
where to look. It is now a fixed button next to the gear icon: gray when
empty, amber with a count when there are unread ones
(`bell-button`/`has-unread`). In the panel, every row got a **header by
type** in the ring's color ("Needs you", "Finished", "Stuck", "Notice" —
`notifications.tipo.*`), before the workspace and the session, and the
alert text now wraps up to three lines instead of turning into an
ellipsis — it was the ellipsis that hid the part that explained things
("Permission: Bash: git push…").

**"New Claude Code" and "New terminal" in the workspace "⋯" menu.** The only
way to start a Claude was the shortcut (which targets the focused pane) or
the empty-pane button; the "+" in the tab bar opens a shell. The two new
entries create a tab in that row's workspace (which need not be the active
one — it becomes active) and start the session in its pane
(`newTabWithSession`). They disappear along with a missing worktree folder,
like everything that needs a shell.

**Splitting a pane with an already-open tab.** The pane header got a "Split
pane" menu: the usual two empty splits, plus, for every terminal tab in the
**same** workspace, "Bring Terminal 2 · claude to the side / below". In the
core, `POST /api/panes/:id/split` accepts `adoptTabId`: the tab's whole tree
moves into side b of the split (`graftLeaf`, the general form of
`splitLeaf`), its panes become the target tab's, and the emptied tab
disappears — sessions are untouched, since they point at a pane. Typed
refusals (`TabAdoptError`): tab not found (404), the tab itself, and a tab
from another workspace (409, with `code`).

### Notes

- SHA-256 of `Bridge Setup 0.14.0.exe` (120,296,162 bytes):
  `d080cccfe4a0d1c7d9fe5fc6baa1d2aaab1e16ced0d0081cf3f1c660c4bbe137`

## [0.13.0] — 2026-09-09 — selectable language

The owner's request, from 09/08/2026, was one line long: **selectable
language in the app.** Until now Bridge had been **fixed Portuguese** — not
by decision, but by origin: it was born for one person, on her machine, and
every sentence was written straight into the file where it appears. The
repository has been public since 0.9.0 and has a `README.en.md`, which
produced the odd situation of someone reading the docs in English,
installing the app, and getting "Aguardando você" in a Portuguese sidebar.

The real problem wasn't translating: it was that **there was nothing to
translate**. The text was scattered across five packages, inside `.tsx`
files, module constants, and literals in the middle of a condition — you
couldn't even answer "how many strings does Bridge have?" without sweeping
the repository by hand. So the version started in the right place: a
**message catalogue** in `@bridge/shared`, where `pt-BR.ts` is the source of
the KEYS (an `as const` object, with `MessageKey` as its key type) and
`en.ts` is pinned by `satisfies Record<MessageKey, string>` — a missing key,
or an extra one, is a **typecheck** error, not a blank sentence on someone's
screen. There are **746 keys**, written in both languages in the same
change.

Two decisions shaped the rest. First: there is **only ONE** language for
everything, and the **core** is what resolves it. The UI, the Electron
process, and the CLI don't ask the machine — they receive the
`languageResolved` the core already computed. Without this, `Intl` in the
core, `navigator.language` in the renderer, and `app.getLocale()` in the
main process could each answer differently on the same computer, and the
app would speak two languages at once. Second: the switch is **live**.
There is no window reload, no "restart the app" — which is why practically
no text constant survived the change: a `const` is evaluated when the
module is imported, and would freeze the language of the first mount.
Wherever there was a constant, there is now a `lang`-taking function.

What was **not** done, and why: no i18n library (a key map and a `{name}`
interpolation are enough, and the project is deliberately lean); no
region-based detection within English (the catalogue has ONE English,
`en-US`); and plural stays an **explicit key** (`sessoes.uma` /
`sessoes.varias`) instead of an automatic rule — the two languages Bridge
speaks share the same plural shape, and a rule library would cost more than
the `if`.

### Added

- **Message catalogue in `@bridge/shared`** (`src/i18n/`): `pt-BR.ts` (the
  source of the keys), `en.ts` (the same 746, pinned by the type),
  `index.ts` with `t(lang, key, params?)`, `resolveLanguage`,
  `systemLanguage`, and `INTL_LOCALE`, and `guard.ts`, the sweep the tests
  use. Keys are named by **surface** (`sidebar.rodape.novaTarefa`,
  `uso.painel.total`), never by text, so they survive a copy rewrite. In
  development, `t` **throws** on an unknown key and on a missing parameter;
  in the `.exe` it degrades gracefully — the check is affirmative
  (`test`/`development`/`BRIDGE_DEV`) because in the packaged app `NODE_ENV`
  simply does not exist, and a `!== 'production'` check would make the
  installed app the most explosive environment of all.

- **`ui.language` in Settings → Appearance**, with three options:
  *Português (Brasil)*, *English*, and *System*. The default is
  **`system`**, and the rule is short: locale `pt`, `pt-…`, or `pt_…` (`pt`,
  `pt-BR`, `pt-PT`, `pt_BR`) becomes Portuguese; **anything else** becomes
  English. Anyone in Brazil configures nothing; anyone outside gets English
  without hunting for the option. Both language NAMES always appear in their
  own language — whoever looks for English looks for "English", even on a
  screen that is in Portuguese; only "System" is a phrase, and that one does
  get translated.

- **The switch applies immediately, everywhere, without reopening
  anything.** The `select` sends `PATCH /api/config`, the core responds
  with the whole configuration, and the WebSocket's `config.changed` swaps
  the window's language — and the main process's along with it. Both
  languages now cover: the whole interface (sidebar, panes, both creation
  dialogs, the "Usage" panel, the notifications panel, the banners written
  into the xterm), the **API error messages**, the **notifications Bridge
  writes**, the **status line**, the launch scheduler's text, the **scope
  guard's refusal reason** — the one the agent reads and repeats back to
  you —, the **tray**, native toasts, and Windows dialogs.

- **The `bridge` CLI in the same language as the app.** It asks the core
  (once per process) and uses its `languageResolved`. With Bridge
  **closed** — `bridge --help`, `bridge --version`, or any command before
  the instance is found — the **`BRIDGE_LANG`** variable (`pt-BR` or `en`)
  applies, and without it, the machine's locale. With Bridge open,
  `BRIDGE_LANG` **does not** override the app, on purpose: two terminals on
  the same machine should not answer in different languages about the same
  core.

- **`languageResolved` in `GET /api/config`** — the language `ui.language`
  resolved to on THIS machine. It is **read-only** through the API (sending
  it in `PATCH` returns `403 read-only`, alongside `port`, `profileDir`, and
  `claudeHome`): whoever wants to switch sends `ui.language`. It travels in
  `config.changed` together with the rest of the configuration, and it is
  where the UI, the main process, and the CLI pull the language from.

- **One language guard per package.** A test in each of the five packages
  sweeps its `src/` looking for an accented literal or a common pt-BR word
  outside the catalogue, and fails listing `file:line`. It's the lock
  against a new string sneaking in without a key. Family-wide exceptions
  live in the test's allowlist (a file-based log, `debug`); one-line
  exceptions live on the line, in a `// i18n-ignore` with the reason next to
  it. The UI's allowlist is **empty**, and a second test in the file is what
  keeps it that way.

- **e2e scenario 14** (`npm run e2e`): the app comes up on a profile with no
  `ui.language`, resolves `system` as pt-BR from the machine's locale,
  receives a `PATCH { ui: { language: 'en' } }` and — **without reopening**
  — switches five surfaces with exact-text assertions (the sidebar footer,
  the empty-pane buttons, the workspace "⋯" menu, Settings → Appearance
  with `English` selected, and a hook-injected `Notification` that arrives
  written by the core as "Waiting for you"), while `bridge list` run from
  outside prints `state`/`age`. It then switches back to `pt-BR` and checks
  the restored text.

### Changed

- **`format.ts` now requires the language.** `formatUsd`, `formatTokens`,
  and the two new functions (`formatCount`, `formatRelativeTime`) take
  `lang` and use `Intl` with the matching locale: `US$ 3,42` and `há 1 min`
  in Portuguese, `US$ 3.42` and `1 min ago` in English. Relative time comes
  from the catalogue, not from `Intl.RelativeTimeFormat` — two keys resolve
  it, and every sidebar row stops paying for building a formatter.

- **Two things now travel as a catalogue KEY, not as a sentence**, because
  whoever produces them has no language and whoever shows them does.
  **`LoginItemState.status`** (the "app installed" / "unsupported" text in
  the System section) leaves the main process as a `MessageKey` and is
  translated by the renderer, with the WINDOW's language — previously the
  main process and the UI each resolved the language on their own, and a
  switch could leave that section in one language with the rest of the
  dialog in another. **`CoreExit.fatal` and `CoreStartError.key`**
  (`sidecar.ts` → `main.ts`) the same: `sidecar.ts` is what BRINGS UP the
  core and does not import `electron`, so it has nowhere to pull a language
  from; `main.ts` is what translates, at the moment it opens the dialog.
  Support bonus: the KEY is what goes to `shell.log`, and reading
  `shell.fatal.semNode` says more than the phrase in the reporter's
  language. Alongside this, **any** startup failure that is not a
  `CoreStartError` now shows the generic "the core did not start" phrase,
  with the raw text going to the log — previously an internal invariant
  turned into a modal dialog.

- **"Restore defaults" showed up in Appearance**, and what it does there is
  put the language back to **`System`**. The section now has a field the
  `PATCH` touches, so the button now exists; the theme stays disabled and is
  unaffected.

- **The sidebar's group order now follows the locale.** `localeCompare`
  takes `INTL_LOCALE[lang]`, which is the correct call — and it means
  switching languages can reorder two repositories whose names only differ
  by an accent.

- **The "Usage" panel footer's bold changed**: it was
  `Estimated <strong>cost</strong>` and became `<strong>Estimated
  cost</strong>`. This is mandatory (in English the word order flips, and
  splitting the sentence per word would leave the emphasis on the wrong word
  in one of the two languages), but it is a visible change: two bold words
  where there was one.

- **The main process now talks to `/api/config`** and subscribes to the
  `config` prefix on `/ws` — neither existed before. It's how the language
  reaches the tray and the native dialogs. The tray is the only main-process
  text that stays ON SCREEN between two events, so it is the only one that
  gets **rebuilt** on the switch (Electron's `Menu` is immutable once
  built); everything else is written at the moment it appears.

### Notes

- **What is declaredly NOT translated:** the agents' and shells' output (the
  text inside the terminal belongs to whoever is running there); the
  notifications the **agent** writes (`Notification` with `message`, and
  `bridge notify "text"`) — the ones Bridge itself writes are translated;
  the **file logs** (`core.log`, `shell.log` stay in pt-BR: they belong to
  the owner and to whoever provides support, and a translated log line is
  harder to search for, not easier); the **NSIS installer**; the
  **documentation** (this file, the README, and the spec stay in
  Portuguese, with the English summary in `README.en.md`); and **proper
  names and identifiers** — `Ctrl+Shift+C`, `wsl:Ubuntu`, `pwsh`, session
  and workspace ids, the `kind` of the rows. An **already recorded**
  notification is not rewritten when you switch languages: it's the record
  of what happened, in the language of that moment. For the same reason,
  the **`session.detail`** the sidebar shows ("thinking…", "writing file")
  stays in the language of the hook that produced it until the next hook
  arrives — it is the last observed state, not a sentence Bridge redraws.
- **No new dependency**, nothing downloaded, no new route, and no new
  shortcut. The new configuration is a `ui` block in `config.json`, merged
  key by key like the others.
- **The guard has a known blind spot:** it looks for ACCENTS. pt-BR copy
  without accents (`Todos`, `Base`, `Msg`, `Total`) and loose text inside
  JSX slip through — what caught those was an eyeball sweep. Mitigation in
  place.
- **Tests**: core 1,089 passing and 3 skipped (57 files), ui 812 (25),
  shell 173 (13), shared 128 (9), cli 90 (4) — **2,292 passing** across 108
  files. The real app's e2e passed **14/14**.
- SHA-256 of `Bridge Setup 0.13.0.exe` (120,247,356 bytes):
  `4f82770c0768697b0fcbb432088319de38671009ad1bf0a1fb6bb5274963b1ae`

## [0.12.2] — 2026-09-09 — sidebar and status line adjustments

Three requests from the owner, all in the same family: the app was showing
too much in one place and too little in another. The sidebar collapsed one
workspace when another was activated; the scope guard's badge stayed lit
after the refusal had already been authorized; and the same usage numbers
appeared twice on screen — in the sidebar and in the Claude Code terminal's
footer.

### Changed

- **Every sidebar workspace is now born EXPANDED, and collapsing is now
  manual.** The owner's question was this: *"when I click a workspace the
  other one collapses — shouldn't everything be open by default, and I'd
  collapse it myself if I wanted to?"*. It was an accordion by design — the
  sidebar expanded the ACTIVE workspace and only that one —, and the
  practical effect was that seeing the sessions of two projects at once was
  impossible: activating one closed the other.

  Now the two things are independent. Every workspace row got a
  **chevron** on the left, which collapses and expands only that workspace
  and activates nothing; clicking the name still ACTIVATES (that's what
  switches the content area) and no longer touches anyone's open state. The
  active workspace keeps its background highlight, which is no longer the
  same thing as "is open". Collapsed, the workspace keeps the **ring of the
  worst state among its sessions**, the way a collapsed group header already
  did: closing a row hides the sessions, never the warning that one of them
  is stuck.

  Which workspaces are collapsed is a MACHINE preference, alongside the
  group ones: same `localStorage`, same `bridge.sidebar.groups` key, new
  `collapsedWorkspaces` field (by workspace id). The stored list is the
  negative of what's shown — whatever isn't in it is open —, which is why a
  preference saved by an earlier version, which had no such field, opens
  everything instead of closing everything. By keyboard, the chevron is a
  button with `aria-expanded` and the label "Collapse workspace" / "Expand
  workspace"; ↑/↓ still moves between group header, workspace, and session,
  with no new stop per row.

  The declared cost: with many workspaces the sidebar gets longer. Manual
  collapsing is the answer, and it is remembered.

- **The 🛡 badge disappears when you allow access.** The report: *"the guard
  blocked… I allowed it, but the blue shield stayed — can it go away after I
  authorize it?"*. The badge was cumulative by a 0.11.0 decision (the
  attempt happened, and that count was its record), but it describes a
  FENCE — and turning on "Allow access outside the worktree" made that
  fence stop existing in that workspace. The warning stayed on screen after
  the owner had already answered it.

  Now `PATCH /api/workspaces/:id { crossAccess: true }` zeroes the refusal
  counter of every live session in that workspace and emits a
  `session.updated` per zeroed session, so the badge disappears immediately,
  with no reload; sessions in other workspaces are untouched. The UI also
  hides the badge while the workspace is allowed — it's the safety net that
  covers the moment between the `PATCH` and the event arriving, and the
  snapshot that comes back from the database on reopening the app.

  **Restricting again does not restore the count**: it starts over from
  zero on the first new refusal. What's lost is the history of earlier
  refusals, which was informational; every refusal is still logged in the
  core's log, with the tool, the path, and the root.

- **The status line left the Claude Code terminal (and stays in the
  sidebar).** The owner's proposal: *"if we already show 5h/week usage and
  context/price in the sidebar, I think it's better to remove it from the
  terminal"*. The TUI's footer line is the `statusLine` Bridge injects into
  the session's `settings.json`, and it shows exactly the same numbers the
  sidebar shows a few inches away.

  The new setting is `usage.terminalStatusLine`, and it is **born off** —
  meaning **the default changed**: whoever wants the line back turns it on
  in **Settings → Usage**, in the *"Show the status line in the Claude Code
  terminal"* toggle. What did **not** change is the most important part: the
  `StatusLine` hook is still injected and called on every redraw, and it's
  where the context, the model, the estimated cost, and the 5-hour and
  weekly windows that feed the session line, the sidebar's limit bars, and
  the usage monitor all come from. Off, Bridge answers the hook with an
  **empty** line. `bridge usage` and the CLI are unchanged.

  Measured with a REAL Claude Code (2.1.266) in a PTY, with a throwaway
  `settings.json`: with the `statusLine` command returning an empty string,
  the TUI **draws no footer at all** — not even a blank bar —, and the
  command KEEPS being called on every redraw (the same test with the
  command returning text draws the line normally). Nothing needed adapting:
  an empty line is enough.

### Notes

- **No new dependency**, nothing downloaded, no new route, and no new
  shortcut. The new setting is a boolean in `usage`, merged key by key like
  the block's other fields.
- **Tests**: core 1,054 passing and 3 skipped (55 files), ui 754 (22),
  shell 153 (11), shared 74 (6), cli 69 (3) — **2,104 passing**. The real
  app's e2e passed **13/13**.
- SHA-256 of `Bridge Setup 0.12.2.exe` (120,080,240 bytes):
  `c13b9e0153ddca430ea098b6a604536230cf7d124763e4f54320c0ec4599772b`

## [0.12.1] — 2026-09-08 — restore survives an unclean death

### Fixed

- **The pane that had been Claude Code came back as a shell.** The owner's
  report was direct: *"I came back and it didn't restore my previous claude
  session, it only shows the workspace I was working on with the shell"*.
  His pane was in the database with everything restore needs —
  `last_kind='agent'`, `last_agent='claude'`, the conversation's
  `last_agent_session_id` — missing exactly one thing: `last_ended_by`,
  which was **null**.

  The cause: restore only resumes a pane marked as ended by the APP
  (`lastEndedBy === 'app'`), and that mark was written in exactly one
  place — the core's `stop()`, meaning **only on a graceful shutdown**. But
  Bridge dies without a graceful shutdown more often than it seems. The
  NSIS installer takes down the running app without sending `WM_CLOSE`;
  Windows shutdown does the same. In those cases `stop()` never runs, no one
  marks anything, and the next launch brings back a shell. In the owner's
  `shell.log`, the app's last three launches started with `orphaned
  instance.json discarded` — the trail of a core that died without anyone
  asking it to — and none of them was preceded by a `shutting down the
  core`.

  The fix flips WHEN the mark gets written. It is now written **when the
  agent starts**, right after the PTY is born, and it means "if the app
  dies right now, resume this pane" — no longer "the app closed cleanly".
  The agent process's normal exit (`/exit`, ✕, closing the pane, a crash)
  still stamps `'user'` on top, which is what stops Bridge from resurrecting
  a conversation you closed on purpose; and `stop()` still marks, now as a
  belt. **Resuming no longer depends on a clean shutdown.**

  Along with it comes an **idempotent migration** that rescues the pane of
  anyone who had already lost the mark: a pane row with `last_kind='agent'`,
  a saved conversation id, and a null `last_ended_by` becomes `'app'` on the
  next database open. That combination only exists for one reason — the
  core died with the agent alive —, because a normal exit always writes
  `'user'` and a shutdown always writes `'app'`. A pane with no conversation
  id and a shell pane are left out, and an already-stamped pane is never
  rewritten.

  And the Electron shell now handles a **Windows session ending** (shutdown,
  restart, sign-out): the window's `session-end` and the app's
  `before-quit` request the same graceful core shutdown that `will-quit`
  always requested, sharing a single `stopCore()` — best effort, without
  blocking the operating system. What keeps killing the app with no warning
  at all is the installer (candidate: electron-builder's
  `customCheckAppRunning` macro).

  None of this changes the HOSTING shell from 0.12.0: its `kind` is still
  `shell`, it gets no agent mark, and it keeps restoring as a plain shell.

### Notes

- **No new dependency**, nothing downloaded, no new route, no new shortcut,
  no new setting. The restore rule is still `lastEndedBy === 'app'` — what
  changed is when that `'app'` gets written.
- **e2e scenario 13**: with a fake `claude` on the PATH, the scenario checks
  in SQLite that the agent's pane is already marked at birth, kills Electron
  and the core's tree with `taskkill /f` (no `app.close()`, no `POST
  /api/shutdown`, leaving `instance.json` behind as proof), relaunches on
  the same profile, and demands the pane come back as an AGENT, with
  `--resume <conversation id>` in the `claude` argv and the sidebar row
  saying `claude`.
- **Tests**: core 1,045 passing and 3 skipped (55 files), ui 728 (22),
  shell 153 (11), shared 73 (6), cli 69 (3) — **2,068 passing**. The real app's e2e passed **13/13**.
- SHA-256 of `Bridge Setup 0.12.1.exe` (120,078,046 bytes):
  `621279c9b79cfc26ba64c5b7e909004aca45cb84f661a95d06d2dcfc1cf4026f`

## [0.12.0] — 2026-09-08 — Claude Code recognized inside the shell

The owner's request was literal: *"I'm running claude code and it shows
shell"*. And it was right. Bridge only knew what a session was doing when
IT was the one that had launched the agent — because that's the moment it
writes the session's `settings.json` and passes `--settings`. Anyone who
opened a shell pane and typed `claude` in there ended up with an invisible
Claude Code: no hook reached the core, the sidebar row said `shell` with the
gray ring of a stopped session, and there was no notification, status line,
usage tracking, or scope guard — with a whole agent working inside that
pane.

Two things changed, both within what Bridge already controls. **Every shell
it opens is born with its own folder in front of that PTY's `PATH`**, with a
`claude` shim that calls the REAL Claude Code, adding the session's
`--settings` — the same hooks file agent sessions use. And **when the first
hook arrives, the shell session becomes a host**: the row starts showing
`claude` with a real state ring, and when you exit Claude it goes back to
saying `shell` — with the shell still alive, in the same pane, with the
same history. No new keystroke, no extra step: you type `claude` the way
you always did.

What was left out, on purpose: nothing is read from the terminal's SCREEN
to guess that a Claude came up (that's exactly what ADR-004 has always
refused — heuristics over pixels instead of a declared fact), and nothing
is written to the user's GLOBAL `settings.json` (Bridge would start touching
a configuration that isn't its own, and that applies to every Claude Code on
the machine). The record is in
[ADR-014](docs/adr/014-wrapper-claude-no-path-do-shell.md).

### Added

- **`claude` wrapper per shell session** (`packages/core/src/adapters/hosted.ts`).
  In `<session folder>\bin` there is a `claude.cmd` (what pwsh and
  Windows PowerShell resolve, via `PATHEXT`) and an extensionless `claude`
  (what Git Bash resolves) — both in the same folder, without either shell
  getting confused. They call the ABSOLUTE path of the real claude, never
  `claude` through the PATH: with its own bin in front, the wrapper would
  find itself. The target is resolved by the CORE process, before any
  prepending, so by construction it never points at the wrapper. Arguments
  are passed through intact.
- **`Session.hosted = { agent, since }`**, present only while the hosting
  lasts, everywhere a session is serialized (`GET /api/state`,
  `session.created`, `session.updated`).
- **The whole UI reads the host as an agent**: the `claude` label and state
  ring in the sidebar row and the pane header, `detail` **"in the shell"**
  when nothing is happening, the tooltip "Claude Code running inside this
  shell", the footer counters ("1 running", "1 need input"), the
  notifications panel, and the close-pane question ("Closing this pane ends
  the claude session. Continue?").
- **Settings → Sessions: "Recognize Claude Code started inside a
  shell"** (`sessions.hostedAgents`, **on** by default), with a note
  explaining what the session gains and what it stays being.
- **e2e scenario 12**: with a fake `claude` on the PATH, a `claude
  --version` typed into the PTY proves through the xterm lines that the argv
  reached the target with the session's `--settings`; then the hooks come in
  through the real route and the row makes the whole `shell` → `claude`
  (`running`, `done`) → `shell` journey, with `GET /api/launcher`'s `active`
  going from 1 to 0 and the shell answering an `echo` at the end.

### Changed

- **`kind` NEVER changes.** A hosting session was born `shell` and stays
  `shell`; `agent` stays absent. What says which agent is in there is
  `hosted.agent`, and the reading rule everywhere on screen became
  `hosted?.agent ?? agent`. That's why **restoring a hosting pane reopens a
  plain shell**, without resuming the conversation. In a pane that ALREADY
  HAD an agent session before, though, the **"Reopen with context"**
  button now reaches it: `POST /api/panes/:id/resume` ignores `lastKind` on
  purpose and resumes the `lastAgentSessionId` the pane had saved — which
  can now be that of a Claude opened inside the shell. In a pane that only
  ever had a shell, the route still answers `422 nothing-to-resume`.
- **The host counts toward the `sessions.maxConcurrentAgents` cap and never
  joins the queue.** It's a real Claude Code consuming a slot
  (`liveAgentCount()` adds it in), but Bridge wasn't the one that launched
  it — queuing it after the fact wouldn't make sense. Honest side effect:
  with the cap at 1 and a host already up, every agent `POST
  /api/sessions` goes to the queue.
- **`claude.cmd` is plain ASCII, on purpose.** cmd.exe reads a batch file in
  the **console's OEM codepage** (437/850), not UTF-8: a `C:\Users\João\...`
  written into the wrapper's body reached claude as
  `C:\Users\Jo├úo\...` — "Settings file not found", measured. So the target
  travels through the ENVIRONMENT (`BRIDGE_CLAUDE_BIN`, which is UTF-16 from
  the parent process to the child) and the settings path comes from
  `%~dp0`, the wrapper's own path, which cmd expands straight from disk. The
  Git Bash wrapper still uses a literal path — the accent survives there —,
  with both paths quoted in single quotes.
- **On WSL the `PATH` is built into the login shell's `exec` line**
  (`PATH='<bin>':$PATH exec "${SHELL:-/bin/sh}" -l`), and the distro's
  wrapper removes **every** occurrence of its own bin before calling
  `claude` from there — entry by entry, by literal comparison, with globbing
  off. This isn't fussiness: the `sh -lc` line runs BEFORE `~/.profile`,
  which on Ubuntu does `PATH="$HOME/.local/bin:$PATH"`, and a cut that only
  caught the first occurrence would let `exec claude` find the wrapper
  again — an infinite loop. **Declared limit:** a login profile that ZEROES
  the `PATH` (instead of prepending to it) turns the feature off; the
  wrapper stays on disk, it's the login shell that no longer sees it.
- **The toggle applies to the NEXT shell.** Turning `sessions.hostedAgents`
  on or off does not interrupt a hosting session in progress: it ends on
  its own at `SessionEnd`. (Turning it off mid-session used to trap the
  hosting session, and that was fixed before the version shipped.)
- **There is no heartbeat.** A Claude killed with `taskkill`, with no
  `SessionEnd`, leaves the session marked as a host until the shell closes —
  occupying a slot of the cap. It's in `SECURITY.md` (accepted risk 20).
- **`resolveClaudeBin()` is cached per core process.** Installing Claude
  Code with Bridge open does not make new shells get the wrapper: the core
  needs restarting (close and reopen the app). With no claude on the
  machine, nothing happens — no file, no PATH touched.
- **The scope guard now applies to the `claude` you type in the shell** —
  and this CHANGES what used to happen in 0.11.x. In a task (worktree) or
  repository workspace, the allowed root is the WORKSPACE's, not the folder
  you're in: a `cd ..\other-repo` followed by `claude` used to give, up
  through 0.11.2, an agent with no fence at all — now `Read`/`Edit` calls on
  that other repository come back **denied**, with the 🛡 badge on the row
  and the blocked path in the pane. It's the price of the session becoming
  recognized: it gained a ring, notifications, and usage tracking through
  the same door the guard comes in by. When outside access is legitimate,
  the way out is the one that already existed: **"Allow access outside the
  worktree"** in the workspace **"⋯"** menu — or turning off **Settings →
  Sessions → "Recognize Claude Code started inside a shell"**, which
  restores 0.11.x behavior on the next shell. The RELATIVE path resolves
  against the hook PAYLOAD's `cwd` (you may have run `cd` before opening
  Claude); the allowed root still comes only from the workspace — see
  `SECURITY.md`.
- **A `claude` opened INSIDE the host is not reinjected.** The session's bin
  stays in front of the PTY's `PATH` and every descendant's — including the
  hosted Claude's own `Bash` tool. Without a guard, a `claude -p …`
  fired from inside there would resolve the wrapper, come up with the SAME
  `settings.json` (same `BRIDGE_SESSION`), and report into the host's
  session: the child's `Stop` would mark "done" while the real Claude was
  still working, and its `SessionEnd` would un-host the whole pane. Now all
  three wrappers check `CLAUDECODE` — the variable that only exists inside a
  Claude Code, and that Bridge strips from the environment of every PTY it
  opens — and, when it's set, they call the real claude **without**
  `--settings`, passing the exit code through. The sub-Claude runs just the
  same; it just no longer speaks for its parent.
- **A pane with a host is not swapped out from under it.** `bridge resume`
  and "Reopen with context" (`POST /api/panes/:id/resume`) used to decide by
  looking only at `kind === 'agent'` and would kill the shell — along with
  the Claude Code working inside it. Now a session with `hosted` answers
  **409 `pane-busy`**, and the core's `replaceLiveShell` refuses by the same
  criterion the UI already used to ask before closing a pane. After
  `SessionEnd`, with the shell back to being just a shell, resume works the
  way it always did.
- **No new shortcut.** Nothing was added, swapped, or removed from the
  keyboard.

### Notes

- **No new dependency**, nothing downloaded.
- Two last-hour fixes, in the same fix wave: the tool `detail` the sidebar
  and `bridge list` show now goes through `sanitizeDisplay` (`tool_input`
  is chosen by the model, and an `ESC]0;…` was reaching the owner's terminal
  raw), and a hook arriving late for an **already-ended** shell session no
  longer promotes anything — it used to mark a dead session as a host,
  which kept occupying a slot of the cap.
- A core code wrapper got hardened at the same time: both paths of the Git
  Bash wrapper are now quoted with `shQuote` (single quotes), as the WSL
  ones already were — a `$` or a backtick in the profile path would have
  expanded inside double quotes. Covered by a text test and by a real run
  of the wrapper in Git's `sh`, in a folder with `$` and single quotes in
  its name.
- **Tests**: core 1,041 passing and 3 skipped (55 files), ui 728 (22), shell
  148 (10), shared 73 (6), cli 69 (3) — **2,059 passing**. The real app's e2e
  passed **12/12**.
- SHA-256 of `Bridge Setup 0.12.0.exe` (120,075,433 bytes):
  `63e78dc4be292b41f1f1dcdbb2479ad9fa0062016e98bf1adeb8930be414e28b`

## [0.11.2] — 2026-09-07 — cleaner shortcut bar

### Changed

- **The tab bar shows the action's name, not the key combo.** There used to
  be five hints with each `<kbd>` (`Ctrl Shift D split`, `Alt ← → move`,
  `Ctrl Shift Y usage`, `Ctrl Shift X close pane`), and together they took
  up the whole bar — "it got too cluttered," in the owner's words. Now it
  reads **split**, **← →** with the verb *move*, **usage**, and **close
  pane**; each one is still the button for the action it announces, and the
  click fires exactly what the key would fire. The combo didn't disappear:
  it's in each button's tooltip ("Close pane (Ctrl+Shift+X)"), read from
  the `keybindings.json` in effect just like before — rebinding still
  changes what Bridge says —, and in the **Settings → Shortcuts** table,
  which is unchanged. The empty pane lost, for the same reason, the two key
  lines above the buttons ("Enter opens a shell here", "Ctrl Shift C opens
  Claude Code"): they repeated in `<kbd>` what the buttons right below
  already say by name, and each one's shortcut stays in its own tooltip. No
  key was swapped, added, or removed.

### Notes

- **No new dependency**, no route touched, nothing in the core.
- **Tests**: `@bridge/ui` 694 passing (21 files) and `@bridge/shared` 72 (6).
  The real app's e2e passed **11/11**, with no selector change — no
  scenario clicked the bar's `<kbd>` elements.
- SHA-256 of `Bridge Setup 0.11.2.exe` (120,064,977 bytes):
  `199189638fdd3fb61a5e42369879a5d9f9c31421501124cb3149ecda4bab71fc`

## [0.11.1] — 2026-09-07 — copy and paste in the terminal

A fix for something basic that had never worked: copying a URL outside
Bridge and pasting it into the Claude Code terminal with `Ctrl+V` did
nothing.

### Fixed

- **`Ctrl+V` pastes in the terminal.** xterm 5.5 turns `Ctrl`+letter into a
  control byte and **cancels** the `keydown`: `Ctrl+V` became `^V` (0x16)
  sent to the PTY, and Chromium's native paste never got a chance to
  happen. Bridge, on its side, had never wired the clipboard into the
  terminal — `Terminal.tsx` had no `attachCustomKeyEventHandler`, no
  `term.paste`, no `contextmenu`. What worked was `Shift+Insert` (through an
  xterm exception of its own), which nobody uses. Now **`Ctrl+V`,
  `Ctrl+Shift+V`, and `Shift+Insert`** all paste, following Windows
  Terminal's and VS Code's terminal convention. The paste goes through
  `term.paste`, which wraps the text in *bracketed paste* when the
  application has turned on mode 2004 — Claude Code turns it on, so pasting
  several lines is still **one** input instead of turning into N Enters.
- **`Ctrl+C` with a selection copies** (and clears the selection).
  **Without** a selection it's still `^C`/SIGINT — that's what it's for in
  a terminal, and changing that unconditionally would remove the only way
  to interrupt a command. `Ctrl+Insert` also copies.
- **Right-click in the terminal**: with a selection it copies, without one
  it pastes. There is no context menu, and the window has no application
  menu at all — that's why no other path to the clipboard was left.

### Notes

- **`Ctrl+Shift+C` did not change**: it's still "open Claude" (the app's
  shortcut), remappable in `keybindings.json`. And `Ctrl+Alt+V`/`Ctrl+Alt+C`
  remain intact for the terminal, because on ABNT2 `AltGr` arrives as
  `Ctrl+Alt`.
- **How the clipboard is read**: `navigator.clipboard.readText()/writeText()`.
  The UI is served at `http://127.0.0.1:<port>`, which Chromium treats as a
  secure context, and the window's default session (which has no
  permission handler) returns `clipboard-read: granted`. This was
  **measured** on this build's Electron 44, not assumed. If a future
  Electron tightens that default, pasting stops calling `preventDefault()`
  from the first refusal onward and lets Chromium paste on its own through
  the native path — it costs one keystroke and works again.
- **No new dependency.**
- **Tests**: `@bridge/ui` 693 passing (21 files, +22 from the new
  `terminal-clipboard.test.ts`), `@bridge/core` 969 (3 skipped, 53 files),
  `@bridge/shell` 148 (10), `@bridge/shared` 72 (6), `@bridge/cli` 69 (3) —
  **1,951 tests**. The real app's e2e passed **11/11**, with the new
  scenario that pastes with `Ctrl+V` into a real xterm, copies the selected
  line with `Ctrl+C` and checks the clipboard **of the main process**, and
  does both through right-click.
- SHA-256 of `Bridge Setup 0.11.1.exe` (120,065,043 bytes):
  `f73ed1dda431c8e82767680b28dced11b73bc951e03e78e2e902a4de1b7fab90`

## [0.11.0] — 2026-09-07 — verified pains from Claude Code users

This version did not come out of a list of ideas: it came out of the
author's research into what people report in `anthropics/claude-code`
issues. Out of 25 claims raised, **6 survived adversarial verification**
and **4 had primary evidence** and fit what Bridge is — an app that runs
several Claude Code instances side by side on Windows. These are the four,
in order of volume × fit: the **server limit** confused with the usage
limit, the **wrong environment** on Windows/WSL, **`--resume` coming back
empty**, and the **lack of isolation between sibling worktrees**.

Three decisions run through the whole version and are worth saying out
loud, because they explain what Bridge does **not** do here. First: Bridge
does not own the agent's state, so in none of the four does it pretend to
fix what belongs to Claude Code — it **shows**, **spaces out**, and
**fences**. Second: a false positive is worse than no detection at all in
all four, because a warning that's wrong teaches you to ignore it — hence
the detector requiring the whole sentence, the resume verdict never being
guessed when the payload is silent, and the scope guard never judging a
shell command. Third: no new dependency came in.

### Added

**The SERVER limit, separated from your usage limit (pain #1).** These are
different things and the terminal calls both of them "limit": the
**usage** one belongs to your account (5 h / week), scales with your plan,
and resets at a known time; the **server** one
(`Server is temporarily limiting requests (not your usage limit)`, `API
Error: 529`, `overloaded_error`) belongs to shared infrastructure, **does
not scale with any plan**, and goes away on its own within minutes.
Whoever can't tell the two apart ends up fiddling with their plan over a
problem that isn't theirs. Bridge now reads the PTY output through a
rolling 4 KB window per session (ANSI stripped) and, matching one of the
four phrases, marks the session as `server-limited`: an **orange** ring and
`⏳ server` badge on the row, with the matched phrase in the tooltip as
proof. The 100% USAGE limit got its own badge, **red**, with the reset
time. The state clears on the next `Stop`/`UserPromptSubmit` or within 5
minutes. Matching requires the WHOLE phrase from Claude Code (or a token
that only exists in the API error body): a `// TODO: handle rate limit` in
a diff, an `if (err.status === 529)` in an open file, and a raw `HTTP 429`
trigger nothing, and there's a test for each of those lines.

**Launch scheduler** (`sessions.scheduleLaunches`, on by default). On top
of the detection came the only lever Bridge has over the CAUSE — the burst
of agents starting together, which is exactly what restoring a workspace
with several panes used to do: a cap of `sessions.maxConcurrentAgents` live
agents (default **4**; beyond it, `POST /api/sessions` answers **`202
{ queued: true, position }`** instead of `201`), **300–900 ms jitter**
between launches in a burst, and **5 s to 60 s backoff** while any session
is throttled. The sidebar shows `N sessions waiting for a slot` with a
**Launch now** button. It never kills or pauses a live session, and `POST
/api/panes/:id/resume` and the agent born with a task **don't** go through
the queue — they're a deliberate click on a single session. Routes: `GET
/api/launcher`, `POST /api/launcher/launch-now`, `DELETE
/api/launcher/pending/:id`, the `launcher.changed` event, and **429
`queue-full`** above 64 pending.

**Session environment per workspace (pain #2)** — `pwsh`, Windows
PowerShell, Git Bash, or a **WSL** distro, picked in the new-workspace
dialog, the "⋯" menu, or via `bridge new --env wsl:Ubuntu`. It's a
**workspace** property, not a global setting: the same machine can have one
repository that only builds in a distro and another that only runs in
`pwsh`. With `{ kind: 'wsl', distro }`, the shell **and** Claude Code both
start inside the distro, via login shell, with `cwd` and `--settings`
translated by `wslpath -a` (the reported pain is exactly the accented
folder, or the network path, that "works by accident" and fails silently).
The switch applies from the **next** session on: killing a live PTY over a
menu choice would throw away the work inside it. `GET /api/environments`
lists what the machine has, with "has `claude`?", "has `node`?", and "is
interop on?" per environment, and the workspace row gets the `wsl:<distro>`
/ `gitbash` badge plus the **⚠ no claude** and **⚠ environment gone**
warnings.

**Hooks for a WSL session run through the WINDOWS Node, via interop**
([ADR-013](docs/adr/013-hooks-de-wsl-pelo-node-do-windows.md)) — never
through the distro's own `node`, even when it has one. The reason is
measured, not cosmetic: in WSL2's default network mode (NAT) **the loopback
is not shared**, and from inside the distro `127.0.0.1` is the distro
itself — the shim's POST would never reach any core, and the session would
stay "idle" forever, with no error. Run through `node.exe`, the shim is a
Windows process and its loopback is the host's. That's why the shim's path
travels in Windows form (interop passes the argv through untranslated) and
`BRIDGE_PORT`, `BRIDGE_TOKEN`, `BRIDGE_SESSION`, and `BRIDGE_SHIM` cross
over through `WSLENV`.

**Detection of a `--resume` that comes back empty, and "Reopen with
context" (pain #3).** `claude --resume <id>` sometimes comes up with no
error at all and opens a **new** conversation — you only find out when you
ask something that depended on what had already been said. Bridge judges
on the first `SessionStart`: a `session_id` different from the one
requested, or a `source` that isn't `resume`, becomes
`Session.resumeOutcome = 'fresh'` and the pane shows the banner *"The
previous conversation was not resumed (Claude opened a new session)"* with
**Reopen with context** and **Dismiss**. A payload with no id **and** no
`source` produces no verdict at all. The button calls `POST
/api/sessions/:id/recap`, which reads the OLD transcript from the tail (2
MiB) and builds a **deterministic recap — no model is called**: your last
request and the agent's last three text replies, with no
`tool_use`/`tool_result`/subagent content, 600 characters per snippet, 2,500
total, all through `sanitizeDisplay` and on **a single line** (a line break
there would be an Enter in the middle of the recap). **This is not the
context coming back**, and the banner doesn't promise that: it's enough for
the new agent to know what subject you were talking about.
`sessions.autoRecap` does the injection without a click and is born **off**
— writing into the agent's prompt is the one thing here that would touch
your terminal on its own. The three legitimate failures are `no-resume`
(422), `transcript-not-found` (404), and `recap-empty` (422).

**Scope guard between worktrees (pain #4).** Two tasks from the same
repository run in `.worktrees/a` and `.worktrees/b`, and a process's `cwd`
is a suggestion, not a fence: nothing stopped task A's Claude from
opening — and rewriting — a file from B by absolute path. `PreToolUse` is
the only Claude Code hook that accepts a permission decision in its
response, and that's where Bridge decides: `Read`, `Edit`, `Write`,
`MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, and `LS` have their
`file_path`/`notebook_path`/`path` resolved against the session's `cwd`
(with `..`, mixed slashes, and symlinks/junctions unwound by `realpath`)
and compared against the allowed root. **The root depends on the workspace
type**: the worktree, in a task; the **whole repository**, in a repo
workspace (whoever opens a repo at its root is working on the repo, and
fencing them into a pane's `cwd` would be a fence nobody asked for); the
`cwd`, outside a repository. Outside it, the response is
`permissionDecision: "deny"` with the reason written **for the agent to
read** — it names the exact menu item that lifts it, because the agent is
the one who'll repeat it back to you. Every refusal lights up a **🛡 N**
badge on the session row, with the last five paths in the tooltip. On/off:
`sessions.scopeGuard` (Settings → Sessions, **on** by default) is the
general switch; `PATCH /api/workspaces/:id { crossAccess }`, via the "⋯"
menu, lifts it for **one** workspace and applies on the next `PreToolUse`,
with no session reopen.

**What the guard deliberately does NOT cover:** **`Bash`** and the
`pattern` of `Glob`/`Grep`. A shell command declares text, not a path, and
the real target depends on `cwd`, `PATH`, variables, and the shell itself —
judging a path inside a string would be wrong both by false positive
(`--exclude=../x`) and false negative (`powershell -EncodedCommand`) at the
same time, and a guard that's wrong both ways teaches you to turn it off;
`pattern` is a search pattern, and its result is already filtered by
`path`. And the per-workspace lift (`crossAccess`) is **total**: on, that
workspace's sessions can once again read and write anywhere on disk, not
just in the neighboring worktree. This is in
[`SECURITY.md`](SECURITY.md) (accepted risk 17) — the guard is against
**agent mistakes** and a **hostile repository** (A4), never against you
(A3), and should never be described as "isolation".

### Changed

- `SessionState` gained **`server-limited`**, and severity was renumbered:
  `stuck > needs-input > server-limited > done > running > idle > exited`.
- An agent's `POST /api/sessions` now has **two** success codes (201 and
  202). `404 pane-not-found` and `409 pane-busy` are still **immediate**:
  they're validated before queuing, because a 202 for a pane that doesn't
  exist would be a promise the queue has no way to keep.
- `session.state` carries `serverLimit` (replaced, never merged: an event
  without the field means the session left that state) and
  `session.updated` now carries `resumeOutcome` and `scopeBlocks`. Every
  session now emits one extra `session.updated`, on the PTY's first byte —
  it's the gate that stops the automatic recap injection from writing
  before the agent's TUI accepts text.
- `USAGE_LIMIT_REACHED_PCT` (100%) went into `@bridge/shared`: the USAGE
  limit threshold is shared policy, but the badge is still built **only in
  the UI** (`usageLimitBadge`). `GET /api/usage/limits` gained no new
  field.
- `config.json` gained the `sessions` object (`maxConcurrentAgents: 4`,
  `scheduleLaunches: true`, `autoRecap: false`, `scopeGuard: true`), merged
  key by key like the others, plus a **Sessions** section in Settings.
- New columns on `workspaces` (`environment_json`, `cross_access`), with an
  idempotent migration: a 0.10.x profile opens normally.
- `bridge new` accepts `--env pwsh | powershell | gitbash | wsl:<distro> |
  default` and knows how to print the scheduler's `202` ("Session queued
  (position N)") without calling a session that doesn't exist yet
  "created".

### Fixed

- **Pane restore no longer starts every agent at the same instant** — it's
  the easiest burst to trigger, and now goes through the spacing like any
  other launch.
- **The concurrency cap can no longer be punched through by a burst.** The
  scheduler reserves the slot at DISPATCH time, not when the session
  exists: `claude --version` runs in between, and eight requests with a
  cap of 4 all used to pass the check before the first one became a
  session.
- **A silent `SessionStart` no longer lets the next `/clear` turn into a
  false alarm.** The judgment window closes on the first `SessionStart`,
  even when it produces no verdict — the lock used to be the already
  recorded verdict, and the owner's own `/clear` (`source: 'clear'`) would
  light up the "resume failed" banner.
- **The scope guard is no longer fooled by an unreadable reparse point.**
  Path resolution only "goes up" a level when the error is
  `ENOENT`/`ENOTDIR` (a file that doesn't exist yet); any other error —
  `EPERM` on a junction with an ACL denying reads — now counts as
  **outside** (fail-closed). It used to reattach the segment name as text,
  and the prefix comparison said "inside".
- **The `deny` reason names a menu item that actually exists.** It used to
  cite "⋯ → Cross access", which the menu never drew; now it says "Allow
  access outside the worktree" / "…the repository", depending on the root.
  It's the agent who reads that sentence, and it's the agent who repeats it
  to you.
- **`bridge new --env` and the new-workspace dialog handle the `202`**
  instead of reading it as a created session.

### Notes

- **No new dependency.** The four pains were closed with what was already
  in the lockfile.
- **Tests**: `@bridge/core` 966 passing (3 skipped, 53 files), `@bridge/ui`
  669 (20), `@bridge/shell` 148 (10), `@bridge/shared` 72 (6), `@bridge/cli`
  69 (3) — **1,924 tests**. The real app's e2e (`npm run e2e`, Electron +
  core + a real PTY) passed **10/10**, with two new scenarios: `PreToolUse`
  coming back `deny` through the shim with the 🛡 badge in the sidebar, and
  the scheduler queue (202 → "Launch now" → the session comes up).
- **Real WSL execution was not verified**: the build machine has no distro
  (`wsl -l -q` comes back empty). The whole chain is under test against a
  simulated `wsl.exe`, and the manual verification is recorded in the
  README.
- SHA-256 of `Bridge Setup 0.11.0.exe` (120,064,606 bytes):
  `a3a4aa65f4953de2fad31514f46805354827073d15130645b49c7f8e04ad7e29`

## [0.10.1] — 2026-09-06 — usage monitor security

A security pass over what 0.10.0 brought (the usage monitor) and over the
surfaces new since 0.8.0: a read-only audit, a fix wave with **one attack
test per finding**, and an adversarial re-review by a different reviewer.
There were **18 findings — 0 critical, 4 high, 6 medium, 8 low** —, all
closed. The updated threat model (with the new attacker, **A6 — hostile
transcript**) is in `SECURITY.md`.

What the audit showed, and is worth saying out loud: the usage monitor is
the **only** Bridge surface that works on its own, every 60 s, on top of
content you didn't type. A `.jsonl` under `<claudeHome>\projects` may have
been written by another process of yours, by an agent running inside a
session, or restored from a backup.

### Fixed

**Count integrity (BU-01, BU-02, BU-08, BU-17).** A transcript line larger
than the read chunk locked that file **forever**: the offset never
advanced, the next pass reread the same bytes, and every bit of usage after
it silently disappeared — "Rescan transcripts" fell into the same loop.
Now a line over 4 MiB is **skipped and counted**, and the offset always
moves forward. A model named `constructor` found "price" in the prototype
chain and turned the whole slice's cost into `NaN` (the panel said "no
model has a price" while the spend was happening): the price table became
`Object.create(null)` and every lookup uses `Object.hasOwn`. A token count
outside `[0, 1e12]` now counts as zero (a pair `{-1e12, +1e12+5}` used to
slip through the only filter that existed and **eat** the real usage of the
day's other buckets), and a timestamp outside `[2020-01-01, today + 2
days]` discards the line — the year 275760 used to create an immortal row
in the database.

**File reading via `usage.pricingFile` (BU-03).** The field read **any**
file, returned a chunk of its content in the warning (a JSON's top-level
keys, a text's first ~10 characters), and blocked the event loop for
**1,069 ms** with a 200 MB file — all of this repeated on every core
startup, because the path lives in `config.json`. It now requires a
`.json` extension, an absolute path, a regular file, and at most 1 MiB
(all checked **before** reading), and any failure becomes a generic
warning: no content snippet, no key name, and no path, anywhere — not in
the response, not on screen, not in `core.log`.

**Hostile text reaching your terminal (BU-04, BU-09, BU-13, BU-16).** The
status line Bridge hands back to Claude Code passed through `ESC`/`BEL`
from the hook payload: hijacking the window title, color, blinking,
clearing the screen — and a bridge into Bridge's own OSC scanner, which
turns into a Windows notification. `bridge usage` printed `cwd` and `model`
raw. A **single** sanitizer came in, `sanitizeDisplay` in `@bridge/shared`,
used by all three screen-facing endpoints (status line, the CLI's human
output, the pane's `title`/`aria-label`): it strips whole escape sequences,
C0/C1, DEL, and Trojan Source's **invisible formatting** characters
(`U+202E` and the other bidi ones, zero-width ones, the BOM), collapses
whitespace, and cuts at the field's cap. The CLI's `--json` and the API
body stay raw on purpose: they're data, not screen. Echoes of `repoId`,
`?tz=`, and of an unknown `keybindings.json` action also come out cleaned
and cut.

**Availability (BU-05, BU-07, BU-11, BU-14).** **Listing** the transcript
tree was synchronous and stopped the core for **3.78 s** on a tree of
50,000 files — on every poller pass, no attacker needed; it became
asynchronous, yielding the event loop every 500 entries or 5 ms (largest
pause measured on a tree of 20,000 files: **3 to 16 ms**), with a cap of
50,000 files and a warning. `POST /api/usage/rescan` gained **409** for an
in-flight rescan and **429** within 30 s of the last one — its cost is
proportional to your whole history, not to the request. `byModel`/`byProject`
now come out with at most 200 buckets plus one summed `(others)` row
(20,000 projects used to produce 4.17 MB of JSON per request), and the
`usage.changed { limits }` event gained the same 1/s cap the progress event
already had, with the last snapshot always delivered.

**Status-line payload capped (BU-06, BU-12).** At most 16 `rate_limits`
windows (5,000 turned into a 153 KB status line handed back to your
terminal on every redraw; 40,000 blew past SQLite's variable limit and
turned into a **500** on the hook route), window keys cleaned and cut at
64 characters, and `resets_at` only within ±10 years — an absurd timestamp
used to literally print `resets undefined`.

**Configuration (BU-10, BU-15).** The 200-model cap on `usage.pricing` that
the docs promised is now enforced — by the API and by `config.json`. The
`cacheWrite1h` field, documented and supported by the calculation, was not
declared in the schema and was **silently dropped**: whoever adjusted the
1-hour write price got a `200` and nothing happened. `PATCH /api/repos/:id`
and `POST /api/sessions` now refuse an unknown field instead of swallowing
it.

**Privacy, in writing (BU-18).** `SECURITY.md` said what the monitor
**doesn't** store; it now also says what it **does** store:
`usage_daily.project` holds the `cwd` of every row and `usage_files.path`
the path of every transcript, both in `%APPDATA%\bridge\bridge.db`, and
`core.log` receives paths in its warnings. A project path is personal
data, and deleting it has a recipe.

### Added

- **`sanitizeDisplay`/`isDisplaySafe`** in `@bridge/shared` — the single
  rule for "outside text going to a screen", tested against the audit's
  payloads.
- **Visible `skippedLines` and `capped`.** When a scan skips a line for
  size, or caps the list at the file limit, the "Usage" panel, **Settings →
  Usage**, and `bridge usage` write down how many, and warn that the number
  shown is **lower** than the real usage. A count lower than the real one
  presented as a total is BU-01's defect all over again, just a polite
  version.
- New `usage_files.skipped_lines` column (automatic migration: the usage
  tables are derived and rebuild themselves).

### Notes

- The scan gives up on the next entry when the core is shutting down:
  without this, making the listing asynchronous blew past the graceful
  shutdown's 1,500 ms budget on a large tree and left `instance.json`
  behind. The e2e caught it.
- Clicking **Rescan transcripts** twice within 30 s now shows the cooldown
  message instead of rescanning. It's the only visible behavior change.
- No new dependency came in (`npm audit`: **0 vulnerabilities**).

## [0.10.0] — 2026-09-06 — native usage monitor

The integration with the external quota tool left the repository, and in its
place Bridge got its own usage monitor: live 5-hour and weekly limits,
daily/weekly/monthly consumption in tokens and estimated cost, a dashboard
panel (`Ctrl+Shift+Y`), the status line built by Bridge itself, and the
`bridge usage` command. Owner decisions: the day starts at **local
midnight**, the **cost is shown**, and the panel is a dashboard ("cmux
doesn't have this"). The decision is in
[ADR-012](docs/adr/012-monitor-de-uso-nativo.md), which **supersedes
ADR-008**.

### Added

**Usage monitor in the core** (`packages/core/src/usage/`) — an incremental
scan of the transcripts Claude Code writes to `<claudeHome>\projects`,
summing tokens by day × model × project × source. It is **recursive**:
besides the main conversation, it counts the **subagent** `*.jsonl` files
nested under the session folder. This isn't a detail — in a sample of 400
transcripts from the author's machine, **62.8% of the tokens came from
subagents**, and the module's first version couldn't see them. Both sides
always go into the total; `bySource` exists so the panel can say "includes
subagents", never to hide half the usage behind a filter.

Reading is **asynchronous, in 256 KB chunks**, yielding the event loop
between them (largest synchronous chunk measured: **8.3 ms**, against a 20
ms target): the core hosts every PTY, and a multi-megabyte `readSync` would
hold up the terminals of whoever is working. Every file is read starting
from its saved offset, the partial line at the end waits for the next pass,
and dedupe is by `message.id:requestId`.

**"Usage" panel** (`Ctrl+Shift+Y`, the **usage** hint in the tab bar, or
"Usage…" in the sidebar "⋯" menu). In the order of the question: the limit
meters (can I keep going right now?) → the total cards → the last-30-days
chart → the by-model and by-project tables → what's an estimate. Range
`day | week | month`. An empty state with the folder being read and a
single CTA.

**Limits block in the sidebar** — shown once, right below the header,
because limits belong to the **account**, not the workspace: repeating the
same 5-hour bar in every expanded workspace would say the same thing three
times, and the wrong takeaway would be "each project has its own quota".
Inside the expanded workspace, the session line stayed: `70k ctx · Fable
5.1 · US$ 0.74`.

**Settings → Usage** — showing the estimated cost, the price file, the
"Rescan transcripts" button (with progress and the result `{ files,
messages, days }`), and the list of models the current table doesn't
cover, with the expected JSON example.

**`bridge usage [--range day|week|month] [--json]`** and **`bridge usage
--rescan`** — the same report as a text table: totals, by model, the 5
biggest projects (the rest becomes `others (N projects)`, summed and not
hidden), the limit windows, the price table's date, and the "includes
subagents" line. It uses the SAME route as the screen, so there's no chance
of the terminal's number diverging from the panel's.

**Routes and event** — `GET /api/usage?range=day|week|month`, `GET
/api/usage/limits`, `POST /api/usage/rescan`, and the `usage.changed`
event, which carries the windows, the days touched by the last scan, and
the **scan progress** (at most once a second, always at the start and the
end).

**Scan progress** — `GET /api/usage` returns `scanning: { active,
filesDone, filesTotal, bytesDone, bytesTotal } | null`. The first read of a
large history takes minutes (8,431 transcripts and 12.8 GB on this
machine), and until now the panel claimed "no transcripts found" the whole
time it was, in fact, reading — a false statement that sends the person
looking for a defect that doesn't exist. It now says "still reading the
transcripts (N of M files)".

**`role="meter"` on the limit meters** (panel and sidebar), with
`aria-valuenow/min/max` besides the label. They used to be `role="img"`: a
figure with a caption, which anyone navigating by meters couldn't find.

**Shared formatting** — `formatUsd`/`formatTokens` in `@bridge/shared`,
used by the core's status line, the UI, and the CLI. Four surfaces write
the same numbers, and each with its own `toFixed` meant `$0.74` in the
terminal and `US$ 0,74` on screen.

### Changed

**The status line handed back to Claude Code is built by Bridge**, in
memory: `87k ctx · Fable 5.1 · US$ 3.42 · 5h 23% (resets in 2h15) · week
68% (resets Mon)`. Fixed order context → model → cost → windows; a missing
field disappears. **No child process** in the path of a line that gets
redrawn several times a second.

**1-hour cache writes counted and charged separately.** The payload
carries `cache_creation_input_tokens` as the SUM of the two writes, with
the breakdown in
`cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`. The 1-hour one
costs **2 × input**; the 5-minute one, 1.25×. Treating them as a single
column underestimated the bill — **22.8% of the write tokens** on the
author's machine are 1-hour ones. The `cache_write_1h` column went into
`usage_daily`, the `cacheWrite1h` field into the totals, and the
`cacheWrite1h` price into every model in the table; a hand-written price
table without that field still works, falling back to the official `2 ×
input` rule.

**A limit window that disappears from a non-empty payload is now cleared.**
`setLimits` only ever did an upsert: if an account lost its `seven_day`
limit while keeping `five_hour`, `seven_day` fossilized in the database and
`GET /api/usage/limits` kept forever returning the percentage and reset of
a window that no longer exists.

**A ten-minute grace period before clearing ALL windows.** A payload with
no `rate_limits` is the legitimate signal of "this account has no limits"
— but with a subscription session and an API-key session open side by
side, the second one would clear the first one's windows on every status
line, and the first one would put them back: the banner flickered. While
any session has reported windows in the last ten minutes, an empty payload
clears nothing.

**Price lookup by model now has two attempts and nothing more**: the exact
id, and the id without its date suffix. The prefix fallback is gone — it
made `claude-opus-4-8` inherit 15/75 from a `claude-opus` entry instead of
5/25, that is, three times the real price, presented with the same
confidence as a correct number.

**`POST /api/usage/rescan` emits `usage.changed` even with no day
touched** (`rescanned: true`). A rebuild that only REMOVES days —
a transcript deleted from outside, a price corrected downward — touches no
day at all, and the panel used to keep the old numbers after a button that
claims to have reread everything.

**A negative `formatUsd` puts the sign before the currency** (`-US$
0.01`): that's how a negative value is written, and `US$ -0.01` reads as
if the symbol were part of the number.

**`bridge` knows a new command** and the help lists it; the **Usage**
section entered the settings dialog (eight sections now).

### Removed

**The integration with the external quota tool**, entirely:
`packages/core/src/quotaAdvisor.ts`, `runAdvisor`/`ADVISOR_TIMEOUT_MS` from
`quota.ts`, the adapter's per-session line cache, the
`quotaAdvisorPath`/`quotaAdvisorResolved` config fields, the
`BRIDGE_QUOTA_ADVISOR` environment variable, the read-only field in the
settings dialog, and the two fake processes from the tests. It was
**optional**, and the data always came from Claude Code's own payload —
what it did was format it. In a public repository this was a dependency
nobody has, a source of truth outside the repository, and still without
the answer that was missing: how much was spent yesterday, this week, per
project. See ADR-008 (superseded) and ADR-012.

**The sidebar's `QuotaStrip`** — became `SidebarLimits` (the account block)
plus `SessionLine` (the session line).

### Privacy

The monitor reads transcripts **in order to count**. What comes out of the
read are the four token counts, the model id, the line's `cwd`, and the
timestamp — message content is never extracted and therefore can never be
recorded. The three new tables (`usage_files`, `usage_daily`,
`usage_limits`) have no content column, and nothing leaves the machine: the
prices are a file in the package, not a lookup. The root is
`BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`, and `claudeHome`
is read-only through the API. See `SECURITY.md`.

### Migration

The `usage_daily` and `usage_files` tables are **derived** — everything in
them can be recalculated by rereading the transcripts. A database from a
version before this change has both dropped and recreated on open, which
forces a full scan: `source` and the 1-hour write enter the schema, SQLite
does not alter a primary key, and migrating aggregated counts without
knowing which file each one came from would cost accuracy. `usage_limits`
is untouched.

## [0.9.0] — 2026-09-05 — polish

Closes out the leftover UI, core, and doc residue from the security phase
that didn't depend on an owner decision — no light theme, no new product.
This is the version prepared to be the first public release: the public
repository became the only living repo, and the tree was normalized so the
first commit wouldn't carry the CRLF of whoever's disk assembled it.

### Added

**`bridge watch`** — the `/ws` events printed to the terminal, one line per
event until `Ctrl+C`, with `--events` (the same prefixes as the server's
`?events=`) and `--json` (JSON-lines on stdout, greeting on stderr, for `|
jq`). Until now only the Electron main process could look at the event bus:
an agent running inside a pane, or the owner debugging a hook that won't
fire, had no way to answer "is the core emitting this?" without opening the
window. No new dependency — `WebSocket` is global in Node 22+, and the
token travels via `?token=` (it's never printed: the status line only
shows the port).

**`problems` in `GET /api/keybindings`** — a field that's a SIBLING of the
actions (not an envelope, which would break every client reading the raw
table) saying what the core found wrong while READING
`keybindings.json`: `json-invalido`, `nao-e-objeto`, `acao-desconhecida`,
`atalho-invalido`. Before this, a broken file used to vanish silently — the
`warn` went to `core.log` and the route answered a table indistinguishable
from a flawless file, with the factory shortcuts standing in for the
owner's choices. The settings dialog's "Shortcuts" section shows these
problems in the SAME yellow banner as the ones the UI itself deduces from
the table (a combo Bridge can't read, two actions on the same key). A
missing field means a flawless file, or a profile with no file at all.

**Sidebar accessibility** — the group header, the workspace row, and the
session row became real controls: `role`, `tabIndex`, an `aria-label` with
state, count, and focus (`"Session claude, stuck, editing, focused"`),
`aria-expanded` on the workspace, `aria-current` on the session, and ↑/↓
navigation between rows (no wraparound at the ends, and no hijacking the
arrow key when focus is inside an open menu). The colored ring, the blue
focus stripe, and the collapsed group's counter simply didn't exist for
anyone using a screen reader. The session's "✕" became a SIBLING of the
clickable area, not a child — a button inside a `role="button"` is nested
interactive content, announced as a single control.

**Tab bar hints derived from the real shortcuts** — the caption comes from
the `Keybindings` in effect, going through the SAME parser that decides
whether a key matches: rebinding in `keybindings.json` used to leave the
caption lying. The `Alt ←→` hint became TWO clickable actions (left and
right) with the shared modifier drawn once — it used to be a single button
that always fired `pane.right`.

**`.gitattributes` with line-ending normalization** — `* text=auto
eol=lf`, `.cmd`/`.bat`/`.ps1`/`.nsh` pinned to `eol=crlf` (cmd.exe doesn't
reliably read a `.cmd` with LF) and the binaries (`.png`, `.ico`, `.woff2`,
`.exe`) marked by hand, so the content heuristic wouldn't decide for them.
The tree was normalized along with it: without this, the first commit
would carry the mix of CRLF and LF the copy left behind, and every future
diff would turn into noise.

### Fixed

**`latestUnread` with no tiebreak criterion** — the last unread was chosen
by sweeping the whole list in JS, and a tie on `at` (trivial when an agent
dumps OSC — exactly the case rate limiting exists to contain) was left up
to whatever order SQLite returned. It became a query, with `ORDER BY at
DESC, rowid DESC LIMIT 1`; `listUnread` got the same tiebreak, because its
order is what the panel shows and it can't dance between two identical
reads.

**`repos.upsert` with `path` already taken by another id** — `path` is
`UNIQUE` and only the `id` conflict was handled: two in-flight
`upsertRepo` calls for the same folder (two workspaces of the same
repository opened together, or two cores on the same profile) would both
think the repo was new, and the second `INSERT` would blow up with
`SQLITE_CONSTRAINT_UNIQUE`, which surfaced as a 500 in the middle of `POST
/api/workspaces`. The upsert now runs in a transaction, the existing
record wins (it's the id the workspaces reference, and the one filter
trust is tied to), `trust_filters` stays out of any UPDATE, and the method
returns the `Repo` that ended up saved.

**Partial failure killing sessions** — closing a tab or workspace with a
stuck session answered 500 with no detail. The others were already being
killed (`Promise.allSettled`); what was missing was the body accounting
for it: the three removal routes now answer `{ error, code:
'kill-failed', killed, failed, failedIds }`, and each failure goes to the
log with its `sessionId`. It's still 500, not 207, on purpose — the layout
is NOT removed (removing it on top of a live PTY would orphan the process,
with no pane left to show it), so the request wasn't fulfilled even in
part. What changed is that the response says which pane to look at, and
repeating the call is safe.

**Orphaned quota badge at the sidebar's default width (280 px)** — each
badge was a loose item in a `flex-wrap`, so the second one would drop to
the next line on its own: an isolated `week 42%` that read as an error
instead of a second quota window. The badges moved into a wrapper (the
strip now has two flex items: either they fit next to the text, or they
drop together) and the text line shrinks with an ellipsis and the full
`title`. Measured in the DOM at 280 px: the two badges' top used to be 83
and 106 px, and became 103 and 103.

**Pane restore vs. a workspace being born** — the "creation in flight"
mark was a global counter: as long as it stayed > 0, the restore effect
would skip WHATEVER workspace became active **and mark it as restored**.
Switching to a never-restored workspace while the dialog was waiting on
the `POST` lost its restore — and, since the mark stuck, it would never
restore again for the rest of that run. Now every in-flight creation has
an IDENTITY (a record with an id per creation, whose end is idempotent)
and keeps track of the workspaces that ALREADY existed when it started: a
workspace that was already there restores normally, and the suspect is
skipped **without marking it**. The end of a creation re-examines the
active workspace, so whichever one stayed active through the whole
creation restores on its own, with no user action. The dialogs' contract
followed suit: `onBusyChange(boolean)` (an anonymous "it's done", impossible
to attribute to the right request) became `beginCreating(): () => void`.

**Finishing touches** — the "✕" on a pane being created is still disabled,
but now explains why in its `title` (a grayed-out button with no reason
reads as an app bug); `findOnPath` stopped being duplicated in `codex.ts`
and `gemini.ts`; `stage-core.mjs` gained `--help`, printed BEFORE the
`rmSync` that opens the run (anyone typing `--help` out of reflex used to
lose the stage and still not know the flags); the sidebar's session row no
longer promises a click in the gap between the clickable area and the "✕";
and `bridge watch` removes its `SIGINT`/`SIGTERM` handlers on the
exception path of closing too.

### Changed

**`git ls-files --stage` only when there could be a gitlink** — filter
driver enumeration runs per repository on every poller cycle, and it read
the WHOLE index just to find `160000`-mode lines. The call is now skipped
when all **three** conditions hold together: there's no `.gitmodules`, the
last successful read of that `cwd` found no gitlink, and the index file
still has the same signature (`size:mtimeMs:ctimeMs`) as back then — the
third one is what makes a later `git submodule add` get seen again.
Fail-closed on any read error: a signature that can't be read never
authorizes skipping. Measured on a synthetic repository of 20,000 files:
full enumeration dropped **36%**.

**An unreadable `config.json` became a warning** — broken JSON (or valid
JSON whose top level isn't an object: `[]`, `"pwsh"`, `null`, `42`) used to
silently fall back to `{}`, and the owner's configuration "vanished" with
no trace of where to look. The profile now carries the reason, and the
core writes it as a `warn` to `core.log` as soon as the logger exists — it
can't be used inside the profile-loading step, because it's the profile
that says where the log lives.

**`pty.exit` stays on the protocol surface, documented** — the event
looked redundant with `session.exited`, but it has a consumer (the UI's
reducer) and says something different: `session.exited` is SESSION state
(an already removed session emits nothing), `pty.exit` is the raw fact of
the process, with the `exitCode` — which is what `bridge watch --events
pty` observes. The rationale is written in `protocol.ts`, where the doubt
used to be.

## [0.8.0] — 2026-09-05 — Security

Security phase requested by the owner ("do a security and vulnerability
phase on the app, autonomously, self-fixing whatever you find"): an audit
against an explicit threat model (A1 hostile terminal output, A2 local
process from the same user, A3 hostile repository, A4 hook payload, A5
dependencies and installer), autonomous fixes for everything Critical/High/
Medium plus whatever was cheap among the Lows, and **five rounds** of
adversarial re-review attempting to bypass each fix. 21 findings: 17 fixed,
1 partial (Electron fuses, no new dependency), 4 accepted with a reason.
The audit, the five rounds' report, and the ledger stay outside the public
repository.

### Fixed

**Authentication and HTTP surface (BR-01)** — route classification became
**default-deny** and started looking at the union of the RAW path with the
normalized one: `GET /%2Fapi/state` used to reach the handler as public. A
path with `%2F`, `%5C`, or `\` is now **400** before any decision. And,
after the re-review, an absolute-form request target (`GET
http://127.0.0.1:<port>/api/state HTTP/1.1`, which Node hands over raw) is
also **400**: `find-my-way` normalized and routed it while the guard saw
"public" in both classifications — measured with a `net.Socket` writing
the request lines by hand.

**Traversal and id validation (BR-02, BR-02b, BR-06, BR-09)** — `POST
/hooks/:sessionId/:event` with `../` in the id or the event wrote a file
outside the profile's log folder; id and event now go through a regex on
input, the dump is built with `basename()` and confined by prefix, and
every file has an 8 MB cap. A hook's `session_id` only becomes `claude
--resume <id>` if it matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (nothing
starting with `-`), and a task/worktree's `base` requires ref shape with
`max(255)` — the 50,000 characters that used to cause a 500
`ENAMETOOLONG` are now 400.

**Git and a hostile repository (BR-03, BR-04, BR-18)** — every git command
now runs with `-c core.fsmonitor=false -c core.useBuiltinFSMonitor=false -c
core.pager=cat`, and the passive reads (poller, repo detection) with
`core.hooksPath` pointed at an empty profile folder, `--ignore-submodules=all`,
and `--` before the refs: a repository from an unknown source was
executing a command every 15 s, with no click at all. `filter.*` drivers
are **not** neutralized (that would break `git-crypt`/`nbstripout`/`git-lfs`)
— they became a **trust model** instead, described below under "Changed".
A hostile branch name (`main; whoami`) can no longer turn into a PTY
command through "View diff": `isSafeRef` in `@bridge/shared`, `diffCommand`
quoting with single quotes, and the UI stopping before the POST.

**Token and profile (BR-07)** — `mode: 0o600` on `instance.json` is a no-op
on Windows (measured: no ACE at all), so the file carrying the token
inherited the folder's permission. The core now runs `icacls
/inheritance:r /grant:r "<DOMAIN\user>:(R,W)"` right after writing it. The
failure is **no longer** silent (it used to be fail-open with a `warn` in a
log nobody opens): it becomes an `error`, `instanceAclApplied: false` in
the state, and a banner in the UI.

**Hooks, quota, and DoS (BR-08, BR-11, BR-12, BR-15)** — the status line
payload's `transcript_path` read an entire arbitrary file
(`~/.ssh/id_ed25519`, a 65 MB sparse file, a UNC path); it now requires an
absolute path with a drive letter and a `.jsonl` extension, gives up above
64 MB, and reads only the last 1 MB. The WS has a `maxPayload` of 1 MiB
(was 100 MB) and a cap of 32 connections; `resize` between 1 and 1000; a
notification truncated at 2000 characters, with 10/s per session and
periodic pruning that now also reaches old **unread** ones (and turned
O(n) — the previous `UPDATE` took 41 s over 20,000 rows, sitting in the
path of an OSC printed in the terminal).

**Electron and the installer (BR-13, BR-14, BR-16, BR-17)** — `$INSTDIR`
is no longer interpolated raw into the NSIS PowerShell line (single quotes
doubled via `WordReplace`); `openPath` uses `lstat` and no longer follows a
junction/symlink; `app.enableSandbox()` runs before `whenReady`.

**Dependencies (BR-05)** — `@fastify/static` **8.3.0 → 10.1.3**, closing
four advisories (one High) for route-guard bypass and non-canonical-path
traversal. `npm audit` (with and without `--omit=dev`): **0
vulnerabilities**.

**`mergeIntoBase` only looked at the root** (carried over from round 3) —
git's `--worktree` scope is per worktree, and a driver declared in the
task worktree's `config.worktree` is invisible to enumeration done at the
root. Merging now requires trust in **both** paths; `canRemoveWorktree`
already did.

**Four low-severity leftovers from the final re-review** — (1) the
poller's tick used to fire one `refreshRepoFilters` per repo all at once;
it became the same pool of 4 that `start()` uses, with `.catch` (with no
`await`, a rejection there would be an `unhandledRejection`). (2)
`listFilterDrivers` gained **in-flight dedupe**: the cache used to be
written only at the end of enumeration, so two concurrent calls for the
same repo would sweep the submodules twice — now the second one waits on
the same promise, and an invalidation midway stops the stale read from
overwriting it. (3) **Realpath containment** for submodules: besides the
declared path, the submodule's folder **and** the gitdir git resolves for
it (`rev-parse --absolute-git-dir`) both now need to sit under the
repository's `realpath` — closing the junction, and the `.git` that's a
file pointing `gitdir: <path outside>` (measured: without this, the
outside repository's driver counted). (4) `isSafeSubmodulePath` at a
**drive root**: `resolve('C:\')` already ends in `\`, and the raw `base +
sep` used to fail every submodule of a repository opened there.

**Suite hygiene** — test files that created a folder under `%TEMP%` and
never deleted it (11 in the core, 3 in the shell) now use a `tmpDir()`
that registers itself for removal at the end of the file, and the core's
vitest gained a `globalTeardown`: at the end of the run, everything it
created disappears (prefixes `bridge-`, `bridge `, `t5-`, `t5f-`), on top
of the one-hour sweep that already existed. The suite used to leave over a
thousand folders on the owner's machine.

### Changed

- **A trust model for git filters.** A repository that declares a filter
  driver (`clean`/`smudge`) and hasn't been trusted yet: the sidebar shows
  **⚠ filters** instead of `+N ~M`, the core runs no git command that
  touches content there, and "New task", "Merge into base", and "Remove
  worktree" all answer **409 `filters-untrusted`**. Trusting is an item in
  the workspace "⋯" menu, belongs to the **repository** (applies to its
  worktrees, saved in `bridge.db`, survives a restart), and never comes on
  by default. Detection enumerates `--local` and `--worktree` with
  `--includes`, at the root and in every worktree, and descends into
  submodules through `.gitmodules` (read with `-z`) **and** through the
  index's gitlinks, refusing a declared path that's absolute, empty, has
  `..`, or sits outside the repository; an enumeration failure counts as
  "has a driver". README: "Git filters and trust" section.
- **`--ignore-submodules=all` on every passive `status` read.** Accepted
  side effect: a submodule with uncommitted changes no longer counts
  toward the sidebar's `~M`.
- A request path with `%2F`, `%5C`, or `\`, and a request target outside
  origin form: **400** on any route.
- `POST /hooks/:sessionId/:event`: **400** when the id doesn't match
  `^[A-Za-z0-9_-]{1,64}$` or the event doesn't match `^[A-Za-z]{1,40}$`
  (every Claude Code event passes).
- `POST /api/sessions`: `resume` now requires
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; `initialCommand` refuses control
  characters and shell metacharacters.
- `POST /api/tasks` and `PATCH /api/workspaces/:id/worktree`: `base`
  requires ref shape and `max(255)`.
- `POST /api/sessions/:id/resize` and the WS `resize` message: `cols`/`rows`
  between **1 and 1000**.
- `POST /api/sessions/:id/notify`: `text` with a **max of 2000** (the CLI
  truncates client-side and warns; the raw API answers 400).
- `/ws`: `maxPayload` of **1 MiB** and at most **32** connections (the
  33rd closes with 1013).
- `GET /` and assets now ship with `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- `diffCommand(base)` (`@bridge/shared`) **throws** on an invalid ref and
  quotes the ref in single quotes.
- The token's transport **did not** change: it's still in `Authorization:
  Bearer` for `/api` and `/ws`, and in `?token=` for `/ws` and `/hooks`. No
  client (UI, shell, CLI, shim) needed to change.
- Versions bumped to **0.8.0** (root, 5 packages,
  `packages/shell/stage/core.package.json`, and the `package-lock.json`
  entries).

### Added

- **`SECURITY.md`** at the root (linked from the README): a summarized
  threat model (A1–A5, what's out of scope, "same user = same trust"), the
  protections in place, the **accepted risks** with each one's reason, the
  manual checks still missing, and how to report a flaw.
- **`PATCH /api/repos/:id` `{ trustFilters: boolean }`** and **`GET
  /api/repos/:id/filters`** → `{ drivers: [...] }` (the second one merges
  the root and every worktree of the repository). `Repo.trustFilters`
  (SQLite, idempotent migration, preserved on `upsert`) and
  `Repo.hasFilterDrivers` (measured in memory when the repo is adopted, on
  every poller pass, and at the core's `start()`, exposed by the snapshot)
  in `@bridge/shared`.
- **Persistent ACL banner**: when `instance.json`'s `icacls` fails, the UI
  shows "Could not restrict permissions on instance.json — another user on
  this machine can read the token" in the footer, with a ✕ to dismiss. It's
  not a 4-second status line: it disappears on its own once a later core
  manages to apply the ACL.
- Security tests: `packages/core/test/security.test.ts`,
  `security-round2..5.test.ts`, `security-task3.test.ts`, and
  `temp-hygiene.test.ts`; `packages/shell/test/shell-security.test.ts`; new
  blocks in `git`, `quota`, `notifications`, `profile`, `api-static`, `db`,
  `api-tasks` (core), `shared/test/git.test.ts`,
  `ui/test/{actions,sidebar-model,menu}.test.ts`, and `cli/test/cli.test.ts`.
  Every fix has a test that **reproduces the attack** and, wherever there
  was a legitimate flow on the same path, a **CONTROL** test proving it
  still passes.

## [0.7.0] — 2026-09-04 — auto-start with Windows and `bridge resume`

Two Phase 5 features the owner asked for: Bridge can now start with
Windows (optionally with no window, just the tray) and the CLI got
`bridge resume` — resuming a pane's Claude Code conversation by hand,
without depending on startup's automatic resume. Codex/Gemini stay out by
the owner's decision.

### Added
- **Start Bridge with Windows** — Settings (`Ctrl+,`) → **System** section
  (the seventh one), with two checkboxes: "Start Bridge with Windows" and
  the sub-option "Start minimized in the tray". Turning it on writes an
  entry to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` pointing at
  `Bridge.exe`; the sub-option adds `--hidden`. Both come **off**, and
  Bridge never turns itself on.
- **`--hidden`**: with the argument, `main.ts` creates the window with
  `show: false` — the core and the sessions come up, but nothing appears
  until you click the tray icon, its "Show" menu item, click a
  notification, or launch a second instance. Without the argument, boot is
  the usual one.
- **`packages/shell/src/loginItem.ts`** (new, a pure and tested part):
  `loginItemArgs`, `shouldStartHidden`, `readLoginItem`, `loginItemSupport`,
  `parseLoginItemInput`. The state **does not** live in `config.json` — the
  registry is what's authoritative, and it can be changed from outside
  (Task Manager › Startup apps); every read goes to Windows and every
  write rereads from there before answering. Two origin-validated IPC
  channels (`bridge:getLoginItem` / `bridge:setLoginItem`, with
  `assertFromUi`) and `window.bridge.loginItem.get()/set({enabled,
  startMinimized})`.
- **`bridge resume [paneId]`** in the CLI: brings back up, in the pane, the
  agent that was running there, with `claude --resume <conversation>`.
  With no argument it uses the current session's pane (`BRIDGE_SESSION` →
  the `X-Bridge-Session` header) or, outside a Bridge session, the focused
  pane. `--json` returns the created session plus `resumedFrom` (the
  resumed conversation's id).
- **`POST /api/panes/:id/resume`** in the core: `:id` is a paneId **or**
  the literal `current` (resolved via the `X-Bridge-Session` header, or in
  its absence, the focused session). Creates the session with `agent =
  pane.lastAgent` and `resume = pane.lastAgentSessionId`, and answers
  `201` with the session + `resumedFrom`. Errors: `404 pane-not-found` (no
  such pane, or no current pane), `409 pane-busy` ("this pane already has
  an agent"), `422 nothing-to-resume` ("This pane has no conversation to
  resume"), and the launch's own codes (`agent-unavailable`,
  `cwd-missing`). `lastEndedBy` does **not** factor into the decision:
  whoever typed the command is asking for the conversation back by hand.
- **A live shell yields its pane to the resumed agent**:
  `CreateSessionInput.replaceLiveShell` (opt-in, today with a single
  caller — the resume route). It's the command's normal case, because with
  `restore.resumeAgents` off (or with startup's resume failing) the pane
  comes back as a **shell**, and it's from inside it that the person types
  `bridge resume`. A live **agent** is still a `PaneBusyError`/409, with or
  without the flag.
- Tests: `packages/shell/test/login-item.test.ts` (new, 17),
  `packages/core/test/api-resume.test.ts` (new, 14 — includes the
  end-to-end agent → app closes → shell on restart → resume),
  `packages/ui/test/settings-model.test.ts` (+6), and
  `packages/cli/test/cli.test.ts` (+6, against a real core).

### Fixed
- **A pane that came back as a shell forgot which conversation it was.**
  Through 0.6.0, `setPaneLast(paneId, 'shell')` erased `lastAgent` and
  `lastAgentSessionId` ("this isn't Claude anymore"). Since restore with
  `resumeAgents` off (or with a failed resume) brings up exactly a shell in
  the pane, the conversation's memory died right there, and `bridge resume`
  answered `422 nothing-to-resume` in the most common scenario. The shell
  now **preserves** both fields (only `lastKind` becomes `'shell'` and
  `lastEndedBy` is cleared), and the resume route no longer looks at
  `lastKind`.
- **Reading auto-start through Electron.** `getLoginItemSettings().openAtLogin`
  doesn't answer "starts with Windows" — it answers "does an entry exist
  that matches the executable **and this query's `args`**", and
  `launchItems[].args` always comes back empty (Electron returns
  Chromium's `GetArgs()`, which lists only positional arguments and drops
  the `--hidden` switch). Measured on Electron 44 with a real registry
  entry. The shell makes **two** queries: `executableWillLaunchAtLogin`
  answers the "on" state, and the `openAtLogin` from the query made
  **with** `--hidden` answers "minimized". `setLoginItemSettings` runs
  **without** the `name` option — passing `name: 'Bridge'` writes a
  pretty name into `Run` and blinds the read (measured: `openAtLogin`
  false on every query), so the value's name is the `APP_ID`.

### Changed
- **`layout.setPaneLast`**: with `kind === 'shell'`, `lastAgent`/
  `lastAgentSessionId` are preserved (see "Fixed"). Automatic restore
  **doesn't change**: `panesToRestore` still decides by `lastKind ===
  'agent'` **and** `lastEndedBy === 'app'`, and a shell still clears both.
  A new agent still doesn't inherit an id.
- **`createSession`** only throws `PaneBusyError` when the pane's live
  session isn't a replaceable shell (`replaceLiveShell`), and the
  replacement happens **after** every validation (the adapter's
  `available()` and the `cwd`): a refused request leaves the terminal the
  person has in hand exactly where it was. Disposal is still the existing
  `disposeSession(existing.id, { removePane: false })` — a single
  `pty.kill`, and the pane doesn't leave the layout.
- **Running `bridge resume` from inside the pane being resumed**: the
  "Resuming the conversation …" line (or `--json`) may not show up,
  because the shell hosting the CLI dies along with it. Documented in the
  CLI, the README, and the tests; the visible outcome is the pane turning
  into the agent, and from another pane the output comes out normal.
- README gained "Start with Windows", the **System** row in the dialog's
  table, the `bridge resume [paneId]` row in the CLI table, and the
  "Resume the conversation" paragraph. Two gaps inherited from 0.6.0 got
  closed at the same time: the **Sessions** section in the dialog's table,
  and the `restore.resumeAgents` field in the table of fields `PATCH
  /api/config` accepts (`restore` is merged key by key like `toast` and
  `terminal`).
- **e2e**: the settings scenario used to check for **6** sections in the
  dialog, and the **System** section made it seven — the assertion was
  updated in `packages/shell/test/e2e.spec.ts`. It was the only failing
  test in the suite at 0.7.0's close.
- Versions bumped to **0.7.0** (root, 5 packages,
  `packages/shell/stage/core.package.json`, and the 7
  `package-lock.json` entries).

## [0.6.0] — 2026-09-04 — resuming Claude Code on reopen

The symptom the owner reported on 0.5.0: closing Bridge with a Claude Code
open and reopening it brought back a **shell** with the "previous session
was Claude Code" hint, and `Ctrl+Shift+C` on that pane would split the
screen — two terminals where there used to be one Claude. Now the pane
comes back with the **same conversation**, the way cmux does.

### Added
- **Automatic resume.** A pane that had a Claude Code **alive when the app
  closed** comes back with `claude --resume <id>`, in the conversation it
  was in. A pane whose agent the **user** ended (`/exit`, ✕, closing the
  pane, `DELETE /api/sessions/:id`) comes back as a shell with the usual
  hint — resuming what someone closed on purpose would be resurrecting a
  dead conversation.
- **Conversation id.** Every Claude Code hook carries its own
  `session_id`; the core saves it in `Session.agentSessionId` (memory) and
  `Pane.lastAgentSessionId` (SQLite, new `last_agent_session_id` and
  `last_ended_by` columns, with an idempotent migration guarded by
  `PRAGMA table_info`). The write is a no-op when the value doesn't
  change, so there's **one** `layout.changed` per session — not one per
  tool used.
- **Who ended it.** `Pane.lastEndedBy`: `'user'` when the session exits
  with the core still up (one `session.exited` listener covers every path
  at once), `'app'` when the core's `stop()` marks the live agent panes
  **before** killing them, with a `stopping` lock so each killed PTY's
  `session.exited` doesn't stamp `'user'` on top.
- **`POST /api/sessions` accepts `resume?: string`** (1–200 chars), and
  Claude's adapter puts `--resume <id>` right after `--settings`. With no
  saved id there's **no** fallback to `--continue` (ambiguous with two
  Claudes in the same folder): it brings up a clean Claude, never a shell.
- **Settings → Sessions** (new section, the sixth): "On reopen, resume
  Claude Code sessions automatically" — `restore.resumeAgents` in `GET`/
  `PATCH /api/config` and in `config.json`, **on** by default (the owner
  confirmed that's what cmux does). Off, every pane comes back as a shell
  with the hint.
- **Resume banner** at the top of the restored xterm: "resuming the
  previous Claude Code session · 9f1a2b3c" (the id's first 8 characters,
  the same prefix `claude --resume` lists). A pane that comes back as a
  shell keeps the old banner — the text is chosen per pane, not per
  restore.
- **A failed resume doesn't leave an orphaned pane**: a 4xx/5xx from the
  `POST` (a binary off the PATH, a cwd that's gone) falls back to a shell
  with the old hint, and the footer reports the reason — "Couldn't resume
  Claude Code: …". A 409 for the pane this very restore is reopening stays
  silent (R9).
- e2e: **scenario 7**, the only one in the file that brings up a **real
  Claude Code** — a workspace with "Open a Claude Code" checked, the trust
  dialog accepted (`ArrowDown` + `Enter`), waiting for `agentSessionId` to
  arrive via the `SessionStart` hook, a graceful `app.close()`,
  relaunching on the same profile, and demanding a `claude` pane (not
  `shell`) with the resume banner and the right id prefix in the xterm.
  7/7 across two consecutive runs.

### Fixed
- **`Ctrl+Shift+C` turning into two terminals** on reopen. The cause
  wasn't the shortcut (it splits when the pane has a live session, and
  that's still true — a test locks the behavior in): it was the pane
  coming back as a shell, which pushed the owner to hit the shortcut to
  get Claude back. With the pane coming back as Claude, there's nothing
  left to hit.

### Changed
- `panesToRestore` now returns `{ paneId, hint, resume? }` — `resume` only
  when `lastKind === 'agent'` **and** `lastEndedBy === 'app'` **and**
  `restore.resumeAgents`; `bannerFor` and the pending hints queue now
  carry the banner's **text** (a `session.id → banner` map), not just the
  id.
- Startup restore now **waits on `GET /api/config`** before deciding: the
  config doesn't come in `hello`, and without the wait, an owner who had
  turned resume off would see the Claudes come up the same way whenever
  the response was late.
- Versions bumped to **0.6.0** (root, 5 packages,
  `packages/shell/stage/core.package.json`, and the 7
  `package-lock.json` entries).

## [0.5.0] — 2026-09-04 — owner's batch: icon, terminal font, panes, sidebar, settings

The six suggestions the owner made during the installed app's first real
run, in a single batch.

### Added
- **The app's own icon**: `packages/shell/build/icon.ico` (16, 24, 32, 48,
  64, 128, and 256 px, PNG-in-ICO) with the `BridgeMark` over a rounded
  `--bg-elevated` square, pointed to in `electron-builder.yml`
  (`win.icon`) — the installer and `Bridge.exe` stopped shipping with
  Electron's default icon.
- `packages/shell/scripts/make-icon.mjs` generates the `.ico` and the 256
  PNG with no new dependency: a distance-to-segment rasterizer
  (`src/iconMark.ts`) + PNG via `zlib` (`src/png.ts`), deterministic and
  idempotent. `src/tray.ts` now draws the SAME mark (the diamond
  placeholder is gone) and `packages/ui/index.html` got the equivalent
  inline SVG favicon.
- **Close pane** (`pane.close`, `Ctrl+Shift+X`): closes an empty, exited,
  or live pane via `DELETE /api/panes/:id` — which ends the session and,
  if it was the tab's last pane, closes the tab too. Three doors: the
  shortcut, the pane header's **✕** (on hover, like the tab's), and the
  empty-pane button. A live **agent** session asks for confirmation; a
  live shell closes right away. Focus goes to the neighbor (`GET
  /api/panes/:id/neighbor`) or to the tab's first pane.
- **Empty pane with buttons** "Open shell", "Open Claude Code", and "Close
  pane" below the key hints (`Enter` still opens the shell), and the
  **tab bar hints became buttons**: clicking fires the same action as the
  shortcut, including the new `Ctrl Shift X close pane` hint.
- **Pinnable and collapsible sidebar groups**: clicking the title
  collapses/expands (with a workspace count and the collapsed group's
  **worst-state ring**, so it doesn't hide a `stuck`); the hover "⋯" has
  "Pin to top"/"Unpin". Pinned ones come first, in the order they were
  pinned. A local preference (`localStorage`, key
  `bridge.sidebar.groups`), with defensive reading — a corrupted value
  becomes an empty preference. The `sidebar/PopoverMenu.tsx` component was
  extracted from `WorkspaceMenu` and reused by `GroupHeader`.
- **Settings** (spec §6): `GET /api/config` and `PATCH /api/config` (a
  validated subset, deep merge on `toast`/`terminal`, atomic tmp+rename
  write, in-memory application, and the `config.changed { config }` event
  on `/ws`). `shell` applies to new sessions, `gitPollSeconds` reschedules
  the poller in flight, `toast` applies to the next notification,
  `terminal` applies to terminals already open.
- **Settings dialog** (`Ctrl+,`, the gear in the sidebar header,
  "Settings…" in the "⋯" menu): Terminal section (font with mono
  suggestions, size 8–24, default shell, a three-line preview with
  box-drawing and blocks), Notifications, Git, Shortcuts (a read-only
  table of the 19 actions × keys + "Open profile folder"), and Appearance
  ("Theme: Dark", disabled). No OK or Cancel: every field sends its own
  `PATCH` and the config that comes back already applies; "Restore
  defaults" per section; a 400 from the core becomes a banner inside the
  dialog.
- `BridgeConfig` gained `profileDir` (the profile folder's absolute path),
  **read-only** and **never written**: `config.json` holds the new
  `StoredConfig` type, and it's the compiler that stops the derived field
  from ending up in the file.
- **New dependency (the batch's only one, authorized by the owner)**:
  `@xterm/addon-unicode11@^0.8.0` in `@bridge/ui`, loaded with
  `term.unicode.activeVersion = '11'` — without it, xterm measured the
  quota-advisor status line's emoji (`🟢`, `🧭`) against the Unicode 6
  table, at width 1, and they overlapped the next letter.
- e2e: two new scenarios (5 — `Ctrl+Shift+T` opens the tab, `Ctrl+Shift+X`
  closes the empty pane and the tab disappears with it; 6 — `Ctrl+,` opens
  the dialog, the font size goes to 16, the open xterm re-renders, and
  `GET /api/config` confirms it).

### Fixed
- **Claude Code's logo and status line broken inside the xterm** (the
  symptom the owner reported). Cause: the embedded
  `geist-mono-variable.woff2` is a 225-codepoint subset, with no
  box-drawing, blocks, braille, or arrows; Chromium resolves fonts **per
  glyph**, so letters came from Geist (7.20 px advance at 12 px) and every
  symbol fell to the next font with its own advance (7.03 px) — the font
  that set the cell's measurement wasn't the one drawing the symbols, and
  the drift reached ~27 px on a 160-column line. The default stack became
  `'Cascadia Mono', Consolas, 'Geist Mono', ui-monospace, monospace`
  (Cascadia Mono comes from the Windows Terminal package and is seen by
  DirectWrite: box-drawing 128/128, blocks 32/32, braille 256/256, all at
  the `W`'s advance).
- Terminal `lineHeight` from 1.5 to **1.0**
  (`design/tokens.json → font.lineTerminal`): at 1.5 the Claude logo's
  three rows never touched and it came out striped.
- `Unicode11Addon` requires `allowProposedApi: true` on `XTerm`; without
  the flag it threw on mount and the **whole renderer went blank** (a Task
  4 finding, fixed before the run ended).
- `mergeConfig` did a **shallow copy** of `toast`: `{ "toast": { "enabled":
  false } }` put back the default `quietWhenFocused`. The merge became key
  by key on `toast` and `terminal`, both in the startup `config.json` and
  in `PATCH`.
- A race between `pane.close` and an **in-flight** session: a pane with
  "Open Claude Code"'s `POST /api/sessions` still pending stayed `empty`
  to the UI, and the ✕ killed the newborn agent with no question asked.
  The in-flight action lock now refuses the close ("Wait for the session
  to open"), the pane's buttons become `disabled` during that window, and
  the state is reread right before the `DELETE`.
- A race between `PATCH` responses on the dialog's numeric fields (typing
  `1` then `4` could leave `1` in effect): a **per-field** send counter,
  and any response that isn't the latest gets discarded. A refused
  `PATCH` now returns the draft to the value the server confirmed.
- "Open keybindings.json" opened nothing: it sent the literal
  `%APPDATA%\bridge\keybindings.json` to `openPath`, which doesn't expand
  environment variables and (per Phase 3's R12) only accepts an
  **existing folder**. It became "Open profile folder", with
  `profileDir`'s absolute path next to it; without Electron, the path
  appears as selectable text in place of the button.
- README: the "the unicode11 addon isn't in the lockfile" note became
  stale once the owner authorized the install; and the profile path in
  the "Settings" section had lost its backslash (`%APPDATA%ridge`).

### Changed
- The sidebar's **"Solto"** group became **"No repository"**
  (`LOOSE_GROUP_NAME`) — the owner found the previous name opaque, and
  this one is the literal criterion.
- `config.json`'s defaults stopped existing in duplicate: `DEFAULT_STORED_CONFIG`
  was born in `packages/shared/src/model.ts`, and the core's
  `DEFAULT_CONFIG` and the UI's `SETTINGS_DEFAULTS`/`TERMINAL_DEFAULTS`
  now **derive** from it. They used to be three hand-written copies, and
  changing a default on one side left the dialog's "Restore defaults"
  silently putting back the old value.
- `Terminal` exposes `fontFamily`/`fontSize` as props (the dialog binds
  them to `config.terminal`) and swaps the xterm font **live**,
  remeasuring the grid and only notifying ConPTY when `cols`/`rows`
  actually change.
- Versions bumped to **0.5.0** (root, 5 packages,
  `packages/shell/stage/core.package.json`, and `package-lock.json`).

## [0.4.2] — 2026-09-04 — fix: bringing the sidebar back

### Fixed
- With the sidebar hidden (☰ menu → "Hide sidebar" or `Ctrl+Shift+S`) there
  was nothing visible to bring it back — only the shortcut, which the owner
  had no way to discover. The tab bar now gets a ☰ button in the left
  corner while the sidebar is hidden (tooltip with the shortcut).

## [0.4.1] — 2026-09-04 — fix: core startup on a fresh install

### Fixed
- The shell only waited 10 s for the core's `instance.json`; on a fresh
  install on another disk (a cold disk, Defender scanning the native
  modules) the core took 55 s to start, and the app showed "The core
  didn't start" while the core was still loading. The shell now waits up
  to 90 s **while the child is alive**, and writes `still waiting for the
  core (N s)` to `shell.log` every 10 s.
- On giving up, the shell now takes down the core's whole **tree**
  (`taskkill /t /f`), not just the direct process: the surviving core used
  to write `instance.json` after the app had already closed.

## [0.4.0] — 2026-09-04 — Phase 4: the `bridge` CLI

### Added
- **The `bridge` CLI** (`packages/cli`, a single esbuild CJS bundle, zero
  runtime dependencies): `notify`, `list`, `focus`, `new`, `task
  new|merge|rm`, `send`, `status`, with `--json` on all of them. It
  discovers the instance via `BRIDGE_PORT`/`BRIDGE_TOKEN` (present in
  every Bridge pane's environment) or via the profile's `instance.json`,
  and never prints or accepts a token.
- Packaging: `resources/cli/{bridge.cjs,bridge.cmd}` in the installed app,
  and `packages/shell/installer.nsh` puts that folder on the user's PATH
  at install time (and removes it at uninstall) via
  `[Environment]::SetEnvironmentVariable(..., 'User')`. The root's `npm run
  build` now builds the CLI before the shell.
- Real screenshots in `design/screenshots/task5-fase4-cli.png`.

### Fixed (Phase 4's final fix wave, post whole-branch review)

- **Window with no application menu** — Electron's default menu gave
  `Ctrl+W` (close window/app), `Ctrl+R`, and `Ctrl+Shift+I` priority over
  Bridge's shortcuts of the same name. `Menu.setApplicationMenu(null)`,
  zoom locked at 1× (window and views), and devtools only with
  `BRIDGE_DEV=1`, via `F12`.
- **`POST /api/sessions/:id/notify` and `/input` for a nonexistent session
  → `404 { code: 'session-not-found' }`** (they used to answer `200 {}`):
  `bridge notify` said "notified" with no notification at all, and `bridge
  send` said "sent" to a PTY that doesn't exist. The `/hooks/*` routes
  stay lenient.
- **`installer.nsh` preserves the PATH's type** —
  `[Environment]::SetEnvironmentVariable(…, 'User')` writes `REG_SZ` when
  the value has no `%`, and switching `HKCU\Environment\Path`'s type would
  stop a user's own `%JAVA_HOME%\bin` from expanding. It now reads raw
  (`GetValue(..., DoNotExpandEnvironmentNames)`), writes `-Type
  ExpandString`, and notifies Windows with `WM_SETTINGCHANGE`
  (`SendMessageTimeout`, 5 s, ABORTIFHUNG). Uninstall removes only Bridge's
  entry, with the same care. **Still never actually run.**
- **`bridge.cmd` honors `BRIDGE_NODE`** and, with no Node, says "Bridge
  needs Node.js 22+ on the PATH (or BRIDGE_NODE=&lt;path&gt;)" instead of
  cmd.exe's `'node' is not recognized`.
- **`bridge --help`, `bridge --version`, and `bridge` with no argument**
  now exit via stdout with code 0 **without talking to the core** —
  previously, with Bridge closed, the help turned into "Bridge isn't
  open".
- README: `setx` (which truncates at 1024 chars and writes `REG_SZ`) left
  the manual PATH fallback, replaced by `Set-ItemProperty … -Type
  ExpandString` at the user scope; the `X-Bridge-Session` paragraph got its
  missing accents back.
- `Client.probe` (a dead probe from Task 1) removed from the CLI.

### Fixed (hygiene inherited from Phase 3 and 4 reviews)
- **`/api/*` refuses an `Origin` outside the loopback with 403** (Phase
  3's R12), the same rule that already applied to `/ws`. A request with no
  `Origin` (CLI, shim, Electron main) still passes, and static assets stay
  without a bearer.
- **`bridge:openPath` requires an existing folder**
  (`statSync(...).isDirectory()`) before `shell.openPath` (Phase 3's R12):
  "Open in Explorer" is the channel's only reason to exist, and opening any
  file through its associated program would be execution.
- **`Core.resolveRepo` re-checks `hasCommits` on disk when a `repoId` comes
  in**: a `repos` row saved by an earlier version (before R7) could point
  at a repo with no commits at all and slip past the `no-commits` refusal.
- `CLI_VERSION` with a `typeof` guard: `tsx packages/cli/src/index.ts` runs
  without esbuild's `define` (prints `dev`) instead of blowing up with a
  `ReferenceError`.
- Stale comments and titles: `initialCommand` in `schemas.ts` (it's "after
  the PTY's first byte, floor 200 ms and cap 3 s", not "200 ms after
  spawn"); the conflict test's title in `git.test.ts` (`code`, not
  `detail`); a note in `theme.css` forbidding `transform`/`filter`/
  `will-change` on the sidebar tree, which would break the "⋯" menu's
  `position: fixed`.

## [0.3.0] — 2026-09-03 — Phase 3: worktrees and git in the sidebar

### Added
- `packages/core/src/git.ts`: a git service on top of the `git` BINARY
  (`execFile`, `windowsHide`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, a 20 s
  timeout) — `detectRepo`, `ensureExclude`, `createWorktree`, `status`,
  `mergeIntoBase`, `canRemoveWorktree`, `removeWorktree`,
  `removeWorktreeForce`, `diffCommand`. Typed errors (`GitError` with
  `code`/`detail`/`stderr`).
- `packages/shared/src/git.ts`: `normalizeTaskName` (lowercase,
  `[a-z0-9._-]`, spaces become `-`, 1–60 chars) — the SAME function in the
  core and the UI.
- `packages/core/src/gitPoller.ts`: per-workspace worktree status every
  `gitPollSeconds` (default 15) **only while there's a WS client**; emits
  `workspace.git` only when `ahead`/`dirty`/`branch` change; an immediate
  `refresh(id)` (route, the `Stop` hook, and task creation).
- Routes: `GET /api/repos`, `GET /api/git/detect?cwd=`, `POST
  /api/tasks`, `GET /api/workspaces/:id/git`, `POST
  /api/workspaces/:id/git/refresh` (204), `POST
  /api/workspaces/:id/merge` (`ff-only`|`no-ff`), `DELETE
  /api/workspaces/:id/worktree` (204). `POST /api/sessions` accepts
  `initialCommand` (≤ 2000 chars, written to the PTY 200 ms after spawn).
- Protocol: the `workspace.git` event and `git: Record<workspaceId,
  GitStatus>` in the snapshot/`hello`.
- `Core.createWorkspace` detects the folder's repo (`repos` upserted by
  the MAIN worktree) and saves `repoId`, `branch`, and `worktree { base,
  path }`.
- UI: the **New task** dialog (`Ctrl+Shift+Alt+N` and the footer button)
  with a repo picker (from `GET /api/repos` + "Choose folder…"), a preview
  of the normalized branch, base, and "Start Claude Code"; `+N ~M` badges
  on the workspace row (`~M > 0` in amber, tooltip with the base); the "⋯"
  menu with **View diff · Merge into base · Remove worktree · Open in
  Explorer · Close workspace** (the three git ones only on a worktree
  workspace).
- Spec §10 refusals, with what's missing written into the status banner:
  `dirty-base` on merge, `dirty-worktree` and `not-merged` on removal
  (checked BEFORE killing the workspace's sessions), `exists` on a
  repeated name; a non-fast-forward `ff-only` comes back `code: 'not-ff'`
  and the UI offers a merge with a commit; a `no-ff` conflict runs `merge
  --abort` and comes back `code: 'conflict'`.
- e2e: a third Playwright `_electron` scenario in a temporary git repo —
  a task created through the dialog, badges `+0 ~0` → `~1` → `+1 ~0`, both
  removal refusals in the status banner, an ff-only merge, and removal
  (the folder and branch disappear).

### Fixed (final fix wave, post whole-branch review)
- **A merge no longer swaps out the user's checkout (R1)**: with the main
  repo on another branch, `mergeIntoBase` now refuses with `409 { code:
  'base-not-checked-out' }` ("The main repository is on `<head>`; check
  out `<base>` before merging") instead of running `git checkout`. A base
  checked out in ANOTHER worktree becomes `409 { code: 'base-in-use' }`
  with its path.
- **Error contract by `code` (R2)**: `not-ff` and `conflict` became real
  `GitErrorCode`s — `409 { code: 'not-ff' }` / `409 { code: 'conflict' }`.
  `detail` stopped being a marker (it's just human text now); the raw
  `stderr` stays in its own field. The UI decides by `code`.
- **Guessed base (R3)**: an ADOPTED worktree pulls the base from the
  branch's upstream, and failing that, from the main worktree's current
  branch, with `worktree.baseGuessed: true`. The tooltip, and the merge
  and removal confirmations, say "(guessed base)", and the menu gained
  **Set base…** (`PATCH /api/workspaces/:id/worktree`, which validates the
  ref).
- **Branch from disk (R4)**: the poller now saves to the workspace the
  branch the worktree currently has; the UI shows `git.branch`; merge and
  removal read the current branch instead of the one saved at creation;
  "Merge into base" disappears on a detached checkout.
- **Poll cost (R5)**: `status()` became ONE call (`git status
  --porcelain=v2 --branch --untracked-files=all`); `+N` comes from `#
  branch.ab` when the upstream is the base itself, otherwise from the
  usual `rev-list`. The poller only runs with a WS client that RECEIVES
  `workspace.git` **and** a `POST /api/focus` with `windowFocused: true`
  within the last 60 s.
- **A refresh arriving mid-read (R6)**: a `refresh` arriving after an
  in-flight read has already started now chains a second one and returns
  its result — the `Stop` hook no longer gets the pre-commit number.
- **An empty body with `content-type: application/json` (item 7)**: the
  global parser now accepts `''` as `{}`; broken JSON is still 400.
- **The clipped "⋯" menu (R8)**: the popover became `position: fixed`,
  placed by `menuPlacement(triggerRect, menuSize, viewport)`, opens
  upward when it doesn't fit below, and closes on scroll/resize.
- **Pane restore (R9)**: now parallel (`Promise.allSettled`) with a lock
  per in-flight pane; a 409 for the pane itself stays silent, everything
  else becomes a status line.
- **Flakiness in the 2nd e2e (an open item since Phase 2)**: the sidebar
  sometimes came back from a relaunch with 1 session while the core had
  2 — startup's `GET /api/state` was answered IN THE MIDDLE of restore,
  and its response (a snapshot with one pane) arrived after the
  `session.created` events, overwriting the UI's session map. `fetchState`
  gained a sequence guard (only the newest request's response is
  applied), and restore now fires a convergence `fetchState` once it's
  done. 10 consecutive test runs, no failure.
- **`initialCommand` (R10)**: now written after the PTY's first `onData`
  (floor 200 ms, cap 3 s) instead of a blind 200 ms timer.
- **A repo with no commit (R7)**: `detectRepo` now returns `hasCommits`;
  `createWorkspace` doesn't register a repo with no commits (this
  machine's `%USERPROFILE%` no longer shows up in `GET /api/repos`), and
  `POST /api/tasks` refuses with `422 { code: 'no-commits' }`.
- **`%TEMP%` leak (R11)**: `log.close()` (drains the queue and closes) now
  runs in `core.stop()` before any `rmSync`, and the core's vitest
  `globalSetup` sweeps `%TEMP%\bridge-*` older than 1 h.
- **Minor items**: `diffCommand` moved to `@bridge/shared` (a single
  copy); `POST /api/sessions` now returns `code` and sends an unknown
  exception to 500; `GET /api/workspaces/:id/git` on a plain workspace
  becomes `404 { code: 'not-worktree' }`; a worktree whose folder
  disappeared becomes `GitStatus.error: 'missing'` (the row shows "(folder
  gone)", the menu only offers "Close workspace"); `normalizeTaskName`
  refuses a mid-string `..` and reserved Windows names.
- Phase 2 hygiene: `presentUnread(…, { force: true })` on
  `did-finish-load` (the title's "(n)" now survives a renderer reload); a
  type guard on `coreEvents`'s `startsWith('pty.')`; an **adopted** core
  now gets watched (`watchAdopted`: `GET /api/state` every 5 s, 3 failures
  = unexpected exit) and adoption now requires `GET /` = 200 when the
  shell was launched with `uiDir` (it no longer adopts a `dev:core` with
  no UI); a stub restored in `try/finally` in the `api-panes` 500 test.

## [0.2.0] — 2026-09-03 — Phase 2: Electron shell and terminals

### Added
- `packages/shared`: domain and protocol types shared by the core, UI, and
  shell; `DEFAULT_KEYBINDINGS` (17 actions).
- `packages/shell`: an Electron 44 app — a single window (no hardware
  acceleration), a `window.bridge` preload with origin-validated IPC, the
  core running as a **sidecar** (a child process of the system's Node; see
  ADR-002), a filtered WS client (`/ws?events=`), native toasts with
  leading-edge coalescing, a tray icon, a title badge, `flashFrame` on
  `needs-input`, a graceful shutdown (`POST /api/shutdown`) with
  `taskkill /t` as a fallback, and adopting an orphaned core on startup.
- Packaging: `npm run dist` → `Bridge Setup 0.2.0.exe` (NSIS x64) and
  `win-unpacked/`; the core built in JS and staged in `resources/core`
  with its own lockfile; the UI in `resources/ui`, served by the core.
- Core: a rotating file logger (`logs/core.log`), the routes `GET
  /api/panes/:id/neighbor`, `POST /api/panes/:id/ratio` (with
  `siblingPaneId`, the lowest common ancestor), `GET /api/keybindings`,
  `POST /api/shutdown`, `GET /api/notifications/latest-unread`;
  `last_kind/last_agent` per pane; `DELETE /api/tabs|workspaces/:id` kill
  the sessions; the UI's static server (`BRIDGE_UI_DIR`) with normalized-
  path auth.
- UI: tabs per workspace, a split tree with a draggable divider, one xterm
  per pane, an empty/exited pane with Enter reopening a shell, 17
  shortcuts (an autorepeat guard + an in-flight action lock), the New
  workspace dialog, the sidebar and notifications panel per the design
  (`design/`), a status banner, local Geist fonts, layout restore on the
  first connection with a banner on the restored session, only the active
  workspace mounted.
- Tests: Playwright `_electron` e2e (2 scenarios: the full flow, and
  relaunch/restore).

### Fixed (Phase 2's final wave)
- Electron's main process did synchronous I/O and `setTitle` on every PTY
  chunk; `shell.log` had no rotation.
- The divider ratio landed on the wrong split in a nested layout.
- An orphaned core (window force-killed) bricked the next launch.
- Every pane of every workspace stayed mounted.
- The core never shut down gracefully (log flush was lost).
- Auth bypass via `//api` and `%2F`; IPC origin checks by string prefix.

## [0.1.0] — 2026-09-03 — Phase 1: core and status

### Added
- `packages/core`: a Fastify server on `127.0.0.1` with a per-instance
  token; PTY sessions (node-pty/ConPTY); a per-session `--settings`
  pointing Claude Code's hooks and status line at the `bin/bridge-hook.cjs`
  shim; a state machine `idle → running → needs-input/done/stuck →
  exited`; the Claude Code adapter (Codex/Gemini as stubs); quota via
  quota-advisor; OSC 9/99/777; notifications with a toast policy; SQLite;
  an HTTP + WS API with backpressure; a fake agent for tests.
- `packages/ui` (provisional): a sidebar with a ring per session, one
  terminal per session, Web Notifications.
- Verified with a real Claude Code (two smoke tests) and a fix wave across
  two rounds after a whole-branch review.
