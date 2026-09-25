// ═══════════════════════════════════════════════════════════════════════
// NASCERA — Senhas
//
// Até 04/08/2026 a senha de cada usuário ficava em TEXTO PURO no users.json
// e o login comparava string com string. Qualquer cópia daquele arquivo —
// um backup, um rsync distraído, uma permissão errada — entregava a senha de
// todos os clientes. E como as pessoas reusam senha, o estrago passava longe
// do NASCERA.
//
// Escolhas, e o porquê de cada uma:
//
// • scrypt, do próprio Node. É memory-hard (o atacante precisa de RAM por
//   tentativa, não só de GPU) e não acrescenta dependência — importante num
//   produto que se instala na máquina do cliente e roda `npm install` sozinho
//   ao atualizar: cada pacote a mais é uma chance a mais de falhar.
//   argon2id seria o padrão-ouro, mas exige compilação nativa em cada VPS.
//
// • Sal aleatório por senha: duas pessoas com a mesma senha viram hashes
//   diferentes, e tabela pré-computada não serve para nada.
//
// • Os parâmetros de custo vão DENTRO do hash guardado. Quando a máquina
//   ficar mais rápida, é só subir o custo — os hashes antigos continuam
//   sendo verificados com os parâmetros deles.
//
// • Comparação em tempo constante. Comparar com === vaza, pelo tempo de
//   resposta, quantos bytes iniciais estavam certos.
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const logger = require('./log.js');

// N=32768 (2^15), r=8, p=1 → ~32 MB e ~50-80 ms por verificação. Custa caro
// para quem tenta bilhões de senhas e é imperceptível em um login.
const CUSTO = { N: 32768, r: 8, p: 1, keylen: 32 };
const MAXMEM = 96 * 1024 * 1024;   // o padrão do Node (32 MB) estoura com este N
const PREFIXO = 'scrypt$';

function derivar(senha, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(senha), salt, params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, chave) => (err ? reject(err) : resolve(chave)),
    );
  });
}

// Devolve algo como: scrypt$32768$8$1$<sal>$<hash>
async function criarHash(senha) {
  if (typeof senha !== 'string' || !senha) throw new Error('Senha vazia');
  const salt = crypto.randomBytes(16);
  const chave = await derivar(senha, salt, CUSTO);
  return [PREFIXO + CUSTO.N, CUSTO.r, CUSTO.p, salt.toString('base64'), chave.toString('base64')].join('$');
}

function ehHash(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIXO);
}

