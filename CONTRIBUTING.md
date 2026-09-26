# Contributing to Bridge

Thanks for taking a look. Bridge is a one-person personal project, so the
best contribution is usually an **issue with a repro** before a big PR:
it's cheap for you and tells me whether the change fits the current
design.

The project's docs are in **English** — the full README is also available
in Portuguese at [README.pt-BR.md](README.pt-BR.md). Issues and PRs are
welcome in English or Portuguese.

**The interface is the exception since 0.13.0:** it speaks both pt-BR
*and* English, and no screen text lives inside a `.tsx` or `.ts` file
anymore — it all comes from a catalog of keys. See "How to add a string"
below.

## What you need

- **Windows 11** x64 — the app is Windows-native (PTY via ConPTY,
  registry, NSIS). There's no Linux/macOS build, and it's not a goal
  today.
- **Node.js 22+** on `PATH`.
- **Git**, with a real repository to exercise the worktree routes.
- Optional, for touching the adapter: **Claude Code** (`claude` on
  `PATH`).

## Running it

```
npm install                  # at the root — it's an npm workspaces monorepo

npm run dev:core             # just the core (Fastify + node-pty + SQLite) on 127.0.0.1:4560
npm run dev:ui               # Vite on 127.0.0.1:5173, proxying /api and /ws to the core
npm run dev:app              # the whole Electron app (builds the shell and starts Electron)
```

`dev:core` + `dev:ui` opens the UI in a browser tab: it's the fastest way
to work on the core or the UI. The instance token lives in
`%APPDATA%\bridge\instance.json`, and the start screen asks for it.

To avoid messing up your real profile while testing, point the profile at
a disposable folder:

```powershell
$env:BRIDGE_PROFILE_DIR = "$env:TEMP\bridge-dev"
```

## Testing

```
npm test                     # vitest across all packages
npm run typecheck            # tsc --noEmit across the five packages (TypeScript strict, ESM)
npm run build                # UI (Vite) + core, CLI, and shell (esbuild)
npm run e2e                  # Playwright + real Electron (16 scenarios)
npm run dist                 # build + stage the core's deps + electron-builder (NSIS x64)
```

One package at a time also works: `npm test -w @bridge/core`,
`npm run typecheck -w @bridge/ui`, and so on.

`npm run e2e` brings up **real Electron, core, and PTY**, and at the end
of each scenario checks that no process was left behind. **No script,
test, or agent kills a process by NAME** (`Stop-Process -Name`,
`taskkill /IM`): only by PID, and only a PID it created itself — killing
by name would take down the Bridge you have open, which shares the image
name of the one being tested. Only **one** scenario spins up a real Claude
Code (the `resume` one, which needs a real agent to prove the panel comes
back as an agent); the others that need one use a fake `claude.cmd` at
the front of the `PATH`, and the toast path is exercised through
`POST /api/sessions/:id/notify`, the same `Notifications.push` the adapter
uses. If you touch anything that changes the interface, run e2e before
opening the PR — it catches layout and restoration regressions vitest
doesn't see.

`npm run dist` needs the pair
`packages/shell/stage/core.package.json` + `core.package-lock.json` to
describe the core's runtime dependencies. After changing
`packages/core`'s `dependencies`, regenerate the pair:

```
npm run stage:refresh-lock -w @bridge/shell
```

## How the code is organized

| Package | What it is |
| --- | --- |
| `packages/core` | The server: PTY sessions, hooks, git/worktree, SQLite, HTTP/WS API. Runs on the system's Node. |
| `packages/shared` | Types, protocol, and the **message catalog** (`src/i18n/`). It's the only dependency shared between core and UI — no `node:` here. |
| `packages/ui` | React + xterm.js. Only draws what the core sends; every mutation is a route. |
| `packages/shell` | The Electron shell: window, tray, native toast, packaging. |
| `packages/cli` | The `bridge` command, a CJS bundle with no runtime dependencies. |

Architecture decisions live in `docs/adr/` — read the relevant ADR before
proposing to change what it decided; if the decision is wrong today, the
way forward is a new ADR that supersedes it, not a silent change.

The execution ledgers (`.superpowers/sdd/`) and the visual direction
material (`design/`) stay out of the public repository, via
`.gitignore`. What was worth keeping from them was promoted into the ADRs
and `CHANGELOG.md`.

## How to add a string (0.13.0)

No screen text lives in a `.tsx`/`.ts` file. It all comes from the
catalog in `packages/shared/src/i18n/`, and the rule is short:

1. **Write the key in BOTH files** — `pt-BR.ts` (which is the source of
   the keys) and `en.ts`. If it's missing from `en.ts`, or extra there,
   `satisfies Record<MessageKey, string>` breaks the **typecheck** — it's
   not a test warning you, it's the compiler.
2. **The key name is the SURFACE, not the text.**
   `sidebar.rodape.novaTarefa`, `uso.painel.total`,
   `dialog.tarefa.branchPreview` — that way rewriting the copy never
   forces a rename. A key that describes the text (`novaTarefaAzul`) ages
   badly on the first copy revision.
3. **Use** `t(lang, 'key', { param })` in core/CLI/shared, `tUi(lang, …)`
   in the UI's models, and `const { t } = useT()` in components.
   Interpolation is `{name}`; there's no i18n dependency at all, and
   there won't be.
