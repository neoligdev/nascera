// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Modelos locais (LLM open source rodando na própria máquina)
//
// Por que dá para fazer isso sem escrever nenhuma ponte de protocolo:
// o Ollama expõe a API de Mensagens da Anthropic em /v1/messages — com
// streaming e tool_use no formato certo. Como o motor do NASCERA é o Claude
// Code, e o CLI dele respeita ANTHROPIC_BASE_URL, basta apontar o motor para
// o Ollama e escolher o modelo. Nenhum tradutor no meio.
//
// (Verificado nesta máquina: /v1/messages devolve content_block com
// {"type":"tool_use"} e stop_reason "tool_use" — que é do que o agente
// depende para fazer qualquer coisa além de conversar.)
//
// O que NÃO muda: cobrança e telemetria continuam existindo, mas um turno
// local não consome crédito — o custo é a máquina do cliente.
// ═══════════════════════════════════════════════════════════════════════

const { execFile } = require('child_process');
const http = require('http');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// Catálogo curado. Tamanhos conferidos no registro do Ollama, não de memória.
// `ramMin` é a RAM total recomendada: o modelo precisa caber com folga para o
// sistema — prometer que um 30B roda em 16 GB é enganar o cliente.
// ATENÇÃO ao campo `ferramentas`: ele NÃO vem do que o Ollama declara.
// Medido nesta base: o `qwen2.5-coder:7b` aparece com "tools" nas
// capabilities do Ollama e mesmo assim se recusou a chamar a ferramenta em
// três prompts diferentes — respondeu texto explicando o que faria. Um
// modelo assim conversa sobre código, mas não constrói projeto no NASCERA.
//
// Por isso: 'sim' = verificado chamando ferramenta de verdade;
//           'nao' = verificado que NÃO chama;
//           'nao-testado' = a UI manda o dono apertar "Testar" antes de usar.
// Um item só, de propósito: é o único que passou no teste de ponta a ponta
// (chamou ferramenta E escreveu arquivo num turno real do motor). Oferecer
// uma lista grande de modelos que ninguém verificou empurra a frustração
// para o cliente — ele baixa 12 GB e descobre que não constrói nada.
const CATALOGO = [
  {
    id: 'qwen3-coder:30b', nome: 'Qwen3 Coder 30B', gb: 17.3, ramMin: 36,
    resumo: 'Chama ferramentas e escreve arquivo — verificado em turno real do motor. '
      + 'É lento: ~2,5 min para uma página simples, contra segundos no Claude.',
    ferramentas: 'sim', recomendado: true,
  },
];

// ─── conversa com o Ollama ────────────────────────────────────────────
function pedir(caminho, { metodo = 'GET', corpo = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(caminho, OLLAMA_URL);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: metodo,
        headers: corpo ? { 'Content-Type': 'application/json' } : {}, timeout },
      (res) => {
        let dados = '';
        res.on('data', (c) => { dados += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(dados || '{}')); } catch { resolve({ raw: dados }); }
        });
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama não respondeu')); });
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

// Procurar um binário no PATH é a única pergunta deste módulo que o sistema
// operacional responde sozinho — não existe API de Node equivalente. Por isso
// o par `where`/`which`, exatamente como motores.js:125 já faz (uma ideia só,
// repetida, em vez de duas invenções diferentes). Antes daqui só havia
// `which`, e no Windows isso marcava o Ollama como ausente PARA SEMPRE.
// `where` pode devolver várias linhas: fica a primeira, como lá.
function comandoDeBusca() {
  return process.platform === 'win32' ? 'where' : 'which';
}

function binarioExiste() {
  const cmd = comandoDeBusca();
  return new Promise((resolve) => {
    execFile(cmd, ['ollama'], { timeout: 5000 }, (err, out) =>
      resolve(err ? null : (String(out).trim().split('\n')[0].trim() || null)));
  });
}

// As duas frases que a UI mostra (e deixa o dono copiar) quando o Ollama não
// está no ar. São o único conteúdo do módulo que depende mesmo do SO —
// instalar e subir serviço não têm equivalente neutro. Ficam isoladas aqui
// para dar para conferir as três plataformas sem precisar das três máquinas.
function comoInstalarOllama() {
  // O `install.sh` é instalador de LINUX. Servi-lo no Windows era mandar o
  // cliente rodar algo que não existe lá. `winget` vem de fábrica no
  // Windows 10/11 e instala o Ollama oficial.
  if (process.platform === 'darwin') return 'brew install ollama && brew services start ollama';
  if (process.platform === 'win32') return 'winget install Ollama.Ollama';
  return 'curl -fsSL https://ollama.com/install.sh | sh';
}

