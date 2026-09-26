/**
 * Monta `<repo>/.stage/core/node_modules` com APENAS as dependências de
 * runtime do core. É essa pasta que o electron-builder copia pra
 * `resources/core/node_modules`.
 *
 * Por que não copiar o `node_modules` da raiz: ele é hoisted e mistura as
 * devDependencies de todos os pacotes (vitest, playwright, electron, tsx…) —
 * centenas de MB que não têm nada a ver com o app instalado. E por que não
 * deixar o electron-builder resolver sozinho: o core não é o pacote que ele
 * empacota (o pacote é o shell); pro builder o core é só um blob de arquivos.
 *
 * **A árvore é reprodutível.** O par `stage/core.package.json` +
 * `stage/core.package-lock.json` (versionados no repo) é copiado pro stage e
 * instalado com `npm ci --omit=dev`. Sem o lockfile, só as 6 deps DIRETAS
 * ficariam fixas e as ~119 transitivas seriam re-resolvidas a cada build — o
 * app instalado podia sair com uma árvore JS diferente da que `npm test`
 * exercitou. `npm ci` ainda falha sozinho se o lockfile e o package.json
 * discordarem.
 *
 * Os módulos nativos (better-sqlite3, node-pty) ficam com os prebuilds do ABI
 * do **Node do sistema**, que é quem executa o core (ruling da Task 5) — por
 * isso NÃO se roda `@electron/rebuild` aqui.
 *
 * Uso:
 *   node scripts/stage-core.mjs                  monta o stage a partir do lockfile
 *   node scripts/stage-core.mjs --refresh-lock   regrava o par versionado a
 *                                                partir das versões diretas do
 *                                                package-lock.json da raiz
 *   node scripts/stage-core.mjs --help           a mesma lista, sem montar nada
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const coreDir = join(repoRoot, 'packages', 'core');
const stageDir = join(repoRoot, '.stage', 'core');
/** Par versionado (entra no git); o `.stage/` é descartável. */
const pinnedDir = join(here, '..', 'stage');
const pinnedPkg = join(pinnedDir, 'core.package.json');
const pinnedLock = join(pinnedDir, 'core.package-lock.json');

/**
 * `--help` sai ANTES de qualquer efeito colateral (o script apaga e remonta
 * `.stage/core` logo na primeira linha da execução): quem digitou o comando
 * errado não pode perder o stage por isso. Sai por stdout com código 0.
 */
const HELP = `stage-core — monta .stage/core com as dependências de runtime do core

Uso: node scripts/stage-core.mjs [--refresh-lock] [--help]

  (sem flag)        apaga e remonta .stage/core instalando packages/shell/stage/
                    core.package.json com \`npm ci --omit=dev\`, confere os
                    binários nativos (better-sqlite3, node-pty), poda o que não
                    vai pro instalador e valida o electronDist do shell.
  --refresh-lock    regrava o par versionado (core.package.json +
                    core.package-lock.json) a partir das versões que o
                    package-lock.json da raiz fixou para as dependências de
                    packages/core. Rode isto depois de mexer nas dependências
                    do core — o build normal FALHA quando os dois divergem.
  --help, -h        esta ajuda.

É este script que o \`npm run dist -w @bridge/shell\` chama antes do
electron-builder; a pasta .stage/ é descartável e não entra no git.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const refreshLock = process.argv.includes('--refresh-lock');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// ------------------------------------------------------------------ npm

// O npm é chamado pelo `npm-cli.js` do próprio Node, e não por `npm.cmd`:
// desde o Node 22 um `.cmd` só sobe com `shell: true` (senão EINVAL), e aí o
// Node emite DEP0190 porque os argumentos vão concatenados, sem escape.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function npm(args) {
  if (existsSync(npmCli)) {
    execFileSync(process.execPath, [npmCli, ...args], { cwd: stageDir, stdio: 'inherit' });
    return;
  }
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: stageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

// ------------------------------------------------- o que o core precisa

/** Versão exata que o lockfile da raiz já resolveu — nada de reabrir ranges. */
function lockedVersion(lock, name) {
  // Um pacote pode estar aninhado (conflito de versão); a forma hoisted é a
  // que o core enxerga hoje, então é ela que vai pro pacote.
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`sem versão no package-lock.json pra ${name}`);
  return entry.version;
}

/** O `package.json` do runtime do core, montado a partir da raiz do monorepo. */
function buildStagePkg() {
  const corePkg = read(join(coreDir, 'package.json'));
  const lock = read(join(repoRoot, 'package-lock.json'));
  const dependencies = {};
  for (const name of Object.keys(corePkg.dependencies ?? {})) {
    // `@bridge/shared` é TypeScript sem build: o esbuild do core já embutiu ele
    // no `dist/index.mjs`, então não existe em node_modules do app.
    if (name.startsWith('@bridge/')) continue;
    dependencies[name] = lockedVersion(lock, name);
  }
  return { name: 'bridge-core-runtime', version: corePkg.version, private: true, dependencies };
}

// --------------------------------------------------------------- prune

/**
 * Tira do stage o que o app instalado nunca carrega. Sem isso o `node_modules`
 * do core sai com 93 MB, dos quais ~65 MB são símbolos de depuração e
 * prebuilds de outras plataformas.
 *
 * O que sai, e por quê:
 * - `*.pdb` — símbolos de depuração do MSVC que acompanham os prebuilds do
 *   node-pty (28 MB só no win32-x64). O runtime nunca abre esses arquivos.
 * - `prebuilds/<outra plataforma>` — o alvo é win32-x64 e só.
 * - `better-sqlite3/deps` e `/src` — a amalgamação do SQLite e o código C++,
 *   usados apenas quando o módulo é COMPILADO. Aqui ele vem pronto em
 *   `build/Release/better_sqlite3.node`.
 * - `node_modules/**\/.bin` — atalhos de CLI (`.cmd`/`.ps1`/shebang) que só
 *   servem pra rodar ferramenta pela linha de comando. O core resolve tudo por
 *   `import`, nunca pelo `.bin`, e são executáveis a mais no instalador
 *   passando pelo signtool à toa.
 */
