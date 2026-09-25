// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Geração de imagens
//
// Por que este módulo existe: os sistemas saíam sem imagem nenhuma. Não é
// limitação do motor — nem o Claude Code nem o Codex geram imagem (o
// `--image` do Codex ANEXA uma imagem ao prompt, não produz). Gerar imagem
// é outro serviço: a API de Imagens da OpenAI.
//
// Dois provedores, e a ordem importa:
//   openai → gpt-image-1. Imagem sob medida para o conteúdo. Exige chave de
//            API própria (o login do ChatGPT do Codex NÃO serve aqui) e
//            cobra por imagem.
//   banco  → foto real de banco público, sem chave e sem custo. Não é sob
//            medida, mas é infinitamente melhor que um quadrado cinza.
//
// Sem chave configurada, cai no banco automaticamente. O site nasce com
// imagem de qualquer jeito — que é o objetivo.
//
// A CHAVE NUNCA ENTRA NO CÓDIGO nem no pacote de release: mora em
// `.credenciais.json` com permissão 0600, ao lado dos outros dados da
// instalação.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const path = require('path');
const crypto = require('crypto');

const ARQUIVO_CREDENCIAIS = path.join(__dirname, '.credenciais.json');
const MODELO_PADRAO = 'gpt-image-2';

// Modelos de imagem da OpenAI e — o que mais importa aqui — o que cada um
// aceita de TAMANHO. Essa diferença não é detalhe: o gpt-image-1 só devolve
// três formatos fixos, então quem pedia 1000x666 recebia 1536x1024, o layout
// quebrava e o agente descartava a imagem já paga. O gpt-image-2 aceita
// qualquer medida divisível por 16, o que acaba com esse desperdício.
// (Limites confirmados na própria API, pelas mensagens de validação.)
const MODELOS = {
  'gpt-image-2':          { nome: 'GPT Image 2',        livre: true,  maxBorda: 3840, minArea: 1024 * 1024, recomendado: true },
  'gpt-image-1.5':        { nome: 'GPT Image 1.5',      livre: false },
  'gpt-image-1':          { nome: 'GPT Image 1',        livre: false },
  'gpt-image-1-mini':     { nome: 'GPT Image 1 mini',   livre: false },
  'chatgpt-image-latest': { nome: 'ChatGPT Image',      livre: false },
};

const QUALIDADES = ['low', 'medium', 'high', 'auto'];

// ─── credenciais ─────────────────────────────────────────────────────
function lerCredenciais() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_CREDENCIAIS, 'utf8')); } catch { return {}; }
}

function salvarCredenciais(dados) {
  fs.writeFileSync(ARQUIVO_CREDENCIAIS, JSON.stringify(dados, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ARQUIVO_CREDENCIAIS, 0o600); } catch {}
}

function definirChaveOpenAI(chave) {
  const c = lerCredenciais();
  const limpa = String(chave || '').trim();
  if (!limpa) { delete c.openaiApiKey; salvarCredenciais(c); return { ok: true, configurada: false }; }
  // Formato conhecido das chaves da OpenAI. Recusar cedo evita o cliente
  // achar que configurou e só descobrir o erro na primeira imagem.
  if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(limpa)) {
    return { ok: false, erro: 'Isso não parece uma chave da OpenAI (começa com "sk-").' };
  }
  c.openaiApiKey = limpa;
  salvarCredenciais(c);
  return { ok: true, configurada: true };
}

// A chave NUNCA volta inteira para a tela — só o suficiente para a pessoa
// reconhecer qual configurou.
function mascarar(chave) {
  if (!chave) return null;
  return chave.slice(0, 6) + '…' + chave.slice(-4);
}

function definirModelo(id) {
  const c = lerCredenciais();
  if (!MODELOS[id]) return { ok: false, erro: 'Modelo desconhecido.' };
  c.modeloImagem = id;
  salvarCredenciais(c);
  return { ok: true, modelo: id };
}

function definirQualidade(q) {
  const c = lerCredenciais();
  if (!QUALIDADES.includes(q)) return { ok: false, erro: 'Qualidade desconhecida.' };
  c.qualidadeImagem = q;
  salvarCredenciais(c);
  return { ok: true, qualidade: q };
}

