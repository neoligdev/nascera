// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Memória compartilhada do projeto
//
// O problema: cada motor guarda a conversa do seu jeito. O Claude Code
// mantém a sessão em ~/.claude; o Codex, um thread próprio. Trocar de motor
// no meio do projeto significava recomeçar do zero — o novo motor não fazia
// ideia do que o anterior tinha construído.
//
// A solução: um arquivo de memória DENTRO do projeto, que os dois leem.
// Verificado na prática: o Claude Code lê `CLAUDE.md`, e o Codex e o
// OpenCode leem `AGENTS.md` (testado nos dois — obedeceram uma regra escrita
// lá). Então a memória é gravada uma vez e espelhada nos dois arquivos.
//
// O que entra aqui é o que sobrevive à troca: o que o projeto é, o que já
// foi feito e as decisões tomadas. NÃO é transcrição de conversa — isso
// incharia o contexto e faria o motor gastar tokens relendo bate-papo.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const path = require('path');

const ARQUIVO = '.nascera/MEMORIA.md';
const MARCA_INICIO = '<!-- NASCERA:MEMORIA:INICIO -->';
const MARCA_FIM = '<!-- NASCERA:MEMORIA:FIM -->';
const MARCA_CAVEMAN_INICIO = '<!-- NASCERA:CAVEMAN:INICIO -->';
const MARCA_CAVEMAN_FIM = '<!-- NASCERA:CAVEMAN:FIM -->';
const ARQUIVO_PRD = '.nascera/prd.md';
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const MAX_MARCOS = 40;

function caminhoDaMemoria(projectPath) {
  return path.join(projectPath, ARQUIVO);
}

function caminhoDoPRD(projectPath) {
  return path.join(projectPath, ARQUIVO_PRD);
}