function prune(modules) {
  const target = `${process.platform}-${process.arch}`;
  const before = dirSize(modules);

  const ptyPrebuilds = join(modules, 'node-pty', 'prebuilds');
  if (existsSync(ptyPrebuilds)) {
    for (const entry of readdirSync(ptyPrebuilds)) {
      if (entry !== target) rmSync(join(ptyPrebuilds, entry), { recursive: true, force: true });
    }
  }
  for (const dir of ['deps', 'src']) {
    rmSync(join(modules, 'better-sqlite3', dir), { recursive: true, force: true });
  }
  const bins = removeBinDirs(modules);
  let pdbs = 0;
  for (const file of walk(modules)) {
    if (file.endsWith('.pdb')) {
      rmSync(file, { force: true });
      pdbs += 1;
    }
  }

  const after = dirSize(modules);
  console.log(`[stage] prune: ${pdbs} .pdb, ${bins} .bin/, prebuilds != ${target}, better-sqlite3/{deps,src}`);
  console.log(`[stage] ${mb(before)} MB -> ${mb(after)} MB`);
}

/**
 * Apaga todo `.bin` filho direto de um `node_modules` — o da raiz do stage e os
 * de qualquer `node_modules` aninhado (conflito de versão).
 */
function removeBinDirs(nodeModulesDir) {
  let removed = 0;
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(nodeModulesDir, entry.name);
    if (entry.name === '.bin') {
      rmSync(full, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    // `@escopo/` não é pacote: os pacotes estão um nível abaixo.
    const packages = entry.name.startsWith('@') ? readdirSync(full).map((n) => join(full, n)) : [full];
    for (const pkgDir of packages) {
      const nested = join(pkgDir, 'node_modules');
      if (existsSync(nested)) removed += removeBinDirs(nested);
    }
  }
  return removed;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function dirSize(dir) {
  let total = 0;
  for (const file of walk(dir)) total += statSync(file).size;
  return total;
}

// ------------------------------------------------------------- execução

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

if (refreshLock) {
  refresh();
} else {
  assertPinnedIsCurrent();
}

copyFileSync(pinnedPkg, join(stageDir, 'package.json'));
copyFileSync(pinnedLock, join(stageDir, 'package-lock.json'));

const pkg = read(pinnedPkg);
console.log('[stage] dependências de runtime do core (do lockfile versionado):');
for (const [name, version] of Object.entries(pkg.dependencies)) console.log(`  ${name}@${version}`);

// `npm ci` (e não `install`): instala EXATAMENTE a árvore do lockfile, sem
// re-resolver transitiva nenhuma, e aborta se o lockfile não bater com o
// package.json. `--install-links` não entra porque não há dependência `file:`
// aqui — seria no-op.
npm(['ci', '--omit=dev', '--no-audit', '--no-fund']);

const modules = join(stageDir, 'node_modules');
if (!existsSync(modules)) throw new Error(`stage falhou: ${modules} não existe`);

// Os binários nativos são a peça que falha em silêncio: prebuild que não baixou
// só aparece com o core já empacotado, morrendo na primeira query ou no
// primeiro PTY. Conferir aqui é a diferença entre um erro de build e um app
// instalado que não abre.
const sqlite = join(modules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(sqlite)) throw new Error(`stage sem o binário nativo do better-sqlite3: ${sqlite}`);
const pty = join(modules, 'node-pty', 'prebuilds', 'win32-x64', 'pty.node');
if (process.platform === 'win32' && !existsSync(pty)) throw new Error(`stage sem o prebuild do node-pty: ${pty}`);

prune(modules);
console.log(`[stage] ok: ${modules}`);

checkElectronDist();

/**
 * `--refresh-lock`: regrava o par versionado a partir das versões DIRETAS que o
 * `package-lock.json` da raiz resolveu, deixando o npm resolver as transitivas
 * uma vez só — aqui, na mão de quem está atualizando, e não a cada build.
 * Rodar depois de mexer nas `dependencies` do core ou de um `npm update`.
 */
function refresh() {
  const next = buildStagePkg();
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log('[stage] --refresh-lock: resolvendo a árvore transitiva…');
  npm(['install', '--package-lock-only', '--omit=dev', '--no-audit', '--no-fund']);
  mkdirSync(pinnedDir, { recursive: true });
  copyFileSync(join(stageDir, 'package.json'), pinnedPkg);
  copyFileSync(join(stageDir, 'package-lock.json'), pinnedLock);
  const packages = Object.keys(read(pinnedLock).packages ?? {}).length - 1;
  console.log(`[stage] regravado: ${pinnedPkg}`);
  console.log(`[stage] regravado: ${pinnedLock} (${packages} pacotes)`);
}

/**
 * O par versionado é a fonte da verdade da árvore empacotada, mas as
 * `dependencies` do core continuam vivendo em `packages/core/package.json`.
 * Se alguém mexer lá (ou num `npm update` da raiz) sem rodar `--refresh-lock`,
 * o app sairia com uma dependência de outra versão — ou faltando. Falhar aqui,
 * dizendo o comando, é melhor do que descobrir isso no app instalado.
 */
function assertPinnedIsCurrent() {
  if (!existsSync(pinnedPkg) || !existsSync(pinnedLock)) {
    throw new Error(`stage sem lockfile versionado (${pinnedPkg}). Rode: npm run stage:refresh-lock -w @bridge/shell`);
  }
  const wanted = buildStagePkg().dependencies;
  const pinned = read(pinnedPkg).dependencies ?? {};
  const drift = [];
  for (const name of new Set([...Object.keys(wanted), ...Object.keys(pinned)])) {
    if (wanted[name] !== pinned[name]) drift.push(`${name}: fixado ${pinned[name] ?? '(ausente)'} != raiz ${wanted[name] ?? '(ausente)'}`);
  }
  if (drift.length > 0) {
    throw new Error(
      `o lockfile do stage está desatualizado em relação ao core/à raiz:\n  ${drift.join('\n  ')}\n` +
        'Rode: npm run stage:refresh-lock -w @bridge/shell',
    );
  }
}

/**
 * O `electron-builder.yml` usa `electronDist` apontando pro Electron que o npm
 * já desempacotou em `node_modules/electron/dist` (ver o comentário lá). Esse
 * caminho depende do hoisting do npm workspaces e da versão FIXA no
 * `package.json` do shell — se um dos dois mudar, o build sairia com um
 * Electron de outra versão ou morreria com "electronDist does not exist" no
 * meio do empacotamento. Falhar aqui, antes, com a razão escrita, é melhor.
 */
function checkElectronDist() {
  const shellPkg = read(join(here, '..', 'package.json'));
  const wanted = shellPkg.devDependencies?.electron;
  const dist = resolve(repoRoot, 'node_modules', 'electron', 'dist');
  const versionFile = join(dist, 'version');
  if (!existsSync(versionFile)) {
    throw new Error(
      `electronDist ausente: ${dist}. Rode \`npm install\` na raiz; se o npm parou de fazer hoisting do electron, ajuste \`electronDist\` no electron-builder.yml.`,
    );
  }
  const found = readFileSync(versionFile, 'utf8').trim();
  if (found !== wanted) {
    throw new Error(
      `electronDist na versão ${found}, mas o shell fixou ${wanted}. Rode \`npm install\` na raiz ou acerte a devDependency \`electron\`.`,
    );
  }
  console.log(`[stage] electronDist: ${dist} (electron ${found})`);
}