4. **Plurals are explicit keys**, not a rule: `sessoes.uma` /
   `sessoes.varias`. The two languages Bridge speaks have the same plural
   form, and a plural-rules library would cost more than the `if` line.
5. **Run `sanitizeDisplay` BEFORE** anything coming from the PTY, from a
   hook payload, or from a transcript — the catalog interpolates, it
   doesn't sanitize. A file path with `\r` inside a `{param}` draws the
   wrong line in the sidebar.
6. **Run the package's test.** Each package has a guard that sweeps its
   `src/` and fails, listing `file:line`, when it finds an accented
   literal or a common pt-BR word outside the catalog. If your line is a
   legitimate exception (log to a file, parser invariant), add a
   `// i18n-ignore` with the reason next to it.

**The blind spot nobody can skip:** the guard looks for ACCENTS. Copy
without an accent — `Todos`, `Base`, `Msg`, `Total`, and especially loose
text inside JSX — slips through. After touching a `.tsx`, do a pass
looking for text you typed and didn't put in the catalog; that's how the
last few were found, not by the test.

**A new language** is, above all, **a new file** in `src/i18n/` with the
same keys — that's the real work, and `satisfies` tells you when it's
complete. The rest is adding the code to five lists in
`shared/src/i18n/index.ts` (the `Language` union, `LANGUAGES`,
`LANGUAGE_SETTINGS`, `CATALOGUES`, and `INTL_LOCALE`), one line in the
`LANGUAGE_KEYS` of `packages/ui/src/settingsModel.ts` (the option → key
map for the language name; without it the selector doesn't know what to
call the new option), and the `systemLanguage` rule, if the machine's
locale should fall into it. The two `z.enum` of `ui.language`
(`api/schemas.ts` and `profile.ts`) **don't** need touching: both derive
from `LANGUAGE_SETTINGS`. The screen's selector doesn't either — it's
generated from the same list; all that's missing is the `idioma.<code>`
key with the language's name **in its own language**, in every catalog.
Outside `CATALOGUES` and the `MessageKey` list, TypeScript points to every
spot that's missing — none of those lists is allowed to stay incomplete
silently.

## Conventions

- **TypeScript strict, ESM.** No loose `any`, no `// @ts-ignore` without
  an explanation of why on the line above.
- **Test alongside the change.** The repository's standard is vitest per
  package, testing a pure function whenever possible; a new route gets a
  route test.
- **A comment explains the *why*, not the *what*.** Much of the
  commentary here records a measurement or a mistake that was costly —
  keep that standard instead of describing what the line next to it
  already says.
- **Interface text: through the catalog, never a literal** (see the
  section above). pt-BR is the source, with "você" address; English is
  written alongside it, in the same change.
- **No new dependency without a clear need.** The project is
  deliberately lean; every extra dependency is weight on the installer
  and maintenance surface. If your change needs one, say why in the issue
  before writing the code.
- **No path from your machine in the code.** No real absolute path or
  your own username in a default, test, or doc — use an environment
  variable, detection, or a generic placeholder (`C:\projects\my-repo`,
  which is what the fixtures use).
- **Line ending is LF, and `.gitattributes` calls the shots.** The root
  has `* text=auto eol=lf`, with `.cmd`/`.bat`/`.ps1`/`.nsh` pinned to
  `eol=crlf` (cmd.exe doesn't reliably read a `.cmd` with LF) and binaries
  (`.png`, `.ico`, `.woff2`, `.exe`) marked by hand, so the content
  heuristic doesn't decide for them and corrupt a file on normalization.
  You don't need to configure `core.autocrlf`: clone, edit, and commit —
  if one of your diffs shows the WHOLE file changed, it's a line ending,
  and the fix is `git add --renormalize .`, not rewriting the file.

## PR flow

1. Open (or comment on) an issue describing the problem and how to
   reproduce it.
2. Fork and create a branch off `main`, with a descriptive name
   (`fix/empty-statusline`, `feat/close-tab-shortcut`).
3. Make small commits, with an imperative, one-line message (`fix login
   item reading with --hidden`). The body, when there is one, explains
   why.
4. Before opening the PR: `npm test`, `npm run typecheck`, and
   `npm run build` green. Run `npm run e2e` if you touched the UI or the
   shell.
5. In the PR description, say what changes for whoever uses the app, how
   you verified it, and what you **didn't** verify. An honest "I didn't
   test the installer" is worth more than an optimistic checklist.

Changes that alter the interface deserve a screenshot in the PR — before
and after.

## Reporting a bug

Include: Bridge version (corner of the settings dialog, or the
installer's name), Windows version, Node version (`node -v`), what you
did, what happened, and what you expected. If the app failed to start,
the core log is at `%APPDATA%\bridge\logs\core.log` and the shell log at
`%APPDATA%\bridge\logs\shell.log` — paste the relevant snippet, not the
whole file.

## Security

The core listens only on `127.0.0.1`, with a per-instance token stored in
`%APPDATA%\bridge\instance.json`. If you find something that breaches
that boundary (remote execution, token leak, writing outside the
profile), **don't open a public issue**: send a private message through
GitHub describing the problem and how to reproduce it.

## Contribution license

By opening a pull request you agree that your contribution is licensed
under the project's same license, [FSL-1.1-MIT](LICENSE).