// Mescla um bloco de texto marcado dentro de um arquivo, sem tocar no resto
// do conteúdo (o que o Nascera ou a pessoa já tiver escrito ali). Usado tanto
// pelo espelho de memória (CLAUDE.md + AGENTS.md) quanto pelo bloco Caveman
// (só AGENTS.md) — cada um com seu próprio par de marcas, para nunca se
// atropelarem no mesmo arquivo.
function mesclarBloco(caminho, marcaInicio, marcaFim, texto) {
  const bloco = `${marcaInicio}\n${texto}\n${marcaFim}`;
  let atual = '';
  try { atual = fs.readFileSync(caminho, 'utf8'); } catch {}
  let novo;
  if (atual.includes(marcaInicio) && atual.includes(marcaFim)) {
    novo = atual.replace(
      new RegExp(marcaInicio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + marcaFim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      bloco);
  } else {
    novo = (atual ? atual.trimEnd() + '\n\n' : '') + bloco + '\n';
  }
  fs.writeFileSync(caminho, novo);
}

function ler(projectPath) {
  try { return JSON.parse(fs.readFileSync(path.join(projectPath, '.nascera/memoria.json'), 'utf8')); }
  catch { return { criadoEm: null, resumo: '', marcos: [], decisoes: [], motorAtual: null }; }
}

function salvar(projectPath, dados) {
  const dir = path.join(projectPath, '.nascera');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memoria.json'), JSON.stringify(dados, null, 2));
}

// Um marco é uma frase curta do que aconteceu ("criou a home", "trocou a
// paleta para azul"). É o que o próximo motor precisa saber para continuar
// sem refazer.
function registrarMarco(projectPath, texto, quem) {
  if (!projectPath || !texto) return;
  try {
    const m = ler(projectPath);
    if (!m.criadoEm) m.criadoEm = new Date().toISOString();
    m.marcos.push({ texto: String(texto).slice(0, 300), quem: quem || null, em: new Date().toISOString() });
    // Teto: memória sem limite vira contexto gigante e caro em todo turno.
    if (m.marcos.length > MAX_MARCOS) m.marcos = m.marcos.slice(-MAX_MARCOS);
    salvar(projectPath, m);
    escreverArquivos(projectPath, m);
  } catch (e) { logger.error('[memoria] falha ao registrar:', e.message); }
}

function registrarDecisao(projectPath, texto) {
  if (!projectPath || !texto) return;
  try {
    const m = ler(projectPath);
    m.decisoes.push({ texto: String(texto).slice(0, 300), em: new Date().toISOString() });
    if (m.decisoes.length > MAX_MARCOS) m.decisoes = m.decisoes.slice(-MAX_MARCOS);
    salvar(projectPath, m);
    escreverArquivos(projectPath, m);
  } catch {}
}

// Registra a troca de motor. É o momento mais importante da memória: é aqui
// que o motor novo precisa entender que não está começando um projeto.
function registrarTrocaDeMotor(projectPath, de, para) {
  if (!projectPath) return;
  try {
    const m = ler(projectPath);
    m.motorAtual = para;
    m.marcos.push({
      texto: `Motor trocado de ${de || 'nenhum'} para ${para}. O trabalho anterior continua valendo — continue de onde parou.`,
      quem: 'nascera', em: new Date().toISOString(),
    });
    salvar(projectPath, m);
    escreverArquivos(projectPath, m);
  } catch {}
}

function montarTexto(m) {
  const linhas = ['# Memória do projeto (mantida pelo Nascera)', ''];
  linhas.push('Este arquivo é escrito automaticamente. Ele existe para que o trabalho');
  linhas.push('continue igual quando o motor de IA muda (Claude Code ↔ GPT Codex).');
  linhas.push('**Leia antes de agir e não recomece o que já está feito.**', '');

  if (m.resumo) linhas.push('## O que é este projeto', '', m.resumo, '');

  if (m.decisoes && m.decisoes.length) {
    linhas.push('## Decisões já tomadas (respeite)', '');
    for (const d of m.decisoes.slice(-15)) linhas.push('- ' + d.texto);
    linhas.push('');
  }

  if (m.marcos && m.marcos.length) {
    linhas.push('## O que já foi feito', '');
    for (const x of m.marcos.slice(-20)) {
      const quando = (x.em || '').slice(0, 10);
      linhas.push(`- ${x.texto}${x.quem ? ` _(${x.quem})_` : ''} ${quando ? `— ${quando}` : ''}`);
    }
    linhas.push('');
  }

  // Sem esta instrução o site nasce sem imagem nenhuma — não porque o
  // agente não queira, mas porque ele não sabe que PODE gerar. Nem o Claude
  // Code nem o Codex geram imagem sozinhos.
  linhas.push('## Imagens — use de verdade, não deixe espaço vazio', '');
  linhas.push('Este projeto tem um gerador de imagens. Ao construir telas, **gere as');
  linhas.push('imagens** em vez de usar `<div>` cinza, ícone genérico ou link quebrado:', '');
  // O comando é `node .nascera/imagem.cjs`, não `./.nascera/imagem.sh`. O script
  // virou Node porque o `.sh` com curl não roda no Windows (sem /bin/sh, sem
  // curl compatível) — e trocar o script sem trocar ESTA linha não adiantaria
  // nada: o agente só faz o que está escrito aqui. `node <caminho>` funciona
  // igual em PowerShell, cmd, bash e zsh, então não há duas versões do texto.
  // A extensão `.cjs` é obrigatória: em projeto com `"type": "module"` no
  // package.json, um `.js` seria lido como ESM e o script morreria no require.
  linhas.push('```');
  linhas.push('node .nascera/imagem.cjs "descrição do que aparece na foto" assets/hero.png 1200x600');
  linhas.push('```', '');
  linhas.push('- O caminho do destino é relativo à raiz do projeto.');
  linhas.push('- O arquivo pode sair como `.jpg` mesmo se você pedir `.png` — o comando');
  linhas.push('  responde com o nome final em `"arquivo"`. **Use esse nome no HTML.**');
  linhas.push('- A imagem sai na medida exata que você pedir, e a resposta traz');
  linhas.push('  `"largura"` e `"altura"` para conferência. Não precisa abrir o arquivo.');
  linhas.push('- Descreva a cena em português, com contexto: "vitrine de loja de tênis,');
  linhas.push('  luz natural, fundo claro" rende melhor que "tênis".');
  linhas.push('- Gere uma imagem por seção que precise (hero, produtos, depoimentos).');
  linhas.push('');
  // Um lote de 18 imagens pagas foi gerado e sobrescrito minutos depois. A
  // regra abaixo existe para que isso não se repita.
  linhas.push('**Cada imagem gerada é cobrada.** Depois de gerar, use o arquivo — não');
  linhas.push('substitua por foto de banco nem regere "para padronizar". Se alguma não');
  linhas.push('servir, regere só aquela, dizendo o que mudar. E se a medida atrapalhar o');
  linhas.push('layout, ajuste o CSS (`object-fit: cover`) em vez de trocar a imagem.');
  linhas.push('');

  if (m.motorAtual) linhas.push(`_Motor atual: ${m.motorAtual}._`, '');
  return linhas.join('\n');
}

// Escreve a memória e a espelha nos dois arquivos de contexto. O espelho vai
// entre marcas, para nunca sobrescrever o que o Nascera (ou a pessoa) já
// escreveu no CLAUDE.md/AGENTS.md.
function escreverArquivos(projectPath, memoria) {
  const m = memoria || ler(projectPath);
  const texto = montarTexto(m);
  try {
    fs.mkdirSync(path.join(projectPath, '.nascera'), { recursive: true });
    fs.writeFileSync(caminhoDaMemoria(projectPath), texto);
  } catch (e) { return { ok: false, erro: e.message }; }

  for (const nome of ['CLAUDE.md', 'AGENTS.md']) {
    try { mesclarBloco(path.join(projectPath, nome), MARCA_INICIO, MARCA_FIM, texto); }
    catch (e) { logger.error('[memoria] ' + nome + ':', e.message); }
  }
  return { ok: true };
}

// Skill Caveman (respostas mais diretas) só entra no AGENTS.md — o Claude já
// recebe a mesma skill de verdade via .claude/skills/ (ver server.js
// writeCavemanSkill), então espelhar aqui também seria redundante. O
// front-matter YAML é convenção do carregador de skills do Claude Code; sem
// sentido dentro de um AGENTS.md, então é removido antes de mesclar.
function escreverCaveman(projectPath) {
  if (!projectPath) return;
  try {
    const src = path.join(TEMPLATES_DIR, 'caveman-SKILL.md');
    if (!fs.existsSync(src)) return;
    const corpo = fs.readFileSync(src, 'utf8')
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .trim();
    mesclarBloco(path.join(projectPath, 'AGENTS.md'), MARCA_CAVEMAN_INICIO, MARCA_CAVEMAN_FIM, corpo);
  } catch (e) { logger.error('[memoria] caveman AGENTS.md:', e.message); }
}

// PRD gerado pela fase de planejamento automático (OpenCode, ver
// servicos/planejamento-automatico.js). Fica só neste arquivo — nunca é
// espelhado em CLAUDE.md/AGENTS.md, porque não deve aparecer para o usuário
// nem inchar o contexto de todo turno. Um arquivo único, sobrescrito a cada
// ciclo: não há necessidade de histórico/versão para isto.
function registrarPRD(projectPath, texto) {
  if (!projectPath || !texto) return;
  try {
    fs.mkdirSync(path.join(projectPath, '.nascera'), { recursive: true });
    fs.writeFileSync(caminhoDoPRD(projectPath), texto);
    registrarMarco(projectPath, 'PRD de planejamento gerado — ver ' + ARQUIVO_PRD, 'opencode');
  } catch (e) { logger.error('[memoria] registrarPRD:', e.message); }
}

// Texto injetado na primeira mensagem depois de uma troca de motor. Sem
// isto, o motor novo lê a memória só se resolver abrir o arquivo — e
// frequentemente não abre.
function textoDeContinuidade(projectPath) {
  const m = ler(projectPath);
  if (!m.marcos.length && !m.resumo) return '';
  const partes = ['[Continuidade do projeto — você está assumindo um trabalho em andamento]'];
  if (m.resumo) partes.push('Projeto: ' + m.resumo);
  if (m.decisoes.length) partes.push('Decisões a respeitar: ' + m.decisoes.slice(-6).map(d => d.texto).join(' | '));
  if (m.marcos.length) partes.push('Já foi feito: ' + m.marcos.slice(-8).map(x => x.texto).join(' | '));
  partes.push('Não recomece do zero. Continue a partir daqui.');
  return partes.join('\n') + '\n\n';
}

function definirResumo(projectPath, resumo) {
  try {
    const m = ler(projectPath);
    m.resumo = String(resumo || '').slice(0, 600);
    if (!m.criadoEm) m.criadoEm = new Date().toISOString();
    salvar(projectPath, m);
    escreverArquivos(projectPath, m);
  } catch {}
}

module.exports = {
  ler, definirResumo, registrarMarco, registrarDecisao, registrarTrocaDeMotor,
  escreverArquivos, textoDeContinuidade, montarTexto, ARQUIVO,
  escreverCaveman, registrarPRD, caminhoDoPRD,
};
