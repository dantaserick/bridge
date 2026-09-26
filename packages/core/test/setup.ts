/**
 * `globalSetup` + `globalTeardown` do vitest do core (R11 + higiene da Task 3).
 *
 * **Setup:** varre o `%TEMP%` atrás de pastas de execuções ANTIGAS da suíte
 * (`bridge-*`, `bridge *`, `t5-*`, `t5f-*`) e apaga o que estiver parado há mais
 * de uma hora.
 *
 * **Teardown:** apaga o que ESTA execução criou — toda pasta com um dos
 * prefixos cujo `mtime` é posterior ao início da rodada —, mais uma segunda
 * passada do corte de uma hora.
 *
 * Por que existe: cada teste do core cria perfil, repo e worktree em pasta
 * temporária. Quando a limpeza do arquivo falha — no Windows, um `core.log`
 * ainda aberto ou o antivírus segurando o `.git` — o `rmSync` é engolido de
 * propósito (derrubar a suíte por causa de lixo em `%TEMP%` seria pior) e a
 * pasta fica. Em dezenas de execuções isso virou mais de mil pastas na máquina
 * do dono. A primeira rede é o `test/tmp.ts` (`afterAll` por arquivo); esta é a
 * segunda, e pega inclusive o que ficou travado enquanto o teste rodava e
 * soltou depois.
 *
 * O corte de 1 hora do setup é o que separa lixo de execução VIVA: outra suíte
 * rodando em paralelo tem pastas recém-criadas, e apagá-las derrubaria a outra
 * execução.
 *
 * **Ressalva do teardown por `mtime`:** uma SEGUNDA suíte iniciada depois desta
 * (duas janelas rodando `npm test` ao mesmo tempo) tem pastas com `mtime` maior
 * que o nosso início e perderia as pastas no nosso fim. O `npm test` da raiz
 * roda os workspaces em sequência, então o caso é o do usuário abrir uma
 * segunda janela de propósito — e o custo é uma suíte com falhas de I/O, não
 * dado do usuário: nada aqui sai de `%TEMP%`.
 *
 * Nunca falha: o que não sai do disco fica pra próxima.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Idade mínima pra uma pasta ser considerada lixo de execução anterior. */
export const STALE_MS = 60 * 60 * 1000;

/**
 * Prefixos usados pelos testes do Bridge (e pelo próprio core, no `profileDir`
 * de teste). `bridge-e2e-` é coberto por `bridge-`; `t5-`/`t5f-` são da Fase 5.
 */
const PREFIXES = ['bridge-', 'bridge ', 't5-', 't5f-'];

function candidates(root: string): string[] {
  try {
    return readdirSync(root).filter((entry) => PREFIXES.some((prefix) => entry.startsWith(prefix)));
  } catch {
    return [];
  }
}

export function sweepTempDirs(root: string = tmpdir(), now: number = Date.now(), staleMs: number = STALE_MS): number {
  let removed = 0;
  for (const entry of candidates(root)) {
    const path = join(root, entry);
    try {
      const info = statSync(path);
      if (!info.isDirectory()) continue;
      // `mtimeMs` e não `birthtime`: uma pasta viva é escrita o tempo todo, e
      // é a última escrita que diz se ainda há alguém usando.
      if (now - info.mtimeMs < staleMs) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      // Pasta travada (processo vivo, antivírus): fica pra próxima varredura.
    }
  }
  return removed;
}

/** Apaga as pastas com os prefixos cujo `mtime` é desta execução (≥ `since`). */
export function sweepRunTempDirs(since: number, root: string = tmpdir()): number {
  let removed = 0;
  for (const entry of candidates(root)) {
    const path = join(root, entry);
    try {
      const info = statSync(path);
      if (!info.isDirectory()) continue;
      if (info.mtimeMs < since) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch {
      // Ainda travada: o corte de 1 hora da próxima execução pega.
    }
  }
  return removed;
}

export default function setup(): () => void {
  const startedAt = Date.now();
  const removed = sweepTempDirs();
  if (removed > 0) console.log(`[setup] ${removed} pasta(s) temporária(s) antiga(s) de bridge apagada(s) de ${tmpdir()}`);

  return function teardown(): void {
    const doRun = sweepRunTempDirs(startedAt);
    const doStale = sweepTempDirs();
    if (doRun + doStale > 0) {
      console.log(`[teardown] ${doRun} pasta(s) desta execução e ${doStale} antiga(s) apagada(s) de ${tmpdir()}`);
    }
  };
}
