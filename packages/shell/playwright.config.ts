import { defineConfig } from '@playwright/test';

/**
 * Task 10 — e2e do app de verdade (`_electron.launch`).
 *
 * Fica separado do vitest de propósito: o `vitest.config.ts` deste pacote só
 * inclui `test/**\/*.test.ts`, e este arquivo é `e2e.spec.ts`, então
 * `npm run test -w @bridge/shell` NÃO tenta rodar o Electron.
 *
 * Pré-requisito: `npm run build:ui` e `npm run build -w @bridge/shell` já
 * rodados (o script `e2e` da raiz faz os dois antes). O spec confere e falha
 * com mensagem pt-BR se faltar algum artefato.
 */
export default defineConfig({
  testDir: 'test',
  testMatch: 'e2e.spec.ts',
  // Um único worker: o app é uma instância só (`requestSingleInstanceLock`) e
  // o core abre porta. Sem retry — flake aqui é bug, não ruído a mascarar.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: 'list',
  // O boot do core (tsx + fastify + sqlite) leva alguns segundos na primeira
  // vez; o teste inteiro tem que caber com folga.
  timeout: 180_000,
  expect: { timeout: 20_000 },
});
