// ═══════════════════════════════════════════════════════════════════════
// NASCERA — serviço de E-MAIL (Sprint A1 do BACKLOG-ADMIN)
//
// O motivo LITERAL do reembolso que já aconteceu: o produto não tinha e-mail.
// Este módulo é a fundação: nodemailer + fila com retry + log de envios +
// templates por evento com variáveis — e o modo NASCERA_MAIL_FAKE=1 (testes:
// grava no log em vez de enviar, mesmo padrão do fake-engine).
//
// Segurança/operação:
//   • senha SMTP no COFRE (segredos.js), nunca em nascera-config.json;
//   • falha de envio NUNCA derruba o chamador (fire-and-forget com retry
//     3× e backoff; o erro real fica no log para o admin ler);
//   • template editável pelo admin com FALLBACK embutido — template apagado
//     ou quebrado nunca quebra o envio;
//   • idempotência por janela (jaEnviadoRecente) para eventos recorrentes
//     como o aviso de 80% — avisar uma vez por semana, não por turno.
//
// Fábrica criar(deps): o server injeta loadNasceraConfig + segredos.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const logger = require('../log.js');

const LOG_FILE = process.env.NASCERA_EMAILS_FILE || path.join(__dirname, '..', 'emails.jsonl');
const COFRE_SENHA = 'email:smtp:senha';

// ── templates embutidos (o fallback que nunca falha) ────────────────────
// Variáveis: {{nome}} {{usuario}} {{link}} {{plano}} {{valor}} {{motivo}} {{pct}}
const PADRAO = {
  'boas-vindas': {
    assunto: 'Bem-vindo ao {{produto}} — defina sua senha e comece',
    corpo: 'Olá {{nome}}!\n\nSua compra foi confirmada e sua conta já está pronta.\n\nDefina sua senha neste link (vale por 7 dias):\n{{link}}\n\nDepois é só entrar e começar a construir.\n\nQualquer dúvida, responda este e-mail.',
  },
  'esqueci-senha': {
    assunto: 'Redefinir sua senha — {{produto}}',
    corpo: 'Olá {{nome}},\n\nRecebemos um pedido para redefinir a sua senha. Use este link (vale por 30 minutos e só funciona uma vez):\n{{link}}\n\nSe não foi você, ignore este e-mail — nada muda.',
  },
  'compra-confirmada': {
    assunto: 'Pagamento confirmado — plano {{plano}} ativo',
    corpo: 'Olá {{nome}}!\n\nSeu pagamento de R$ {{valor}} foi confirmado e o plano {{plano}} já está ativo na sua conta.\n\nBons builds!',
  },
  'credito-80': {
    assunto: 'Você já usou {{pct}}% dos seus créditos',
    corpo: 'Olá {{nome}},\n\nVocê já usou {{pct}}% dos créditos desta semana. Para não ser interrompido no meio de um build, veja os planos e créditos:\n{{link}}',
  },
  'suspensao': {
    assunto: 'Sua conta foi suspensa — {{produto}}',
    corpo: 'Olá {{nome}},\n\nSua conta foi suspensa: {{motivo}}.\n\nSeus projetos continuam intactos. Para regularizar, fale com a gente respondendo este e-mail.',
  },
};
const EVENTOS = Object.keys(PADRAO);

