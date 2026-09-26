import { t, type Language } from '@bridge/shared';
import type { AgentAdapter, LaunchCtx, LaunchSpec } from './types.js';
import { availableOnPath } from './which.js';

export const geminiAdapter: AgentAdapter = {
  id: 'gemini',
  label: 'Gemini',
  async available(lang: Language) {
    return availableOnPath('gemini', lang);
  },
  launch(_ctx: LaunchCtx): LaunchSpec {
    // O adaptador não existe: a mensagem é do BRIDGE e vira 500 no log.
    throw new Error(t('pt-BR', 'core.erro.adaptadorNaoImplementado', { agente: 'Gemini' }));
  },
  onHook() {
    return {};
  },
};