function estado() {
  const c = lerCredenciais();
  const tem = !!c.openaiApiKey;
  const modelo = c.modeloImagem || MODELO_PADRAO;
  return {
    provedor: tem ? 'openai' : 'banco',
    openai: {
      configurada: tem, mascarada: mascarar(c.openaiApiKey),
      modelo, qualidade: c.qualidadeImagem || 'auto',
      modelos: Object.entries(MODELOS).map(([id, m]) => ({
        id, nome: m.nome, recomendado: !!m.recomendado,
        medida: m.livre ? 'qualquer medida' : 'só 1024×1024, 1024×1536 e 1536×1024',
      })),
      qualidades: QUALIDADES,
    },
    banco: { sempreDisponivel: true, fonte: 'picsum.photos' },
    explicacao: tem
      ? `As imagens são geradas sob medida pelo ${(MODELOS[modelo] || {}).nome || modelo}.`
      : 'Sem chave da OpenAI: as imagens vêm de banco de fotos, sem custo. Configure a chave para gerar sob medida.',
  };
}

// ─── tamanho ─────────────────────────────────────────────────────────
// Modelos de dimensão fixa aceitam SÓ estes três. Qualquer outro volta 400 e
// a imagem cairia no banco silenciosamente — foi o que aconteceu no primeiro
// teste real (pedi 256x256 e a OpenAI recusou). Como o agente pede medidas de
// layout (800x600, 1200x400), traduzimos pela PROPORÇÃO em vez de recusar.
const TAMANHOS_FIXOS = { quadrado: '1024x1024', retrato: '1024x1536', paisagem: '1536x1024' };

function medidaPedida(tamanho) {
  const m = String(tamanho || '').match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!m) return { l: 1024, a: 1024 };
  return { l: parseInt(m[1], 10) || 1024, a: parseInt(m[2], 10) || 1024 };
}

const passo16 = n => Math.max(16, Math.round(n / 16) * 16);

// Tamanho a PEDIR para um modelo de dimensão livre: a medida do layout,
// ajustada só o necessário para caber nas regras da API (múltiplo de 16,
// piso de pixels, teto de borda). A proporção é preservada — é ela que
// determina se a imagem serve ou não no lugar onde vai.
function tamanhoLivre(l, a, cap) {
  let el = l, ea = a;
  const area = el * ea;
  if (area < cap.minArea) { const k = Math.sqrt(cap.minArea / area); el *= k; ea *= k; }
  const maior = Math.max(el, ea);
  if (maior > cap.maxBorda) { const k = cap.maxBorda / maior; el *= k; ea *= k; }
  return `${passo16(el)}x${passo16(ea)}`;
}

function tamanhoParaOpenAI(tamanho, modelo) {
  const { l, a } = medidaPedida(tamanho);
  const cap = MODELOS[modelo] || MODELOS[MODELO_PADRAO];
  if (cap.livre) return tamanhoLivre(l, a, cap);
  const razao = l / a;
  if (razao > 1.2) return TAMANHOS_FIXOS.paisagem;
  if (razao < 0.83) return TAMANHOS_FIXOS.retrato;
  return TAMANHOS_FIXOS.quadrado;
}

// ─── geração ─────────────────────────────────────────────────────────
async function viaOpenAI(prompt, { tamanho = '1024x1024' } = {}) {
  const c = lerCredenciais();
  if (!c.openaiApiKey) throw new Error('Chave da OpenAI não configurada');

  const modelo = c.modeloImagem || MODELO_PADRAO;
  const corpo = {
    model: modelo,
    prompt, size: tamanhoParaOpenAI(tamanho, modelo), n: 1,
  };
  if (QUALIDADES.includes(c.qualidadeImagem)) corpo.quality = c.qualidadeImagem;

  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + c.openaiApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    let detalhe = txt.slice(0, 300);
    try { const j = JSON.parse(txt); detalhe = (j.error && j.error.message) || detalhe; } catch {}
    // 401 quase sempre é chave errada/revogada; dizer isso poupa suporte.
    if (r.status === 401) throw new Error('A OpenAI recusou a chave (401). Confira se ela é válida e tem créditos.');
    throw new Error(`OpenAI respondeu ${r.status}: ${detalhe}`);
  }

  const j = await r.json();
  const item = (j.data || [])[0] || {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const img = await fetch(item.url);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error('A OpenAI não devolveu imagem');
}

