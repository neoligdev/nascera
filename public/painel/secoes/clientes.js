/* ═══ NASCERA ADMIN v2 — CLIENTES ═══════════════════════════════════════
   A tela do dia a dia: quem são, se podem entrar, quanto de crédito têm
   e para onde o crédito foi. Casa /api/admin/users com /api/admin/billing
   pelo username — um lado sabe quem é a pessoa, o outro quanto ela tem.
   Regra que a tela repete o tempo todo: suspender preserva os projetos;
   excluir é o último recurso.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var ALVO = null;     // container da seção (para o re-render local)
var LISTA = [];      // usuários já casados com o billing
var PLANOS = [];     // catálogo de planos vindo da config de cobrança
var BUSCA = '';
var FILTRO = 'todos';
var ABA = 'dados';   // aba corrente da ficha
var EXTRATO = {};    // cache do extrato por usuário (só busca quando abre a aba)
var EU = localStorage.getItem('nascera_user') || '';

var MEIOS = [
  { v: 'pix', t: 'Pix' }, { v: 'transferencia', t: 'Transferência bancária' },
  { v: 'dinheiro', t: 'Dinheiro' }, { v: 'cartao', t: 'Cartão' },
  { v: 'boleto', t: 'Boleto' }, { v: 'outro', t: 'Outro' },
];

Z.registrar('clientes', {
  render: function (alvo) {
    ALVO = alvo; BUSCA = ''; FILTRO = 'todos'; EXTRATO = {};
    return carregar().then(function () { pintar(); });
  },
});

// ─── Dados ────────────────────────────────────────────────────────────
function carregar() {
  return Promise.all([
    Z.api('/api/admin/users'),
    Z.api('/api/admin/billing').catch(function () { return { config: {}, users: [] }; }),
  ]).then(function (r) {
    var users = r[0], bill = r[1] || {};
    if (!Array.isArray(users)) {
      if (users && users.error) Z.erro(users.error);
      users = [];
    }
    PLANOS = (bill.config && bill.config.plans) || [];
    var porUser = {};
    (bill.users || []).forEach(function (b) { porUser[b.username] = b; });
    LISTA = users.map(function (u) {
      var b = porUser[u.username] || {};
      return {
        username: u.username,
        name: u.name || u.username,
        email: u.email || '',
        role: u.role || 'user',
        createdAt: u.createdAt || null,
        suspended: !!u.suspended,
        suspendedReason: u.suspendedReason || '',
        iaPropria: !!u.iaPropria,
        plan: b.plan || '',
        planName: b.planName || '—',
        availableMilli: b.availableMilli || 0,
        balanceMilli: b.balanceMilli || 0,
        grantMilli: b.grantMilli || 0,
        cycleMilli: b.cycleMilli || 0,
        monthlySpendUsd: b.monthlySpendUsd || 0,
        monthChargedUsd: b.monthChargedUsd || 0,
        monthBaseUsd: b.monthBaseUsd || 0,
        monthCapUsd: b.monthCapUsd || 0,
        weekUsedPct: b.weekUsedPct || 0,
        sessionUsedPct: b.sessionUsedPct || 0,
      };
    }).sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
  });
}

// Recarrega os dados e repinta a tela; reabre a ficha se pedirem.
function atualizar(user, aba) {
  return carregar().then(function () {
    pintar();
    if (user && achar(user)) abrirFicha(user, aba);
    else Z.fecharModal();
  }).catch(falha);
}

function achar(u) {
  for (var i = 0; i < LISTA.length; i++) if (LISTA[i].username === u) return LISTA[i];
  return null;
}

// ─── Pintura da tela ──────────────────────────────────────────────────
function pintar() {
  var total = LISTA.length;
  var ativos = LISTA.filter(function (u) { return !u.suspended; }).length;
  var susp = total - ativos;
  var admins = LISTA.filter(function (u) { return u.role === 'admin'; }).length;
  var ias = LISTA.filter(function (u) { return u.iaPropria; }).length;

  var html = C.cab({
    trilha: 'Negócio · Sua base',
    icone: 'clientes',
    titulo: 'Clientes',
    sub: 'Quem tem conta no seu Nascera: se pode entrar, em que plano está e quanto crédito ainda tem.',
    acoes: [
      C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' }),
      C.btn('Novo cliente', { classe: 'primario', icone: 'mais', acao: 'novo' }),
    ],
  });

  html += C.stats([
    { rot: 'Clientes', num: Z.num(total), cap: admins + ' admin(s) · ' + (total - admins) + ' cliente(s)', icone: 'clientes' },
    { rot: 'Ativos', num: Z.num(ativos), cap: 'Podem entrar e construir agora', icone: 'check', tom: ativos ? 'ok' : '' },
    { rot: 'Suspensos', num: Z.num(susp), cap: susp ? 'Sem acesso — os projetos continuam guardados' : 'Ninguém bloqueado', icone: 'bloqueio', tom: susp ? 'erro' : '' },
    { rot: 'Com IA própria', num: Z.num(ias), cap: 'Usam a chave deles — não consomem seu crédito', icone: 'raio', tom: ias ? 'acento' : '' },
  ]);

  html += '<span class="z-rotulo" style="margin-top:22px">Sua base</span>';
  html += C.busca('cli-busca', 'Buscar por nome, usuário ou e-mail…');
  html += C.filtros('cli-filtros', [
    { id: 'todos', t: 'Todos', n: total },
    { id: 'ativos', t: 'Ativos', n: ativos },
    { id: 'suspensos', t: 'Suspensos', n: susp },
    { id: 'admins', t: 'Admins', n: admins },
    { id: 'ia', t: 'IA própria', n: ias },
  ], FILTRO);
  html += '<div id="cli-lista"></div>';

  ALVO.innerHTML = '<div id="cli-raiz">' + html + '</div>';
  pintarLista();

  var b = document.getElementById('cli-busca');
  if (b) {
    b.value = BUSCA;
    b.oninput = function () { BUSCA = b.value; pintarLista(); };
  }
  Z.ligarFiltros('cli-filtros', function (id) { FILTRO = id; pintarLista(); });
  // O container é recriado a cada pintura — nenhum listener se acumula.
  Z.ligarAcoes('cli-raiz', ACOES);
}

function filtrada() {
  var t = BUSCA.trim().toLowerCase();
  return LISTA.filter(function (u) {
    if (FILTRO === 'ativos' && u.suspended) return false;
    if (FILTRO === 'suspensos' && !u.suspended) return false;
    if (FILTRO === 'admins' && u.role !== 'admin') return false;
    if (FILTRO === 'ia' && !u.iaPropria) return false;
    if (!t) return true;
    return (u.username + ' ' + u.name + ' ' + u.email).toLowerCase().indexOf(t) >= 0;
  });
}

function pintarLista() {
  var cx = document.getElementById('cli-lista');
  if (!cx) return;

  if (!LISTA.length) {
    cx.innerHTML = C.vazio({
      icone: 'clientes', tit: 'Nenhuma conta ainda',
      txt: 'Crie a primeira conta e mande o link de acesso — o cliente define a senha dele e já entra construindo.',
      acao: C.btn('Novo cliente', { classe: 'primario', icone: 'mais', acao: 'novo' }),
    });
    return;
  }

  var lista = filtrada();
  if (!lista.length) {
    cx.innerHTML = C.vazio({
      icone: 'busca', tit: 'Ninguém bate com esse filtro',
      txt: 'Tente outro termo de busca ou volte para <b>Todos</b>.',
      acao: C.btn('Ver todos', { acao: 'limpar-filtro' }),
    });
    return;
  }

  var linhas = lista.map(function (u) {
    var chips = u.suspended
      ? C.chipPonto('Suspenso', 'erro')
      : C.chipPonto('Ativo', 'ok');
    if (u.iaPropria) chips += ' ' + C.chip('IA própria', 'info');
    if (u.username === EU) chips += ' ' + C.chip('Você', 'acento');

    var acoes = C.btn('Ficha', { classe: 'mini', acao: 'ficha', dado: u.username, titulo: 'Abrir a ficha completa' }) +
      C.btn('', { classe: 'mini fantasma', icone: 'link', acao: 'link', dado: u.username, titulo: 'Gerar link de acesso' });
    if (u.username !== EU) {
      acoes += u.suspended
        ? C.btn('', { classe: 'mini fantasma', icone: 'check', acao: 'reativar', dado: u.username, titulo: 'Reativar o acesso' })
        : C.btn('', { classe: 'mini fantasma', icone: 'bloqueio', acao: 'suspender', dado: u.username, titulo: 'Suspender o acesso' });
      acoes += C.btn('', { classe: 'mini fantasma', icone: 'lixeira', acao: 'excluir', dado: u.username, titulo: 'Excluir a conta' });
    }

    return '<tr>' +
      '<td class="forte"><div data-acao="ficha" data-dado="' + att(u.username) + '" style="cursor:pointer">' +
        Z.esc(u.name) +
        '<div class="z-cel-sub">' + Z.esc(u.email || '@' + u.username) + '</div></div></td>' +
      '<td>' + (u.role === 'admin' ? C.chip('Admin', 'acento') : C.chip('Cliente')) + '</td>' +
      '<td>' + chips + (u.suspended && u.suspendedReason
        ? '<div class="z-cel-sub">' + Z.esc(u.suspendedReason) + '</div>' : '') + '</td>' +
      '<td>' + Z.esc(u.planName) +
        '<div class="z-cel-sub">' + (u.monthlySpendUsd ? 'gastou ' + Z.usd(u.monthlySpendUsd) + ' no mês' : 'sem gasto no mês') + '</div></td>' +
      '<td class="num dir">' + cr(u.availableMilli) +
        '<div class="z-cel-sub">' + (u.grantMilli ? cr(u.grantMilli) + ' de cortesia' : 'sem cortesia') + '</div></td>' +
      '<td class="dir z-fg3">' + Z.data(u.createdAt) + '</td>' +
      '<td class="dir"><div class="z-linha" style="justify-content:flex-end;gap:5px;flex-wrap:nowrap">' + acoes + '</div></td>' +
    '</tr>';
  });

  cx.innerHTML = C.card({
    corpo: C.tabela([
      { t: 'Cliente' }, { t: 'Papel' }, { t: 'Status' }, { t: 'Plano' },
      { t: 'Créditos', dir: true }, { t: 'Entrou em', dir: true }, { t: '', dir: true },
    ], linhas, { icone: 'clientes' }),
  });
}

// ─── Ações da lista ───────────────────────────────────────────────────
var ACOES = {
  'recarregar': function () { atualizar(); },
  'novo': function () { dialogoNovo(); },
  'limpar-filtro': function () { FILTRO = 'todos'; BUSCA = ''; pintar(); },
  'ficha': function (u) { abrirFicha(u, 'dados'); },
  'link': function (u) { gerarLink(u); },
  'suspender': function (u) { dialogoSuspender(u); },
  'reativar': function (u) { reativar(u); },
  'excluir': function (u) { dialogoExcluir(u); },
};

// ─── Ficha do cliente (modal largo com abas) ──────────────────────────
function abrirFicha(username, aba) {
  var c = achar(username);
  if (!c) return Z.erro('Cliente não encontrado. Atualize a lista.');
  ABA = aba || 'dados';

  var chips = [c.role === 'admin' ? C.chip('Admin', 'acento') : C.chip('Cliente')];
  chips.push(c.suspended ? C.chipPonto('Suspenso', 'erro') : C.chipPonto('Ativo', 'ok'));
  chips.push(C.chip(c.planName, 'info'));
  if (c.iaPropria) chips.push(C.chip('IA própria'));
  if (c.username === EU) chips.push(C.chip('Você', 'acento'));

  Z.modal({
    largo: true, icone: 'usuario',
    titulo: Z.esc(c.name),
    sub: (c.email ? Z.esc(c.email) + ' · ' : '') + '<span class="z-mono">' + Z.esc(c.username) + '</span>' +
         ' · na casa desde ' + Z.data(c.createdAt),
    chips: chips,
    corpo: C.abas('fic-abas', [
      { id: 'dados', t: 'Dados', icone: 'usuario' },
      { id: 'plano', t: 'Plano & Créditos', icone: 'dinheiro' },
      { id: 'consumo', t: 'Consumo', icone: 'raio' },
      { id: 'compras', t: 'Compras', icone: 'caixa' },
    ], ABA) + '<div id="fic-corpo"></div>',
    pe: '<button class="z-btn" data-fechar>Fechar</button>',
    aoAbrir: function () {
      Z.ligarAbas('fic-abas', function (id) { ABA = id; pintarAba(c, id); });
      pintarAba(c, ABA);
    },
  });
}

function pintarAba(c, id) {
  var cx = document.getElementById('fic-corpo');
  if (!cx) return;

  // Consumo e Compras vêm do mesmo endpoint — busca uma vez só.
  if ((id === 'consumo' || id === 'compras') && !EXTRATO[c.username]) {
    cx.innerHTML = C.carregando('Buscando o histórico desta conta…');
    Z.api('/api/admin/billing/users/' + encodeURIComponent(c.username) + '/extrato')
      .then(function (d) { EXTRATO[c.username] = d && !d.error ? d : { eventos: [], compras: [] }; })
      .catch(function () { EXTRATO[c.username] = { eventos: [], compras: [] }; })
      .then(function () { if (ABA === id) pintarAba(c, id); });
    return;
  }

  var html = id === 'plano' ? abaPlano(c)
    : id === 'consumo' ? abaConsumo(c)
    : id === 'compras' ? abaCompras(c)
    : abaDados(c);

  // Wrapper novo a cada pintura: os listeners não se acumulam trocando de aba.
  cx.innerHTML = '<div id="fic-p">' + html + '</div>';
  Z.ligarAcoes('fic-p', acoesFicha(c));
}

// ── Aba: Dados ──
function abaDados(c) {
  var h = '<span class="z-rotulo">Identificação</span>' +
    '<div class="z-campos">' +
      C.campo({ id: 'fd-nome', rotulo: 'Nome', valor: c.name, dica: 'Como o cliente se chama' }) +
      C.campo({ id: 'fd-email', rotulo: 'E-mail', tipo: 'text', valor: c.email, dica: 'para@onde.mando', ajuda: 'É por aqui que saem os avisos de suspensão e de compra confirmada.' }) +
      C.campo({ id: 'fd-papel', rotulo: 'Papel', tipo: 'select', valor: c.role, opcoes: [
        { v: 'user', t: 'Cliente' }, { v: 'admin', t: 'Administrador' },
      ], ajuda: 'Admin enxerga este painel inteiro. Dê com parcimônia.' }) +
      C.campo({ id: 'fd-senha', rotulo: 'Nova senha', tipo: 'password', valor: '', dica: 'deixe em branco para manter', ajuda: 'Mínimo de 6 caracteres. Prefira mandar o link de acesso: assim só o cliente sabe a senha.' }) +
    '</div>' +
    '<div class="z-linha z-mt">' +
      C.btn('Salvar dados', { classe: 'primario', icone: 'check', acao: 'salvar-dados' }) +
      C.btn('Gerar link de acesso', { icone: 'link', acao: 'link-ficha' }) +
    '</div>';

  h += '<div class="z-sep"></div><span class="z-rotulo">Acesso</span>';

  if (c.username === EU) {
    h += C.banner('Esta é a <b>sua própria conta</b>. Você não pode se suspender nem se excluir — se pudesse, ninguém sobraria para reverter.', 'info');
    return h;
  }

  if (c.suspended) {
    h += C.banner('Conta <b>suspensa</b>' + (c.suspendedReason ? ' — motivo registrado: “' + Z.esc(c.suspendedReason) + '”' : '') +
      '. O cliente não consegue entrar, mas <b>os projetos dele continuam intactos</b>.', 'erro');
    h += '<div class="z-linha">' + C.btn('Reativar acesso', { classe: 'primario', icone: 'check', acao: 'reativar-ficha' }) + '</div>';
  } else {
    h += C.banner('<b>Suspender preserva tudo:</b> o cliente perde o acesso na hora, os projetos, domínios e créditos ficam guardados. É o que se usa em caso de inadimplência.', 'alerta');
    h += '<div class="z-linha">' + C.btn('Suspender acesso', { icone: 'bloqueio', acao: 'suspender-ficha' }) + '</div>';
  }

  h += '<div class="z-sep"></div><span class="z-rotulo">Último recurso</span>';
  h += C.banner('<b>Excluir apaga a conta, não os projetos.</b> Os sites continuam no disco sem dono e ninguém mais entra nessa conta. Não dá para desfazer — na dúvida, suspenda.', 'erro');
  h += '<div class="z-linha">' + C.btn('Excluir cliente', { classe: 'perigo', icone: 'lixeira', acao: 'excluir-ficha' }) + '</div>';
  return h;
}

// ── Aba: Plano & Créditos ──
function abaPlano(c) {
  var h = C.stats([
    { rot: 'Plano atual', num: Z.esc(c.planName), cap: c.plan ? 'slug: ' + Z.esc(c.plan) : 'sem plano definido', icone: 'dinheiro', pequeno: true },
    { rot: 'Disponível', num: cr(c.availableMilli), cap: 'de ' + cr(c.cycleMilli) + ' do ciclo', icone: 'caixa', tom: c.availableMilli > 0 ? 'ok' : 'erro' },
    { rot: 'Cortesia ativa', num: cr(c.grantMilli), cap: c.grantMilli ? 'gasta antes do ciclo' : 'nenhuma cortesia', icone: 'raio', tom: c.grantMilli ? 'acento' : '' },
    { rot: 'Saldo avulso', num: cr(c.balanceMilli), cap: 'créditos comprados fora do plano', icone: 'receita' },
  ]);

  h += '<span class="z-rotulo">Consumo do ciclo</span>';
  h += C.card({
    corpo: '<div class="z-col" style="gap:7px">' +
      linha('Gasto no mês', Z.usd(c.monthlySpendUsd) + ' de ' + Z.usd(c.monthCapUsd)) +
      linha('Custo real para você', Z.usd(c.monthBaseUsd)) +
      linha('Cobrado no mês', Z.usd(c.monthChargedUsd)) +
      linha('Janela da semana', c.weekUsedPct + '% usada') +
      linha('Sessão de 5h', c.sessionUsedPct + '% usada') +
    '</div>',
  });

  h += '<div class="z-sep"></div><span class="z-rotulo">Mexer no plano e nos créditos</span>';
  h += C.banner('Se o cliente <b>pagou</b> por isso, informe o valor e a referência do comprovante: a venda entra no relatório de receita. Se for cortesia de verdade (brinde, teste, desculpa), deixe o valor zerado.', 'info');
  h += '<div class="z-linha">' +
    C.btn('Trocar de plano', { classe: 'primario', icone: 'dinheiro', acao: 'plano' }) +
    C.btn('Dar cortesia', { icone: 'raio', acao: 'cortesia' }) +
    C.btn('Adicionar saldo', { icone: 'caixa', acao: 'saldo' }) +
    C.btn('Zerar gasto do mês', { icone: 'atualiza', acao: 'zerar' }) +
  '</div>';
  h += '<div class="z-dica">Cortesia é crédito com prazo e etiqueta, gasto antes do resto. Saldo é crédito avulso que não expira. Zerar o gasto libera o ciclo de novo sem trocar o plano.</div>';
  return h;
}

// ── Aba: Consumo ──
function abaConsumo(c) {
  var d = EXTRATO[c.username] || {};
  var ev = d.eventos || [];
  var linhas = ev.map(function (e) {
    return '<tr>' +
      '<td class="z-fg3">' + Z.data(e.ts, true) + '</td>' +
      '<td class="num dir forte">' + fmt(e.creditos) + '</td>' +
      '<td class="num dir">' + (e.daCortesia ? fmt(e.daCortesia) : '—') + '</td>' +
      '<td class="num dir">' + (e.doSaldo ? fmt(e.doSaldo) : '—') + '</td>' +
      '<td class="num dir z-fg3">' + Z.usd(e.chargedUsd) + '</td>' +
    '</tr>';
  });
  var total = ev.reduce(function (a, e) { return a + (Number(e.creditos) || 0); }, 0);

  if (!linhas.length) {
    return C.vazio({
      icone: 'raio', tit: 'Nada consumido ainda',
      txt: 'Cada turno de IA deste cliente aparece aqui, com quanto saiu da cortesia e quanto saiu do saldo.',
    });
  }
  return C.card({
    tit: 'Turno a turno', sub: 'Os ' + ev.length + ' lançamentos mais recentes · ' + fmt(total) + ' crédito(s) no período',
    corpo: C.tabela([
      { t: 'Quando' }, { t: 'Créditos', dir: true }, { t: 'Da cortesia', dir: true },
      { t: 'Do saldo', dir: true }, { t: 'Custo real', dir: true },
    ], linhas, { icone: 'raio' }),
  });
}

// ── Aba: Compras ──
function abaCompras(c) {
  var d = EXTRATO[c.username] || {};
  var cp = d.compras || [];
  var linhas = cp.map(function (v) {
    var tom = v.status === 'aprovada' ? 'ok' : v.status === 'reembolsada' ? 'erro' : 'alerta';
    return '<tr>' +
      '<td class="z-fg3">' + Z.data(v.criadaEm, true) + '</td>' +
      '<td class="forte">' + Z.brl(v.valorBrl) + '</td>' +
      '<td>' + Z.esc(rotuloMeio(v.meio)) + '<div class="z-cel-sub">' + Z.esc(v.gateway || 'manual') + '</div></td>' +
      '<td>' + Z.esc(v.plano || '—') + '</td>' +
      '<td>' + C.chipPonto(rotuloStatus(v.status), tom) + '</td>' +
      '<td class="z-mono z-fg3">' + Z.esc(v.referencia || '—') + '</td>' +
    '</tr>';
  });
  var pago = cp.filter(function (v) { return v.status === 'aprovada'; })
               .reduce(function (a, v) { return a + (Number(v.valorBrl) || 0); }, 0);

  if (!linhas.length) {
    return C.vazio({
      icone: 'caixa', tit: 'Nenhuma compra registrada',
      txt: 'Vendas pela Hotmart, Pix conferido ou crédito lançado com valor pago aparecem aqui.',
    });
  }
  return C.card({
    tit: 'Histórico de compras', sub: 'Já entrou de verdade: <b>' + Z.brl(pago) + '</b> em vendas aprovadas',
    corpo: C.tabela([
      { t: 'Quando' }, { t: 'Valor' }, { t: 'Meio' }, { t: 'Plano' }, { t: 'Status' }, { t: 'Referência' },
    ], linhas, { icone: 'receita' }),
  });
}

// ─── Ações dentro da ficha ────────────────────────────────────────────
function acoesFicha(c) {
  return {
    'salvar-dados': function () {
      var corpo = { name: val('fd-nome'), email: val('fd-email'), role: val('fd-papel') };
      var senha = val('fd-senha');
      if (senha) {
        if (senha.length < 6) return Z.erro('A senha precisa de pelo menos 6 caracteres.');
        corpo.password = senha;
      }
      Z.apiJson('/api/admin/users/' + encodeURIComponent(c.username), 'PATCH', corpo).then(function (d) {
        if (d && d.error) return Z.erro(d.error);
        Z.ok('Dados de ' + (corpo.name || c.username) + ' salvos.');
        atualizar(c.username, 'dados');
      }).catch(falha);
    },
    'link-ficha': function () { gerarLink(c.username); },
    'suspender-ficha': function () { dialogoSuspender(c.username); },
    'reativar-ficha': function () { reativar(c.username); },
    'excluir-ficha': function () { dialogoExcluir(c.username); },
    'plano': function () { dialogoPlano(c, {}); },
    'cortesia': function () { dialogoCredito(c, 'cortesia', {}); },
    'saldo': function () { dialogoCredito(c, 'saldo', {}); },
    'zerar': function () {
      Z.confirmar({
        titulo: 'Zerar o gasto do mês?',
        texto: 'O contador de consumo de <b>' + Z.esc(c.name) + '</b> volta a zero e o ciclo abre de novo, sem trocar o plano. ' +
               'O histórico de turnos continua no extrato — só o acumulado das janelas é reiniciado.',
        confirmar: 'Zerar o gasto',
        aoConfirmar: function () {
          Z.apiJson('/api/admin/billing/users/' + encodeURIComponent(c.username), 'POST', { resetSpend: true }).then(function (d) {
            if (d && d.error) return Z.erro(d.error);
            Z.ok('Gasto do mês zerado. O ciclo de ' + c.name + ' recomeçou.');
            delete EXTRATO[c.username];
            atualizar(c.username, 'plano');
          }).catch(falha);
        },
      });
    },
  };
}

// ─── Diálogos ─────────────────────────────────────────────────────────
function dialogoNovo() {
  Z.perguntar({
    icone: 'usuario', titulo: 'Novo cliente',
    sub: 'Crie a conta e mande o link de acesso — o próprio cliente define a senha dele.',
    campos: [
      { id: 'username', rotulo: 'Usuário (login)', dica: 'joao', ajuda: 'Sem espaços. É o que ele digita para entrar.' },
      { id: 'name', rotulo: 'Nome', dica: 'João da Silva' },
      { id: 'email', rotulo: 'E-mail', dica: 'joao@empresa.com.br', ajuda: 'Usado para avisos de compra, suspensão e recuperação de senha.' },
      { id: 'password', rotulo: 'Senha provisória', tipo: 'password', dica: 'mínimo 6 caracteres', ajuda: 'Obrigatória agora; depois é só gerar o link de acesso para o cliente trocar.' },
      { id: 'role', rotulo: 'Papel', tipo: 'select', valor: 'user', opcoes: [{ v: 'user', t: 'Cliente' }, { v: 'admin', t: 'Administrador' }] },
    ],
    confirmar: 'Criar conta',
    aoConfirmar: function (v) {
      if (!v.username || !v.password) return Z.erro('Usuário e senha são obrigatórios.');
      if (v.password.length < 6) return Z.erro('A senha precisa de pelo menos 6 caracteres.');
      Z.apiJson('/api/admin/users', 'POST', v).then(function (d) {
        if (d && d.error) return Z.erro(d.error);
        Z.ok('Conta de ' + (v.name || v.username) + ' criada.');
        atualizar();
      }).catch(falha);
    },
  });
}

function dialogoSuspender(username) {
  var c = achar(username); if (!c) return;
  Z.perguntar({
    icone: 'bloqueio', titulo: 'Suspender ' + Z.esc(c.name),
    sub: 'O acesso morre na hora. Os projetos, domínios e créditos continuam guardados — isso não apaga nada.',
    campos: [{
      id: 'motivo', rotulo: 'Motivo', tipo: 'textarea',
      valor: c.suspendedReason || '',
      dica: 'Ex.: mensalidade de agosto em aberto',
      ajuda: 'Fica registrado na conta e vai no e-mail de aviso, se o cliente tiver e-mail cadastrado.',
    }],
    confirmar: 'Suspender acesso',
    aoConfirmar: function (v) {
      Z.apiJson('/api/admin/users/' + encodeURIComponent(username), 'PATCH', {
        suspended: true, suspendedReason: v.motivo,
      }).then(function (d) {
        if (d && d.error) return Z.erro(d.error);
        Z.ok(c.name + ' está suspenso. Os projetos dele continuam intactos.');
        atualizar(username, 'dados');
      }).catch(falha);
    },
  });
}

function reativar(username) {
  var c = achar(username); if (!c) return;
  Z.confirmar({
    titulo: 'Reativar ' + Z.esc(c.name) + '?',
    texto: 'O acesso volta imediatamente, com os projetos e créditos do jeito que ficaram.',
    confirmar: 'Reativar',
    aoConfirmar: function () {
      Z.apiJson('/api/admin/users/' + encodeURIComponent(username), 'PATCH', { suspended: false }).then(function (d) {
        if (d && d.error) return Z.erro(d.error);
        Z.ok(c.name + ' pode entrar de novo.');
        atualizar(username, 'dados');
      }).catch(falha);
    },
  });
}

function dialogoExcluir(username) {
  var c = achar(username); if (!c) return;
  Z.confirmar({
    perigo: true,
    titulo: 'Excluir ' + Z.esc(c.name) + '?',
    texto: 'A conta some e o login para de funcionar para sempre. <b>Os projetos NÃO são apagados</b> — eles continuam no disco, ' +
           'só ficam sem dono, e nenhum cliente consegue mais abri-los.<br><br>' +
           'Se a ideia é só cortar o acesso (inadimplência, pausa, briga), <b>suspenda</b>: dá para reverter em um clique.',
    confirmar: 'Excluir mesmo assim',
    aoConfirmar: function () {
      Z.api('/api/admin/users/' + encodeURIComponent(username), { method: 'DELETE' }).then(function (d) {
        if (d && d.error) return Z.erro(d.error);
        Z.ok('Conta de ' + c.name + ' excluída. Os projetos continuam no disco.');
        delete EXTRATO[username];
        atualizar();
      }).catch(falha);
    },
  });
}

// Trocar plano — com a opção de registrar o dinheiro que entrou junto.
function dialogoPlano(c, pre) {
  if (!PLANOS.length) return Z.erro('Nenhum plano configurado ainda. Cadastre em Planos & Créditos.');
  Z.perguntar({
    icone: 'dinheiro', titulo: 'Plano de ' + Z.esc(c.name),
    sub: 'Hoje: <b>' + Z.esc(c.planName) + '</b>. Trocar o plano muda o teto de consumo do ciclo.',
    campos: [
      { id: 'plan', rotulo: 'Novo plano', tipo: 'select', valor: pre.plan || c.plan, opcoes: opcoesPlanos() },
    ].concat(camposPagamento(pre, 'Se este plano foi pago agora')),
    confirmar: 'Aplicar plano',
    aoConfirmar: function (v) {
      if (!validaPagamento(v, function () { dialogoPlano(c, v); })) return;
      enviarBilling(c, montarPagamento(v, { plan: v.plan }), 'Plano de ' + c.name + ' atualizado.');
    },
  });
}

// Cortesia ou saldo — mesma conversa, contas diferentes.
function dialogoCredito(c, tipo, pre) {
  var ehCortesia = tipo === 'cortesia';
  Z.perguntar({
    icone: ehCortesia ? 'raio' : 'caixa',
    titulo: (ehCortesia ? 'Dar cortesia para ' : 'Adicionar saldo para ') + Z.esc(c.name),
    sub: ehCortesia
      ? 'Cortesia é gasta <b>antes</b> do ciclo e pode ter etiqueta para você lembrar do porquê. Hoje: ' + cr(c.grantMilli) + ' crédito(s).'
      : 'Saldo avulso não expira e entra depois da cortesia. Hoje: ' + cr(c.balanceMilli) + ' crédito(s).',
    campos: [
      { id: 'credits', rotulo: 'Quantos créditos', tipo: 'number', valor: pre.credits || '', dica: '50', ajuda: '1 crédito ≈ o teto de gasto em dólar configurado em Planos & Créditos.' },
    ].concat(ehCortesia
      ? [{ id: 'label', rotulo: 'Etiqueta', valor: pre.label || 'Cortesia', dica: 'Ex.: bônus de boas-vindas', ajuda: 'Aparece no extrato — serve para você lembrar por que deu.' }]
      : []
    ).concat(camposPagamento(pre, ehCortesia ? 'Se na verdade o cliente pagou por estes créditos' : 'Se estes créditos foram comprados')),
    confirmar: ehCortesia ? 'Dar cortesia' : 'Adicionar saldo',
    aoConfirmar: function (v) {
      var n = parseFloat(v.credits);
      if (!(n > 0)) return Z.erro('Informe quantos créditos você quer lançar.');
      if (!validaPagamento(v, function () { dialogoCredito(c, tipo, v); })) return;
      var corpo = ehCortesia
        ? { grantCredits: n, grantLabel: v.label || 'Cortesia' }
        : { addBalanceCredits: n };
      enviarBilling(c, montarPagamento(v, corpo),
        (ehCortesia ? 'Cortesia' : 'Saldo') + ' de ' + fmt(n) + ' crédito(s) lançado para ' + c.name + '.');
    },
  });
}

// Os três campos que transformam um lançamento em VENDA no relatório.
function camposPagamento(pre, contexto) {
  return [
    { id: 'valorPagoBrl', rotulo: 'Valor pago (R$)', tipo: 'number', valor: pre.valorPagoBrl || '', dica: '0',
      ajuda: contexto + ', informe o valor — a venda entra no relatório de receita. Deixe vazio se for por conta da casa.' },
    { id: 'meioPagamento', rotulo: 'Meio de pagamento', tipo: 'select', valor: pre.meioPagamento || 'pix', opcoes: MEIOS },
    { id: 'referenciaPagamento', rotulo: 'Referência do pagamento', valor: pre.referenciaPagamento || '', dica: 'ID do comprovante, e-mail do Pix…',
      ajuda: 'Obrigatória quando há valor: é o que permite conferir o dinheiro depois.' },
  ];
}
function validaPagamento(v, reabrir) {
  var valor = parseFloat(v.valorPagoBrl);
  if (valor > 0 && !String(v.referenciaPagamento || '').trim()) {
    Z.erro('Informe a referência do comprovante junto com o valor pago.');
    setTimeout(reabrir, 60);
    return false;
  }
  return true;
}
function montarPagamento(v, corpo) {
  var valor = parseFloat(v.valorPagoBrl);
  if (valor > 0) {
    corpo.valorPagoBrl = valor;
    corpo.meioPagamento = v.meioPagamento || 'pix';
    corpo.referenciaPagamento = String(v.referenciaPagamento || '').trim();
  }
  return corpo;
}
function enviarBilling(c, corpo, msgOk) {
  Z.apiJson('/api/admin/billing/users/' + encodeURIComponent(c.username), 'POST', corpo).then(function (d) {
    if (d && d.error) return Z.erro(d.error);
    Z.ok(msgOk + (corpo.valorPagoBrl ? ' Venda de ' + Z.brl(corpo.valorPagoBrl) + ' registrada.' : ''));
    delete EXTRATO[c.username];
    atualizar(c.username, 'plano');
  }).catch(falha);
}

// ─── Link de acesso ───────────────────────────────────────────────────
function gerarLink(username) {
  var c = achar(username); if (!c) return;
  Z.apiJson('/api/admin/users/' + encodeURIComponent(username) + '/link-acesso', 'POST', {}).then(function (d) {
    if (!d || d.error) return Z.erro((d && d.error) || 'Não consegui gerar o link.');
    var url = location.origin + d.link;
    copiar(url).then(function (copiou) { modalLink(c, url, d.expiraEmDias || 7, copiou); });
  }).catch(falha);
}

function modalLink(c, url, dias, copiou) {
  Z.modal({
    icone: 'link',
    titulo: 'Link de acesso de ' + Z.esc(c.name),
    sub: 'Vale por ' + dias + ' dia(s) e morre no primeiro uso. Quem abrir define a senha desta conta.',
    corpo: (copiou
        ? C.banner('<b>Já copiei para a área de transferência.</b> É só colar no WhatsApp ou no e-mail do cliente.', 'ok')
        : C.banner('<b>Copie o link abaixo.</b> Seu navegador não deixou copiar sozinho — clique no campo para selecionar tudo.', 'alerta')) +
      '<label class="z-lbl">Link</label>' +
      '<input class="z-in z-mono" id="lnk-url" readonly value="' + Z.esc(url) + '">' +
      '<div class="z-dica">Trate como senha: quem tiver este link entra na conta de ' + Z.esc(c.name) + '. Não publique em grupo nem em lugar aberto.</div>',
    pe: '<button class="z-btn" data-fechar>Fechar</button>' +
        C.btn('Copiar de novo', { classe: 'primario', icone: 'codigo', id: 'lnk-copiar' }),
    aoAbrir: function (m) {
      var i = m.querySelector('#lnk-url');
      if (i) { i.onclick = function () { i.select(); }; i.focus(); i.select(); }
      var b = m.querySelector('#lnk-copiar');
      if (b) b.onclick = function () {
        copiar(url).then(function (ok2) {
          if (ok2) Z.ok('Link copiado.');
          else { Z.toast('Não consegui copiar sozinho — selecione o link e copie na mão.'); if (i) i.select(); }
        });
      };
    },
  });
}

function copiar(txt) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(txt)
      .then(function () { return true; }, function () { return false; });
  }
  return Promise.resolve(false);
}

// ─── Miudezas ─────────────────────────────────────────────────────────
function linha(rot, val) {
  return '<div class="z-linha entre" style="font-size:12.5px">' +
    '<span class="z-fg3">' + rot + '</span><span class="z-fg2">' + val + '</span></div>';
}
function cr(milli) {
  var v = (Number(milli) || 0) / 1000;
  return fmt(v);
}
function fmt(v) {
  v = Number(v) || 0;
  return v.toLocaleString('pt-BR', { maximumFractionDigits: v >= 100 ? 0 : 2 });
}
function val(id) {
  var e = document.getElementById(id);
  return e ? String(e.value || '').trim() : '';
}
// Z.esc não escapa aspas; num atributo isso deixaria um login torto quebrar
// a célula inteira.
function att(v) { return Z.esc(v == null ? '' : v).replace(/"/g, '&quot;'); }
function opcoesPlanos() {
  return PLANOS.map(function (p) {
    return { v: p.slug, t: p.name + (p.priceBrl > 0 ? ' — ' + Z.brl(p.priceBrl) + '/mês' : ' — gratuito') };
  });
}
function rotuloMeio(m) {
  for (var i = 0; i < MEIOS.length; i++) if (MEIOS[i].v === m) return MEIOS[i].t;
  return m || '—';
}
function rotuloStatus(s) {
  return s === 'aprovada' ? 'Aprovada' : s === 'reembolsada' ? 'Reembolsada' : s === 'pendente' ? 'Aguardando conferência' : (s || '—');
}
function falha(e) {
  if (e && (e.message === 'nao-autorizado' || e.message === 'sem-acesso')) return;
  console.error('[clientes]', e);
  Z.erro('Não consegui falar com o servidor. Tente de novo em instantes.');
}
})();
