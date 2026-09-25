// ═══════════════════════════════════════════════════════════════════════
// NASCERA — ADAPTADORES DE GATEWAY DE PAGAMENTO (A2 do BACKLOG-ADMIN)
//
// Quatro empresas, um núcleo só. Cada adaptador sabe apenas DUAS coisas:
//   • validar(req, segredos)  — esta chamada veio mesmo do gateway?
//   • interpretar(req)        — o que aconteceu, em vocabulário do NASCERA?
// Quem credita, cria conta, aplica plano, grava a venda e manda e-mail é o
// núcleo em rotas/webhooks.js — idêntico para os quatro. Assim um gateway
// novo não duplica a lógica que mexe em dinheiro.
//
// VOCABULÁRIO comum devolvido por interpretar():
//   { tipo: 'aprovada' | 'reembolsada' | 'ignorado',
//     txId, email, nome, valorBrl, ofertaId, produtoId, evento }
//
// SEGURANÇA: nenhum adaptador "confia e segue". Sem segredo configurado, o
// webhook responde 503 (desligado). Assinatura errada, 401. É fail-closed —
// dinheiro nunca entra por chamada não verificada.
// ═══════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

function igualSeguro(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}
function centavosParaReais(v) {
  const n = Number(v) || 0;
  return n / 100;
}

// ─── HOTMART ──────────────────────────────────────────────────────────
// Verificação: header `x-hotmart-hottok` igual ao hottok da conta.
const hotmart = {
  id: 'hotmart',
  artigo: 'a',      // para o texto do painel sair em português de gente
  nome: 'Hotmart',
  cor: '#F04E23',
  resumo: 'Infoproduto com afiliados. A venda aprovada vira cliente e plano sozinha.',
  campos: [
    { id: 'hottok', rotulo: 'Hottok', tipo: 'senha', segredo: true, obrigatorio: true,
      ajuda: 'Hotmart → Ferramentas → Webhook (API e Notificações). O hottok aparece na tela de cadastro do webhook.' },
  ],
  comoLigar: [
    'Entre na Hotmart → Ferramentas → Webhook (API e Notificações).',
    'Clique em Cadastrar Webhook e cole a URL do webhook (o primeiro campo abaixo).',
    'Marque os eventos: Compra aprovada, Compra completa, Reembolso, Chargeback e Cancelamento.',
    'Copie o hottok que a Hotmart mostrar e cole no campo aqui do lado.',
  ],
  validar(req, seg) {
    if (!seg.hottok) return { ok: false, motivo: 'nao-configurado' };
    return igualSeguro(req.headers['x-hotmart-hottok'], seg.hottok)
      ? { ok: true } : { ok: false, motivo: 'assinatura' };
  },
  interpretar(req) {
    const b = req.body || {};
    const evento = String(b.event || '').toUpperCase();
    const d = b.data || {}, compra = d.purchase || {}, comprador = d.buyer || {};
    const base = {
      evento,
      txId: compra.transaction || b.id || null,
      email: comprador.email || null,
      nome: comprador.name || null,
      valorBrl: (compra.price && Number(compra.price.value)) || 0,
      ofertaId: (compra.offer && compra.offer.code) || null,
      produtoId: (d.product && d.product.id) || null,
    };
    if (evento === 'PURCHASE_APPROVED' || evento === 'PURCHASE_COMPLETE') return Object.assign(base, { tipo: 'aprovada' });
    if (['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_PROTEST', 'PURCHASE_CANCELED'].includes(evento)) {
      return Object.assign(base, { tipo: 'reembolsada' });
    }
    return Object.assign(base, { tipo: 'ignorado' });
  },
};

