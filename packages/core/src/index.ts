import { createCore } from './core.js';

async function main(): Promise<void> {
  // Terminal interativo vê o log no console além do arquivo; lançado pelo
  // shell Electron (`BRIDGE_LOG_CONSOLE=0`) só o arquivo, pra não encher o
  // pipe de um processo filho que ninguém está lendo.
  const core = createCore({
    profileDir: process.env.BRIDGE_PROFILE_DIR,
    // Definido pelo shell: a UI buildada vira estático em `http://127.0.0.1:<porta>/`.
    uiDir: process.env.BRIDGE_UI_DIR,
    consoleLog: !!process.stdout.isTTY && process.env.BRIDGE_LOG_CONSOLE !== '0',
  });
  const log = core.deps.log.child('core');

  process.on('uncaughtException', (err) => {
    // Um hook mal formado ou um bug isolado num handler não pode derrubar o
    // core inteiro — ele hospeda sessões de agente vivas.
    log.error('erro não tratado', { err });
  });

  const stopOnce = (() => {
    let stopping = false;
    return async (signal: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      log.info('encerrando', { signal });
      await core.stop();
      process.exit(0);
    };
  })();

  process.on('SIGINT', () => void stopOnce('SIGINT'));
  process.on('SIGTERM', () => void stopOnce('SIGTERM'));

  try {
    const { port } = await core.start();
    log.info('core no ar', { url: `http://127.0.0.1:${port}`, instancePath: core.deps.profile.instancePath });
  } catch (err) {
    // Causa nº 1 de falha na subida: já tem um Bridge de pé. O stack do
    // Fastify não diz isso; a mensagem abaixo diz, e aponta onde conferir.
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log.error('porta ocupada — outra instância do Bridge?', {
        port: core.deps.profile.config.port,
        instancePath: core.deps.profile.instancePath,
      });
      // O processo morre aqui: sem o flush a linha ficaria na fila.
      await core.deps.log.flush();
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  // Último recurso: pode não haver core (e portanto logger) pra escrever.
  console.error('[core] falhou ao iniciar', err);
  process.exit(1);
});
