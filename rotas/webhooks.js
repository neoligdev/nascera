// ═══════════════════════════════════════════════════════════════════════
// NASCERA — WEBHOOKS DE PAGAMENTO: Hotmart, Kiwify, Asaas e Mercado Pago
//
// A venda credita SOZINHA, inclusive às 3h da manhã — era a janela
// "pagou → não recebeu" que já custou um reembolso.
//
// UM NÚCLEO, QUATRO GATEWAYS. Os adaptadores (servicos/gateways.js) só sabem
// responder duas perguntas — "veio mesmo do gateway?" e "o que aconteceu?".
// Daqui para baixo o caminho do dinheiro é idêntico para os quatro:
//   idempotência primeiro (vendas.jaExiste — TODOS reentregam, por dias)
//   → acha o usuário pelo e-mail (ou CRIA, com senha aleatória + link de
//     primeiro acesso) → aplica o plano mapeado (oferta→plano, com padrão)
//   → registra a VENDA no ledger → dispara boas-vindas/confirmação.
// Reembolso/chargeback → marca no ledger + SUSPENDE (nunca exclui).
//
// Segurança (igual para os quatro):
//   • segredos no cofre (AES-GCM), nunca em config plano; comparação timing-safe.
//   • sem segredo configurado → 503 (desligado). Assinatura errada → 401.
//     Fail-closed: dinheiro nunca entra por chamada não verificada.
//   • evento sem mapeamento de plano → registra venda 'sem_plano' + atividade
//     (o admin resolve com 1 clique) — NUNCA credita às cegas.
//   • erro NOSSO → 500 de verdade, para o gateway reentregar depois do conserto.
//
// Primeiro acesso: o comprador recebe (por e-mail, ou por link que o admin
// copia) um token de uso único e define a própria senha em /definir-senha.html.
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const gateways = require('../servicos/gateways.js');
const logger = require('../log.js');

// Chave onde o hottok da Hotmart morava antes dos 4 gateways — lida uma
// última vez em segredosDe() e promovida para a chave nova.
const COFRE_HOTTOK_ANTIGO = 'webhook:hotmart:hottok';