// ─── KIWIFY ───────────────────────────────────────────────────────────
// Verificação: `?signature=` na query = HMAC-SHA1 do CORPO CRU com o token.
const kiwify = {
  id: 'kiwify',
  // A fatia de kiwi encosta nas bordas do viewBox (500 de 512): encolhe um
  // tico para respirar igual às vizinhas.
  logoEscala: 0.92,
  artigo: 'a',      // para o texto do painel sair em português de gente
  nome: 'Kiwify',
  cor: '#00B57F',
  resumo: 'Infoproduto brasileiro. Assina o corpo da chamada com HMAC — checagem forte.',
  campos: [
    { id: 'token', rotulo: 'Token do webhook', tipo: 'senha', segredo: true, obrigatorio: true,
      ajuda: 'Kiwify → Apps → Webhooks → criar webhook. O token aparece junto da URL cadastrada.' },
  ],
  comoLigar: [
    'Entre na Kiwify → Apps → Webhooks.',
    'Crie um webhook novo e cole a URL do webhook (o primeiro campo abaixo).',
    'Marque os eventos: Compra aprovada, Reembolso e Chargeback.',
    'Copie o token que a Kiwify gera e cole no campo aqui do lado.',
  ],
  validar(req, seg) {
    if (!seg.token) return { ok: false, motivo: 'nao-configurado' };
    const assinatura = req.query && req.query.signature;
    if (!assinatura) return { ok: false, motivo: 'assinatura' };
    // O HMAC é sobre os BYTES recebidos — por isso o corpo cru.
    const cru = req.corpoCru || Buffer.from(JSON.stringify(req.body || {}));
    const esperado = crypto.createHmac('sha1', seg.token).update(cru).digest('hex');
    return igualSeguro(assinatura, esperado) ? { ok: true } : { ok: false, motivo: 'assinatura' };
  },
  interpretar(req) {
    const b = req.body || {};
    const cliente = b.Customer || b.customer || {};
    const produto = b.Product || b.product || {};
    const com = b.Commissions || b.commissions || {};
    const status = String(b.order_status || b.status || '').toLowerCase();
    // A Kiwify manda o valor em centavos (charge_amount).
    const valor = com.charge_amount != null ? centavosParaReais(com.charge_amount)
                : (b.charge_amount != null ? centavosParaReais(b.charge_amount) : 0);
    const base = {
      evento: (b.webhook_event_type || status || '').toString(),
      txId: b.order_id || b.id || null,
      email: cliente.email || null,
      nome: cliente.full_name || cliente.first_name || null,
      valorBrl: valor,
      ofertaId: b.product_offer_id || (b.Subscription && b.Subscription.plan && b.Subscription.plan.id) || null,
      produtoId: produto.product_id || produto.id || null,
    };
    if (status === 'paid' || status === 'approved') return Object.assign(base, { tipo: 'aprovada' });
    if (['refunded', 'chargedback', 'chargeback'].includes(status)) return Object.assign(base, { tipo: 'reembolsada' });
    return Object.assign(base, { tipo: 'ignorado' });
  },
};

// ─── ASAAS ────────────────────────────────────────────────────────────
// Verificação: header `asaas-access-token` igual ao token que VOCÊ define
// no cadastro do webhook no painel do Asaas.
const asaas = {
  id: 'asaas',
  artigo: 'o',
  // O logo do Asaas é um app-icon: já vem com fundo azul próprio. No painel ele
  // sangra até a borda do quadradinho, senão vira quadrado dentro de quadrado.
  logoSangra: true,      // para o texto do painel sair em português de gente
  nome: 'Asaas',
  cor: '#1B7BEE',
  resumo: 'Pix, boleto e cartão com cobrança recorrente. O evento já vem completo, sem consulta extra.',
  campos: [
    { id: 'token', rotulo: 'Token de autenticação do webhook', tipo: 'senha', segredo: true, obrigatorio: true,
      ajuda: 'Você INVENTA este token e cadastra no Asaas → Integrações → Webhooks, no campo "Token de autenticação". Use algo longo e aleatório.' },
  ],
  comoLigar: [
    'Entre no Asaas → Integrações → Webhooks → Adicionar webhook.',
    'Copie a URL do webhook (o primeiro campo abaixo) e cole em "URL do webhook" no Asaas.',
    'Invente um token longo (ex.: 32 caracteres aleatórios), cole no campo "Token de autenticação" do Asaas E no campo aqui do lado — os dois têm que ser idênticos.',
    'Marque os eventos de Cobrança: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_REFUNDED e PAYMENT_CHARGEBACK_REQUESTED.',
  ],
  validar(req, seg) {
    if (!seg.token) return { ok: false, motivo: 'nao-configurado' };
    return igualSeguro(req.headers['asaas-access-token'], seg.token)
      ? { ok: true } : { ok: false, motivo: 'assinatura' };
  },
  interpretar(req) {
    const b = req.body || {};
    const evento = String(b.event || '').toUpperCase();
    const p = b.payment || {};
    const base = {
      evento,
      txId: p.id || b.id || null,
      // O e-mail do pagador nem sempre vem no payload; quando o dono usa
      // externalReference com o e-mail/username, aproveitamos.
      email: (p.customerEmail || (p.customer && p.customer.email) || null),
      nome: (p.customerName || (p.customer && p.customer.name) || null),
      valorBrl: Number(p.value) || 0,
      ofertaId: p.externalReference || null,
      produtoId: p.installment || null,
      referenciaExterna: p.externalReference || null,
    };
    if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(evento)) return Object.assign(base, { tipo: 'aprovada' });
    if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_DELETED'].includes(evento)) {
      return Object.assign(base, { tipo: 'reembolsada' });
    }
    return Object.assign(base, { tipo: 'ignorado' });
  },
};

