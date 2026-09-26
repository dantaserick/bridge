import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    /**
     * ADR-012 — NENHUM teste pode ler o `~/.claude` de quem roda a suíte.
     *
     * O monitor de uso resolve a raiz dos transcripts por
     * `BRIDGE_CLAUDE_HOME` → `CLAUDE_CONFIG_DIR` → `~/.claude`, e a varredura
     * inicial começa junto com o `createCore` — ou seja, dezenas de testes que
     * só queriam um core de pé varreriam o histórico real da máquina. Aqui a
     * variável aponta pra uma pasta que NÃO EXISTE: `listTranscripts` devolve
     * lista vazia sem tocar em disco, e nada é criado (então nada sobra em
     * `%TEMP%`). Quem precisa de transcripts de verdade passa `claudeHome`
     * pro `createCore`, ou aponta a variável pra um `tmpDir()` próprio.
     */
    env: {
      BRIDGE_CLAUDE_HOME: join(tmpdir(), 'bridge-sem-transcripts-do-teste'),
    },
    // R11 — varre o lixo de `%TEMP%` (perfis/repos/worktrees de execuções
    // anteriores que o `afterAll` não conseguiu apagar) antes de começar, e no
    // fim apaga o que ESTA execução criou (o `setup` devolve o teardown).
    globalSetup: ['test/setup.ts'],
  },
});
