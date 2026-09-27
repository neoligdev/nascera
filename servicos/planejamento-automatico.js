// ═══════════════════════════════════════════════════════════════════════
// NASCERA — pipeline invisível de planejamento automático
//
// Pedidos de "construir algo novo" passam primeiro por uma sessão OpenCode
// GRATUITA (modelo opencode/big-pickle), que conversa com o usuário só o
// necessário e escreve um PRD; só depois o Claude entra para construir —
// sem gastar tokens caros explorando ou perguntando. Invisível: o usuário
// nunca escolhe motor, nunca vê o PRD.
//
// Este arquivo é só a DECISÃO e o ESTADO (classificador, elegibilidade, teto
// de segurança, textos fixos). A troca de canal em si (fechar a sessão
// normal, reabrir em modo planejamento, ouvir o marcador, fazer o handoff de
// volta) fica em servicos/motor-ws.js, que já é quem segura a referência
// viva do canal/WebSocket — ver docs/superpowers/specs/
// 2026-09-26-pipeline-opencode-planejamento-claude-build-design.md
// ═══════════════════════════════════════════════════════════════════════

// Marcador que o prompt de planejamento instrui o OpenCode a emitir sozinho,
// na ÚLTIMA linha da resposta, quando o PRD estiver pronto. Nunca deve
// alcançar o usuário — quem chama detectarMarcador() já recebe o texto sem
// ele (ver extrairPRD).
const MARCADOR_CONCLUSAO = '[[NASCERA_PRD_PRONTO]]';

const MODELO_PLANEJAMENTO = 'opencode/big-pickle';

// Teto de segurança: nunca deixa o usuário esperando um modelo grátis
// travado numa conversa sem fim. Ao estourar qualquer um dos dois, o
// handoff acontece mesmo sem o marcador, com o que houver até ali.
const MAX_RODADAS = 6;
const MAX_MS_PLANEJAMENTO = 5 * 60 * 1000;

const PROMPT_PLANEJAMENTO = [
  'Você está na fase de PLANEJAMENTO de um pedido de construção de site/app —',
  'não escreva código nenhum aqui, só entenda o pedido e produza um PRD.',
  'Converse com o usuário SÓ o suficiente para tirar ambiguidade real; não',
  'prolongue perguntando o óbvio. Quando tiver clareza suficiente, escreva um',
  'PRD curto em markdown (o que é, para quem, principais telas/funcionalidades,',
  'decisões de escopo) como sua ÚLTIMA mensagem desta fase, terminando essa',
  'mensagem, sozinha na última linha, com exatamente:',
  MARCADOR_CONCLUSAO,
  'Nunca mencione este marcador nem explique que ele existe — é uso interno.',
].join('\n');

// ── Classificador (heurística v1 — ver nota no fim do arquivo) ──────────
// Curto-circuito: texto que parece relatório de erro nunca vira PRD, mesmo
// se também tiver uma palavra de "construir" no meio.
const PARECE_ERRO = /(error:|exception|stack trace|traceback|at\s+\S+\.(js|ts|mjs|cjs):\d+)/i;

const PALAVRAS_TRIVIAIS = /\b(corrig[ei]|conserta|conserte|ajusta|ajuste|troca a cor|troca a fonte|troque a cor|troque a fonte|bug|erro|não (está|funciona)|nao (esta|funciona)|deixa (mais|menos)|deixe (mais|menos)|pequeno ajuste|fix|tweak|typo)\b/i;

const PALAVRAS_BUILD = /\b(crie|criar|construir|construa|monte|montar|adicionar? (uma )?funcionalidade|nova funcionalidade|novo (site|sistema|app|dashboard|projeto|aplicativo)|do zero|from scratch|build|implement|implemente|feature)\b/i;

// `primeiraMensagem` (projeto sem histórico de chat ainda) é o sinal mais
// forte que existe de "isto é um build novo" — mais forte que qualquer
// palavra-chave, porque é objetivo (não depende do usuário escrever certo).
function classificar(mensagem, { primeiraMensagem } = {}) {
  const texto = String(mensagem || '');
  if (PARECE_ERRO.test(texto)) return 'build';
  if (primeiraMensagem) return 'planejar';
  if (PALAVRAS_TRIVIAIS.test(texto) && texto.length < 400) return 'build';
  if (PALAVRAS_BUILD.test(texto)) return 'planejar';
  // Padrão conservador: na dúvida, não atrasa — vai direto pro Claude.
  return 'build';
}