function comoIniciarOllama() {
  // No Windows não há systemd nem brew services: quem sobe o servidor é o
  // próprio `ollama serve` (ou o app na bandeja, que faz o mesmo).
  if (process.platform === 'darwin') return 'brew services start ollama';
  if (process.platform === 'win32') return 'ollama serve';
  return 'systemctl start ollama';
}

// Estado honesto: instalado ≠ rodando. A UI precisa saber a diferença para
// dizer "instale o Ollama" ou "o Ollama está parado".
//
// Quem MANDA aqui é a porta HTTP, não o PATH — e por dois motivos:
//   1. é neutra de plataforma (o resto do módulo inteiro já fala HTTP);
//   2. prova algo mais forte e mais útil: que o serviço está NO AR. Binário no
//      PATH não garante turno nenhum; porta respondendo garante.
// Isso ainda conserta um caso real do Windows que `where` sozinho não pega: o
// instalador do Ollama põe o binário no PATH, mas processo já rodando não
// enxerga PATH novo — o NASCERA diria "não instalado" até reiniciar, enquanto a
// porta já responde.
// O PATH continua sendo consultado (em paralelo, sem custo de latência) porque
// é ele que separa "não instalado" de "instalado mas parado" quando a porta
// está muda — a distinção que a UI usa para escolher a mensagem.
async function estado() {
  const [versao, caminho] = await Promise.all([
    pedir('/api/version', { timeout: 4000 }).catch(() => null),
    binarioExiste(),
  ]);
  if (versao) {
    try {
      const lista = await listar();
      return { instalado: true, rodando: true, caminho, versao: versao.version || null, modelos: lista };
    } catch { /* respondeu /api/version e não /api/tags: cai para "parado", como antes */ }
  }
  if (!caminho) return { instalado: false, rodando: false, modelos: [], comoInstalar: comoInstalarOllama() };
  return { instalado: true, rodando: false, caminho, modelos: [], comoIniciar: comoIniciarOllama() };
}

async function listar() {
  const r = await pedir('/api/tags', { timeout: 8000 });
  return (r.models || []).map((m) => ({
    id: m.name,
    gb: m.size ? +(m.size / 1073741824).toFixed(1) : null,
    parametros: (m.details && m.details.parameter_size) || null,
    quantizacao: (m.details && m.details.quantization_level) || null,
    modificadoEm: m.modified_at || null,
  }));
}

// Catálogo + o que já está na máquina, com o aviso de RAM já resolvido aqui
// (a UI não deveria precisar saber a regra).
async function catalogo() {
  let instalados = [];
  try { instalados = (await listar()).map((m) => m.id); } catch {}
  const ramGb = Math.round(require('os').totalmem() / 1073741824);
  return {
    ramGb,
    modelos: CATALOGO.map((m) => ({
      ...m,
      instalado: instalados.includes(m.id),
      cabeNestaMaquina: ramGb >= m.ramMin,
      aviso: ramGb >= m.ramMin ? null
        : `Precisa de ~${m.ramMin} GB de RAM; esta máquina tem ${ramGb} GB. Vai rodar muito devagar ou nem carregar.`,
      // A UI precisa dizer isto ANTES de a pessoa escolher: modelo que não
      // chama ferramenta não serve para construir projeto, por mais que
      // converse bem sobre código.
      avisoFerramentas: m.ferramentas === 'nao'
        ? 'Não chama ferramentas: serve para conversar sobre código, não para construir projetos.'
        : m.ferramentas === 'nao-testado'
          ? 'Ainda não verificado nesta máquina — baixe e aperte "Testar" antes de usar para valer.'
          : null,
    })),
  };
}

// ─── download com progresso ──────────────────────────────────────────
// O Ollama transmite o progresso em NDJSON. Guardamos em memória porque a
// UI acompanha por polling — e porque um download interrompido não deve
// deixar estado mentiroso em disco.
const _baixando = new Map();   // id → { total, recebido, status, erro, fim }

function progresso(id) {
  return _baixando.get(id) || null;
}

