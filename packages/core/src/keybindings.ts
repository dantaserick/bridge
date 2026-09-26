import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_KEYBINDINGS, KEY_ACTIONS, sanitizeDisplay } from '@bridge/shared';
import type { KeyAction, KeybindingProblem, Keybindings, KeybindingsResponse } from '@bridge/shared';
import type { Profile } from './profile.js';

/** Só o que `loadKeybindings` precisa do logger — mantém a função testável. */
interface WarnLogger {
  warn(msg: string, data?: object): void;
}

const KNOWN = new Set<string>(KEY_ACTIONS);

/**
 * Atalhos efetivos MAIS o que deu errado ao ler o arquivo.
 *
 * Os defaults da spec §6 com o `keybindings.json` do perfil por cima, ação por
 * ação. Arquivo ausente, JSON quebrado, chave desconhecida ou valor que não é
 * string não invalidam o resto — cada problema vira um warn e o default
 * daquela ação continua valendo. Um arquivo mal editado nunca deixa o app sem
 * atalho.
 *
 * Os problemas também SAEM daqui (`problems`), e não só do log: sem isso o
 * diálogo de configurações recebia uma tabela indistinguível da de um arquivo
 * perfeito e não tinha como avisar que o arquivo do dono está sendo ignorado.
 */
export function loadKeybindingsWithProblems(profile: Profile, log?: WarnLogger): KeybindingsResponse {
  const path = join(profile.dir, 'keybindings.json');
  const merged: Keybindings = { ...DEFAULT_KEYBINDINGS };
  const problems: KeybindingProblem[] = [];
  if (!existsSync(path)) return merged;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log?.warn('keybindings.json inválido — usando os atalhos padrão', { path, err });
    return { ...merged, problems: [{ kind: 'json-invalido' }] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log?.warn('keybindings.json não é um objeto — usando os atalhos padrão', { path });
    return { ...merged, problems: [{ kind: 'nao-e-objeto' }] };
  }

  for (const [action, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN.has(action)) {
      log?.warn('ação desconhecida no keybindings.json — ignorada', { path, action });
      // BU-16: o nome da ação vem do `keybindings.json`, que pode ter chegado
      // num backup ou zip (A7). Ele sai em `GET /api/keybindings.problems` e a
      // CLI o imprime; 120 caracteres limpos bastam pra a pessoa achar a linha.
      problems.push({ kind: 'acao-desconhecida', action: sanitizeDisplay(action, 120) });
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      log?.warn('atalho inválido no keybindings.json — mantido o padrão', { path, action });
      problems.push({ kind: 'atalho-invalido', action: sanitizeDisplay(action, 120) });
      continue;
    }
    merged[action as KeyAction] = value;
  }
  // Sem problema nenhum a chave não aparece: um arquivo impecável responde
  // exatamente o que respondia antes deste campo existir.
  return problems.length > 0 ? { ...merged, problems } : merged;
}

/** Só a tabela de atalhos — quem não liga pros problemas do arquivo. */
export function loadKeybindings(profile: Profile, log?: WarnLogger): Keybindings {
  const { problems: _problems, ...keybindings } = loadKeybindingsWithProblems(profile, log);
  return keybindings;
}
