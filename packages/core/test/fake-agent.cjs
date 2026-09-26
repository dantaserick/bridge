#!/usr/bin/env node
'use strict';

// Agente falso pra testar o shim e o core sem precisar do claude.cmd de
// verdade. Roda uma sequência de hooks (via bridge-hook.cjs, exatamente como
// o Claude Code faria) e depois fica vivo lendo stdin — assim o PTY não
// morre no meio do teste e a sessão continua "presente" pra UI, do jeito que
// uma sessão de agente real ficaria entre turnos.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STEP_DELAY_MS = 150;
const fixturesDir = path.join(__dirname, 'fixtures', 'hooks');

const SEQUENCES = {
  turn: [
    ['SessionStart', 'session-start'],
    ['UserPromptSubmit', 'user-prompt'],
    ['PreToolUse', 'pre-tool-bash'],
    ['PostToolUse', 'post-tool'],
    ['Stop', 'stop'],
  ],
  permission: [
    ['SessionStart', 'session-start'],
    ['UserPromptSubmit', 'user-prompt'],
    ['PermissionRequest', 'permission-request'],
  ],
  loop: [
    ['Stop', 'stop-blocked'],
    ['Stop', 'stop-blocked'],
    ['Stop', 'stop-blocked'],
    ['Stop', 'stop-blocked'],
    ['Stop', 'stop-blocked'],
  ],
};

function loadFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runHook(shim, sessionId, event, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim, sessionId, event]);
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    child.stdin.write(payload);
    child.stdin.end();
  });
}

function waitForQuit() {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('q\n') || buf.trim() === 'q') resolve();
    });
    process.stdin.on('end', () => resolve());
  });
}

async function main() {
  const sequenceName = process.argv[2];
  const steps = SEQUENCES[sequenceName];
  const sessionId = process.env.BRIDGE_SESSION;
  const shim = process.env.BRIDGE_SHIM;

  if (steps && sessionId && shim) {
    for (const [event, fixture] of steps) {
      await runHook(shim, sessionId, event, loadFixture(fixture));
      await sleep(STEP_DELAY_MS);
    }
  }

  process.stdout.write('fake-agent: done\n');
  await waitForQuit();
  process.exit(0);
}

main();
