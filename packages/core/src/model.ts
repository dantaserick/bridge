/**
 * Compat: os tipos do domínio moram em `@bridge/shared` (core, ui e shell
 * consomem a MESMA definição). Este arquivo fica só pra não reescrever os
 * `from './model.js'` espalhados pelo core.
 */
export * from '@bridge/shared';