function registrar(app, deps) {
  const {
    adminMiddleware, loadUsers, saveUsers, senhas, billing, vendas, segredos,
    loadNasceraConfig, saveNasceraConfig, appendActivity, trackEvent, USERS,
    email,   // A1 (opcional): boas-vindas/compra-confirmada/suspensão automáticos
  } = deps;

  const urlBase = () => ((loadNasceraConfig().email || {}).urlBase || '');

  // ── helpers ─────────────────────────────────────────────────────────
  function acharPorEmail(email) {
    if (!email) return null;
    const alvo = String(email).trim().toLowerCase();
    const users = loadUsers();
    for (const [username, u] of Object.entries(users)) {
      if (String(u.email || '').trim().toLowerCase() === alvo) return username;
    }
    return null;
  }

  // username único a partir do e-mail: "maria@x.com" → "maria" (ou maria2…)
  function usernameDoEmail(email, users) {
    const base = String(email).split('@')[0].toLowerCase()
      .replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'cliente';
    let cand = base, n = 1;
    while (users[cand]) { n++; cand = base + n; }
    return cand;
  }

  async function criarComprador(emailComprador, nome, gid) {
    const users = loadUsers();
    const username = usernameDoEmail(emailComprador, users);
    // Senha aleatória forte que NINGUÉM conhece: o acesso real vem pelo link
    // de primeiro acesso — enviado SOZINHO no e-mail de boas-vindas (A1).
    const senhaAleatoria = crypto.randomBytes(24).toString('base64url');
    const token = crypto.randomBytes(32).toString('base64url');
    users[username] = {
      name: nome || username, email: String(emailComprador).trim(),
      password: await senhas.criarHash(senhaAleatoria),
      role: 'user', createdAt: new Date().toISOString(),
      criadoPor: 'webhook:' + (gid || 'gateway'),
      definirSenha: {
        hash: crypto.createHash('sha256').update(token).digest('hex'),
        expiraEm: Date.now() + 7 * 24 * 60 * 60 * 1000,
      },
    };
    saveUsers(users);
    USERS[username] = { password: users[username].password };
    return { username, token };
  }

  // ── segredos e config por gateway ───────────────────────────────────
  function segredosDe(gid) {
    const g = gateways.POR_ID[gid]; if (!g) return {};
    const out = {};
    g.campos.forEach(function (c) {
      if (!c.segredo) return;
      let v = segredos.obter(gateways.chaveCofre(gid, c.id));
      // Migração: o hottok da Hotmart morava numa chave própria antes dos
      // quatro gateways existirem. Quem já tinha configurado não reconfigura.
      if (!v && gid === 'hotmart' && c.id === 'hottok') {
        v = segredos.obter(COFRE_HOTTOK_ANTIGO);
        if (v) segredos.guardar(gateways.chaveCofre(gid, c.id), v);
      }
      out[c.id] = v;
    });
    return out;
  }
  function cfgDe(gid) {
    const cfg = loadNasceraConfig();
    const novo = (cfg.gateways || {})[gid];
    if (novo) return novo;
    // Migração silenciosa: a config antiga da Hotmart morava em webhooks.hotmart.
    if (gid === 'hotmart') return (cfg.webhooks || {}).hotmart || {};
    return {};
  }
  function resolverPlano(conf, ofertaId, produtoId) {
    const mapa = (conf && conf.planoPorOferta) || {};
    return (ofertaId && mapa[String(ofertaId)]) || (produtoId && mapa[String(produtoId)]) ||
           (conf && conf.planoPadrao) || null;
  }
  // Irmã de resolverPlano, mas SEM padrão pega-tudo: pacote é avulso, não
  // mensalidade — não existe "pacote padrão pra toda oferta sem mapeamento".
  // Só resolve com mapeamento EXPLÍCITO em conf.pacotePorOferta.
  function resolverPacote(conf, ofertaId, produtoId) {
    const mapa = (conf && conf.pacotePorOferta) || {};
    return (ofertaId && mapa[String(ofertaId)]) || (produtoId && mapa[String(produtoId)]) || null;
  }
  function pacoteDoCatalogo(pacoteId) {
    if (!pacoteId) return null;
    return (billing.getConfig().pacotes || []).find(p => p.id === pacoteId) || null;
  }

  // ═══ O NÚCLEO DO DINHEIRO — um só para os quatro gateways ═══
  // Cada adaptador só diz "veio mesmo do gateway?" e "o que aconteceu?".
  // Daqui para baixo o caminho é idêntico: idempotência primeiro, conta,
  // plano, venda no ledger, e-mail. Um gateway novo não duplica nada disto.
  app.post('/api/webhooks/:gateway', async (req, res) => {
    const gid = String(req.params.gateway || '').toLowerCase();
    const g = gateways.POR_ID[gid];
    if (!g) return res.status(404).json({ error: 'Gateway desconhecido' });

    const seg = segredosDe(gid);
    const v = g.validar(req, seg);
    if (!v.ok) {
      if (v.motivo === 'nao-configurado') return res.status(503).json({ error: 'Webhook não configurado' });
      trackEvent('webhook_assinatura_invalida', { gateway: gid, ip: req.ip || null });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let ev;
    try {
      ev = await g.interpretar(req, seg);   // Mercado Pago consulta a API aqui
    } catch (err) {
      appendActivity({ type: 'webhook_erro', user: '?', data: { gateway: gid, erro: err.message }, at: new Date().toISOString() });
      return res.status(500).json({ error: 'Não consegui ler o evento' });   // gateway reentrega
    }

    try {
      // ── venda aprovada → creditar (idempotente) ──
      if (ev.tipo === 'aprovada') {
        if (!ev.txId) return res.status(400).json({ error: 'Evento sem identificador de transação' });
        // IDEMPOTÊNCIA PRIMEIRO: reentrega (todos os gateways reentregam, por
        // DIAS) encontra a venda e vira no-op. Com PG, quem decide é o UNIQUE.
        if (await vendas.jaExiste(gid, ev.txId)) return res.json({ ok: true, duplicada: true });

        const conf = cfgDe(gid);
        // Pacote resolve PRIMEIRO: resolverPlano tem um padrão pega-tudo
        // (conf.planoPadrao) — se rodasse antes, uma oferta pensada pra pacote
        // mas ainda sem mapeamento cairia no plano padrão do gateway por engano.
        // Pacote nunca tem padrão, então checá-lo primeiro nunca desvia uma
        // venda de plano de verdade.
        const pacoteId = resolverPacote(conf, ev.ofertaId, ev.produtoId);
        const pacote = pacoteId ? pacoteDoCatalogo(pacoteId) : null;
        const plano = pacoteId ? null : resolverPlano(conf, ev.ofertaId, ev.produtoId);
        const emailComprador = ev.email || null;
        // Asaas/Mercado Pago podem mandar o e-mail (ou o username) na
        // referência externa — é o caminho de achar a conta quando o payload
        // não traz e-mail nenhum. Pra PACOTE (crédito avulso, silencioso e sem
        // aviso ao "dono" da conta), esse último recurso — tratar a referência
        // como username direto, sem checar e-mail — fica de fora: um
        // referenciaExterna reaproveitado por engano (link de pagamento
        // copiado, template mal configurado no gateway) creditaria a conta de
        // um terceiro real sem chance de reclamar. Pra PLANO isso já existia
        // e continua (achado da revisão: risco de config, não de código).
        let username = acharPorEmail(emailComprador) ||
                       (ev.referenciaExterna ? acharPorEmail(ev.referenciaExterna) : null) ||
                       (!pacoteId && ev.referenciaExterna && loadUsers()[ev.referenciaExterna] ? ev.referenciaExterna : null);
        let criado = false, tokenAcesso = null;
        if (!username && emailComprador) {
          const novo = await criarComprador(emailComprador, ev.nome, gid);
          username = novo.username; tokenAcesso = novo.token; criado = true;
        }

        let status = 'aprovada';
        if (username && plano) {
          try { billing.setUserPlan(username, plano); }
          catch (e) { status = 'sem_plano'; }   // plano do mapa não existe mais
        } else if (!(username && pacote)) {
          status = 'sem_plano';                  // sem mapeamento ou sem e-mail
        }
        // pacote (se houver) NÃO é aplicado aqui ainda — só depois que o registro
        // abaixo vencer a corrida contra uma reentrega simultânea. setUserPlan
        // pode rodar antes porque aplicar o MESMO plano 2× é inofensivo;
        // addBalance não é — duas entregas quase simultâneas passariam pelo
        // jaExiste() dos dois lados antes de qualquer uma vencer o ledger.

        const reg = await vendas.registrar({
          gateway: gid, transactionId: ev.txId, username, email: emailComprador,
          valorBrl: ev.valorBrl || 0, meio: gid, referencia: ev.txId,
          plano: status === 'aprovada' && plano ? plano : null,
          // Grava o que foi COMPRADO mesmo quando `status` não é 'aprovada'
          // (sem e-mail ainda, pacote apagado do catálogo depois de mapeado
          // etc.) — senão a venda pendente fica sem nenhum registro do que
          // era, e o admin não tem como aplicar manualmente depois
          // (achado da revisão: `status` já diz se foi APLICADO; este campo
          // diz o que foi VENDIDO — os dois puderam divergir sempre).
          pacoteCreditos: pacote ? pacote.creditos : null,
          origem: 'webhook', status, evento: ev.evento,
        });
        // Corrida entre duas entregas simultâneas: o UNIQUE decide — quem
        // perdeu NÃO manda e-mail, NÃO conta como criado, e (novo) NÃO
        // credita o pacote.
        if (reg.duplicada) return res.json({ ok: true, duplicada: true });

        let pacoteAplicado = false;
        if (status === 'aprovada' && pacote) {
          // addBalance é síncrono e pode falhar (I/O de disco) — sem guarda,
          // uma falha aqui vira 500, o gateway reentrega, jaExiste() já acha
          // a venda (linha 158) e a reentrega vira no-op silencioso: o
          // cliente pagou e nunca mais recebe o crédito (achado da revisão).
          // A venda já ficou registrada (linha acima) com o que foi
          // comprado — um admin pode aplicar manualmente pelo botão "+
          // Saldo" já existente, então logar alto aqui é a rede de segurança,
          // não silenciar o erro nem arriscar cobrar 2× n dando retry aqui.
          try {
            billing.addBalance(username, pacote.creditos, 'Pacote ' + pacote.id);
            pacoteAplicado = true;
          } catch (err) {
            logger.error('[webhooks] addBalance falhou pro pacote ' + pacote.id + ' de ' + username + ' (venda ' + reg.venda.id + '): ' + err.message);
            appendActivity({
              type: 'pacote_credito_falhou', user: username,
              data: { gateway: gid, txId: ev.txId, pacote: pacote.id, creditos: pacote.creditos, vendaId: reg.venda.id, erro: err.message },
              at: new Date().toISOString(),
            });
          }
        }

        // A1: o onboarding fecha SOZINHO — comprador novo recebe o link para
        // definir a senha; cliente existente recebe a confirmação do plano.
        if (email && emailComprador) {
          const nome = ev.nome || username;
          if (criado && tokenAcesso) {
            email.enviarEvento('boas-vindas', emailComprador, {
              nome, usuario: username, link: urlBase() + '/definir-senha.html?t=' + tokenAcesso,
            });
          } else if (status === 'aprovada') {
            email.enviarEvento('compra-confirmada', emailComprador, {
              nome, plano: pacote ? ('Pacote de ' + pacote.creditos + ' créditos') : plano,
              valor: (ev.valorBrl || 0).toFixed(2).replace('.', ','),
            });
          }
        }
        appendActivity({
          type: status === 'aprovada' ? 'venda_gateway' : 'venda_gateway_pendente',
          user: username || emailComprador || '?',
          data: { gateway: gid, txId: ev.txId, plano, pacote: pacote ? pacote.id : null, valor: ev.valorBrl, criado,
                  motivo: status === 'aprovada' ? null : 'sem mapeamento de plano/pacote ou sem e-mail' },
          at: new Date().toISOString(),
        });
        return res.json({
          ok: true, gateway: gid, username,
          plano: status === 'aprovada' && plano ? plano : null,
          pacote: status === 'aprovada' && pacote ? pacote.id : null,
          criado, pendente: status !== 'aprovada',
        });
      }

      // ── reembolso/chargeback → suspender (NUNCA excluir) ──
      if (ev.tipo === 'reembolsada') {
        if (ev.txId) await vendas.marcarReembolso(gid, ev.txId, ev.evento);
        const username = acharPorEmail(ev.email) ||
                         (ev.referenciaExterna ? acharPorEmail(ev.referenciaExterna) : null);
        if (username) {
          const users = loadUsers();
          if (users[username] && users[username].role !== 'admin') {
            users[username].suspended = true;
            users[username].suspendedReason = 'Reembolso/estorno em ' + g.nome + ' (' + ev.evento + ')';
            users[username].suspendedAt = new Date().toISOString();
            saveUsers(users);
            if (email && users[username].email) {
              email.enviarEvento('suspensao', users[username].email, {
                nome: users[username].name || username,
                motivo: 'reembolso/estorno do pagamento em ' + g.nome,
              });
            }
          }
        }
        appendActivity({ type: 'reembolso_gateway', user: username || ev.email || '?',
                         data: { gateway: gid, txId: ev.txId, evento: ev.evento }, at: new Date().toISOString() });
        return res.json({ ok: true, gateway: gid, evento: ev.evento });
      }

      // Evento que não tratamos (boleto emitido, pagamento pendente…): 200
      // para o gateway não reentregar para sempre — mas fica registrado.
      trackEvent('webhook_ignorado', { gateway: gid, evento: ev.evento });
      return res.json({ ok: true, ignorado: ev.evento });
    } catch (err) {
      // Erro NOSSO: 500 de verdade — o gateway reentrega, e como a
      // idempotência é a primeira checagem, a reentrega não credita 2×.
      appendActivity({ type: 'webhook_erro', user: '?',
                       data: { gateway: gid, evento: ev && ev.evento, txId: ev && ev.txId, erro: err.message },
                       at: new Date().toISOString() });
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ── config dos gateways (admin) ─────────────────────────────────────
  app.get('/api/admin/gateways', adminMiddleware, (_req, res) => {
    const cfg = loadNasceraConfig();
    res.json({
      gateways: gateways.catalogo().map(function (g) {
        const seg = segredosDe(g.id);
        const conf = cfgDe(g.id);
        const faltando = g.campos.filter(function (c) { return c.obrigatorio && !seg[c.id]; }).map(function (c) { return c.rotulo; });
        return Object.assign({}, g, {
          configurado: faltando.length === 0,
          faltando,
          // Segredo NUNCA volta inteiro: só o rabo, para o admin reconhecer.
          valores: g.campos.reduce(function (o, c) {
            const v = seg[c.id];
            o[c.id] = v ? '•••' + String(v).slice(-4) : null;
            return o;
          }, {}),
          planoPadrao: conf.planoPadrao || null,
          planoPorOferta: conf.planoPorOferta || {},
          pacotePorOferta: conf.pacotePorOferta || {},
          url: '/api/webhooks/' + g.id,
        });
      }),
      pix: (cfg.pagamentos || {}).pix || null,
    });
  });

  app.put('/api/admin/gateways/:id', adminMiddleware, (req, res) => {
    const gid = String(req.params.id || '').toLowerCase();
    const g = gateways.POR_ID[gid];
    if (!g) return res.status(404).json({ error: 'Gateway desconhecido' });
    const corpo = req.body || {};

    // Segredos: campo ausente ou vazio = mantém o que já está guardado.
    g.campos.forEach(function (c) {
      if (!c.segredo) return;
      const v = corpo[c.id];
      if (v !== undefined && String(v).trim() !== '') {
        segredos.guardar(gateways.chaveCofre(gid, c.id), String(v).trim());
      }
    });

    const planoPorOferta = (corpo.planoPorOferta && typeof corpo.planoPorOferta === 'object') ? corpo.planoPorOferta : {};
    const pacotePorOferta = (corpo.pacotePorOferta && typeof corpo.pacotePorOferta === 'object') ? corpo.pacotePorOferta : {};
    // A mesma oferta nunca pode significar plano E pacote — rejeitado AQUI
    // (config), nunca em runtime: em runtime resolverPacote()/resolverPlano()
    // resolveriam pra um dos dois silenciosamente.
    const conflitos = Object.keys(planoPorOferta).filter(k => pacotePorOferta[k] !== undefined);
    if (conflitos.length) {
      return res.status(400).json({ error: 'Oferta mapeada para plano E pacote ao mesmo tempo: ' + conflitos.join(', ') });
    }
    const cfg = loadNasceraConfig();
    cfg.gateways = cfg.gateways || {};
    cfg.gateways[gid] = { planoPadrao: corpo.planoPadrao || null, planoPorOferta, pacotePorOferta };
    saveNasceraConfig(cfg);
    appendActivity({ type: 'admin_gateway_config', user: req.user.user,
                     data: { gateway: gid, planoPadrao: cfg.gateways[gid].planoPadrao }, at: new Date().toISOString() });
    res.json({ ok: true });
  });

  // Desliga um gateway: apaga os segredos (o webhook volta a responder 503).
  app.delete('/api/admin/gateways/:id', adminMiddleware, (req, res) => {
    const gid = String(req.params.id || '').toLowerCase();
    const g = gateways.POR_ID[gid];
    if (!g) return res.status(404).json({ error: 'Gateway desconhecido' });
    g.campos.forEach(function (c) {
      if (c.segredo) segredos.esquecer(gateways.chaveCofre(gid, c.id));
    });
    appendActivity({ type: 'admin_gateway_desligado', user: req.user.user, data: { gateway: gid }, at: new Date().toISOString() });
    res.json({ ok: true });
  });

  // ── ledger de vendas (admin) ────────────────────────────────────────
  app.get('/api/admin/vendas', adminMiddleware, async (req, res) => {
    res.json({
      resumo: await vendas.resumo(),
      vendas: await vendas.listar({ username: req.query.username || undefined, limite: Number(req.query.limite) || 100 }),
    });
  });

  // ── link de primeiro acesso (o comprador define a própria senha) ────
  // Token de uso único, 7 dias, hash no users.json — o link É a credencial,
  // então ele só EXISTE na resposta desta chamada (o admin copia e envia).
  app.post('/api/admin/users/:username/link-acesso', adminMiddleware, (req, res) => {
    const users = loadUsers();
    const u = users[req.params.username];
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
    const token = crypto.randomBytes(32).toString('base64url');
    u.definirSenha = {
      hash: crypto.createHash('sha256').update(token).digest('hex'),
      expiraEm: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    saveUsers(users);
    appendActivity({ type: 'admin_link_acesso', user: req.user.user, data: { username: req.params.username }, at: new Date().toISOString() });
    res.json({ ok: true, link: '/definir-senha.html?t=' + token, expiraEmDias: 7 });
  });

  // Público (o comprador chega pelo link): troca o token pela senha nova.
  app.post('/api/primeiro-acesso', async (req, res) => {
    const { token, senha } = req.body || {};
    if (!token || !senha || String(senha).length < 6) {
      return res.status(400).json({ error: 'Token e senha (mín. 6 caracteres) obrigatórios' });
    }
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const users = loadUsers();
    const entrada = Object.entries(users).find(([, u]) =>
      u.definirSenha && u.definirSenha.hash === hash);
    if (!entrada || entrada[1].definirSenha.expiraEm < Date.now()) {
      return res.status(400).json({ error: 'Link inválido ou expirado. Peça um novo ao suporte.' });
    }
    const [username, u] = entrada;
    u.password = await senhas.criarHash(String(senha));
    delete u.definirSenha;             // uso único: o link morre aqui
    saveUsers(users);
    USERS[username] = { password: u.password };
    appendActivity({ type: 'primeiro_acesso_concluido', user: username, data: {}, at: new Date().toISOString() });
    res.json({ ok: true, username });
  });
}

module.exports = { registrar };