function iguaisEmTempoConstante(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // timingSafeEqual exige mesmo tamanho; comparar o resumo evita vazar o
  // tamanho da senha guardada.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Confere a senha contra o que está guardado.
// Devolve { ok, precisaMigrar } — precisaMigrar avisa que o registro ainda
// está em texto puro e deve ser regravado como hash.
async function conferir(senha, guardado) {
  if (typeof guardado !== 'string' || !guardado || typeof senha !== 'string') {
    return { ok: false, precisaMigrar: false };
  }
  if (!ehHash(guardado)) {
    // Legado: texto puro. Aceita uma última vez para não trancar ninguém
    // para fora, e sinaliza a migração.
    return { ok: iguaisEmTempoConstante(senha, guardado), precisaMigrar: true };
  }
  const partes = guardado.split('$');
  // scrypt , N , r , p , salt , hash
  if (partes.length !== 6) return { ok: false, precisaMigrar: false };
  const params = {
    N: parseInt(partes[1], 10), r: parseInt(partes[2], 10),
    p: parseInt(partes[3], 10), keylen: Buffer.from(partes[5], 'base64').length,
  };
  if (!(params.N > 1) || !(params.r > 0) || !(params.p > 0) || !(params.keylen > 0)) {
    return { ok: false, precisaMigrar: false };
  }
  try {
    const chave = await derivar(senha, Buffer.from(partes[4], 'base64'), params);
    const guardada = Buffer.from(partes[5], 'base64');
    if (chave.length !== guardada.length) return { ok: false, precisaMigrar: false };
    return { ok: crypto.timingSafeEqual(chave, guardada), precisaMigrar: false };
  } catch {
    return { ok: false, precisaMigrar: false };
  }
}

// Usuário que não existe: gasta EXATAMENTE o mesmo trabalho de uma
// verificação real — um scrypt, contra um hash de mentira calculado uma vez.
// Fazer dois (gerar + conferir) seria tão denunciador quanto não fazer
// nenhum: o atacante lê a diferença no cronômetro e descobre quem tem conta.
let _hashFalso = null;
async function conferirInexistente(senha) {
  if (!_hashFalso) _hashFalso = await criarHash(crypto.randomBytes(24).toString('hex'));
  await conferir(String(senha || ''), _hashFalso);
  return { ok: false, precisaMigrar: false };
}

// ── Migração ──────────────────────────────────────────────────────────
// Converte na subida do servidor toda senha que ainda esteja em texto puro.
// Esperar cada usuário logar deixaria o arquivo com senhas legíveis por
// tempo indeterminado — justamente o problema que estamos consertando. A
// senha de ninguém muda: só a forma como ela é guardada.
async function migrarTudo(carregar, salvar) {
  let usuarios;
  try { usuarios = carregar() || {}; } catch { return { migrados: 0 }; }
  const pendentes = Object.entries(usuarios).filter(([, u]) => u && typeof u.password === 'string' && !ehHash(u.password));
  if (!pendentes.length) return { migrados: 0 };
  for (const [nome, u] of pendentes) {
    try { usuarios[nome].password = await criarHash(u.password); }
    catch (e) { logger.error('[senhas] não consegui migrar ' + nome + ':', e.message); }
  }
  try { salvar(usuarios); } catch (e) { return { migrados: 0, erro: e.message }; }
  return { migrados: pendentes.length, quais: pendentes.map(([n]) => n) };
}

// ── Freio de força bruta ──────────────────────────────────────────────
// Hash forte protege quem ROUBOU o arquivo. Não protege de alguém tentando
// senha por senha na tela de login — para isso, o custo tem que subir a cada
// erro. Em memória de propósito: reiniciar o processo é raro e não queremos
// mais um arquivo de estado.
const _erros = new Map();   // chave → { qtd, ate }
const LIMITE = 5;
const ESPERA_BASE_MS = 20000;
const JANELA_MS = 15 * 60 * 1000;

function chaveFreio(usuario, ip) {
  return String(usuario || '?').toLowerCase() + '|' + String(ip || '?');
}

// Devolve 0 se pode tentar, ou os segundos que faltam para poder.
function esperaObrigatoria(usuario, ip) {
  const e = _erros.get(chaveFreio(usuario, ip));
  if (!e) return 0;
  if (Date.now() > e.ate) return 0;
  return Math.ceil((e.ate - Date.now()) / 1000);
}

function registrarErro(usuario, ip) {
  const k = chaveFreio(usuario, ip);
  const agora = Date.now();
  const e = _erros.get(k);
  const qtd = (e && agora - (e.em || 0) < JANELA_MS ? e.qtd : 0) + 1;
  // Passou do limite: a espera dobra a cada erro novo (20s, 40s, 80s…),
  // com teto de 15 min.
  const espera = qtd <= LIMITE ? 0 : Math.min(ESPERA_BASE_MS * Math.pow(2, qtd - LIMITE - 1), JANELA_MS);
  _erros.set(k, { qtd, em: agora, ate: agora + espera });
  if (_erros.size > 5000) _erros.clear();   // teto de memória
  return Math.ceil(espera / 1000);
}

function limparErros(usuario, ip) {
  _erros.delete(chaveFreio(usuario, ip));
}

module.exports = {
  criarHash, conferir, ehHash, conferirInexistente, migrarTudo,
  esperaObrigatoria, registrarErro, limparErros,
  _CUSTO: CUSTO,
};