// ─── MERCADO PAGO ─────────────────────────────────────────────────────
// Verificação: header `x-signature` (ts + v1) = HMAC-SHA256 de um manifesto
// montado com o id da notificação. Diferente dos outros, o corpo do aviso é
// MAGRO: traz só o id do pagamento — os dados vêm de uma consulta à API.
const mercadopago = {
  id: 'mercadopago',
  // O oval ocupa só ~69% da altura do viewBox: sem compensar, parece menor
  // que os outros logos na mesma fileira.
  logoEscala: 1.24,
  artigo: 'o',      // para o texto do painel sair em português de gente
  nome: 'Mercado Pago',
  cor: '#00B1EA',
  resumo: 'Pix instantâneo e cartão. O aviso traz só o id — o NASCERA consulta a API para saber o resto.',
  campos: [
    { id: 'secret', rotulo: 'Chave secreta do webhook', tipo: 'senha', segredo: true, obrigatorio: true,
      ajuda: 'Mercado Pago → Suas integrações → sua aplicação → Webhooks. Ao cadastrar a URL, ele mostra a "assinatura secreta".' },
    { id: 'accessToken', rotulo: 'Access token', tipo: 'senha', segredo: true, obrigatorio: true,
      ajuda: 'Mercado Pago → Suas integrações → Credenciais de produção → Access token. É com ele que o NASCERA consulta o pagamento.' },
  ],
  comoLigar: [
    'Entre em Mercado Pago → Suas integrações → sua aplicação → Webhooks.',
    'Cole a URL do webhook (o primeiro campo abaixo) e marque o evento "Pagamentos".',
    'Copie a assinatura secreta que aparece e cole no primeiro campo.',
    'Em Credenciais de produção, copie o Access token e cole no segundo campo.',
    'Dica: mande o e-mail do comprador em external_reference ao criar a cobrança — é assim que o NASCERA acha a conta.',
  ],
  validar(req, seg) {
    if (!seg.secret) return { ok: false, motivo: 'nao-configurado' };
    const cab = req.headers['x-signature'];
    if (!cab) return { ok: false, motivo: 'assinatura' };
    // x-signature: "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45…"
    const partes = {};
    String(cab).split(',').forEach(function (p) {
      const i = p.indexOf('=');
      if (i > 0) partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    if (!partes.ts || !partes.v1) return { ok: false, motivo: 'assinatura' };
    const idRecurso = (req.query && (req.query['data.id'] || req.query.id)) ||
                      (req.body && req.body.data && req.body.data.id) || '';
    const reqId = req.headers['x-request-id'] || '';
    // O manifesto é definido pelo Mercado Pago nesta ordem exata.
    const manifesto = 'id:' + String(idRecurso).toLowerCase() + ';' +
                      (reqId ? 'request-id:' + reqId + ';' : '') +
                      'ts:' + partes.ts + ';';
    const esperado = crypto.createHmac('sha256', seg.secret).update(manifesto).digest('hex');
    return igualSeguro(partes.v1, esperado) ? { ok: true } : { ok: false, motivo: 'assinatura' };
  },
  // O aviso é magro: precisa consultar. Por isso este adaptador é async.
  async interpretar(req, seg) {
    const b = req.body || {};
    const tipo = String(b.type || b.topic || '').toLowerCase();
    const idPagamento = (b.data && b.data.id) || (req.query && req.query['data.id']) || null;
    const vazio = { tipo: 'ignorado', evento: tipo, txId: idPagamento, email: null, nome: null, valorBrl: 0, ofertaId: null, produtoId: null };
    if (tipo !== 'payment' || !idPagamento) return vazio;
    if (!seg.accessToken) return Object.assign(vazio, { erro: 'sem access token para consultar o pagamento' });

    const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(idPagamento), {
      headers: { Authorization: 'Bearer ' + seg.accessToken },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('consulta ao Mercado Pago falhou (HTTP ' + r.status + ')');
    const p = await r.json();
    const pagador = p.payer || {};
    const base = {
      evento: tipo + ':' + String(p.status || ''),
      txId: String(p.id || idPagamento),
      email: pagador.email || null,
      nome: [pagador.first_name, pagador.last_name].filter(Boolean).join(' ') || null,
      valorBrl: Number(p.transaction_amount) || 0,
      ofertaId: p.external_reference || null,
      produtoId: (p.additional_info && p.additional_info.items && p.additional_info.items[0] && p.additional_info.items[0].id) || null,
      referenciaExterna: p.external_reference || null,
    };
    if (p.status === 'approved') return Object.assign(base, { tipo: 'aprovada' });
    if (p.status === 'refunded' || p.status === 'charged_back' || p.status === 'cancelled') {
      return Object.assign(base, { tipo: 'reembolsada' });
    }
    return Object.assign(base, { tipo: 'ignorado' });
  },
};

const TODOS = [hotmart, kiwify, asaas, mercadopago];
const POR_ID = {};
TODOS.forEach(function (g) { POR_ID[g.id] = g; });

// O que o painel mostra (sem nunca devolver segredo em claro).
function catalogo() {
  return TODOS.map(function (g) {
    return {
      id: g.id, nome: g.nome, artigo: g.artigo, cor: g.cor, resumo: g.resumo,
      logoSangra: !!g.logoSangra, logoEscala: g.logoEscala || 1,
      comoLigar: g.comoLigar,
      campos: g.campos.map(function (c) {
        return { id: c.id, rotulo: c.rotulo, tipo: c.tipo, ajuda: c.ajuda, obrigatorio: !!c.obrigatorio };
      }),
    };
  });
}

module.exports = { TODOS, POR_ID, catalogo, chaveCofre: function (gid, campo) { return 'gateway:' + gid + ':' + campo; } };