function baixar(id) {
  if (!/^[\w.\-:\/]+$/.test(String(id || ''))) throw new Error('Modelo inválido');
  const atual = _baixando.get(id);
  if (atual && !atual.fim) return atual;

  const estadoJob = { id, total: 0, recebido: 0, status: 'começando', erro: null, fim: false, em: Date.now() };
  _baixando.set(id, estadoJob);

  // O Ollama baixa em CAMADAS e manda uma linha por camada. Guardar só a
  // última faz a barra pular: o modelo tem uma camada de ~1 GB e outras de
  // poucas centenas de BYTES — a de 487 bytes zerava o progresso na cara do
  // usuário. Por isso somamos por digest.
  const camadas = new Map();

  const url = new URL('/api/pull', OLLAMA_URL);
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json' } },
    (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const linhas = buffer.split('\n');
        buffer = linhas.pop();
        for (const linha of linhas) {
          if (!linha.trim()) continue;
          try {
            const p = JSON.parse(linha);
            if (p.status) estadoJob.status = p.status;
            if (p.error) { estadoJob.erro = p.error; estadoJob.fim = true; }
            if (p.digest && p.total) {
              const c = camadas.get(p.digest) || { total: 0, recebido: 0 };
              c.total = p.total;
              // O Ollama repete a linha da camada; `completed` é acumulado
              // dela, não incremento — então é atribuição, não soma.
              if (p.completed) c.recebido = p.completed;
              camadas.set(p.digest, c);
              let t = 0, r = 0;
              for (const v of camadas.values()) { t += v.total; r += v.recebido; }
              estadoJob.total = t;
              estadoJob.recebido = r;
            }
          } catch {}
        }
      });
      res.on('end', () => {
        estadoJob.fim = true;
        if (!estadoJob.erro) { estadoJob.status = 'pronto'; estadoJob.recebido = estadoJob.total || estadoJob.recebido; }
      });
    });
  req.on('error', (e) => { estadoJob.erro = e.message; estadoJob.fim = true; });
  req.write(JSON.stringify({ model: id, stream: true }));
  req.end();

  return estadoJob;
}

async function remover(id) {
  if (!/^[\w.\-:\/]+$/.test(String(id || ''))) throw new Error('Modelo inválido');
  await pedir('/api/delete', { metodo: 'DELETE', corpo: { model: id }, timeout: 20000 });
  _baixando.delete(id);
  return { ok: true };
}

// ─── prova de que o modelo serve para o NASCERA ────────────────────────
// Responder texto não basta: sem tool_use o agente não escreve arquivo
// nenhum. Esta função é o que separa "o modelo baixou" de "o modelo serve".
async function testar(id) {
  const inicio = Date.now();
  try {
    const r = await pedir('/v1/messages', {
      metodo: 'POST', timeout: 120000,
      corpo: {
        model: id, max_tokens: 200,
        tools: [{
          name: 'escrever_arquivo',
          description: 'Escreve conteúdo em um arquivo',
          input_schema: {
            type: 'object',
            properties: { caminho: { type: 'string' }, conteudo: { type: 'string' } },
            required: ['caminho'],
          },
        }],
        messages: [{ role: 'user', content: 'Crie o arquivo /tmp/ola.txt com o texto "ola". Use a ferramenta.' }],
      },
    });
    const blocos = r.content || [];
    const usouFerramenta = blocos.some((b) => b.type === 'tool_use');
    return {
      ok: true,
      respondeu: blocos.length > 0,
      usaFerramentas: usouFerramenta,
      segundos: +((Date.now() - inicio) / 1000).toFixed(1),
      aviso: usouFerramenta ? null
        : 'O modelo respondeu, mas não chamou a ferramenta. Ele serve para conversar, não para construir projetos.',
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// O que o motor precisa no ambiente para falar com o modelo local em vez
// da Anthropic. O token é exigido pelo CLI, mas o Ollama ignora o valor.
function ambienteParaMotor(id) {
  return {
    ANTHROPIC_BASE_URL: OLLAMA_URL,
    ANTHROPIC_AUTH_TOKEN: 'ollama-local',
    ANTHROPIC_MODEL: id,
  };
}

module.exports = {
  OLLAMA_URL, CATALOGO,
  estado, listar, catalogo, baixar, progresso, remover, testar, ambienteParaMotor,
  // Expostos para o teste provar a detecção sem Ollama instalado e conferir as
  // mensagens das três plataformas numa máquina só.
  comandoDeBusca, binarioExiste, comoInstalarOllama, comoIniciarOllama,
};