// Banco de fotos: a mesma "semente" devolve sempre a mesma foto, então o
// site não troca de imagem a cada build — o que pareceria bug.
async function viaBanco(prompt, { largura = 1024, altura = 1024 } = {}) {
  const semente = crypto.createHash('sha256').update(String(prompt)).digest('hex').slice(0, 12);
  const url = `https://picsum.photos/seed/${semente}/${largura}/${altura}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('Banco de fotos respondeu ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Entrega a medida EXATA que foi pedida.
//
// Este passo existe por um prejuízo real e observado: numa geração de 18
// imagens, a API devolveu 1536x1024 para pedidos de 1000x666 (limite do
// gpt-image-1). O layout desalinhou, o agente trocou tudo por foto de banco
// e as 18 imagens pagas foram jogadas fora — sobrou uma. Com o tamanho certo
// chegando, não há motivo para descartar.
//
// `cover` recorta em vez de esticar: rosto achatado é pior que borda cortada.
// Se já veio na medida certa, não reprocessa — recodificar perde qualidade.
async function ajustarMedida(buffer, l, a) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    if (meta.width === l && meta.height === a) return buffer;
    let img = sharp(buffer).resize(l, a, { fit: 'cover', position: 'attention' });
    img = (meta.format === 'jpeg') ? img.jpeg({ quality: 92 }) : img.png({ compressionLevel: 9 });
    return await img.toBuffer();
  } catch (e) {
    // Sem sharp a imagem ainda serve: melhor na medida errada que nenhuma.
    logger.error('[imagens] não consegui ajustar a medida:', e.message);
    return buffer;
  }
}

// Gera e grava. Devolve qual provedor atendeu — a UI e o agente precisam
// saber se a imagem é sob medida ou de banco.
async function gerar(prompt, destino, opcoes = {}) {
  if (!prompt || !destino) throw new Error('Informe o texto e o destino');
  const c = lerCredenciais();
  const tamanho = opcoes.tamanho || '1024x1024';
  const { l, a } = medidaPedida(tamanho);

  let buffer, provedor;
  if (c.openaiApiKey && opcoes.provedor !== 'banco') {
    try {
      buffer = await viaOpenAI(prompt, { tamanho });
      provedor = 'openai';
    } catch (e) {
      // Falha na OpenAI não pode deixar o site sem imagem: cai para o banco
      // e avisa. Melhor uma foto genérica do que um buraco na página.
      logger.error('[imagens] OpenAI falhou, usando banco:', e.message);
      buffer = await viaBanco(prompt, { largura: l, altura: a });
      provedor = 'banco';
      opcoes._aviso = 'A OpenAI falhou (' + e.message + '); usei banco de fotos.';
    }
  } else {
    buffer = await viaBanco(prompt, { largura: l, altura: a });
    provedor = 'banco';
  }

  buffer = await ajustarMedida(buffer, l, a);

  // O banco devolve JPEG; a OpenAI, PNG. Gravar um JPEG com nome .png cria
  // um arquivo mentiroso — funciona no navegador, mas quebra ferramenta que
  // confia na extensão. Ajustamos o nome ao conteúdo real.
  const formatoReal = (buffer[0] === 0xff && buffer[1] === 0xd8) ? '.jpg'
    : (buffer[0] === 0x89 && buffer[1] === 0x50) ? '.png' : path.extname(destino) || '.img';
  let alvo = destino;
  if (path.extname(destino).toLowerCase() !== formatoReal) {
    alvo = destino.replace(/\.[^.]*$/, '') + formatoReal;
  }

  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.writeFileSync(alvo, buffer);

  // A medida real vai na resposta para o agente não precisar adivinhar (nem
  // abrir o arquivo) na hora de escrever o HTML.
  let largura = l, altura = a;
  try { const m = await require('sharp')(buffer).metadata(); largura = m.width; altura = m.height; } catch {}

  return {
    ok: true, provedor, arquivo: alvo, bytes: buffer.length,
    largura, altura, tamanho: `${largura}x${altura}`,
    modelo: provedor === 'openai' ? (c.modeloImagem || MODELO_PADRAO) : null,
    aviso: opcoes._aviso || null,
  };
}

// Testa a configuração sem sujar projeto nenhum.
async function testar() {
  const destino = path.join(require('os').tmpdir(), 'nascera-teste-imagem.png');
  try {
    // 1024x1024 porque é o menor que o gpt-image-1 aceita. Pedir menor
    // fazia o teste "passar" pelo banco e esconder que a chave funcionava.
    const r = await gerar('um quadrado azul simples, minimalista', destino, { tamanho: '1024x1024' });
    try { fs.unlinkSync(destino); } catch {}
    return { ok: true, provedor: r.provedor, bytes: r.bytes, aviso: r.aviso };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  estado, definirChaveOpenAI, definirModelo, definirQualidade,
  gerar, testar, lerCredenciais,
  ARQUIVO_CREDENCIAIS, MODELO_PADRAO, MODELOS, QUALIDADES,
};