function criar(deps) {
  const { loadNasceraConfig, motores } = deps;

  // Estado em memória, por projeto — deliberadamente NÃO persistido: se o
  // servidor reiniciar no meio do planejamento, a próxima mensagem do
  // usuário simplesmente vai direto pro Claude (ver elegivelParaPipeline:
  // sem estado, estaPlanejando() é false e o classificador decide de novo).
  const estados = new Map();

  function estaPlanejando(projectId) {
    return !!projectId && estados.has(projectId);
  }

  // Falso quando o admin desligou o pipeline, forçou um motor específico
  // pra instalação toda, ou o PRÓPRIO projeto tem um motor forçado (escape
  // hatch de suporte/debug já existente) — em qualquer um desses casos, o
  // pipeline automático não deve pisar na escolha explícita de alguém.
  function elegivelParaPipeline(proj) {
    const cfg = loadNasceraConfig() || {};
    if (cfg.pipelineAutomatico === false) return false;
    if (motores.ehValido(cfg.motor) && cfg.motor !== 'claude') return false;
    if (proj && motores.ehValido(proj.motor)) return false;
    return true;
  }

  function motorTemporario(projectId) {
    return estaPlanejando(projectId) ? 'opencode' : null;
  }

  function modeloTemporario(projectId) {
    return estaPlanejando(projectId) ? MODELO_PLANEJAMENTO : null;
  }

  function promptPrefixoTemporario(projectId) {
    return estaPlanejando(projectId) ? PROMPT_PLANEJAMENTO : null;
  }

  function iniciarPlanejamento(projectId, mensagemOriginal) {
    estados.set(projectId, {
      rodadas: 0,
      iniciadoEm: Date.now(),
      ultimaMensagemUsuario: mensagemOriginal,
    });
  }

  // Chamado a cada mensagem enviada pro OpenCode durante o planejamento —
  // guarda a mensagem crua (pra reenviar ao Claude se o OpenCode falhar) e
  // devolve se o teto de segurança já foi atingido.
  function registrarRodada(projectId, mensagemOriginal) {
    const e = estados.get(projectId);
    if (!e) return { estourou: false };
    e.rodadas += 1;
    if (mensagemOriginal !== undefined) e.ultimaMensagemUsuario = mensagemOriginal;
    const estourou = e.rodadas >= MAX_RODADAS || (Date.now() - e.iniciadoEm) >= MAX_MS_PLANEJAMENTO;
    return { estourou };
  }

  function mensagemParaRetomar(projectId) {
    const e = estados.get(projectId);
    return e ? e.ultimaMensagemUsuario : '';
  }

  function finalizarPlanejamento(projectId) {
    estados.delete(projectId);
  }

  function detectarMarcador(texto) {
    return String(texto || '').includes(MARCADOR_CONCLUSAO);
  }

  // PRD = a resposta do OpenCode sem o marcador (que nunca deve sobreviver
  // até o arquivo nem até o usuário).
  function extrairPRD(texto) {
    return String(texto || '').split(MARCADOR_CONCLUSAO).join('').trim();
  }

  return {
    classificar, elegivelParaPipeline, estaPlanejando,
    motorTemporario, modeloTemporario, promptPrefixoTemporario,
    iniciarPlanejamento, registrarRodada, mensagemParaRetomar, finalizarPlanejamento,
    detectarMarcador, extrairPRD,
    MARCADOR_CONCLUSAO, MAX_RODADAS, MAX_MS_PLANEJAMENTO,
  };
}

module.exports = { criar, classificar, MARCADOR_CONCLUSAO, PROMPT_PLANEJAMENTO, MODELO_PLANEJAMENTO };

// NOTA (heurística v1): classificar() é deliberadamente ingênuo — palavra-
// chave + tamanho + "projeto vazio". Vai errar em pedidos ambíguos ou mal
// escritos. ponytail: evoluir para uma classificação por modelo barato (ou
// pelo próprio big-pickle, com um prompt de 1 palavra de resposta) se a
// precisão não for suficiente na prática — não vale a complexidade agora
// sem medir o erro real primeiro.
