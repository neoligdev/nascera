/* ═══ NASCERA ADMIN v2 — PLANOS & CRÉDITOS ═════════════════════════════
   Como os clientes PAGAM e o que cada real libera de uso.
   O preço do plano vira consumo (÷ câmbio); cada modelo desconta pelo
   custo real × markup. Markup mínimo é +0%: nunca se vende abaixo do custo.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var CFG = null;      // config de billing em edição (local até salvar)
var PLANOS = [];     // linhas editáveis
var MODELOS = [];    // linhas editáveis
var USUARIOS = [];   // /api/admin/billing → users (para contar clientes por plano)

var MODOS = [
  { id: 'off', icone: 'fechado', nome: 'Desligado',
    desc: 'Ninguém é cobrado nem bloqueado. Todo mundo usa à vontade e a conta da IA é sua. ' +
          'Bom para testar com amigos — perigoso com estranhos.' },
  { id: 'subscription', icone: 'receita', nome: 'Mensalidade simples',
    desc: 'O cliente paga um valor fixo por fora (Hotmart, Pix) e usa sem medição. ' +
          'O plano é só rótulo e preço: o NASCERA não trava ninguém por uso.' },
  { id: 'credits', icone: 'raio', nome: 'Mensalidade + Uso',
    desc: 'O modelo do próprio Claude: o preço da mensalidade LIBERA um tanto de uso, medido por sessão de 5h e por semana. ' +
          'Cada turno desconta o custo real × seu markup — nunca abaixo do custo.' },
];

Z.registrar('planos', {
  render: function (alvo) {
    return Z.api('/api/admin/billing').then(function (d) {
      if (d.error) { Z.erro(d.error); throw new Error(d.error); }
      CFG = d.config || {};
      USUARIOS = d.users || [];
      PLANOS = (CFG.plans || []).map(function (p) {
        return { slug: p.slug, name: p.name, priceBrl: n(p.priceBrl), bonusUsd: n(p.bonusUsd), creditsPerMonth: n(p.creditsPerMonth) };
      });
      MODELOS = (CFG.models || []).map(function (m) {
        return { id: m.id, name: m.name, inMtok: n(m.inMtok), outMtok: n(m.outMtok),
                 cacheReadMtok: n(m.cacheReadMtok), cacheWriteMtok: n(m.cacheWriteMtok), markup: n(m.markup) };
      });

      var html = C.cab({
        trilha: 'Negócio · Como os clientes pagam',
        icone: 'dinheiro',
        titulo: 'Planos & Créditos',
        sub: 'A régua do seu negócio: quanto cada plano custa, quanto de uso ele libera e quanto sobra para você. ' +
             'Nada aqui vale antes de clicar em Salvar.',
        acoes: [
          C.btn('Salvar tudo', { classe: 'primario', icone: 'check', acao: 'salvar' }),
          C.btn('Descartar', { icone: 'atualiza', acao: 'recarregar', titulo: 'Volta tudo para o que está salvo' }),
        ],
      });

      html += statsTopo();
      html += '<div id="pl-avisos"></div>';

      html += '<span class="z-rotulo">Como você cobra</span>';
      html += '<div class="z-grade" id="pl-modos">' + cartoesModo() + '</div>';
      html += '<div id="pl-aviso-modo" class="z-mt">' + avisoModo() + '</div>';

      html += '<div class="z-mt">' + C.abas('pl-abas', [
        { id: 'motor',    t: 'Motor de créditos', icone: 'raio' },
        { id: 'planos',   t: 'Planos',            icone: 'dinheiro' },
        { id: 'modelos',  t: 'Custo por modelo',  icone: 'ia' },
      ], 'motor') + '</div>';

      html += '<div id="pl-p-motor">' + painelMotor() + '</div>';
      html += '<div id="pl-p-planos" class="z-oculto">' + C.card({
        tit: 'Planos que você vende',
        sub: 'O preço é a única alavanca: o consumo liberado deriva dele (preço ÷ câmbio). ' +
             'Bônus em US$ é subsídio deliberado — sai do seu bolso além do preço.',
        acoes: [C.btn('Novo plano', { classe: 'mini', icone: 'mais', acao: 'add-plano' })],
        corpo: '<div id="pl-tab-planos"></div>',
      }) + '</div>';
      html += '<div id="pl-p-modelos" class="z-oculto">' + C.card({
        tit: 'Custo por modelo',
        sub: 'O que a Anthropic cobra de você por milhão de tokens, e quanto você cobra em cima. ' +
             'Markup vazio herda o padrão do motor.',
        acoes: [C.btn('Novo modelo', { classe: 'mini', icone: 'mais', acao: 'add-modelo' })],
        corpo: '<div id="pl-tab-modelos"></div>',
      }) + '</div>';

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="pl-raiz">' + html + '</div>';
      var raiz = document.getElementById('pl-raiz');
      desenharPlanos();
      desenharModelos();

      Z.ligarAbas('pl-abas', function (id) {
        ['motor', 'planos', 'modelos'].forEach(function (x) {
          var el = document.getElementById('pl-p-' + x);
          if (el) el.classList.toggle('z-oculto', x !== id);
        });
      });

      // Mexeu em qualquer número do motor ou das tabelas → recalcula o que deriva
      raiz.addEventListener('input', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('z-in')) recalcular();
      });

      Z.ligarAcoes(raiz, {
        'recarregar':      function () { Z.recarregar(); },
        'salvar':          salvar,
        'modo':            trocarModo,
        'add-plano':       addPlano,
        'remover-plano':   removerPlano,
        'add-modelo':      addModelo,
        'remover-modelo':  removerModelo,
      });
    });
  },
});

// ─── Topo ─────────────────────────────────────────────────────────────
function statsTopo() {
  var preco = {}, mrr = 0, pagantes = 0, base = 0, cobrado = 0;
  PLANOS.forEach(function (p) { preco[p.slug] = p.priceBrl; });
  USUARIOS.forEach(function (u) {
    var v = preco[u.plan] || 0;
    if (v > 0) { mrr += v; pagantes++; }
    base += n(u.monthBaseUsd);
    cobrado += n(u.monthChargedUsd);
  });
  var mkPct = pctDe(CFG.defaultMarkup);
  var margem = CFG.defaultMarkup > 0 ? Math.round((1 - 1 / CFG.defaultMarkup) * 100) : 0;

  return C.stats([
    { rot: 'Mensalidades ativas', num: Z.brl(mrr), icone: 'dinheiro', tom: mrr > 0 ? 'ok' : '',
      cap: pagantes ? Z.num(pagantes) + ' cliente(s) em plano pago' : 'Ninguém em plano pago ainda' },
    { rot: 'Consumo cobrado no mês', num: Z.usd(cobrado), icone: 'raio',
      cap: 'O que os clientes queimaram no seu preço' },
    { rot: 'Custo real da IA no mês', num: Z.usd(base), icone: 'ia', tom: base > cobrado && base > 0 ? 'erro' : '',
      cap: base > cobrado && base > 0 ? 'Está saindo mais caro do que você cobra' : 'O que a Anthropic cobrou de você' },
    { rot: 'Markup padrão', num: '+' + mkPct + '%', icone: 'receita', tom: 'acento',
      cap: 'Sobra ' + margem + '% de margem no consumo' },
  ]);
}

// ─── Modo ─────────────────────────────────────────────────────────────
function cartoesModo() {
  return MODOS.map(function (m) {
    var ativo = CFG.mode === m.id;
    return '<div class="z-item" data-acao="modo" data-dado="' + m.id + '"' +
      (ativo ? ' style="border-color:rgba(var(--z-acc-rgb),.45);background:var(--z-card-hi)"' : '') + '>' +
      '<div class="z-item-cab"><div class="z-item-icone">' + Z.svg(m.icone) + '</div>' +
        '<div class="z-item-tit">' + Z.esc(m.nome) + '</div></div>' +
      '<div class="z-item-chips">' + (ativo ? C.chipPonto('Em uso', 'ok') : C.chip('Clique para escolher')) + '</div>' +
      '<div class="z-item-desc">' + Z.esc(m.desc) + '</div></div>';
  }).join('');
}

function avisoModo() {
  if (CFG.mode === 'credits') {
    return C.banner('Os números abaixo estão <b>valendo agora</b>: cada turno passa pelo portão de crédito antes de rodar, ' +
      'e o cliente vê o quanto já usou da sessão de 5h e da semana. Admins são isentos.', 'ok');
  }
  if (CFG.mode === 'subscription') {
    return C.banner('Nesta modalidade o NASCERA <b>não bloqueia ninguém por uso</b> — quem cobra é o gateway. ' +
      'Os números abaixo ficam guardados, prontos para o dia em que você ligar o modo <b>Mensalidade + Uso</b>.', 'info');
  }
  return C.banner('Cobrança <b>desligada</b>: nenhum turno é bloqueado nem debitado, e o custo da IA é integralmente seu. ' +
    'Os planos abaixo continuam aparecendo na tela de compra, mas não limitam nada.', 'alerta');
}

function trocarModo(id) {
  CFG.mode = id;
  var grade = document.getElementById('pl-modos');
  if (grade) grade.innerHTML = cartoesModo();
  var av = document.getElementById('pl-aviso-modo');
  if (av) av.innerHTML = avisoModo();
  Z.toast('Modo escolhido. Clique em "Salvar tudo" para valer.');
}

// ─── Motor de créditos ────────────────────────────────────────────────
function painelMotor() {
  return C.card({
    tit: 'Motor de créditos',
    sub: 'Os seis números que definem quanto de uso cada real compra. Mexer aqui reprecifica o produto inteiro.',
    corpo:
      '<div class="z-campos">' +
        C.campo({ id: 'pl-markup', rotulo: 'Markup padrão (%)', valor: pctDe(CFG.defaultMarkup),
          dica: 'ex.: 100', ajuda: 'Quanto você cobra acima do custo. <b>+100%</b> = cobra o dobro do que paga (margem de 50%). Zero repassa o custo — nunca menos.' }) +
        C.campo({ id: 'pl-fx', rotulo: 'Câmbio US$ → R$', valor: fmt(CFG.usdToBrl),
          dica: 'ex.: 5,50', ajuda: 'Converte o preço do plano em uso liberado. Câmbio alto = plano libera menos.' }) +
        C.campo({ id: 'pl-usdcr', rotulo: 'US$ por crédito', valor: fmt(CFG.usdPerCredit),
          dica: 'ex.: 0,20', ajuda: 'A unidade das cortesias e do saldo avulso. <b>Mudar reprecifica o saldo já exibido</b>, retroativamente.' }) +
        C.campo({ id: 'pl-diario', rotulo: 'Teto diário padrão (US$)', valor: fmt(CFG.defaultDailyLimitUsd),
          dica: 'ex.: 10', ajuda: 'Freio contra um dia desgovernado. <b>0</b> desliga o freio.' }) +
        C.campo({ id: 'pl-sessoes', rotulo: 'Sessões de 5h por semana', valor: n(CFG.sessionsPerWeek) || 5,
          dica: 'ex.: 5', ajuda: 'Quantas janelas cheias de 5h cabem na semana do cliente. Define o teto de cada sessão.' }) +
        C.campo({ id: 'pl-tz', rotulo: 'Fuso das janelas', valor: CFG.timezone || 'America/Sao_Paulo',
          dica: 'America/Sao_Paulo', ajuda: 'Dia, semana e mês viram NESTE fuso — não no do servidor.' }) +
      '</div>',
  });
}

// ─── Planos ───────────────────────────────────────────────────────────
function desenharPlanos() {
  var caixa = document.getElementById('pl-tab-planos');
  if (!caixa) return;
  var linhas = PLANOS.map(function (p, i) {
    return '<tr>' +
      '<td>' + inp('pl' + i + '-slug', p.slug, 110) + '</td>' +
      '<td>' + inp('pl' + i + '-nome', p.name, 165) + '</td>' +
      '<td>' + inp('pl' + i + '-preco', fmt(p.priceBrl), 92) + '</td>' +
      '<td>' + inp('pl' + i + '-bonus', p.bonusUsd > 0 ? fmt(p.bonusUsd) : '', 80) + '</td>' +
      '<td class="z-mono" id="pl' + i + '-mes">' + Z.usd(capMes(p)) + '</td>' +
      '<td class="z-mono z-fg3" id="pl' + i + '-sessao">' + Z.usd(capSessao(p)) + '</td>' +
      '<td>' + chipClientes(p.slug) + '</td>' +
      '<td class="dir">' + C.btn('', { classe: 'perigo mini', icone: 'lixeira', acao: 'remover-plano', dado: String(i), titulo: 'Remover plano' }) + '</td>' +
    '</tr>';
  });
  caixa.innerHTML = C.tabela([
    { t: 'Slug' }, { t: 'Nome que o cliente vê' }, { t: 'Preço R$' }, { t: 'Bônus US$' },
    { t: 'Libera / mês' }, { t: 'Por sessão 5h' }, { t: 'Clientes' }, { t: '', dir: true },
  ], linhas, {
    icone: 'dinheiro', vazioTit: 'Nenhum plano cadastrado',
    vazioTxt: 'Sem plano não há o que vender: a tela de compra fica vazia e o webhook da Hotmart não sabe o que liberar.',
  }) + '<div class="z-dica" style="margin-top:10px">O <b>slug</b> é o nome interno (usado no webhook e no ledger) — evite trocar depois de vender. ' +
      '<b>Libera / mês</b> é derivado: preço ÷ câmbio + bônus.</div>';
}

function chipClientes(slug) {
  var n0 = 0;
  USUARIOS.forEach(function (u) { if (u.plan === slug) n0++; });
  return n0 ? C.chip(Z.num(n0), 'acento') : '<span class="z-fg3">—</span>';
}

function colherPlanos() {
  PLANOS.forEach(function (p, i) {
    p.slug = String(pegar('pl' + i + '-slug', p.slug)).trim();
    p.name = String(pegar('pl' + i + '-nome', p.name)).trim();
    p.priceBrl = num(pegar('pl' + i + '-preco', p.priceBrl));
    p.bonusUsd = num(pegar('pl' + i + '-bonus', p.bonusUsd));
  });
}

function addPlano() {
  colherPlanos();
  PLANOS.push({ slug: 'novo-' + Date.now().toString(36).slice(-4), name: 'Novo plano', priceBrl: 0, bonusUsd: 0, creditsPerMonth: 0 });
  desenharPlanos();
  Z.toast('Linha criada. Preencha e clique em "Salvar tudo".');
}

function removerPlano(i) {
  colherPlanos();
  i = parseInt(i, 10);
  var p = PLANOS[i];
  if (!p) return;
  if (PLANOS.length <= 1) return Z.erro('Deixe pelo menos um plano — sem nenhum, o sistema não sabe o que dar a ninguém.');
  var quantos = 0;
  USUARIOS.forEach(function (u) { if (u.plan === p.slug) quantos++; });
  var tirar = function () { PLANOS.splice(i, 1); desenharPlanos(); Z.toast('Removido daqui. Clique em "Salvar tudo" para valer.'); };
  if (!quantos) return tirar();
  Z.confirmar({
    perigo: true, titulo: 'Remover "' + Z.esc(p.name) + '"?',
    texto: '<b>' + Z.num(quantos) + ' cliente(s)</b> estão neste plano. Removendo, eles caem no primeiro plano da lista ' +
           'na próxima leitura — e passam a valer o teto de uso dele. Ninguém perde projeto, mas o limite muda.',
    confirmar: 'Remover mesmo assim', aoConfirmar: tirar,
  });
}

// ─── Modelos ──────────────────────────────────────────────────────────
function desenharModelos() {
  var caixa = document.getElementById('pl-tab-modelos');
  if (!caixa) return;
  var mkPad = multDe(num(pegar('pl-markup', pctDe(CFG.defaultMarkup))));
  var linhas = MODELOS.map(function (m, i) {
    var eff = m.markup > 0 ? m.markup : mkPad;
    return '<tr>' +
      '<td>' + inp('md' + i + '-id', m.id, 95) + '</td>' +
      '<td>' + inp('md' + i + '-nome', m.name, 150) + '</td>' +
      '<td>' + inp('md' + i + '-in', fmt(m.inMtok), 72) + '</td>' +
      '<td>' + inp('md' + i + '-out', fmt(m.outMtok), 72) + '</td>' +
      '<td>' + inp('md' + i + '-cr', fmt(m.cacheReadMtok), 72) + '</td>' +
      '<td>' + inp('md' + i + '-cw', fmt(m.cacheWriteMtok), 72) + '</td>' +
      '<td>' + inp('md' + i + '-mk', m.markup > 0 ? pctDe(m.markup) : '', 66, pctDe(mkPad) + ' (padrão)') + '</td>' +
      '<td class="z-mono z-fg3" id="md' + i + '-cobra">' + Z.usd(m.inMtok * eff) + ' / ' + Z.usd(m.outMtok * eff) + '</td>' +
      '<td class="dir">' + C.btn('', { classe: 'perigo mini', icone: 'lixeira', acao: 'remover-modelo', dado: String(i), titulo: 'Remover modelo' }) + '</td>' +
    '</tr>';
  });
  caixa.innerHTML = C.tabela([
    { t: 'Id (casa por trecho)' }, { t: 'Nome' }, { t: 'Entrada' }, { t: 'Saída' },
    { t: 'Cache leitura' }, { t: 'Cache escrita' }, { t: 'Markup %' }, { t: 'Você cobra (in/out)' }, { t: '', dir: true },
  ], linhas, {
    icone: 'ia', vazioTit: 'Nenhum modelo na tabela',
    vazioTxt: 'Sem tabela de preço, todo turno é cobrado pelo custo que o próprio SDK informa, com o markup padrão.',
  }) + '<div class="z-dica" style="margin-top:10px">Valores em <b>US$ por milhão de tokens</b>. O <b>id</b> casa por trecho contra o modelo real ' +
      '(<span class="z-mono">opus-5</span> ganha de <span class="z-mono">opus</span>), então versões diferentes convivem na lista.</div>';
}

function colherModelos() {
  MODELOS.forEach(function (m, i) {
    m.id = String(pegar('md' + i + '-id', m.id)).trim().toLowerCase();
    m.name = String(pegar('md' + i + '-nome', m.name)).trim();
    m.inMtok = num(pegar('md' + i + '-in', m.inMtok));
    m.outMtok = num(pegar('md' + i + '-out', m.outMtok));
    m.cacheReadMtok = num(pegar('md' + i + '-cr', m.cacheReadMtok));
    m.cacheWriteMtok = num(pegar('md' + i + '-cw', m.cacheWriteMtok));
    var mk = String(pegar('md' + i + '-mk', '')).trim();
    m.markup = mk === '' ? 0 : multDe(num(mk));
  });
}

function addModelo() {
  colherModelos();
  MODELOS.push({ id: '', name: 'Novo modelo', inMtok: 0, outMtok: 0, cacheReadMtok: 0, cacheWriteMtok: 0, markup: 0 });
  desenharModelos();
  Z.toast('Linha criada. Preencha e clique em "Salvar tudo".');
}

function removerModelo(i) {
  colherModelos();
  i = parseInt(i, 10);
  if (MODELOS.length <= 1) return Z.erro('Deixe pelo menos um modelo na tabela — a lista vazia é recusada pelo servidor.');
  MODELOS.splice(i, 1);
  desenharModelos();
  Z.toast('Removido daqui. Clique em "Salvar tudo" para valer.');
}

// ─── Recalcular derivados sem perder o foco ───────────────────────────
function recalcular() {
  colherPlanos();
  colherModelos();
  var mkPad = multDe(num(pegar('pl-markup', pctDe(CFG.defaultMarkup))));
  PLANOS.forEach(function (p, i) {
    escrever('pl' + i + '-mes', Z.usd(capMes(p)));
    escrever('pl' + i + '-sessao', Z.usd(capSessao(p)));
  });
  MODELOS.forEach(function (m, i) {
    var eff = m.markup > 0 ? m.markup : mkPad;
    escrever('md' + i + '-cobra', Z.usd(m.inMtok * eff) + ' / ' + Z.usd(m.outMtok * eff));
  });
}
function escrever(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }

function fx() { var v = num(pegar('pl-fx', CFG.usdToBrl)); return v > 0 ? v : 5.5; }
function porCredito() { var v = num(pegar('pl-usdcr', CFG.usdPerCredit)); return v > 0 ? v : 0.2; }
function sessoes() { var v = parseInt(num(pegar('pl-sessoes', CFG.sessionsPerWeek)), 10); return v > 0 ? v : 5; }
function capMes(p) {
  var cap = (n(p.priceBrl) / fx()) + n(p.bonusUsd);
  return cap > 0 ? cap : n(p.creditsPerMonth) * porCredito();
}
function capSessao(p) { return capMes(p) / 4 / sessoes(); }

// ─── Salvar ───────────────────────────────────────────────────────────
function salvar() {
  colherPlanos();
  colherModelos();

  if (String(pegar('pl-markup', '')).trim() === '') return Z.erro('Informe o markup padrão — em branco ele zeraria a sua margem.');
  if (!PLANOS.length) return Z.erro('Cadastre pelo menos um plano antes de salvar.');
  if (!MODELOS.length) return Z.erro('Deixe pelo menos um modelo na tabela de custo.');
  var falta = null;
  PLANOS.forEach(function (p) { if (!p.slug || !p.name) falta = 'Todo plano precisa de slug e nome.'; });
  MODELOS.forEach(function (m) { if (!m.id) falta = 'Todo modelo precisa de um id (o trecho que casa com o modelo real).'; });
  if (falta) return Z.erro(falta);

  var corpo = {
    mode: CFG.mode,
    usdPerCredit: porCredito(),
    defaultDailyLimitUsd: num(pegar('pl-diario', CFG.defaultDailyLimitUsd)),
    timezone: String(pegar('pl-tz', CFG.timezone)).trim() || 'America/Sao_Paulo',
    defaultMarkup: multDe(num(pegar('pl-markup', 0))),
    usdToBrl: fx(),
    sessionsPerWeek: sessoes(),
    plans: PLANOS.map(function (p) {
      return { slug: p.slug, name: p.name, priceBrl: p.priceBrl, bonusUsd: p.bonusUsd, creditsPerMonth: p.creditsPerMonth || 0 };
    }),
    models: MODELOS.map(function (m) {
      return { id: m.id, name: m.name, inMtok: m.inMtok, outMtok: m.outMtok,
               cacheReadMtok: m.cacheReadMtok, cacheWriteMtok: m.cacheWriteMtok, markup: m.markup };
    }),
  };

  Z.apiJson('/api/admin/billing/config', 'PUT', corpo).then(function (r) {
    if (r.error) return Z.erro(r.error);
    var avisos = r.warnings || [];
    if (!avisos.length) { Z.ok('Cobrança salva. Já está valendo para o próximo turno.'); return Z.recarregar(); }
    var caixa = document.getElementById('pl-avisos');
    if (caixa) {
      caixa.innerHTML = C.banner('<b>Salvo — mas repare nisto:</b><br>' +
        avisos.map(function (a) { return '• ' + Z.esc(a); }).join('<br>'), 'alerta');
    }
    Z.ok('Salvo. Tem avisos no topo da tela para você olhar.');
    var corpoEl = document.getElementById('z-corpo');
    if (corpoEl) corpoEl.scrollTop = 0;
  });
}

// ─── utilidades locais ────────────────────────────────────────────────
function pegar(id, padrao) {
  var el = document.getElementById(id);
  return el ? el.value : (padrao == null ? '' : padrao);
}
function inp(id, valor, largura, dica) {
  return '<input class="z-in" id="' + id + '" type="text" autocomplete="off" style="width:' + largura + 'px;padding:6px 9px" ' +
    'value="' + att(valor) + '" placeholder="' + att(dica) + '">';
}
// Z.esc não escapa aspas; num atributo isso deixaria um nome como Plano "Ouro"
// quebrar o input inteiro.
function att(v) { return Z.esc(v == null ? '' : v).replace(/"/g, '&quot;'); }
function n(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
// Aceita "5,5" e "5.5" — o cliente é brasileiro e digita com vírgula.
function num(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  var x = parseFloat(s);
  return isNaN(x) ? 0 : x;
}
function fmt(v) {
  var x = n(v);
  return x === Math.round(x) ? String(x) : String(x).replace('.', ',');
}
function pctDe(mult) { return Math.round((n(mult) > 0 ? n(mult) - 1 : 0) * 100); }
function multDe(pct) { return 1 + (Math.max(0, n(pct)) / 100); }
})();
