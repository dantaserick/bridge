import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    /**
     * ADR-012 — os testes do shell sobem o CORE DE VERDADE como processo
     * filho, e o filho herda este ambiente. Sem a variável, cada um desses
     * testes faria o monitor de uso varrer o `~/.claude` real de quem roda a
     * suíte: leitura de dezenas de MB por teste, e um encerramento gracioso
     * competindo com ela. A pasta apontada NÃO existe — a varredura devolve
     * lista vazia sem tocar em disco, e nada é criado em `%TEMP%`.
     */
    env: {
      BRIDGE_CLAUDE_HOME: join(tmpdir(), 'bridge-sem-transcripts-do-teste'),
    },
  },
});
