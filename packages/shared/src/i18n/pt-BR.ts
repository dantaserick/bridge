/**
 * O catálogo em português do Brasil — a FONTE DAS CHAVES (spec §13).
 *
 * Este arquivo é o dicionário: `MessageKey` sai de `keyof typeof ptBR`, e o
 * `en.ts` tem um `satisfies Record<MessageKey, string>` que não compila com
 * chave a menos nem a mais. Ou seja: quem acrescenta um texto acrescenta
 * AQUI primeiro, e o compilador cobra a tradução antes do teste rodar.
 *
 * **Como o nome de uma chave é escolhido.** Por SUPERFÍCIE, nunca pelo texto:
 * `ambiente.semClaude.rotulo`, não `avisoSemClaude`. A copy é reescrita várias
 * vezes na vida de uma tela — "⚠ sem claude" pode virar outra coisa amanhã —,
 * e uma chave batizada pelo texto vira mentira no dia seguinte, enquanto uma
 * chave batizada pelo lugar continua verdadeira. O caminho vai do geral pro
 * particular (`sidebar.fila.aguardando`), e o último segmento diz o PAPEL do
 * texto quando há mais de um no mesmo ponto: `.rotulo` pro que aparece,
 * `.titulo` pro `title=` (tooltip), `.nota` pra explicação embaixo do campo.
 *
 * **Plural é chave explícita** (`.uma` / `.varias`), nunca regra automática:
 * a regra do português não é a do inglês e nenhuma das duas é a do russo. Uma
 * chave por forma é mais linhas e nenhuma surpresa.
 *
 * **Parâmetro** é `{nome}` e entra pelo terceiro argumento do `t`. O texto que
 * vem de PTY, hook ou transcript passa por `sanitizeDisplay` ANTES de virar
 * parâmetro — o catálogo não limpa nada.
 */
