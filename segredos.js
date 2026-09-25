// ═══════════════════════════════════════════════════════════════════════
// NASCERA — cofre de credenciais reversíveis
//
// Diferente de `senhas.js`: aquele guarda senha de LOGIN, que é via única
// (scrypt, nunca volta ao texto). Aqui é para credencial que o sistema
// precisa USAR depois — a senha SSH de um projeto remoto, por exemplo.
// Como precisa ser usada, precisa poder ser lida de volta; então o que se
// faz é tirá-la de onde ela vaza e cifrá-la em repouso.
//
// O problema concreto: `/api/remote/connect` gravava `remotePass` em TEXTO
// PURO dentro de projects.json — arquivo com permissão 644 (todo mundo lê),
// que vai em backup, aparece em screenshot e quase entrou em pacote de
// release. Uma senha de root de VPS do cliente, à vista.
//
// Agora: AES-256-GCM, chave em arquivo 0600, e o texto cifrado num arquivo
// separado (também 0600) — não em projects.json. Um projects.json vazado
// deixa de carregar segredo nenhum.
//
// GCM e não CBC: além de cifrar, autentica. Se alguém adulterar o arquivo,
// a decifragem falha em vez de devolver lixo silenciosamente.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const path = require('path');
const crypto = require('crypto');

const ARQUIVO_CHAVE = path.join(__dirname, '.chave-cofre');
const ARQUIVO_COFRE = path.join(__dirname, '.cofre.json');

function chave() {
  try {
    const b = Buffer.from(fs.readFileSync(ARQUIVO_CHAVE, 'utf8').trim(), 'hex');
    if (b.length === 32) return b;
  } catch { /* ainda não existe */ }
  const nova = crypto.randomBytes(32);
  fs.writeFileSync(ARQUIVO_CHAVE, nova.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(ARQUIVO_CHAVE, 0o600); } catch {}
  return nova;
}

function cifrar(texto) {
  const iv = crypto.randomBytes(12);                 // 96 bits, o recomendado para GCM
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  // iv + tag + dados num só blob: quem guarda não precisa saber o formato.
  return Buffer.concat([iv, c.getAuthTag(), dados]).toString('base64');
}

function decifrar(blobBase64) {
  const b = Buffer.from(blobBase64, 'base64');
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

function lerCofre() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_COFRE, 'utf8')); } catch { return {}; }
}

function gravarCofre(dados) {
  fs.writeFileSync(ARQUIVO_COFRE, JSON.stringify(dados, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ARQUIVO_COFRE, 0o600); } catch {}
}

// Guarda um segredo sob uma chave lógica (ex.: 'ssh:<projectId>').
function guardar(id, valor) {
  const c = lerCofre();
  if (valor === null || valor === undefined || valor === '') delete c[id];
  else c[id] = cifrar(valor);
  gravarCofre(c);
}

// Devolve o segredo em claro, ou null. Adulteração devolve null (e avisa) —
// nunca lixo silencioso, que viraria uma tentativa de login com senha errada.
function obter(id) {
  const guardado = lerCofre()[id];
  if (!guardado) return null;
  try { return decifrar(guardado); }
  catch (e) { logger.error('[cofre] segredo "' + id + '" não decifra (chave trocada ou arquivo adulterado)'); return null; }
}

function esquecer(id) { guardar(id, null); }

module.exports = { guardar, obter, esquecer, ARQUIVO_COFRE, ARQUIVO_CHAVE };