function criar(deps) {
  const { loadNasceraConfig, segredos } = deps;

  function cfgSmtp() {
    return (loadNasceraConfig().email || {});
  }
  function configurado() {
    const c = cfgSmtp();
    if (!c.host || !c.remetente) return false;
    // Relay interno sem autenticação é raro mas existe (semAuth); o normal
    // é exigir a senha no cofre.
    return c.semAuth ? true : segredos.obter(COFRE_SENHA) !== null;
  }

  function transporter() {
    const c = cfgSmtp();
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
      host: c.host,
      port: Number(c.port) || 587,
      secure: Number(c.port) === 465,          // 465 = TLS implícito; 587 = STARTTLS
      auth: c.semAuth ? undefined : { user: c.usuario || c.remetente, pass: segredos.obter(COFRE_SENHA) || '' },
      connectionTimeout: 10000,
    });
  }

  // ── log append-only (o admin lê os últimos envios na tela) ────────────
  function logar(entrada) {
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + '\n');
    } catch (e) { logger.error('[email] log falhou:', e.message); }
  }
  function logRecentes(n) {
    try {
      const linhas = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
      return linhas.slice(-(n || 30)).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
  // Evento recorrente: já mandei este evento para este destino nos últimos N dias?
  function jaEnviadoRecente(evento, para, dias) {
    const corte = Date.now() - (dias || 7) * 24 * 60 * 60 * 1000;
    return logRecentes(500).some(e =>
      e.evento === evento && e.para === para &&
      (e.status === 'enviado' || e.status === 'fake') &&
      new Date(e.ts).getTime() > corte);
  }

  // ── renderização (template do admin > padrão embutido) ────────────────
  function renderizar(evento, vars) {
    const overrides = (loadNasceraConfig().emailTemplates || {})[evento] || {};
    const base = PADRAO[evento] || { assunto: evento, corpo: '' };
    const assunto = (overrides.assunto || base.assunto);
    const corpo = (overrides.corpo || base.corpo);
    const todas = { produto: (loadNasceraConfig().nomeProduto || 'Nascera'), ...vars };
    const preencher = (t) => String(t).replace(/\{\{(\w+)\}\}/g, (_, k) => (todas[k] != null ? String(todas[k]) : ''));
    const texto = preencher(corpo);
    // Layout HTML mínimo e limpo por cima do texto (quebras preservadas).
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a2e">' +
      texto.split('\n').map(l => l.trim() === '' ? '<br>' :
        '<p style="margin:0 0 4px;line-height:1.6">' + l.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#6666FF">$1</a>') + '</p>').join('') +
      '</div>';
    return { assunto: preencher(assunto), texto, html };
  }

  // ── envio com retry (nunca lança; resultado vai para o log) ───────────
  async function tentarEnvio(msg) {
    const c = cfgSmtp();
    const t = transporter();
    try {
      await t.sendMail({
        from: c.remetenteNome ? `"${c.remetenteNome}" <${c.remetente}>` : c.remetente,
        to: msg.para, subject: msg.assunto, text: msg.texto, html: msg.html,
      });
      return { ok: true };
    } catch (e) { return { ok: false, erro: e.message }; } finally { try { t.close(); } catch {} }
  }

  async function enviar({ para, assunto, texto, html, evento }) {
    if (!para) return { ok: false, erro: 'sem destinatário' };
    if (process.env.NASCERA_MAIL_FAKE) {
      logar({ para, assunto, evento: evento || null, status: 'fake' });
      return { ok: true, fake: true };
    }
    if (!configurado()) {
      logar({ para, assunto, evento: evento || null, status: 'erro', erro: 'SMTP não configurado' });
      return { ok: false, erro: 'SMTP não configurado' };
    }
    // 3 tentativas com backoff — provedor SMTP engasga, a fila insiste.
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const r = await tentarEnvio({ para, assunto, texto, html });
      if (r.ok) { logar({ para, assunto, evento: evento || null, status: 'enviado', tentativa }); return { ok: true }; }
      if (tentativa === 3) { logar({ para, assunto, evento: evento || null, status: 'erro', erro: r.erro, tentativa }); return { ok: false, erro: r.erro }; }
      await new Promise(res => setTimeout(res, tentativa === 1 ? 30000 : 120000));
    }
  }

  // Fire-and-forget: os chamadores (webhook, débito) NUNCA esperam o SMTP.
  function enviarEvento(evento, para, vars) {
    const { assunto, texto, html } = renderizar(evento, vars || {});
    enviar({ para, assunto, texto, html, evento }).catch(() => {});
  }
  // Recorrente com janela: o aviso de 80% sai 1× por semana, não 1× por turno.
  function enviarEventoUnico(evento, para, vars, dias) {
    if (jaEnviadoRecente(evento, para, dias)) return false;
    // Reserva a janela ANTES do envio assíncrono — dois turnos simultâneos não
    // passam os dois pelo jaEnviadoRecente.
    logar({ para, assunto: '(reserva)', evento, status: 'fake', reserva: true });
    enviarEvento(evento, para, vars);
    return true;
  }

  // Teste do admin: envio direto, erro VERBATIM na resposta (sem retry).
  async function testar(para) {
    if (process.env.NASCERA_MAIL_FAKE) return { ok: true, fake: true };
    if (!configurado()) return { ok: false, erro: 'Preencha host, remetente e senha primeiro.' };
    const r = await tentarEnvio({
      para, assunto: 'Teste de e-mail — Nascera',
      texto: 'Se você está lendo isto, o SMTP do seu Nascera está funcionando. 🎉',
      html: '<p>Se você está lendo isto, o SMTP do seu Nascera está funcionando. 🎉</p>',
    });
    logar({ para, assunto: 'Teste de e-mail — Nascera', evento: 'teste', status: r.ok ? 'enviado' : 'erro', erro: r.erro });
    return r;
  }

  return { configurado, enviar, enviarEvento, enviarEventoUnico, renderizar, testar, logRecentes, EVENTOS, PADRAO, COFRE_SENHA };
}

module.exports = { criar, EVENTOS, PADRAO, COFRE_SENHA, LOG_FILE };