export const ptBR = {
  // ------------------------------------------------------------- formatação
  /** `format.ts` — o dinheiro. O símbolo é `US$` nos dois idiomas (spec §13). */
  'formato.moeda.usd': 'US$ {valor}',
  /** O sinal vem ANTES da moeda: `-US$ 2,50`, não `US$ -2,50`. */
  'formato.moeda.usdNegativo': '-US$ {valor}',
  'formato.tokens.mil': '{valor}k',
  'formato.tokens.milhao': '{valor}M',
  'formato.tempo.agora': 'agora',
  'formato.tempo.minutos': 'há {n} min',
  'formato.tempo.horas': 'há {n} h',
  /** Um dia atrás tem palavra própria — em nenhum idioma se diz "há 1 dias". */
  'formato.tempo.ontem': 'ontem',
  'formato.tempo.dias': 'há {n} dias',

  // ---------------------------------------------------------------- ambiente
  // Dor verificada #2. Os três primeiros são nome de produto e não se traduzem
  // (spec §13); estão no catálogo porque o rótulo inteiro sai por uma porta só.
  'ambiente.pwsh': 'PowerShell 7 (pwsh)',
  'ambiente.powershell': 'Windows PowerShell',
  'ambiente.gitbash': 'Git Bash',
  'ambiente.wsl': 'WSL · {distro}',
  'ambiente.semClaude.rotulo': '⚠ sem claude',
  'ambiente.semClaude.titulo':
    'claude não encontrado neste ambiente. A sessão de agente vai falhar ao subir; instale o Claude Code dentro dele ou troque o ambiente pelo menu "⋯" do workspace.',
  'ambiente.sumiu.rotulo': '⚠ ambiente sumiu',
  'ambiente.sumiu.titulo':
    'O ambiente escolhido não responde nesta máquina (distro parada, removida ou sem shell). Escolha outro pelo menu "⋯" do workspace.',

  // ------------------------------------------------------------------ idioma
  // O seletor de Configurações → Aparência (spec §6/§13). Os dois nomes de
  // idioma ficam NA PRÓPRIA LÍNGUA nos dois catálogos — quem procura inglês
  // procura por "English", inclusive numa tela que está em português. Só "do
  // sistema" é uma frase, e essa sim se traduz.
  'idioma.ptBR': 'Português (Brasil)',
  'idioma.en': 'English',
  'idioma.sistema': 'Do sistema',

  // =========================================================== CORE — erros
  // O `code` do corpo de erro (`pane-busy`, `invalid-config`) NUNCA muda: ele
  // é o contrato com a UI e com a CLI. O que sai daqui é só o `error.message`,
  // montado na BORDA da API com o `core.language()` do instante da resposta.
  'core.erro.painelNaoEncontrado': 'painel não encontrado: {paneId}',
  'core.erro.adotarAba.naoEncontrada': 'aba não encontrada: {tabId}',
  'core.erro.adotarAba.mesmaAba': 'a aba já é a deste painel',
  'core.erro.adotarAba.outroWorkspace': 'a aba é de outro workspace',
  'core.erro.painelSemId': 'nenhum painel atual: passe o paneId',
  'core.erro.painelOcupado': 'painel já tem uma sessão ativa',
  'core.erro.painelComAgente': 'este painel já está com um agente',
  'core.erro.painelSemConversa': 'Este painel não tem conversa pra retomar',
  'core.erro.painelJaNaFila': 'este painel já tem um agente na fila: {paneId}',
  'core.erro.filaCheia': 'a fila de lançamentos está cheia ({max})',
  'core.erro.filaVazia': 'a fila está vazia',
  'core.erro.lancamentoNaoEstaNaFila': 'lançamento não está na fila',
  'core.erro.lancamentoNaoEstaNaFilaComId': 'lançamento não está na fila: {id}',
  'core.erro.sessaoNaoEncontrada': 'sessão não encontrada',
  'core.erro.workspaceNaoEncontrado': 'workspace não encontrado',
  'core.erro.workspaceNaoEncontradoComId': 'workspace não encontrado: {workspaceId}',
  'core.erro.naoEWorktree': 'este workspace não é um worktree de tarefa',
  'core.erro.nomeTarefaInvalido': 'nome de tarefa inválido: "{nome}"',
  'core.erro.refInvalida': 'ref inválida: "{ref}"',
  'core.erro.killFalhou': 'não consegui encerrar {n} sessão(ões)',
  'core.erro.semAgente': 'agente não especificado',
  'core.erro.agenteDesconhecido': 'agente desconhecido: {agente}',
  'core.erro.agenteIndisponivel': 'Agente indisponível',
  'core.erro.cwdInexistente': 'pasta inexistente: {cwd}',
  'core.erro.cwdInvalido': 'cwd inválido ou inexistente',
  'core.erro.informeCwd': 'informe cwd',
  'core.erro.abaNaoEncontrada': 'aba não encontrada',
  'core.erro.dirInvalido': 'dir inválido: use {opcoes}',
  'core.erro.rangeInvalido': 'range inválido: use {opcoes}',
  'core.erro.fusoDesconhecido': 'fuso desconhecido: {tz}',
  'core.erro.ancoraInvalida': 'anchor inválida: {valor} — use AAAA-MM-DD, de {min} até hoje ({hoje})',
  'core.erro.ancoraComCustom': 'anchor não vale com range=custom — use from e to',
  'core.erro.periodoSoCustom': 'from e to só valem com range=custom',
  'core.erro.periodoIncompleto': 'range=custom precisa de from e to (AAAA-MM-DD)',
  'core.erro.periodoDataInvalida': 'data inválida em {campo}: {valor} — use AAAA-MM-DD',
  'core.erro.periodoInvertido': 'período invertido: from {de} é depois de to {ate}',
  'core.erro.periodoAntesDoMinimo': 'período começa antes de {min}',
  'core.erro.periodoFuturo': 'período começa depois de hoje ({hoje})',
  'core.erro.periodoLongo': 'período longo demais: {dias} dias (máximo {max})',
  'core.erro.releituraEmAndamento': 'já há uma releitura em andamento',
  'core.erro.releituraCooldown': 'releitura de transcrições no máximo a cada {s} s',
  'core.erro.somenteLeitura': '{campos}: só pelo config.json',
  'core.erro.configInvalida': 'Configuração inválida: {caminho}: {motivo}',
  'core.erro.corpoInvalido': 'Corpo inválido: {caminho}: {motivo}',
  /**
   * O `{caminho}` das duas linhas acima quando o issue do zod não tem caminho
   * nenhum — o corpo INTEIRO é que está errado. É marcador de lugar, mas ele
   * aparece dentro de uma frase que a pessoa lê, e ficava em pt-BR mesmo com o
   * Bridge em inglês (`Invalid body: (corpo): …`).
   */
  'core.erro.corpoCaminho': '(corpo)',
  'core.erro.invalido': 'inválido',
  'core.erro.informeAmbienteOuCrossAccess': 'informe environment e/ou crossAccess',
  'core.erro.comandoInicialInvalido': 'comando com caractere de controle ou separador de shell',
  'core.erro.recap.semResume': 'esta sessão não pediu pra retomar conversa nenhuma',
  'core.erro.recap.semTranscript': 'o transcript da conversa anterior não está mais no disco',
  'core.erro.recap.vazio': 'não sobrou texto aproveitável no transcript da conversa anterior',
  'core.erro.hookParametroInvalido': 'Parâmetro de hook inválido',
  'core.erro.caminhoInvalido': 'Caminho inválido',
  'core.erro.originNaoPermitida': 'Origin não permitida',
  'core.erro.tokenInvalido': 'Token inválido',
  'core.erro.hooksSomenteLocal': 'Hooks só aceitam chamada local, sem Origin',
  'core.erro.limiteConexoes': 'limite de conexões',
  'core.erro.binNaoEncontrado': '{bin} não encontrado no PATH',
  'core.erro.adaptadorNaoImplementado': 'Adaptador {agente} ainda não implementado nesta versão',

  // ------------------------------------------------------ erros de validação
  // Mensagens de `refine` do zod. O `message` do schema guarda a CHAVE; quem
  // traduz é o `parseBody`, que sabe o idioma no instante da resposta.
  'core.erro.refSimples': 'use um nome de ref simples (letras, dígitos, `.`, `_`, `-`, `/`)',
  'core.erro.distroInvalida': 'nome de distro inválido',
  'core.erro.distroSoComWsl': 'informe distro apenas (e obrigatoriamente) quando kind for wsl',
  'core.erro.conversaInvalida': 'id de conversa inválido',
  'core.erro.usagePricingMax': 'no máximo {max} modelos em usage.pricing',

  // ------------------------------------------------------------- erros do git
  'core.erro.git.falhou': 'git {comando} falhou',
  'core.erro.git.filtrosSemConfianca':
    'Este repositório declara filtros git (clean/smudge). Confirme que confia neles no menu do workspace antes de mesclar/remover.',
  'core.erro.git.pastaExiste': 'já existe uma pasta {caminho}',
  'core.erro.git.branchExiste': 'já existe um branch chamado {branch}',
  'core.erro.git.baseSuja': 'o repositório tem alterações não commitadas em {base}; commite ou descarte antes de mesclar',
  'core.erro.git.baseEmUso': 'o branch {base} está em uso pelo worktree {worktree}; feche-o (ou mescle por lá) antes de mesclar',
  'core.erro.git.baseNaoCheckout': 'O repositório principal está em {head}; faça checkout de {base} antes de mesclar.',
  'core.erro.git.naoFf': '{branch} não avança {base} em linha reta; precisa de um commit de merge',
  'core.erro.git.naoFfComGit': '{branch} não avança {base} em linha reta; precisa de um commit de merge (git: {stderr})',
  'core.erro.git.conflito': 'Conflito ao mesclar {branch} em {base}; o merge foi desfeito. Resolva no terminal.',
  'core.erro.git.worktreeSujo': 'o worktree tem {n} arquivo(s) com alteração não commitada; commite ou descarte antes de remover',
  'core.erro.git.naoMesclado': 'o branch {branch} ainda não foi mesclado em {base}',
  'core.erro.git.repoDesconhecido': 'repositório desconhecido: {repo}',
  'core.erro.git.repoSumiu': 'o repositório sumiu do disco: {caminho}',
  'core.erro.git.semCommits': 'crie o primeiro commit antes de abrir uma tarefa',
  'core.erro.git.naoERepo': 'a pasta não é um repositório git: {caminho}',
  'core.erro.git.informeRepo': 'informe repoId ou repoPath',
  'core.erro.git.refDesconhecida': 'o ref {ref} não existe neste repositório',
  'core.erro.git.enumeracaoFalhou': '(enumeração falhou)',
  'core.erro.git.submoduloInvalido': '(caminho de submódulo inválido)',

  // ------------------------------------------------------- erros de ambiente
  'core.erro.ambiente.naoRespondeu': 'o ambiente {id} não respondeu — escolha outro no menu do workspace',
  'core.erro.ambiente.semClaude': 'claude não encontrado em {id} — instale o Claude Code na distro ou troque o ambiente',
  'core.erro.ambiente.distroInvalida': 'distro do WSL inválida ou ausente',
  'core.erro.ambiente.traduzPasta': 'não consegui traduzir a pasta da sessão pra distro {distro}',
  'core.erro.ambiente.traduzCaminhos': 'não consegui traduzir os caminhos do Bridge pra distro {distro}',
  'core.erro.ambiente.interopNode': 'não consegui alcançar o Node do Windows por interop na distro {distro}',

  // -------------------------------------- CORE — rótulos e motivos de ambiente
  'core.ambiente.motivo.gitBashAusente': 'Git for Windows não encontrado em C:\\Program Files\\Git\\bin\\bash.exe',
  'core.ambiente.motivo.distroSemResposta': 'a distro não respondeu (não instalada, parada ou sem shell)',
  'core.ambiente.motivo.semInterop':
    'interop do Windows desligado nesta distro (/proc/sys/fs/binfmt_misc/WSLInterop): os hooks do Bridge não vão rodar',
  'core.ambiente.motivo.semClaude': 'sem claude nesta distro (o Bridge não sobe agente aqui)',

  // ------------------------------------------------- CORE — notificações
  'core.notificacao.aguardando': 'Aguardando você',
  'core.notificacao.terminou': 'Terminou o turno',
  'core.notificacao.permissao': 'Permissão: {detalhe}',
  'core.notificacao.permissaoSolicitada': 'Permissão solicitada',
  'core.notificacao.loopStop': 'Travou em loop de Stop',

  // --------------------------------------- CORE — `detail` da linha da sessão
  'core.sessao.detalhe.pensando': 'pensando…',
  'core.sessao.detalhe.terminei': 'terminei',
  'core.sessao.detalhe.aguardandoPermissao': 'aguardando permissão',
  'core.sessao.detalhe.travado': 'travado — precisa de ajuda',
  'core.sessao.detalhe.subagente': 'subagente terminou',
  'core.sessao.detalhe.subagentes.um': '1 subagente rodando',
  'core.sessao.detalhe.subagentes.varios': '{n} subagentes rodando',
  'core.sessao.detalhe.aguardandoSubagentes.um': 'esperando 1 subagente',
  'core.sessao.detalhe.aguardandoSubagentes.varios': 'esperando {n} subagentes',
  'core.sessao.detalhe.limiteServidor': 'limite do servidor',

  // ------------------------------------------------------ CORE — statusline
  'core.statusline.contexto': '{tokens} ctx',

  // ------------------------------------------- CORE — janelas de limite (uso)
  'core.uso.janela.cincoHoras': '5h',
  'core.uso.janela.semana': 'semana',
  'core.uso.reseta.minutos': 'reseta em {n}min',
  'core.uso.reseta.horas': 'reseta em {n}h',
  'core.uso.reseta.horasMinutos': 'reseta em {h}h{m}',
  'core.uso.reseta.dia': 'reseta {dia}',
  'core.uso.diaSemana.dom': 'dom',
  'core.uso.diaSemana.seg': 'seg',
  'core.uso.diaSemana.ter': 'ter',
  'core.uso.diaSemana.qua': 'qua',
  'core.uso.diaSemana.qui': 'qui',
  'core.uso.diaSemana.sex': 'sex',
  'core.uso.diaSemana.sab': 'sáb',

  // Os dois BALDES do relatório de uso. O valor guardado no banco é o
  // sentinela em pt-BR (`(sem projeto)` está em linhas antigas de
  // `usage_daily`); estas chaves são o que aparece na TELA — a tradução
  // acontece na leitura, nunca na escrita, senão trocar de idioma partiria
  // o mesmo projeto em dois baldes no histórico.
  'core.uso.balde.outros': '(outros)',
  'core.uso.balde.semProjeto': '(sem projeto)',
  /** A data da tabela de preços quando há `usage.pricing`/`pricingFile` por cima. */
  'core.uso.precos.comAjustes': '{data} (com ajustes locais)',

  // ----------------------------------------------- CORE — avisos de preço
  'core.uso.aviso.modeloSemPreco':
    'modelo sem preço: {modelo} — o consumo dele conta nos tokens, mas fica de fora do custo estimado (Configurações → Uso)',
  'core.uso.aviso.precosNaoObjeto': '{origem}: o conteúdo não é um objeto de preços; ignorado',
  'core.uso.aviso.precoInvalido':
    '{origem}: preço inválido para "{modelo}" (esperado input/output/cacheWrite/cacheRead ≥ 0, cacheWrite1h opcional); ignorado',
  'core.uso.aviso.arquivoPrecosInvalido':
    'usage.pricingFile: arquivo de preços inválido (esperado um .json regular de até 1 MiB); usando a tabela embutida',
  'core.uso.aviso.entradasIgnoradas.uma':
    'usage.pricingFile: 1 entrada ignorada por não ter forma de preço (esperado input/output/cacheWrite/cacheRead ≥ 0, cacheWrite1h opcional); as demais valem',
  'core.uso.aviso.entradasIgnoradas.varias':
    'usage.pricingFile: {n} entradas ignoradas por não terem forma de preço (esperado input/output/cacheWrite/cacheRead ≥ 0, cacheWrite1h opcional); as demais valem',

  // ------------------------------------------- CORE — guarda de escopo (deny)
  // Lida pelo AGENTE, que a repete pro dono: sai no idioma configurado como
  // qualquer outro texto de gente.
  'core.escopo.raiz.worktree': 'fora do worktree desta tarefa',
  'core.escopo.raiz.repo': 'fora do repositório deste workspace',
  'core.escopo.raiz.pasta': 'fora da pasta deste workspace',
  'core.escopo.menu.worktree': 'worktree',
  'core.escopo.menu.repo': 'repositório',
  'core.escopo.unc': ' Caminhos UNC e `\\\\?\\` são sempre recusados.',
  'core.escopo.razao':
    'Bridge: {onde} ({alvo}). Esta sessão só pode ler e escrever dentro de {raiz}.{extra} Libere em ⋯ → "Permitir acesso fora do {menu}".',

  // ---------------------------------------------- CORE — resumo da retomada
  'core.recap.pedido': 'Último pedido seu:',
  'core.recap.respostas': 'Últimas respostas do agente:',

  // ================================================================ UI
  // As chaves da interface (Task 3 do lote de idioma). Nome por SUPERFÍCIE:
  // `sidebar.*` (a lista da esquerda), `menu.*` (o "⋯" do workspace),
  // `tabs.*` (a barra de abas), `pane.*` (o painel vazio), `actions.*` (as
  // frases de status e de confirmação), `settings.*` (o diálogo) e `uso.*`
  // (o painel "Uso" e o bloco de limites da sidebar).
  //
  // Onde uma frase carrega marcação inline (`<kbd>`, `<code>`, `<strong>`), o
  // texto vira PARTES numeradas (`.parte1`, `.parte2`…). É feio, e é o menor
  // dos males: uma chave só obrigaria a jogar fora a marcação (a tecla deixa
  // de parecer tecla), e um "rich text" caseiro obrigaria a inventar uma
  // sintaxe de marcação dentro do catálogo. A parte é sempre uma frase inteira
  // ou um pedaço com sentido próprio — nunca uma palavra solta.

  // ------------------------------------------------------------ UI — sidebar
  'sidebar.grupo.semRepositorio': 'Sem repositório',
  'sidebar.git.titulo': 'base: {base}',
  'sidebar.git.tituloDeduzida': 'base: {base} (base deduzida)',
  'sidebar.git.semBase': 'sem base conhecida',
  'sidebar.worktree.sumiu': '(pasta sumiu)',
  'sidebar.filtros.rotulo': '⚠ filtros',
  'sidebar.filtros.titulo':
    'Este repositório declara filtros git (clean/smudge). Enquanto você não confiar neles, o Bridge não roda git que toque no conteúdo — por isso não há +N ~M. Use o menu "⋯" do workspace.',
  'sidebar.hospedada.titulo': 'Claude Code aberto dentro deste shell',
  /** O `detail` da hospedeira ociosa (spec §5) — a palavra que separa o Claude que você digitou do que o Bridge subiu. */
  'sidebar.hospedada.detalhe': 'no shell',
  'sidebar.sessao.agente': 'agente',
  'sidebar.sessao.saida': 'código {codigo}',
  'sidebar.sessao.encerrar': 'Encerrar sessão',
  'sidebar.sessao.encerrarRotulo': 'Encerrar sessão {rotulo}',

  // O estado da sessão por extenso: é o que o leitor de tela fala no lugar do
  // anel colorido, e o `title` do próprio anel.
  'sidebar.estado.idle': 'ociosa',
  'sidebar.estado.running': 'trabalhando',
  'sidebar.estado.needsInput': 'esperando você',
  'sidebar.estado.done': 'concluída',
  'sidebar.estado.stuck': 'travada',
  'sidebar.estado.exited': 'encerrada',
  /** "do servidor" com todas as letras: a confusão com o limite de USO é a dor que este estado desfaz. */
  'sidebar.estado.serverLimited': 'limite do servidor',
  'sidebar.estado.semSessao': 'sem sessão',

  'sidebar.linha.workspace': 'Workspace {nome}',
  'sidebar.linha.semSessoes': 'sem sessões',
  'sidebar.linha.umaSessao': '1 sessão',
  'sidebar.linha.variasSessoes': '{n} sessões',
  'sidebar.linha.worktreeSumiu': 'a pasta do worktree sumiu',
  'sidebar.linha.filtrosNaoConfiados': 'filtros git não confiados',
  'sidebar.linha.ambiente': 'ambiente {id}',
  'sidebar.linha.ambienteProblema': 'ambiente sem claude ou indisponível',
  'sidebar.linha.sessao': 'Sessão {rotulo}',
  'sidebar.linha.emFoco': 'em foco',
  'sidebar.ambiente.titulo': 'as sessões deste workspace sobem em {id}',

  'sidebar.chevron.recolher': 'Recolher {nome}',
  'sidebar.chevron.expandir': 'Expandir {nome}',
  'sidebar.grupo.rotulo': 'Grupo {nome}',
  'sidebar.grupo.umWorkspace': '1 workspace',
  'sidebar.grupo.variosWorkspaces': '{n} workspaces',
  'sidebar.grupo.recolhido': 'recolhido',
  'sidebar.grupo.expandido': 'expandido',
  'sidebar.grupo.acoes': 'Ações do grupo {nome}',
  'sidebar.grupo.desafixar': 'Desafixar',
  'sidebar.grupo.desafixar.titulo': 'devolve o grupo à ordem normal',
  'sidebar.grupo.fixar': 'Fixar no topo',
  'sidebar.grupo.fixar.titulo': 'mantém o grupo no topo da sidebar',
  'sidebar.workspace.acoes': 'Ações do workspace {nome}',

  'sidebar.servidor.rotulo': '⏳ servidor',
  'sidebar.servidor.nota': 'Limite do SERVIDOR (não é o seu limite de uso).',
  'sidebar.servidor.titulo': '{nota} O terminal disse: “{frase}”',
  /** O `{menu}` é o MESMO item que a razão do deny cita (`core.escopo.menu.*`). */
  'sidebar.escopo.nota':
    'A guarda de escopo barrou estes caminhos (fora da raiz desta sessão). Libere em ⋯ → Permitir acesso fora do {menu}.',

  'sidebar.fila.uma': '1 sessão aguardando slot',
  'sidebar.fila.varias': '{n} sessões aguardando slot',
  'sidebar.fila.ativos': '{ativos} de {maximo} agentes de pé',
  'sidebar.fila.limiteServidor.uma': '1 sessão no limite do servidor — os lançamentos estão espaçados',
  'sidebar.fila.limiteServidor.varias': '{n} sessões no limite do servidor — os lançamentos estão espaçados',
  'sidebar.fila.erro': 'o último lançamento falhou: {motivo}',
  'sidebar.fila.lancarAgora': 'Lançar agora',
  'sidebar.fila.lancarAgora.titulo': 'Ignora o escalonador uma vez',

  'sidebar.menu.rotulo': 'Menu',
  'sidebar.menu.ativarAvisos': 'Ativar avisos',
  'sidebar.menu.marcarLidas': 'Marcar todas como lidas',
  'sidebar.menu.alternarSidebar': 'Alternar sidebar',
  'sidebar.menu.uso': 'Uso…',
  'sidebar.menu.configuracoes': 'Configurações…',
  // O mesmo liga/desliga do `Ctrl+Shift+R`: o rótulo alterna pelo estado.
  'sidebar.notificacoes.titulo': 'Notificações (Ctrl+Shift+I)',
  'sidebar.notificacoes.rotulo': '{n} notificações não lidas',
  /** O sino fica sempre na tela: este é o rótulo dele quando não há nada. */
  'sidebar.notificacoes.nenhuma': 'Nenhuma notificação não lida',
  'sidebar.configuracoes.rotulo': 'Configurações',
  'sidebar.configuracoes.titulo': 'Configurações (Ctrl+,)',
  'sidebar.vazio': 'Nenhum workspace ainda.',
  'sidebar.rodape.novaTarefa': 'Nova tarefa',
  'sidebar.rodape.novaTarefa.titulo': 'Nova tarefa (Ctrl+Shift+Alt+N)',
  'sidebar.rodape.workspace': 'Workspace',
  'sidebar.rodape.workspace.titulo': 'Novo workspace (Ctrl+Shift+N)',
  'sidebar.largura': 'Largura da sidebar',

  // -------------------------------------------- UI — menu "⋯" do workspace
  'menu.diff': 'Ver diff',
  'menu.diff.titulo': 'git diff {base}...HEAD',
  'menu.mesclar': 'Mesclar no base',
  'menu.mesclar.titulo': 'mescla em {base}',
  'menu.mesclar.tituloDeduzida': 'mescla em {base} (base deduzida)',
  'menu.removerWorktree': 'Remover worktree',
  'menu.removerWorktree.titulo': 'remove a pasta e o branch {branch}',
  'menu.removerWorktree.tituloSemBranch': 'remove a pasta do worktree',
  'menu.definirBase': 'Definir base…',
  'menu.definirBase.titulo': 'base atual: {base}',
  'menu.definirBase.tituloDeduzida': 'base atual: {base} (base deduzida)',
  'menu.filtros.retirar': 'Retirar a confiança nos filtros',
  'menu.filtros.retirar.titulo': 'volta a NÃO rodar git que toque conteúdo neste repositório',
  'menu.filtros.confiar': 'Confiar nos filtros git deste repositório',
  'menu.filtros.confiar.titulo': 'os filtros clean/smudge do repo passam a rodar nas leituras do Bridge',
  'menu.ambiente.rotulo': 'Ambiente: {rotulo}',
  'menu.ambiente.semClaude': ' (sem claude)',
  'menu.ambiente.indisponivel': ' (indisponível)',
  'menu.ambiente.titulo': 'as próximas sessões deste workspace sobem em {id}',
  'menu.ambiente.padrao': 'Ambiente: padrão do Bridge',
  'menu.ambiente.padrao.titulo': 'volta a usar o shell da configuração global',
  // O `{menu}` é `core.escopo.menu.*` — a razão do deny cita ESTE item pelo
  // nome, então as duas frases têm que ser a mesma frase.
  'menu.escopo.restringir': 'Restringir ao {menu}',
  'menu.escopo.restringir.titulo': 'as sessões deste workspace voltam a ser barradas fora da raiz',
  'menu.escopo.permitir': 'Permitir acesso fora do {menu}',
  'menu.escopo.permitir.titulo': 'as sessões deste workspace passam a poder ler e escrever em qualquer lugar',
  'menu.novoClaude': 'Novo Claude Code',
  'menu.novoClaude.titulo': 'abre uma aba nova neste workspace com um Claude Code',
  'menu.novoTerminal': 'Novo terminal',
  'menu.novoTerminal.titulo': 'abre uma aba nova neste workspace com um shell',
  'menu.explorer': 'Abrir no Explorer',
  'menu.fechar': 'Fechar workspace',

  // ------------------------------------------------------ UI — barra de abas
  'tabs.tecla.espaco': 'Espaço',
  'tabs.dica.divide': 'divide',
  'tabs.dica.navega': 'navega',
  'tabs.dica.uso': 'uso',
  'tabs.dica.fechaPainel': 'fecha painel',
  'tabs.dica.titulo': '{acao} ({teclas})',
  'tabs.dica.semAtalho': '{acao} (sem atalho)',
  'tabs.mostrarSidebar': 'Mostrar sidebar',
  'tabs.mostrarSidebar.titulo': 'Mostrar sidebar (Ctrl+Shift+S)',
  'tabs.fechar': 'Fechar {titulo}',
  'tabs.nova': 'Nova aba',
  'tabs.nova.titulo': 'Nova aba (Ctrl+Shift+T)',

  // --------------------------------------------------- UI — painel (o vazio)
  'pane.vazio.shell': 'Abrir shell',
  'pane.vazio.shell.titulo': 'Abrir um shell neste painel (Enter)',
  'pane.vazio.claude': 'Abrir Claude Code',
  'pane.vazio.claude.titulo': 'Subir o Claude Code neste painel (Ctrl+Shift+C)',
  'pane.vazio.fechar': 'Fechar painel',
  'pane.vazio.fechar.titulo': 'Fechar este painel (Ctrl+Shift+X)',

  // ------------------------------------- UI — status, confirmação e perguntas
  'actions.semPainel.dividir': 'Nenhum painel pra dividir',
  'actions.semPainel.fechar': 'Nenhum painel pra fechar',
  'actions.semPainel.diff': 'Nenhum painel pra abrir o diff',
  'actions.semWorkspace.aba': 'Abra um workspace antes de criar uma aba',
  'actions.semWorkspace.agente': 'Abra um workspace antes de subir um agente',
  'actions.fila.mensagem':
    'Na fila do escalonador (posição {posicao}) — o Bridge sobe assim que houver slot. "Lançar agora" na sidebar ignora a espera.',
  'actions.fecharAba.uma': 'Fechar "{titulo}" encerra 1 sessão viva. Continuar?',
  'actions.fecharAba.varias': 'Fechar "{titulo}" encerra {n} sessões vivas. Continuar?',
  'actions.fecharPainel.confirma': 'Fechar este painel encerra a sessão {rotulo}. Continuar?',
  'actions.aguardeSessao': 'Aguarde a sessão abrir',
  'actions.semNaoLida': 'Nenhuma notificação não lida',
  'actions.naoEWorktree': 'Este workspace não é uma tarefa com worktree',
  'actions.semRepo': 'Este workspace não está ligado a um repositório conhecido',
  'actions.filtros.confirma':
    'Confiar nos filtros git deste repositório?\n\nOs comandos clean/smudge declarados no .git/config passam a ser EXECUTADOS pelas leituras automáticas do Bridge (o +N ~M da sidebar, a cada 15 s).\n\nConfie apenas em repositório de origem conhecida.',
  'actions.filtros.confiado': 'Filtros git deste repositório confiados.',
  'actions.filtros.retirado': 'Confiança nos filtros git retirada.',
  'actions.diff.baseInvalida': 'Base com nome inválido pra linha de comando: {base}',
  'actions.merge.confirma': 'Mesclar {branch} em {base}?',
  'actions.merge.baseDeduzida': '{base} (base deduzida)',
  'actions.merge.naoFf': 'Não é fast-forward. Fazer merge com commit?',
  'actions.merge.comCommit': 'Mesclado em {base} com commit de merge',
  'actions.merge.ff': 'Mesclado em {base} (fast-forward)',
  'actions.remover.confirma': 'Remover o worktree e o branch {branch}?',
  'actions.remover.confirmaDeduzida': 'Remover o worktree e o branch {branch}? (base deduzida: {base})',
  'actions.base.pergunta': 'Base de {branch} (branch, tag ou origin/<branch>):',
  'actions.base.definida': 'Base de {branch} agora é {base}',
  'actions.ambiente.desconhecido': 'Ambiente desconhecido: {id}',
  'actions.ambiente.definido': 'Ambiente de {nome}: {id} — vale nas próximas sessões',
  'actions.ambiente.padrao': 'Ambiente de {nome}: padrão do Bridge — vale nas próximas sessões',
  'actions.escopo.liberado': '{nome}: acesso fora do {menu} liberado — vale já, no próximo passo do agente',
  'actions.escopo.restrito': '{nome}: restrito ao {menu} — vale já, no próximo passo do agente',
  'actions.fecharWorkspace.confirma': 'Fechar o workspace {nome}? As sessões vivas dele são encerradas.',
  'actions.sessao.encerrar': 'Encerrar a sessão {rotulo}?',

  // ------------------------------------------------------------- UI — janela
  'app.reconectando': 'Reconectando ao core…',
  'app.acl.aviso': 'Não consegui restringir a permissão do instance.json — outro usuário desta máquina pode ler o token',
  'app.acl.fechar': 'Fechar o aviso nesta execução',
  'app.erro.core': 'Falha ao falar com o core: {motivo}',
  'app.erro.tentarDeNovo': 'Tentar de novo',
  'app.erro.semToken': 'Perdi o token do core. Feche e abra o Bridge de novo.',
  'app.token.dica': 'Cole o token de %APPDATA%\\bridge\\instance.json',
  'app.token.conectar': 'Conectar',
  'app.rodape.rodando': '{n} rodando',
  'app.rodape.pedemInput': '{n} pedem input',
  'app.rodape.travado': '{n} travado',
  'app.rodape.limiteServidor': '{n} no limite do servidor',
  /**
   * Duas chaves, e não uma com `{n}`: com uma só, o rodapé de quem tem UMA
   * sessão aberta dizia "1 sessões". É o mesmo par `.uma`/`.varias` da fila da
   * sidebar e do aviso de fechar aba. Zero usa o plural nos dois idiomas.
   */
  'app.rodape.core.uma': 'core {endereco} · 1 sessão',
  'app.rodape.core.varias': 'core {endereco} · {n} sessões',
  'app.vazio.parte1': 'Nenhum workspace ainda.',
  'app.vazio.parte2': 'cria o primeiro.',

  // ----------------------------------------------------- UI — configurações
  'settings.titulo': 'Configurações',
  'settings.fechar.rotulo': 'Fechar configurações',
  'settings.fechar.titulo': 'Fechar (Esc)',
  'settings.secoes': 'Seções',
  'settings.restaurar': 'Restaurar padrões',
  'settings.rodape.parte1': 'fecha · cada campo salva sozinho',

  'settings.secao.terminal': 'Terminal',
  'settings.secao.terminal.nota': 'fonte, corpo e o shell das sessões novas',
  'settings.secao.sessoes': 'Sessões',
  'settings.secao.sessoes.nota': 'quantos agentes ao mesmo tempo, e o que volta ao reabrir',
  'settings.secao.notificacoes': 'Notificações',
  'settings.secao.notificacoes.nota': 'quando o Bridge te chama',
  'settings.secao.uso': 'Uso',
  'settings.secao.uso.nota': 'custo estimado e a tabela de preços',
  'settings.secao.git': 'Git',
  'settings.secao.git.nota': 'de quanto em quanto tempo o core relê o worktree',
  'settings.secao.atalhos': 'Atalhos',
  'settings.secao.atalhos.nota': 'a tabela em vigor — edição no keybindings.json',
  'settings.secao.aparencia': 'Aparência',
  'settings.secao.aparencia.nota': 'tema e idioma da interface',
  'settings.secao.sistema': 'Sistema',
  'settings.secao.sistema.nota': 'início automático com o Windows',

  'settings.erro.fonteVazia': 'A fonte não pode ficar vazia.',
  'settings.erro.fonteLonga': 'A lista de fontes passa de 200 caracteres.',
  'settings.erro.corpoFonte': 'O corpo da fonte é um inteiro entre {min} e {max}.',
  'settings.erro.poll': 'O intervalo do poll é um inteiro entre {min} e {max} segundos.',
  'settings.erro.shell': 'Shell desconhecido: {valor}.',
  'settings.erro.maxAgentes': 'O máximo de agentes simultâneos é um inteiro entre {min} e {max}.',
  'settings.erro.arquivoPrecos': 'O caminho do arquivo de preços passa de {max} caracteres.',
  'settings.erro.idioma': 'Idioma desconhecido: {valor}.',
  'settings.erro.campoDesconhecido': 'Campo desconhecido: {campo}.',

  'settings.terminal.fonte': 'Fonte',
  'settings.terminal.fonte.nota':
    'Aceita uma lista com fallback, como no CSS. A ordem importa: o browser resolve fonte por glifo, e uma fonte sem box-drawing na frente quebra o logo do Claude Code.',
  'settings.terminal.tamanho': 'Tamanho',
  'settings.terminal.shell': 'Shell padrão',
  'settings.terminal.shell.nota': 'Vale para as sessões novas; as vivas continuam no shell com que nasceram.',
  'settings.terminal.previa.nota':
    'A moldura fecha e os blocos se encostam quando a fonte tem os glifos na largura da célula. Os três símbolos fora da caixa (✻ ❄ ⛔) nenhuma mono do Windows tem — eles sempre vêm de fallback.',

  'settings.sessoes.retomar': 'Ao reabrir, retomar as sessões do Claude Code automaticamente',
  'settings.sessoes.retomar.nota.parte1':
    'Vale só pros painéis que ainda tinham um Claude Code vivo quando o Bridge fechou — o que você encerrou na mão (',
  'settings.sessoes.retomar.nota.parte2': ', ✕, fechar painel) volta como shell com a dica do',
  'settings.sessoes.retomar.nota.parte3': '. Desligada, todo painel volta como shell.',
  'settings.sessoes.escalonar': 'Escalonar lançamentos de agente',
  'settings.sessoes.maxAgentes': 'Máximo de agentes ao mesmo tempo',
  'settings.sessoes.escalonador.nota':
    'O limite do SERVIDOR ("Server is temporarily limiting requests") não é o seu limite de uso e não escala com o plano: ele bate em quem sobe várias sessões de uma vez. Com o escalonador ligado, os lançamentos saem espaçados (300–900 ms), o que passar do teto entra numa fila visível na sidebar, e enquanto alguma sessão estiver no limite do servidor o espaçamento vira 5 s → 60 s. Desligado, todo pedido sobe na hora.',
  'settings.sessoes.autoRecap': 'Ao falhar o resume, injetar o resumo automaticamente',
  'settings.sessoes.autoRecap.nota':
    'Quando o Claude Code ignora o `--resume` e abre uma conversa nova, o Bridge percebe (o `session_id` do primeiro hook não é o que foi pedido) e monta um resumo determinístico do transcript anterior: seu último pedido e as últimas respostas, em texto puro, no máximo 2 500 caracteres. Não é o contexto de volta — é o suficiente pra retomar o assunto. Desligada (o padrão), a faixa no painel oferece "Reabrir com contexto" e você decide; ligada, o resumo é escrito no prompt do agente sozinho.',
  'settings.sessoes.escopo': 'Guarda de escopo entre worktrees',
  'settings.sessoes.escopo.nota':
    'Cada sessão de agente só pode ler e escrever dentro da raiz dela: o worktree, quando o workspace é uma tarefa; o repositório inteiro, quando não é. Um Read/Edit/Write/Glob/Grep fora disso volta recusado pro Claude, com o motivo. Comandos de Bash NÃO são barrados (o caminho de verdade depende do shell, e julgar texto de comando erraria nos dois sentidos). É uma proteção contra erro do agente e contra repositório hostil — não é uma barreira contra você: para liberar um workspace específico, use "Permitir acesso fora do worktree" no menu "⋯" dele.',
  'settings.sessoes.mouse': 'Clique do mouse no Claude Code',
  'settings.sessoes.mouse.nota':
    'Ligado, as sessões novas sobem o Claude Code na interface fullscreen (a que aceita clique nas opções e nas abas) e o terminal repassa o mouse ao programa. Desligado, o mouse fica com o Bridge: arrastar sempre seleciona texto. Vale pra sessões abertas depois da mudança.',
  'settings.sessoes.hospedados': 'Reconhecer o Claude Code aberto dentro de um shell',
  'settings.sessoes.hospedados.nota':
    'Cada shell que o Bridge abre nasce com um atalho `claude` na frente do PATH dele. Quando você digita `claude` ali dentro, ele sobe com as configurações do Bridge: a linha da sessão passa a mostrar `claude` com anel de estado, você recebe as notificações de "esperando você" e "terminei", e valem a statusline, o registro de uso e a guarda de escopo — como numa sessão de agente. A sessão continua sendo um shell (ela nunca vira uma sessão de agente, e ao sair do Claude a linha volta a dizer `shell`); ao reabrir o Bridge, o painel volta como shell, sem retomar a conversa. Ligar ou desligar vale pro próximo shell que você abrir — os que já estão de pé seguem como estão.',

  'settings.notificacoes.toasts': 'Mostrar toasts do sistema',
  'settings.notificacoes.silenciar': 'Silenciar com a janela do Bridge em foco',
  'settings.notificacoes.nota.parte1': 'Vale na próxima notificação. A lista de não lidas (',
  'settings.notificacoes.nota.parte2': ') continua registrando tudo mesmo com o toast desligado.',

  'settings.uso.mostrarCusto': 'Mostrar o custo estimado',
  'settings.uso.mostrarCusto.nota.parte1': 'Vale no painel',
  'settings.uso.mostrarCusto.nota.parte2':
    ', na linha da sessão na sidebar e na statusline devolvida ao Claude Code. Desligado, o painel conta tokens por dia no lugar do custo — o resto continua igual.',
  'settings.uso.mostrarCusto.nota.parte3': 'A estimativa usa a {tabela}.',
  'settings.uso.precosDe': 'tabela de preços de {data}',
  'settings.uso.linhaTerminal': 'Mostrar a linha de status no terminal do Claude Code',
  'settings.uso.linhaTerminal.nota':
    'Desligada (o padrão), o rodapé do Claude Code fica limpo e a sidebar continua mostrando exatamente os mesmos números: contexto, modelo, custo estimado e as janelas de 5 h e da semana. O Bridge continua lendo tudo isso do Claude Code do mesmo jeito — o que sai é só o texto no terminal. Ligue aqui se você prefere ver a linha também dentro do painel; vale na próxima vez que o Claude Code redesenhar a tela.',
  'settings.uso.arquivoPrecos': 'Arquivo de preços',
  'settings.uso.arquivoPrecos.placeholder': '(usando a tabela embutida)',
  'settings.uso.arquivoPrecos.nota':
    'Um JSON com a mesma forma do exemplo abaixo, lido na subida e a cada "Reler transcrições". Vazio volta pra tabela embutida. Arquivo ausente ou malformado vira aviso no painel, não erro.',
  'settings.uso.reler': 'Reler transcrições',
  'settings.uso.reler.nota':
    'Zera as contagens e relê todas as transcrições do zero. Responde quando termina — numa máquina com muito histórico isso leva minutos, não segundos.',
  'settings.uso.semPreco.titulo': 'Modelos sem preço na tabela em vigor:',
  'settings.uso.semPreco.nota.parte1': 'As mensagens deles entram nas contagens de tokens; o custo fica de fora. Aponte um arquivo acima (ou escreva',
  'settings.uso.semPreco.nota.parte2': 'no',
  'settings.uso.semPreco.nota.parte3': ') com esta forma — valores em USD por milhão de tokens:',

  'settings.git.intervalo': 'Intervalo do poll (segundos)',
  'settings.git.intervalo.nota':
    'De quanto em quanto tempo o core relê `+N ~M` dos worktrees. O poller é reagendado na hora, sem reiniciar o app; ele só roda com a janela em foco recente.',

  'settings.atalhos.abrirPasta': 'Abrir pasta do perfil',
  'settings.atalhos.dica': 'keybindings.json fica nessa pasta',
  'settings.atalhos.editarEm': 'keybindings.json fica nessa pasta. Edite em',
  'settings.atalhos.releitura': 'A tabela é lida a cada pedido: salvar o arquivo e reabrir o Bridge basta, sem reinstalar nada.',
  'settings.atalhos.colunaAcao': 'Ação',
  'settings.atalhos.colunaAtalho': 'Atalho',
  'settings.atalhos.acaoGenerica': 'uma ação',
  'settings.atalhos.aviso.um': 'Atenção: um problema no keybindings.json.',
  'settings.atalhos.aviso.varios': 'Atenção: {n} problemas no keybindings.json.',
  'settings.atalhos.problema.invalido': '{acao}: "{combinacao}" não é uma combinação que o Bridge saiba ler.',
  'settings.atalhos.problema.duplicado':
    '{acao}: mesma combinação de "{outra}" ({combinacao}), que vem antes e fica com a tecla.',
  'settings.atalhos.titulo.invalido': 'O Bridge não consegue ler esta combinação; ela nunca dispara.',
  'settings.atalhos.titulo.duplicado': 'Outra ação, mais acima na tabela, já usa esta combinação e fica com a tecla.',
  'settings.atalhos.arquivo.jsonInvalido':
    'O keybindings.json não é JSON válido: o arquivo inteiro foi descartado e valem os atalhos padrão.',
  'settings.atalhos.arquivo.naoEObjeto':
    'O keybindings.json não tem um objeto no topo: o arquivo inteiro foi descartado e valem os atalhos padrão.',
  'settings.atalhos.arquivo.acaoDesconhecida':
    '{acao} não é uma ação que o Bridge conheça; a linha do arquivo foi ignorada.',
  'settings.atalhos.arquivo.atalhoInvalido':
    '{acao}: o valor no arquivo não é um texto de combinação; o atalho padrão continua valendo.',
  'settings.atalhos.arquivo.generico': 'O core reclamou do keybindings.json ({kind}).',

  // Nome por extenso de cada ação de atalho — a primeira coluna da tabela e o
  // tooltip das dicas da barra de abas.
  'settings.atalhos.acao.workspaceNovo': 'Novo workspace',
  'settings.atalhos.acao.tarefaNova': 'Nova tarefa',
  'settings.atalhos.acao.abaNova': 'Nova aba',
  'settings.atalhos.acao.abaFechar': 'Fechar aba',
  'settings.atalhos.acao.painelDividirV': 'Dividir na vertical',
  'settings.atalhos.acao.painelDividirH': 'Dividir na horizontal',
  'settings.atalhos.acao.painelFechar': 'Fechar painel',
  'settings.atalhos.acao.painelEsquerda': 'Painel à esquerda',
  'settings.atalhos.acao.painelDireita': 'Painel à direita',
  'settings.atalhos.acao.painelAcima': 'Painel acima',
  'settings.atalhos.acao.painelAbaixo': 'Painel abaixo',
  'settings.atalhos.acao.workspaceAnterior': 'Workspace anterior',
  'settings.atalhos.acao.workspaceProximo': 'Próximo workspace',
  'settings.atalhos.acao.notificacoesPular': 'Pular pra não lida',
  'settings.atalhos.acao.notificacoesPainel': 'Painel de notificações',
  'settings.atalhos.acao.agenteClaude': 'Claude Code no painel',
  'settings.atalhos.acao.sidebarAlternar': 'Alternar sidebar',
  'settings.atalhos.acao.configuracoesAbrir': 'Abrir configurações',
  'settings.atalhos.acao.usoAbrir': 'Abrir o painel de uso',

  'settings.aparencia.tema': 'Tema',
  'settings.aparencia.tema.escuro': 'Escuro',
  'settings.aparencia.tema.nota': 'Outros temas em breve — o claro precisa de direção de design antes de existir.',
  'settings.aparencia.idioma': 'Idioma',
  'settings.aparencia.idioma.nota':
    'A troca vale na hora, na interface inteira — e também na CLI (`bridge`) e nas notificações do Windows. "Do sistema" segue o idioma do Windows: português em qualquer variante, inglês no resto.',

  'settings.sistema.inicio': 'Iniciar o Bridge junto com o Windows',
  'settings.sistema.minimizado': 'Começar minimizado na bandeja',
  'settings.sistema.consultando': 'Consultando o Windows…',
  'settings.sistema.nota':
    'Cria uma entrada em {chave} apontando pro Bridge instalado. Vem desligado, e o estado é lido do Windows — tirar a entrada por lá (Gerenciador de Tarefas › Aplicativos de inicialização) desmarca isto aqui.',
  'settings.sistema.nota.parte1':
    'Minimizado, o Bridge sobe com o core e as sessões já de pé, mas sem janela: ela aparece no clique do ícone da bandeja, no menu',
  'settings.sistema.nota.parte2': 'ou no clique de uma notificação.',
  'settings.sistema.mostrar': 'Mostrar',

  // ------------------------------------------------ UI — painel "Uso" e limites
  'uso.semPreco': 'sem preço',
  'uso.janela.cincoHoras': 'Limite de 5 horas',
  'uso.janela.semana': 'Limite da semana',
  'uso.janela.curta.cincoHoras': '5h',
  'uso.janela.curta.semana': 'sem',
  'uso.reseta.em': 'reseta em ',
  'uso.reseta.no': 'reseta ',
  'uso.diaSemana.curto.dom': 'dom',
  'uso.diaSemana.curto.seg': 'seg',
  'uso.diaSemana.curto.ter': 'ter',
  'uso.diaSemana.curto.qua': 'qua',
  'uso.diaSemana.curto.qui': 'qui',
  'uso.diaSemana.curto.sex': 'sex',
  'uso.diaSemana.curto.sab': 'sáb',
  'uso.diaSemana.longo.dom': 'no domingo',
  'uso.diaSemana.longo.seg': 'na segunda',
  'uso.diaSemana.longo.ter': 'na terça',
  'uso.diaSemana.longo.qua': 'na quarta',
  'uso.diaSemana.longo.qui': 'na quinta',
  'uso.diaSemana.longo.sex': 'na sexta',
  'uso.diaSemana.longo.sab': 'no sábado',
  'uso.mes.1': 'janeiro',
  'uso.mes.2': 'fevereiro',
  'uso.mes.3': 'março',
  'uso.mes.4': 'abril',
  'uso.mes.5': 'maio',
  'uso.mes.6': 'junho',
  'uso.mes.7': 'julho',
  'uso.mes.8': 'agosto',
  'uso.mes.9': 'setembro',
  'uso.mes.10': 'outubro',
  'uso.mes.11': 'novembro',
  'uso.mes.12': 'dezembro',
  'uso.recorte.hoje': 'hoje',
  'uso.recorte.semana': 'semana de {dia}',
  'uso.recorte.mes': 'mês',
  'uso.recorte.mesAno': '{mes} de {ano}',
  'uso.recorte.opcao.dia': 'dia',
  'uso.recorte.opcao.semana': 'semana',
  'uso.recorte.opcao.mes': 'mês',
  'uso.recorte.opcao.ano': 'ano',
  'uso.recorte.opcao.personalizado': 'personalizado',
  'uso.recorte.intervalo': '{de} – {ate}',
  'uso.cabecalho.dia': '{recorte} · o dia começa à meia-noite local',
  'uso.vazio.cabecalho': 'nada para somar ainda',
  'uso.vazio.titulo': 'Nenhuma transcrição encontrada em',
  'uso.vazio.dica':
    'Abra uma sessão do Claude Code em qualquer workspace e o Bridge soma os tokens na varredura seguinte, que roda a cada minuto. Transcrições em outra pasta: aponte o caminho em Configurações → Uso.',
  'uso.varredura.lendo': 'ainda lendo as transcrições ({feitos} de {total} arquivos)',
  'uso.varredura.linhaIgnorada.uma': '1 linha ignorada por tamanho',
  'uso.varredura.linhaIgnorada.varias': '{n} linhas ignoradas por tamanho',
  'uso.varredura.limitada': 'lista limitada a {n} arquivos',
  'uso.varredura.ressalva': '{partes} — a contagem abaixo é menor que o consumo real.',
  'uso.rescan.fracao': '{feitos} de {total} arquivos',
  'uso.rescan.lendo': 'Lendo… {fracao}',
  'uso.rescan.lendoPct': 'Lendo… {fracao} ({pct}%)',
  'uso.rescan.umDia': '1 dia',
  'uso.rescan.dias': '{n} dias',
  'uso.rescan.pronto': 'Pronto: {arquivos} arquivos, {mensagens} mensagens, {dias} com consumo.',
  'uso.limite.atingido': 'limite de uso atingido · {reset}',
  'uso.limite.atingidoSemReset': 'limite de uso atingido ({janela})',
  'uso.limite.titulo': '{janela}: {pct}% da sua cota. Este é o SEU limite de uso — ele reseta.',
  'uso.semLimites.rotulo': 'Sem limites de 5h e da semana',
  'uso.semLimites.nota':
    'O Claude Code só informa os limites de uso em contas de assinatura. A contagem e o custo abaixo continuam valendo.',
  'uso.cartao.entrada': 'Entrada',
  'uso.cartao.saida': 'Saída',
  'uso.cartao.cache': 'Cache',
  'uso.cartao.custo': 'Custo estimado',
  'uso.cartao.mensagens': 'Mensagens',
  'uso.cartao.tokens': 'tokens',
  'uso.cache.escrita': '{valor} escrita',
  'uso.cache.escrita1h': '{valor} escrita 1h',
  'uso.cache.leitura': '{valor} leitura',
  'uso.contagem': '{n} {itens}',
  'uso.substantivo.modelo.uma': 'modelo',
  'uso.substantivo.modelo.varias': 'modelos',
  'uso.substantivo.projeto.uma': 'projeto',
  'uso.substantivo.projeto.varias': 'projetos',
  'uso.subagentes': 'inclui {n} de subagentes',
  'uso.grafico.titulo.custo': 'Custo por dia',
  'uso.grafico.titulo.tokens': 'Tokens por dia',
  'uso.grafico.tokens': '{valor} tokens',
  'uso.grafico.mensagens': '{n} mensagens',
  'uso.tabela.outros': 'outros ({n} {itens})',
  'uso.aviso.semPreco.um': '1 modelo sem preço na tabela',
  'uso.aviso.semPreco.varios': '{n} modelos sem preço na tabela',
  'uso.aviso.maisModelos.um': '(e mais 1 modelo)',
  'uso.aviso.maisModelos.varios': '(e mais {n} modelos)',
  /**
   * O começo de `core.uso.aviso.modeloSemPreco`, para separar os avisos "sem
   * preço" (que a caixa do painel já mostra com a lista) dos avisos de TABELA
   * (arquivo ilegível, override malformado), que não têm outro lugar. Os dois
   * textos precisam começar igual — se um mudar, o outro muda junto.
   */
  'uso.aviso.prefixoSemPreco': 'modelo sem preço',
  'uso.rodape.projeto':
    'Projeto é a pasta de trabalho da sessão do Claude Code, não o workspace do Bridge: duas tarefas na mesma pasta somam no mesmo projeto.',
  'uso.rodape.custo':
    'pela tabela de preços embutida — não é fatura: tokens contados nas transcrições × preço por modelo. Ajuste ou troque a tabela em',

  // ------------------------------------------- UI — painel "Uso" (a tela)
  // O que o `usageModel` NÃO decide: os rótulos que o próprio `.tsx` escreve
  // (título, cabeçalhos de tabela, dicas de seção, o CTA do estado vazio).
  'uso.painel.titulo': 'Uso',
  'uso.painel.fechar.rotulo': 'Fechar painel de uso',
  'uso.painel.fechar.titulo': 'Fechar (Esc)',
  'uso.painel.somando': 'Somando…',
  'uso.painel.reler': 'Reler transcrições',
  'uso.painel.lendoDe': 'Lendo de {home}.',
  'uso.painel.intervalo': 'Intervalo',
  'uso.painel.grafico.dica': 'últimos 30 dias · barra azul = intervalo selecionado',
  'uso.painel.grafico.dicaJanela': '{de} a {ate} · barra azul = intervalo selecionado',
  'uso.painel.periodo.navegacao': 'Navegar entre períodos',
  'uso.painel.periodo.anterior': 'Período anterior',
  'uso.painel.periodo.proximo': 'Próximo período',
  'uso.painel.periodo.hoje': 'Hoje',
  'uso.painel.periodo.hojeTitulo': 'Voltar ao período de hoje',
  'uso.painel.periodo.livre': 'Período personalizado',
  'uso.painel.periodo.de': 'De',
  'uso.painel.periodo.ate': 'Até',
  'uso.painel.periodo.invalido': 'período inválido: até {max} dias, de {min} até hoje',
  'uso.painel.tabela.porModelo': 'Por modelo',
  'uso.painel.tabela.modelo': 'Modelo',
  'uso.painel.tabela.porProjeto': 'Por projeto',
  'uso.painel.tabela.projeto': 'Projeto',
  'uso.painel.tabela.dicaProjeto': '8 maiores + outros',
  'uso.painel.tabela.msg': 'Msg',
  'uso.painel.tabela.tokens': 'Tokens',
  'uso.painel.tabela.tokens.titulo': 'entrada + saída + cache',
  'uso.painel.tabela.custo': 'Custo',
  'uso.painel.tabela.total': 'Total',
  /** O caminho de navegação que o rodapé e o aviso citam — escrito num lugar só. */
  'uso.painel.configuracoesUso': 'Configurações → Uso',
  // Frases INTEIRAS (e não pedaços de frase) dos dois lados do
  // `<strong>Configurações → Uso</strong>`: a ordem das palavras muda entre os
  // idiomas, e quebrar por palavra deixaria o inglês torto.
  'uso.painel.semPreco.um': 'as mensagens dele entram nas contagens, o custo não.',
  'uso.painel.semPreco.varios': 'as mensagens deles entram nas contagens, o custo não.',
  'uso.painel.semPreco.arquivo': 'aceita um arquivo de preços.',

  // --------------------------------------------------- UI — painel (o resto)
  /** O rótulo do cabeçalho quando não há sessão nenhuma neste painel. */
  'pane.vazio.rotulo': 'painel vazio',
  'pane.encerrou': 'encerrou · código {codigo}',
  'pane.encerrou.processo': 'processo encerrou · código {codigo}',
  'pane.fechar.rotulo': 'Fechar painel',
  /** Menu "Dividir" do cabeçalho do painel (10/09/2026). */
  'pane.dividir.rotulo': 'Dividir painel',
  'pane.dividir.lado': 'Dividir ao lado',
  'pane.dividir.lado.titulo': 'abre um painel vazio à direita deste',
  'pane.dividir.abaixo': 'Dividir abaixo',
  'pane.dividir.abaixo.titulo': 'abre um painel vazio abaixo deste',
  'pane.dividir.trazerLado': 'Trazer {aba} pro lado',
  'pane.dividir.trazerAbaixo': 'Trazer {aba} pra baixo',
  'pane.dividir.trazer.titulo': 'a aba sai da barra e entra neste split; o que roda nela continua rodando',
  /** Como uma aba aparece no menu: o título dela e a posição na barra. */
  'pane.dividir.aba': '{titulo} {n}',
  'pane.fechar.titulo': 'Fechar painel (Ctrl+Shift+X)',
  'pane.fechar.nascendo': 'Uma sessão está nascendo neste painel — espere ela aparecer',
  /** A faixa de saída: cada frase vem DEPOIS do seu `<kbd>` (ver as notas em partes). */
  'pane.saida.enter': 'reabre um shell',
  'pane.saida.claude': 'Claude de novo',

  // ------------------------------------------------ UI — reabrir com contexto
  // Dor verificada #3. O RESUMO em si vem do core (`POST /api/sessions/:id/
  // recap`), já traduzido — a UI não o retraduz; o que está aqui é o que a UI
  // escreve EM VOLTA dele.
  'recap.faixa': 'A conversa anterior não foi retomada (o Claude abriu uma sessão nova).',
  'recap.reabrir': 'Reabrir com contexto',
  'recap.reabrir.titulo': 'Monta um resumo automático do transcript anterior e escreve no prompt do Claude Code',
  'recap.ignorar': 'Ignorar',
  'recap.ignorar.titulo': 'Some com este aviso; nada é escrito no terminal',
  /** UMA LINHA, sem `\n`: o texto vai pro PTY sem bracketed paste (ver `recap.ts`). */
  'recap.prompt.prefixo': 'Contexto da sessão anterior (resumo automático do Bridge): ',
  'recap.prompt.sufixo': ' — Continue de onde parou.',
  'recap.erro': 'Não deu pra montar o resumo da conversa anterior: {detalhe}',
  'recap.enviado': 'Resumo da conversa anterior enviado ao Claude Code ({n} caracteres).',

  // ------------------------------------------------------- UI — restauração
  // As três `restore.faixa.*` de texto são a linha do painel restaurado
  // (`.pane-restore-strip`). Até 13/09/2026 eram escritas no xterm, e o
  // `ESC[2J` do ConPTY as apagava.
  'restore.faixa.dica': 'sessão anterior era Claude Code · Ctrl+Shift+C pra subir de novo',
  'restore.faixa.retomando': 'retomando a sessão anterior do Claude Code',
  'restore.faixa.retomandoId': 'retomando a sessão anterior do Claude Code · {id}',
  'restore.faixa.dispensar': 'Dispensar aviso',
  'restore.faixa.dispensar.titulo': 'Some com este aviso; o terminal não muda',
  'restore.erro.umPainel': 'Não consegui reabrir o shell em um painel',
  'restore.erro.variosPaineis': 'Não consegui reabrir {n} painéis',
  'restore.erro.resume': 'Não deu pra retomar o Claude Code: {detalhe}',

  // ------------------------------------------------------------ UI — diálogos
  'dialog.cancelar': 'Cancelar',
  'dialog.dica.esc': 'cancela',
  'dialog.dica.enter': 'cria',
  'dialog.criando': 'Criando…',
  'dialog.escolher': 'Escolher…',

  'dialog.workspace.titulo': 'Novo workspace',
  'dialog.workspace.subtitulo': 'uma pasta, várias sessões',
  'dialog.workspace.pasta': 'Pasta',
  'dialog.workspace.pasta.placeholder': 'C:\\projetos\\meu-repo',
  'dialog.workspace.pasta.prompt': 'Pasta do workspace',
  /** O mesmo seletor, mas na nova TAREFA: o que se escolhe ali é o repositório. */
  'dialog.task.pasta.prompt': 'Pasta do repositório',
  'dialog.workspace.nome': 'Nome',
  'dialog.workspace.ambiente': 'Ambiente',
  'dialog.workspace.ambiente.padrao': 'Padrão do Bridge (shell da configuração)',
  'dialog.workspace.ambiente.semClaude': ' — sem claude',
  'dialog.workspace.ambiente.indisponivel': ' — indisponível',
  'dialog.workspace.nota.padrao': 'Sem escolha, vale o shell da configuração do Bridge.',
  'dialog.workspace.nota.wsl': 'O shell e o Claude Code sobem dentro da distro, com os caminhos traduzidos.',
  'dialog.workspace.nota.shell': 'Muda o shell das sessões de terminal; o Claude Code continua rodando no Windows.',
  'dialog.workspace.abrirClaude': 'Abrir um Claude Code no primeiro painel',
  'dialog.workspace.claudeNaoSubiu': 'Workspace criado, mas o Claude não subiu: {detalhe}',
  'dialog.workspace.criar': 'Criar workspace',

  'dialog.task.titulo': 'Nova tarefa',
  'dialog.task.subtitulo': 'um worktree git por tarefa',
  'dialog.task.repositorio': 'Repositório',
  'dialog.task.escolhaRepo': 'Escolha um repositório…',
  'dialog.task.escolherPasta': 'Escolher pasta…',
  'dialog.task.nome': 'Nome da tarefa',
  'dialog.task.nome.placeholder': 'mailbox do chefe',
  'dialog.task.base': 'Base',
  'dialog.task.branch': 'branch: {branch}',
  'dialog.task.branch.vazio': 'branch: —',
  'dialog.task.nomeInvalido': 'nome inválido: sobra vazio depois de normalizar',
  'dialog.task.subirClaude': 'Subir Claude Code no primeiro painel',
  'dialog.task.criar': 'Criar tarefa',
  'dialog.task.erro.existe': 'Já existe uma tarefa com esse nome',
  'dialog.task.erro.naoERepo': 'A pasta escolhida não é um repositório git',
  'dialog.task.detect.naoERepo': 'não é um repositório git',
  'dialog.task.aviso.claudeNaoSubiu': 'Tarefa criada, mas o Claude não subiu — abra com Ctrl+Shift+C',

  // ------------------------------------------------- UI — painel de avisos
  'notifications.titulo': 'Notificações',
  'notifications.naoLidas': '{n} não lidas',
  'notifications.fechar': 'Fechar',
  'notifications.filtro.todos': 'Todos',
  'notifications.marcarLidas': 'marcar todas como lidas',
  'notifications.vazio': 'Nada por aqui.',
  /** Cabeçalho da linha, por `kind`: é o que responde "o que foi que alertou". */
  'notifications.tipo.needs-input': 'Precisa de você',
  'notifications.tipo.done': 'Terminou',
  'notifications.tipo.stuck': 'Travado',
  'notifications.tipo.custom': 'Aviso',
  /** O rótulo de uma linha cuja sessão o app já esqueceu. */
  'notifications.sessao': 'sessão',
  'notifications.rodape.foco': 'vai pra quem chamou',
  'notifications.rodape.fecha': 'fecha',

  // ================================================================ SHELL
  // O processo main do Electron (bandeja, toast nativo, diálogos de erro).
  // O que NÃO passa por aqui, por decisão da
  // spec §13: as linhas de `shell.log`, que são do dono e do suporte.
  'shell.bandeja.mostrar': 'Mostrar',
  'shell.bandeja.sair': 'Sair',
  'shell.bandeja.naoLidas': 'Bridge · {n} não lidas',
  /** O resumo represado da janela de coalescência de 2 s (spec §4). */
  'shell.toast.resumo': '{n} avisos · último: {texto}',
  'shell.fatal.coreNaoSubiu': 'O core não subiu: veja logs/shell.log',
  'shell.fatal.coreEncerrou': 'O core encerrou inesperadamente: veja logs/shell.log',
  'shell.fatal.semNode': 'Bridge precisa do Node.js 22+ no PATH (ou BRIDGE_NODE=<caminho>)',
  'shell.fatal.inesperado': 'Erro inesperado: {detalhe}\nVeja logs/shell.log',
  // O início automático com o Windows: são CHAVES que atravessam o IPC, não
  // frases — quem traduz é a UI, com o idioma dela (ver `loginItemView`).
  'shell.loginItem.dev':
    'Disponível só no app instalado: em desenvolvimento o executável é o electron.exe, e o Windows abriria o Electron cru no próximo login.',
  'shell.loginItem.plataforma': 'O início automático do Bridge só existe no Windows.',
  /**
   * O terceiro valor do mesmo conjunto, e o único que NÃO vem do shell: a UI
   * aberta num navegador comum não tem processo main nenhum (`bridge.ts`, `webShim`).
   * Mora aqui porque é a mesma pergunta ("por que não dá pra mexer nisto?") e
   * quem a responde na tela é a MESMA função (`loginItemView`).
   */
  'shell.loginItem.web': 'O início automático com o Windows está disponível só no app instalado.',

  // ================================================================ CLI
  'cli.erro.semCore': 'Bridge não está aberto (instance.json não encontrado ou core morto)',
  'cli.erro.flagDesconhecida': 'flag desconhecida: --{flag}',
  'cli.erro.comandoDesconhecido':
    'comando desconhecido: {comando} — use notify, list, focus, new, task, resume, send, status, usage ou watch',
  'cli.erro.comandoNenhum': '(nenhum)',
  'cli.uso.notify': 'uso: bridge notify "texto" [--session <id>] (ou -- "--texto")',
  'cli.uso.focus': 'uso: bridge focus <sessionId|workspace>',
  'cli.uso.send': 'uso: bridge send <sessionId> "texto" (ou -- "--texto")',
  'cli.uso.task': 'uso: bridge task <new|merge|rm> ...',
  'cli.uso.taskNew': 'uso: bridge task new <repo> <nome> [--base <branch>] [--no-agent]',
  'cli.uso.taskMerge': 'uso: bridge task merge <workspace> [--no-ff]',
  'cli.uso.taskRm': 'uso: bridge task rm <workspace>',
  'cli.uso.watch': 'uso: bridge watch [--events notification,session] [--json]',

  'cli.notify.semSessao': 'sem sessão: use --session ou rode de dentro de um painel do Bridge',
  'cli.notify.enviada': 'Notificação enviada.',
  'cli.notify.enviadaCortada': 'Notificação enviada (texto cortado em {max} caracteres).',

  'cli.list.cabecalho.id': 'id',
  'cli.list.cabecalho.workspace': 'workspace',
  'cli.list.cabecalho.estado': 'estado',
  'cli.list.cabecalho.detail': 'detail',
  'cli.list.cabecalho.idade': 'há',
  'cli.tabela.vazio': '(vazio)',

  'cli.focus.emFoco': 'Sessão em foco: {sessionId}',

  'cli.new.splitInvalido': 'valor inválido para --split: use v ou h (recebido "{valor}")',
  'cli.new.envInvalido': 'valor inválido para --env: use pwsh, powershell, gitbash, wsl:<distro> ou padrao (recebido "{valor}")',
  'cli.new.semWorkspace': 'nenhum workspace encontrado; crie um pelo Bridge antes',
  'cli.new.ambientePadrao': 'padrão do Bridge',
  'cli.new.ambiente': ' · ambiente {ambiente}',
  'cli.new.enfileirada':
    'Sessão enfileirada (posição {posicao}) no workspace {workspace}{onde}. O Bridge sobe assim que houver slot — "Lançar agora" na sidebar ignora a espera.',
  'cli.new.criada': 'Sessão {id} criada ({tipo}) no workspace {workspace}{onde}.',

  'cli.task.criada': 'Tarefa {nome} criada{onde}.',
  'cli.task.criadaEm': ' em {caminho}',
  'cli.task.mergeConcluido': 'Merge ({modo}) de {workspace} concluído{detalhe}.',
  'cli.task.mergeDetalhe': ': {mensagem}',
  'cli.task.worktreeRemovido': 'Worktree de {workspace} removido.',
  'cli.task.tenteNoFf': '{erro} — tente: bridge task merge {workspace} --no-ff',


  'cli.resume.retomando': 'Retomando a conversa {conversa} no painel {paneId}',
  'cli.resume.outroPainel': '{erro} — passe outro painel: bridge resume <paneId>',

  'cli.send.enviado': 'Enviado.',


  'cli.status.ativo': 'Bridge ativo — porta {porta}, {sessoes} sessão(ões), versão {versao}.',

  'cli.resolve.nomeAmbiguo': 'nome ambíguo: {n} workspaces chamados \'{nome}\' — use o id: {opcoes}',
  'cli.resolve.workspaceNaoEncontrado': 'workspace não encontrado: {alvo}',
  'cli.resolve.workspaceSemSessao': 'workspace sem sessão: {alvo}',
  'cli.resolve.workspaceSemAba': 'workspace sem aba de terminal: {workspace}',

  'cli.watch.ligado': '# ligado em 127.0.0.1:{porta} ({filtro}) — Ctrl+C pra sair',
  'cli.watch.eventos': 'eventos: {eventos}',
  'cli.watch.todosEventos': 'todos os eventos',
  'cli.watch.coreFechou': '# o core fechou a conexão',
  'cli.watch.semType': '(sem type)',

  // --------------------------------------------------------- CLI — `usage`
  'cli.uso.range.dia': 'dia',
  'cli.uso.range.semana': 'semana',
  'cli.uso.range.mes': 'mês',
  'cli.uso.range.ano': 'ano',
  'cli.uso.range.personalizado': 'personalizado',
  'cli.uso.rangeInvalido': 'range inválido: {valor} — use dia, semana, mes ou ano (período livre: --de e --ate)',
  'cli.uso.rangeSemValor': '--range precisa de um valor: dia, semana, mes ou ano',
  'cli.uso.rescanComRange': '--rescan relê todas as transcrições e não aceita --range, --anchor, --de nem --ate',
  'cli.uso.dataSemValor': '--{flag} precisa de uma data AAAA-MM-DD',
  'cli.uso.dataInvalida': 'data inválida em --{flag}: {valor} — use AAAA-MM-DD',
  'cli.uso.periodoIncompleto': 'período personalizado precisa de --de e --ate',
  'cli.uso.anchorComPeriodo': '--anchor não combina com --de/--ate: escolha um recorte ancorado ou um período',
  'cli.uso.rangeComPeriodo': '--de/--ate já definem um período personalizado — tire o --range {range}',
  'cli.uso.releituraConcluida': 'Releitura concluída: {arquivos} transcrições, {mensagens} mensagens, {dias} com consumo.',
  'cli.uso.dias.um': '1 dia',
  'cli.uso.dias.varios': '{n} dias',
  'cli.uso.cabecalho': 'Uso — {range} ({periodo}) · fuso {tz}',
  'cli.uso.periodoIntervalo': '{de} a {ate}',
  'cli.uso.varredura': 'varredura em andamento: {feitos} de {total} transcrições lidas — os números ainda vão subir',
  'cli.uso.linhasIgnoradas.uma': '1 linha ignorada por tamanho',
  'cli.uso.linhasIgnoradas.varias': '{n} linhas ignoradas por tamanho',
  'cli.uso.listaLimitada': 'lista limitada a {n} arquivos',
  'cli.uso.ressalva': '{partes} — a contagem abaixo é menor que o consumo real',
  'cli.uso.totais': 'Totais',
  'cli.uso.linha.entrada': 'entrada',
  'cli.uso.linha.saida': 'saída',
  'cli.uso.linha.cache': 'cache',
  'cli.uso.linha.mensagens': 'mensagens',
  'cli.uso.linha.custo': 'custo',
  'cli.uso.coluna.valor': 'valor',
  'cli.uso.cache.escrita': '{tokens} escrita',
  'cli.uso.cache.escrita1h': '{tokens} escrita 1h',
  'cli.uso.cache.leitura': '{tokens} leitura',
  'cli.uso.semPrecoNaTabela': 'nenhum modelo do recorte tem preço na tabela',
  'cli.uso.estimativa': 'estimativa · tabela de {data}',
  'cli.uso.estimativaParcial': 'estimativa · tabela de {data} · parcial (ver avisos)',
  'cli.uso.incluiSubagentes': '  inclui subagentes: {pct} dos tokens ({parte} de {total})',
  'cli.uso.porModelo': 'Por modelo',
  'cli.uso.coluna.modelo': 'modelo',
  'cli.uso.coluna.tokens': 'tokens',
  'cli.uso.coluna.mensagens': 'mensagens',
  'cli.uso.coluna.custo': 'custo',
  'cli.uso.semPreco': 'sem preço',
  'cli.uso.porProjeto': 'Por projeto',
  'cli.uso.porProjetoTop': 'Por projeto ({top} maiores de {total})',
  'cli.uso.coluna.projeto': 'projeto',
  'cli.uso.outrosProjetos': 'outros ({n} projetos)',
  'cli.uso.limites': 'Limites',
  'cli.uso.semLimites': '  (nenhum) — o Claude Code só informa limites em conta de assinatura',
  'cli.uso.coluna.janela': 'janela',
  'cli.uso.coluna.usado': 'usado',
  'cli.uso.coluna.reseta': 'reseta',
  'cli.uso.avisos': 'Avisos',
  'cli.uso.reseta.minutos': 'em {n}min',
  'cli.uso.reseta.horas': 'em {n}h',
  'cli.uso.reseta.horasMinutos': 'em {h}h{m}',

  // A ajuda inteira é UMA chave: o alinhamento das colunas é parte do texto, e
  // quebrá-la em trinta chaves deixaria a tradução impossível de conferir.
  'cli.ajuda': `bridge — CLI do Bridge (versão {versao})

Uso: bridge <comando> [argumentos] [--json]

  bridge notify "texto" [--session <id>]     avisa o dono a partir da sessão atual
  bridge list                                sessões: id, workspace, estado, detail, idade
  bridge focus <sessionId|workspace>         traz a janela e foca a sessão
  bridge new [--agent claude] [--cwd <pasta>] [--workspace <id>] [--split v|h] [--env <ambiente>]
  bridge task new <repo> <nome> [--base <branch>] [--no-agent]
  bridge task merge <workspace> [--no-ff]    default ff-only
  bridge task rm <workspace>
  bridge resume [paneId]                     retoma a conversa do agente no painel
  bridge send <sessionId> "texto"            escreve no stdin da sessão (a CLI põe o \\r)
  bridge status                              core vivo? porta, versão, sessões
  bridge usage [--range dia|semana|mes|ano] [--anchor AAAA-MM-DD]
                                             consumo, custo estimado e limites
  bridge usage --de AAAA-MM-DD --ate AAAA-MM-DD   o mesmo, num período livre
  bridge usage --rescan                      relê todas as transcrições do zero
  bridge watch [--events notification,session]   os eventos do core, um por
                                             linha, até Ctrl+C

  --json      imprime o corpo cru em vez da frase traduzida (vale em todos)
  --help      esta ajuda            --version   só o número da versão
  --          encerra as flags: o resto é texto, mesmo começando com --

A instância vem de BRIDGE_PORT/BRIDGE_TOKEN (o ambiente de todo painel do
Bridge) ou do instance.json do perfil. O token nunca é impresso nem aceito
por argumento.`,
} as const;

/**
 * Toda chave que existe. Vem do catálogo pt-BR de propósito: acrescentar uma
 * chave só no `en.ts` não a torna real — ela não teria texto em português.
 */
export type MessageKey = keyof typeof ptBR;
