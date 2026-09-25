// ═══════════════════════════════════════════════════════════════════════
// NASCERA — assinatura das atualizações (Ed25519)
//
// O problema que isto resolve, apontado numa auditoria de cliente:
// o atualizador conferia o sha256 do pacote — mas o hash vinha DO MESMO
// SERVIDOR que servia o pacote. Isso protege contra corrupção no caminho,
// e contra absolutamente nada além disso: quem dominar o servidor de
// atualização serve um pacote malicioso E o hash correspondente. Como o
// pacote é código que roda na máquina do cliente, isso vira execução remota
// em toda a base instalada de uma vez.
//
// A correção: assinatura de chave pública. A chave PRIVADA fica com quem
// publica (fora do produto, num cofre). A chave PÚBLICA vai embutida em cada
// cópia do NASCERA. Um servidor comprometido pode servir o que quiser — sem a
// privada, não consegue produzir assinatura que a pública valide.
//
// Ed25519 e não RSA: chave e assinatura curtas, verificação rápida, e sem
// parâmetros para configurar errado. Vem no Node, sem dependência nova.
//
// Gerar o par (uma vez, na máquina de quem publica):
//   node assinatura.js --gerar-par
// Assinar um pacote:
//   node assinatura.js --assinar nascera-1.5.0.tar.gz --chave chave-privada.pem
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const logger = require('./log.js');
const crypto = require('crypto');

// ─── Chave pública oficial ───────────────────────────────────────────
// Substituída pelo valor real ao gerar o par. Enquanto estiver vazia, o
// modo de compatibilidade permanece ligado (veja `exigirAssinatura`).
const CHAVE_PUBLICA_OFICIAL = process.env.NASCERA_UPDATE_PUBKEY || '';

// Exigir assinatura é o padrão SE existe chave pública configurada. Sem
// chave, o produto ainda não tem como verificar nada — e travar as
// atualizações de quem já está instalado seria pior que o risco. A variável
// permite forçar a exigência mesmo antes disso.
function exigirAssinatura() {
  if (process.env.NASCERA_EXIGIR_ASSINATURA === 'true') return true;
  if (process.env.NASCERA_EXIGIR_ASSINATURA === 'false') return false;
  return !!CHAVE_PUBLICA_OFICIAL;
}

function chavePublica() {
  if (!CHAVE_PUBLICA_OFICIAL) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.from(CHAVE_PUBLICA_OFICIAL, 'base64'),
      format: 'der', type: 'spki',
    });
  } catch (e) {
    logger.error('[assinatura] chave pública inválida:', e.message);
    return null;
  }
}

// Verifica a assinatura de um arquivo. Devolve o motivo em vez de só
// `false` — na hora de investigar, "por que falhou" importa.
function verificarArquivo(caminhoDoPacote, assinaturaBase64) {
  if (!exigirAssinatura()) {
    return { ok: true, verificado: false, motivo: 'assinatura não exigida nesta instalação' };
  }
  const pub = chavePublica();
  if (!pub) return { ok: false, motivo: 'chave pública ausente ou inválida no cliente' };
  if (!assinaturaBase64) return { ok: false, motivo: 'o servidor não enviou assinatura para este pacote' };

  let assinatura;
  try { assinatura = Buffer.from(assinaturaBase64, 'base64'); }
  catch { return { ok: false, motivo: 'assinatura em formato inválido' }; }

  let dados;
  try { dados = fs.readFileSync(caminhoDoPacote); }
  catch (e) { return { ok: false, motivo: 'não consegui ler o pacote: ' + e.message }; }

  // Ed25519 assina a mensagem inteira; algoritmo `null` é o correto aqui.
  const valida = crypto.verify(null, dados, pub, assinatura);
  return valida
    ? { ok: true, verificado: true }
    : { ok: false, motivo: 'ASSINATURA NÃO CONFERE — o pacote não foi publicado por quem diz ser' };
}

function assinarArquivo(caminho, chavePrivadaPem) {
  const priv = crypto.createPrivateKey(chavePrivadaPem);
  const dados = fs.readFileSync(caminho);
  return crypto.sign(null, dados, priv).toString('base64');
}

function gerarPar() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicaBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privadaPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

module.exports = {
  verificarArquivo, assinarArquivo, gerarPar, exigirAssinatura,
  CHAVE_PUBLICA_OFICIAL,
};

// ─── linha de comando ────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--gerar-par')) {
    const par = gerarPar();
    logger.info('\n🔑  Par de chaves para assinar atualizações do NASCERA\n');
    logger.info('CHAVE PRIVADA — guarde num cofre. NUNCA no repositório, nunca no pacote.');
    logger.info('Quem tiver este arquivo pode publicar atualização em nome do NASCERA.\n');
    logger.info(par.privadaPem);
    logger.info('CHAVE PÚBLICA — vai embutida em cada cópia do NASCERA (é pública mesmo):\n');
    logger.info('  ' + par.publicaBase64 + '\n');
    logger.info('Como usar:');
    logger.info('  1. Salve a privada em chave-privada.pem (modo 600), fora do projeto.');
    logger.info('  2. Defina a pública no ambiente do produto:');
    logger.info('     NASCERA_UPDATE_PUBKEY=' + par.publicaBase64);
    logger.info('  3. Assine cada release antes de publicar:');
    logger.info('     node assinatura.js --assinar nascera-X.Y.Z.tar.gz --chave chave-privada.pem\n');
    process.exit(0);
  }

  // Verificação pela linha de comando — é o que o atualizador da VPS chama
  // antes de extrair o pacote. Sai com código 1 quando a assinatura não
  // confere, para o shell abortar a atualização.
  const v = args.indexOf('--verificar');
  if (v >= 0) {
    const pacote = args[v + 1];
    const s = args.indexOf('--sig');
    const arqSig = s >= 0 ? args[s + 1] : (pacote ? pacote + '.sig' : null);
    if (!pacote || !arqSig) {
      logger.error('\nUso: node assinatura.js --verificar <pacote.tar.gz> [--sig <arquivo.sig>]\n');
      process.exit(1);
    }
    let sig;
    try { sig = fs.readFileSync(arqSig, 'utf8').trim(); }
    catch (e) { logger.error('  não consegui ler a assinatura: ' + e.message); process.exit(1); }

    const r = verificarArquivo(pacote, sig);
    if (!r.ok) { logger.error('  ✖ ' + r.motivo); process.exit(1); }
    if (!r.verificado) { logger.error('  ✖ sem chave pública configurada — recusando'); process.exit(1); }
    logger.info('  ✓ assinatura confere');
    process.exit(0);
  }

  const i = args.indexOf('--assinar');
  if (i >= 0) {
    const pacote = args[i + 1];
    const j = args.indexOf('--chave');
    const chave = j >= 0 ? args[j + 1] : null;
    if (!pacote || !chave) {
      logger.error('\nUso: node assinatura.js --assinar <pacote.tar.gz> --chave <privada.pem>\n');
      process.exit(1);
    }
    try {
      const sig = assinarArquivo(pacote, fs.readFileSync(chave, 'utf8'));
      logger.info('\n  Assinatura (envie junto ao publicar o release):\n');
      logger.info('  ' + sig + '\n');
    } catch (e) {
      logger.error('\n  Falhou: ' + e.message + '\n');
      process.exit(1);
    }
    process.exit(0);
  }

  logger.info('\nUso:\n  node assinatura.js --gerar-par' +
              '\n  node assinatura.js --assinar <pacote> --chave <privada.pem>\n');
}
