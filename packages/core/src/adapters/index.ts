import type { AgentId } from '../model.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import type { AgentAdapter } from './types.js';

export function adapters(): Record<AgentId, AgentAdapter> {
  return { claude: claudeAdapter, codex: codexAdapter, gemini: geminiAdapter };
}
