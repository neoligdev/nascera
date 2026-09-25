/* ═══ NASCERA ADMIN v2 — RECEITA & VENDAS ══════════════════════════════
   O dinheiro que ENTRA. Três caminhos, uma tela:
     • Gateways — Hotmart, Kiwify, Asaas e Mercado Pago: a venda aprovada
                  vira cliente e plano sozinha, por webhook assinado
     • Pix      — o cliente avisa, você confere e libera
     • Manual   — você registrou o pagamento ao dar créditos em Clientes
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var VENDAS = [];    // ledger carregado
var PLANOS = [];    // catálogo (para os selects)
var GATEWAYS = [];  // os 4 meios de pagamento, como o admin os vê
var SEL = '';       // gateway aberto na tela
var OFERTAS = {};   // mapa oferta → plano do gateway aberto
var FILTRO = 'todas';

Z.registrar('receita', {
  render: function (alvo) {
    return Promise.all([
      Z.api('/api/admin/vendas'),
      Z.api('/api/admin/gateways').catch(function () { return {}; }),
      Z.api('/api/admin/billing').catch(function () { return {}; }),
    ]).then(function (r) {
      var d = r[0] || {}, gw = r[1] || {}, bil = r[2] || {};
      GATEWAYS = gw.gateways || [];
      if (d.error) Z.erro(d.error);
      if (gw.error) Z.erro(gw.error);

      VENDAS  = d.vendas || [];
      PLANOS  = (bil.config || {}).plans || [];
      
      FILTRO  = 'todas';
      var res = d.resumo || {};
      var pix = gw.pix || {};
      var pendentes = contar('aguardando_confirmacao');
      var semPlano  = contar('sem_plano');

      var html = C.cab({
        trilha: 'Negócio · O dinheiro que entra',
        icone: 'receita',
        titulo: 'Receita & Vendas',
        sub: 'Cada real que entrou, de onde veio e o que ainda depende de você. ' +
             'O gateway credita sozinho; o Pix espera sua conferência.',
        acoes: [C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' })],
      });

      html += C.stats([
        { rot: 'Receita do mês', num: Z.brl(res.mes), cap: Z.num(res.vendasMes) + ' venda(s) confirmada(s)', icone: 'dinheiro', tom: res.mes > 0 ? 'ok' : '' },
        { rot: 'Receita total', num: Z.brl(res.total), cap: 'Desde o primeiro cliente', icone: 'receita' },
        { rot: 'Esperando você', num: Z.num(pendentes), cap: pendentes ? 'Pix avisado, plano ainda travado' : 'Nada na fila — em dia', icone: 'relogio', tom: pendentes ? 'alerta' : '' },
        { rot: 'Reembolsos', num: Z.num(res.reembolsos), cap: res.reembolsos ? 'Contas suspensas automaticamente' : 'Nenhum até agora', icone: 'alerta', tom: res.reembolsos ? 'erro' : '' },
      ]);

      if (pendentes) {
        html += C.banner('<b>' + Z.num(pendentes) + ' cliente(s)</b> avisaram que fizeram o Pix e estão parados esperando. ' +
          'Confira o valor na sua conta e clique em <b>Confirmar Pix</b> — o plano é ativado na hora.', 'alerta');
      }
      if (semPlano) {
        html += C.banner('<b>' + Z.num(semPlano) + ' compra(s)</b> entraram sem plano: o dinheiro chegou, mas o NASCERA não soube o que liberar. ' +
          'Resolva dando o plano na tabela abaixo e ajuste o plano padrão em <b>Meios de pagamento</b> para não acontecer de novo.', 'erro');
      }

      // ── abas ──
      html += C.abas('rv-abas', [
        { id: 'vendas',  t: 'Vendas',     icone: 'receita' },
        { id: 'meios',   t: 'Meios de pagamento', icone: 'dinheiro' },
        { id: 'pix',     t: 'Pix manual', icone: 'dinheiro' },
      ], 'vendas');

      // ── painel: vendas ──
      var filtros = C.filtros('rv-filtros', [
        { id: 'todas',                  t: 'Todas',        n: VENDAS.length },
        { id: 'aprovada',               t: 'Aprovadas',    n: contar('aprovada') },
        { id: 'aguardando_confirmacao', t: 'Aguardando Pix', n: pendentes },
        { id: 'sem_plano',              t: 'Sem plano',    n: semPlano },
        { id: 'reembolsada',            t: 'Reembolsadas', n: contar('reembolsada') },
      ], 'todas');

      html += '<div id="rv-p-vendas">' + C.card({
        tit: 'Histórico de vendas',
        sub: 'O ledger nunca reescreve o passado: reembolso vira status, não sumiço.',
        corpo: filtros + C.busca('rv-busca', 'Buscar por cliente, e-mail, plano ou referência…') +
               '<div id="rv-lista"></div>',
      }) + '</div>';

      // ── painel: meios de pagamento (os 4 gateways) ──
      html += '<div id="rv-p-meios" class="z-oculto">' + painelMeios() + '</div>';

      // ── painel: Pix ──
      html += '<div id="rv-p-pix" class="z-oculto">' + painelPix(pix) + '</div>';

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="rv-raiz">' + html + '</div>';
      desenharVendas();
      desenharMeios();

      Z.ligarAbas('rv-abas', function (id) {
        ['vendas', 'meios', 'pix'].forEach(function (x) {
          var el = document.getElementById('rv-p-' + x);
          if (el) el.classList.toggle('z-oculto', x !== id);
        });
      });
      Z.ligarFiltros('rv-filtros', function (id) { FILTRO = id; desenharVendas(); });
      var busca = document.getElementById('rv-busca');
      if (busca) busca.oninput = desenharVendas;

      Z.ligarAcoes('rv-raiz', {
        'recarregar':     function () { Z.recarregar(); },
        'confirmar-pix':  confirmarPix,
        'dar-plano':      darPlano,
        'abrir-gateway':    abrirGateway,
        'salvar-gateway':   salvarGateway,
        'desligar-gateway': desligarGateway,
        'add-oferta':       addOferta,
        'remover-oferta':   removerOferta,
        'salvar-pix':     salvarPix,
        'ver-compra':     function () { window.open('/comprar.html', '_blank'); },
      });
    });
  },
});

// ─── Vendas ───────────────────────────────────────────────────────────
function contar(status) {
  var n = 0;
  VENDAS.forEach(function (v) { if ((v.status || 'aprovada') === status) n++; });
  return n;
}
function acharVenda(id) {
  var achada = null;
  VENDAS.forEach(function (v) { if (v.id === id) achada = v; });
  return achada;
}

function desenharVendas() {
  var caixa = document.getElementById('rv-lista');
  if (!caixa) return;
  var termo = String(pegar('rv-busca')).toLowerCase().trim();
  var lista = VENDAS.filter(function (v) {
    if (FILTRO !== 'todas' && (v.status || 'aprovada') !== FILTRO) return false;
    if (!termo) return true;
    var texto = [v.username, v.email, v.plano, v.referencia, v.transactionId, v.gateway, v.meio].join(' ').toLowerCase();
    return texto.indexOf(termo) >= 0;
  });

  var linhas = lista.map(function (v) {
    var ref = String(v.referencia || '—');
    return '<tr>' +
      '<td><div class="z-fg2">' + Z.data(v.criadaEm) + '</div>' +
        '<div class="z-cel-sub">' + Z.desde(v.criadaEm) + ' atrás</div></td>' +
      '<td class="forte">' + Z.esc(v.username || '—') +
        (v.email ? '<div class="z-cel-sub">' + Z.esc(v.email) + '</div>' : '') + '</td>' +
      '<td class="num">' + Z.brl(v.valorBrl) + '</td>' +
      '<td>' + C.chip(rotuloOrigem(v.gateway)) +
        (v.meio && v.meio !== v.gateway ? '<div class="z-cel-sub">' + Z.esc(v.meio) + '</div>' : '') + '</td>' +
      '<td>' + (v.plano ? C.chip(v.plano, 'acento') : '<span class="z-fg3">—</span>') + '</td>' +
      '<td class="z-mono" title="' + att(ref) + '">' + Z.esc(ref.length > 22 ? ref.slice(0, 22) + '…' : ref) + '</td>' +
      '<td class="dir">' + estado(v) + '</td>' +
    '</tr>';
  });

  var vazioTxt = VENDAS.length
    ? 'Nenhuma venda com esse filtro. Tente "Todas".'
    : 'As vendas entram sozinhas pelo webhook do seu gateway, quando um cliente avisa que fez o Pix, ' +
      'ou quando você registra um pagamento ao dar créditos em Clientes.';

  caixa.innerHTML = C.tabela([
    { t: 'Quando' }, { t: 'Cliente' }, { t: 'Valor' }, { t: 'Origem' },
    { t: 'Plano' }, { t: 'Referência' }, { t: 'Situação', dir: true },
  ], linhas, {
    icone: 'receita',
    vazioTit: VENDAS.length ? 'Nada com esse filtro' : 'Nenhuma venda ainda',
    vazioTxt: vazioTxt,
  });
}

function estado(v) {
  var s = v.status || 'aprovada';
  if (s === 'aprovada') return C.chipPonto('Aprovada', 'ok');
  if (s === 'reembolsada') {
    return C.chip('Reembolsada', 'erro') +
      (v.reembolsoEvento ? '<div class="z-cel-sub">' + Z.esc(v.reembolsoEvento) + '</div>' : '');
  }
  if (s === 'aguardando_confirmacao') {
    return C.btn('Confirmar Pix', {
      classe: 'primario mini', icone: 'check', acao: 'confirmar-pix', dado: v.id,
      titulo: 'O cliente avisou que pagou. Confira o valor na sua conta e confirme para liberar o plano.',
    });
  }
  if (s === 'sem_plano') {
    return C.chip('Sem plano', 'alerta') +
      '<div style="margin-top:6px">' + C.btn('Dar o plano', {
        classe: 'mini', acao: 'dar-plano', dado: v.id,
        titulo: 'A compra entrou, mas nenhum plano foi aplicado. Escolha qual liberar para este cliente.',
      }) + '</div>';
  }
  return C.chip(s);
}

function rotuloOrigem(g) {
  var gwNome = { hotmart: 'Hotmart', kiwify: 'Kiwify', asaas: 'Asaas', mercadopago: 'Mercado Pago' }[g];
  if (gwNome) return gwNome;
  if (g === 'pix-manual') return 'Pix do cliente';
  if (g === 'manual') return 'Registro manual';
  return String(g || '—');
}

function confirmarPix(id) {
  var v = acharVenda(id);
  if (!v) return;
  Z.perguntar({
    icone: 'dinheiro',
    titulo: 'Confirmar o Pix de ' + Z.esc(v.username || v.email || 'cliente'),
    sub: 'Confira <b>' + Z.brl(v.valorBrl) + '</b> na sua conta antes de confirmar. ' +
         'Ao confirmar, o plano <b>' + Z.esc(v.plano || '—') + '</b> é ativado na hora e o cliente recebe o e-mail de confirmação.',
    campos: [{
      id: 'referencia', rotulo: 'Referência do comprovante',
      dica: 'E2E, id da transação, "print do WhatsApp"…',
      ajuda: 'Fica gravada no ledger para sempre — é o que prova de onde veio esse dinheiro.',
    }],
    confirmar: 'Confirmar e liberar o plano',
    aoConfirmar: function (vals) {
      Z.apiJson('/api/admin/vendas/' + encodeURIComponent(id) + '/confirmar', 'POST',
        { referencia: String(vals.referencia || '').trim() }
      ).then(function (r) {
        if (r.error) return Z.erro(r.error);
        Z.ok(r.jaAprovada ? 'Essa venda já estava aprovada — nada mudou.' : 'Pix confirmado. O plano já está valendo.');
        Z.recarregar();
      });
    },
  });
}

function darPlano(id) {
  var v = acharVenda(id);
  if (!v) return;
  if (!v.username) {
    return Z.modal({
      icone: 'alerta', titulo: 'Essa compra não tem conta ligada',
      sub: 'Veio sem e-mail utilizável, então nenhum cliente foi criado.',
      corpo: '<p class="z-p">Crie a conta em <b>Clientes</b> com o e-mail do comprador e aplique o plano por lá. ' +
             'Depois volte aqui só para conferir que o valor bate.</p>' +
             '<p class="z-p" style="margin-top:10px">Referência desta compra: <span class="z-mono">' + Z.esc(v.referencia || v.transactionId || '—') + '</span></p>',
      pe: '<button class="z-btn" data-fechar>Entendi</button>',
    });
  }
  if (!PLANOS.length) return Z.erro('Nenhum plano cadastrado. Crie os planos primeiro em Planos & Créditos.');
  Z.perguntar({
    icone: 'dinheiro',
    titulo: 'Liberar o plano de ' + Z.esc(v.username),
    sub: 'Pagou <b>' + Z.brl(v.valorBrl) + '</b> e ficou sem plano porque a oferta não estava mapeada.',
    campos: [{
      id: 'plano', rotulo: 'Plano a aplicar', tipo: 'select',
      valor: PLANOS[0] ? PLANOS[0].slug : '',
      opcoes: PLANOS.map(function (p) { return { v: p.slug, t: p.name + ' — ' + Z.brl(p.priceBrl) }; }),
      ajuda: 'Depois de resolver, defina o <b>plano padrão</b> do gateway em <b>Meios de pagamento</b>: as próximas compras entram sozinhas.',
    }],
    confirmar: 'Aplicar plano',
    aoConfirmar: function (vals) {
      Z.apiJson('/api/admin/billing/users/' + encodeURIComponent(v.username), 'POST', { plan: vals.plano })
        .then(function (r) {
          if (r.error) return Z.erro(r.error);
          Z.ok('Plano aplicado. O cliente já pode trabalhar — a venda continua marcada como "sem plano" no histórico, que é o registro do que aconteceu.');
          Z.recarregar();
        });
    },
  });
}

// ─── Meios de pagamento ───────────────────────────────────────────────
// Os quatro gateways numa grade. Clicar num deles abre a configuração
// logo abaixo — segredo já guardado NUNCA volta inteiro para a tela:
// o campo vem vazio e a dica mostra só o rabo do valor. Em branco
// significa "mantém o que já está no cofre".
function painelMeios() {
  return C.card({
    tit: 'Meios de pagamento',
    sub: 'Ligue quantos quiser ao mesmo tempo — cada um tem seu próprio endereço de webhook e seus próprios segredos. ' +
         'Toda venda aprovada, venha de onde vier, cai na aba <b>Vendas</b> com o mesmo tratamento.',
    corpo: '<div class="z-grade" id="rv-gws"></div>',
  }) + '<div id="rv-gw-conf" class="z-mt"></div>';
}

function acharGw(id) {
  for (var i = 0; i < GATEWAYS.length; i++) if (GATEWAYS[i].id === id) return GATEWAYS[i];
  return null;
}

function desenharMeios() {
  var caixa = document.getElementById('rv-gws');
  if (!caixa) return;
  caixa.innerHTML = GATEWAYS.map(function (g) {
    var faltam = g.faltando || [];
    var parcial = faltam.length && faltam.length < g.campos.length;
    var chip = g.configurado ? C.chipPonto('Ligado', 'ok')
             : parcial      ? C.chipPonto('Falta ' + faltam.join(' e '), 'alerta')
                            : C.chip('Desligado');
    return '<div class="z-item' + (SEL === g.id ? ' ativo' : '') + '" data-acao="abrir-gateway" data-dado="' + att(g.id) + '">' +
      '<div class="z-item-cab">' + marcaHtml(g) +
        '<div class="z-item-tit">' + Z.esc(g.nome) + '</div>' +
      '</div>' +
      '<div class="z-item-chips">' + chip +
        (g.planoPadrao ? C.chip(g.planoPadrao, 'acento') : '') +
        (contarVendas(g.id) ? C.chip(contarVendas(g.id) + ' venda' + (contarVendas(g.id) > 1 ? 's' : '')) : '') +
      '</div>' +
      '<div class="z-item-desc">' + Z.esc(g.resumo) + '</div>' +
    '</div>';
  }).join('');
  ligarQuedaDeLogo(caixa);
  desenharConfGateway();
}

// O logo oficial de cada marca mora em /painel/logos/<id>.svg, num quadradinho
// tingido com a cor dela. É arquivo de terceiro: se um dia sumir, o onerror
// devolve a inicial no mesmo lugar — o card nunca mostra imagem quebrada.
function marcaHtml(g) {
  return '<div class="z-item-icone marca' + (g.logoSangra ? ' sangra' : '') + '" style="--z-marca-bg:' + att(g.cor) + '1f;color:' + att(g.cor) +
           ';font-weight:700;font-size:12.5px">' +
    '<img src="/painel/logos/' + att(g.id) + '.svg" alt="" data-inicial="' + att(g.nome.charAt(0)) + '"' +
      (g.logoEscala && g.logoEscala !== 1 ? ' style="width:' + (19 * g.logoEscala).toFixed(1) + 'px;height:' + (19 * g.logoEscala).toFixed(1) + 'px"' : '') + '>' +
  '</div>';
}

function ligarQuedaDeLogo(caixa) {
  [].forEach.call(caixa.querySelectorAll('.z-item-icone.marca img'), function (img) {
    img.onerror = function () {
      var box = img.parentNode;
      box.textContent = img.getAttribute('data-inicial') || '?';
    };
  });
}

function contarVendas(gid) {
  return VENDAS.filter(function (v) { return (v.gateway || '') === gid; }).length;
}

function abrirGateway(id) {
  SEL = (SEL === id) ? '' : id;                 // clicar de novo fecha
  var g = acharGw(SEL);
  OFERTAS = g ? JSON.parse(JSON.stringify(g.planoPorOferta || {})) : {};
  desenharMeios();
  var alvo = document.getElementById('rv-gw-conf');
  if (SEL && alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function desenharConfGateway() {
  var alvo = document.getElementById('rv-gw-conf');
  if (!alvo) return;
  var g = acharGw(SEL);
  if (!g) {
    alvo.innerHTML = C.banner(
      'Clique num meio de pagamento acima para configurar. Enquanto um gateway está desligado, ' +
      'o NASCERA <b>recusa</b> qualquer chamada que chegue no endereço dele — ninguém ganha plano por engano.', 'info');
    return;
  }

  var url = location.origin + g.url;
  var oA = (g.artigo || 'o');                     // 'a Hotmart' / 'o Asaas'
  var oANome = oA + ' ' + Z.esc(g.nome);
  var aviso = g.configurado
    ? C.banner('<b>' + Z.esc(g.nome) + ' ligad' + (oA === 'a' ? 'a' : 'o') + '.</b> Cada compra aprovada vira cliente e plano sozinha; ' +
               'reembolso e chargeback suspendem o acesso sem apagar o histórico.', 'ok')
    : C.banner('<b>' + Z.esc(g.nome) + ' desligad' + (oA === 'a' ? 'a' : 'o') + '.</b> Sem o segredo o NASCERA recusa toda chamada dessa origem, ' +
               'e cada venda vira trabalho manual seu. Preencha os campos abaixo para ligar.', 'erro');

  var passos = C.banner('<b>Como ligar:</b><ol class="z-passos">' +
    (g.comoLigar || []).map(function (t) { return '<li>' + Z.esc(t) + '</li>'; }).join('') + '</ol>', 'info');

  var campos = '<div class="z-campos">' +
    C.campo({ id: 'rv-url', rotulo: 'URL do webhook (clique para copiar)', valor: url,
      ajuda: 'É este endereço que ' + oANome + ' chama a cada venda. Só funciona com o NASCERA publicado em domínio próprio.' }) +
    g.campos.map(function (c) {
      var atual = (g.valores || {})[c.id];
      return C.campo({
        id: 'rv-gw-' + c.id, rotulo: c.rotulo, tipo: 'password', auto: false,
        dica: atual ? 'Guardado ' + atual + ' — cole outro só para trocar' : 'Cole aqui o valor',
        ajuda: Z.esc(c.ajuda) + (atual ? ' <b>Em branco mantém o atual.</b>' : ''),
      });
    }).join('') +
    C.campo({ id: 'rv-plano-padrao', rotulo: 'Plano aplicado em toda compra aprovada', tipo: 'select',
      valor: g.planoPadrao || '',
      opcoes: [{ v: '', t: '— não aplicar plano automaticamente —' }].concat(PLANOS.map(function (p) {
        return { v: p.slug, t: p.name + ' — ' + Z.brl(p.priceBrl) };
      })),
      ajuda: 'Sem plano padrão a venda entra marcada como <b>sem plano</b> e fica esperando você — o dinheiro nunca se perde, mas o cliente espera.' }) +
  '</div>' +
  '<div class="z-linha" style="margin-top:16px">' +
    C.btn('Salvar ' + g.nome, { classe: 'primario', icone: 'check', acao: 'salvar-gateway', dado: g.id }) +
    (g.configurado || (g.faltando || []).length < g.campos.length
      ? C.btn('Desligar', { classe: 'perigo', icone: 'x', acao: 'desligar-gateway', dado: g.id }) : '') +
  '</div>';

  alvo.innerHTML = aviso + passos +
    C.card({ tit: 'Conexão com ' + oA + ' ' + g.nome, sub: Z.esc(g.resumo), corpo: campos }) +
    '<div class="z-mt">' + C.card({
      tit: 'Ofertas mapeadas',
      sub: 'Vende mais de um plano na mesma conta? Diga qual código de oferta libera qual plano. ' +
           'O que não estiver aqui cai no plano padrão.',
      acoes: [C.btn('Mapear oferta', { classe: 'mini', icone: 'mais', acao: 'add-oferta' })],
      corpo: '<div id="rv-ofertas"></div>',
    }) + '</div>';

  desenharOfertas();

  // URL do webhook: só-leitura, copia ao clicar
  var campoUrl = document.getElementById('rv-url');
  if (campoUrl) {
    campoUrl.readOnly = true;
    campoUrl.classList.add('z-mono');
    campoUrl.style.cursor = 'pointer';
    campoUrl.onclick = function () { copiar(campoUrl); };
  }
}

function desenharOfertas() {
  var caixa = document.getElementById('rv-ofertas');
  if (!caixa) return;
  var linhas = Object.keys(OFERTAS).map(function (cod) {
    return '<tr><td class="z-mono forte">' + Z.esc(cod) + '</td>' +
      '<td>' + C.chip(OFERTAS[cod], 'acento') + '</td>' +
      '<td class="dir">' + C.btn('', { classe: 'perigo mini', icone: 'lixeira', acao: 'remover-oferta', dado: cod, titulo: 'Remover mapeamento' }) + '</td></tr>';
  });
  caixa.innerHTML = C.tabela(
    [{ t: 'Código da oferta' }, { t: 'Libera o plano' }, { t: '', dir: true }], linhas,
    { icone: 'caixa', vazioTit: 'Nenhuma oferta mapeada',
      vazioTxt: 'Tudo bem: toda compra aprovada vira o plano padrão. Mapeie só se vender planos diferentes na mesma conta.' });
}

function addOferta() {
  if (!PLANOS.length) return Z.erro('Cadastre os planos primeiro em Planos & Créditos.');
  Z.perguntar({
    icone: 'raio', titulo: 'Mapear uma oferta',
    sub: 'O código da oferta aparece no link de checkout do gateway.',
    campos: [
      { id: 'codigo', rotulo: 'Código da oferta', dica: 'ex.: k3m9xz2p' },
      { id: 'plano', rotulo: 'Plano que essa oferta libera', tipo: 'select',
        valor: PLANOS[0] ? PLANOS[0].slug : '',
        opcoes: PLANOS.map(function (p) { return { v: p.slug, t: p.name + ' — ' + Z.brl(p.priceBrl) }; }) },
    ],
    confirmar: 'Mapear',
    aoConfirmar: function (vals) {
      var cod = String(vals.codigo || '').trim();
      if (!cod) return Z.erro('Informe o código da oferta.');
      OFERTAS[cod] = vals.plano;
      desenharOfertas();
      Z.toast('Mapeado. Clique em "Salvar" para valer de verdade.');
    },
  });
}

function removerOferta(cod) {
  delete OFERTAS[cod];
  desenharOfertas();
  Z.toast('Removido. Clique em "Salvar" para valer de verdade.');
}

function salvarGateway(id) {
  var g = acharGw(id);
  if (!g) return;
  var corpo = { planoPadrao: pegar('rv-plano-padrao') || null, planoPorOferta: OFERTAS };
  g.campos.forEach(function (c) {
    var v = String(pegar('rv-gw-' + c.id)).trim();
    if (v) corpo[c.id] = v;                 // vazio = mantém o que está no cofre
  });
  Z.apiJson('/api/admin/gateways/' + id, 'PUT', corpo).then(function (r) {
    if (r.error) return Z.erro(r.error);
    Z.ok(g.nome + ' salv' + (g.artigo === 'a' ? 'a' : 'o') + '. Faça uma compra de teste para ver a venda cair aqui sozinha.');
    Z.recarregar();
  });
}

function desligarGateway(id) {
  var g = acharGw(id);
  if (!g) return;
  Z.confirmar({
    perigo: true, titulo: 'Desligar ' + g.nome + '?',
    texto: 'Os segredos saem do cofre e o endereço do webhook passa a recusar tudo que ' + (g.artigo || 'o') + ' ' + Z.esc(g.nome) +
           ' mandar. As vendas já registradas continuam no histórico — nada é apagado.',
    confirmar: 'Desligar',
    aoConfirmar: function () {
      Z.apiJson('/api/admin/gateways/' + id, 'DELETE').then(function (r) {
        if (r.error) return Z.erro(r.error);
        Z.ok(g.nome + ' desligad' + (g.artigo === 'a' ? 'a' : 'o') + '.');
        Z.recarregar();
      });
    },
  });
}

// ─── Pix manual ───────────────────────────────────────────────────────
function painelPix(pix) {
  var ligado = !!(pix && pix.chave);
  var aviso = ligado
    ? C.banner('<b>Pix ativo.</b> Seus clientes veem essa chave em <b>/comprar.html</b>, pagam e clicam em "já fiz o Pix". ' +
               'A intenção cai na aba <b>Vendas</b> esperando sua conferência — ninguém recebe plano sem você olhar o extrato.', 'ok')
    : C.banner('<b>Sem chave Pix cadastrada.</b> A tela de compra fica sem forma de pagamento manual: ' +
               'quem não comprar pelos gateways não tem por onde pagar.', 'alerta');

  var corpo =
    '<div class="z-campos">' +
      C.campo({ id: 'rv-pix-chave', rotulo: 'Chave Pix', valor: (pix && pix.chave) || '', auto: false,
        dica: 'CPF/CNPJ, e-mail, telefone ou chave aleatória',
        ajuda: 'Aparece exatamente assim para o cliente. Confira caractere por caractere.' }) +
      C.campo({ id: 'rv-pix-titular', rotulo: 'Titular da chave', valor: (pix && pix.titular) || '', auto: false,
        dica: 'O nome que o cliente vai ver no app do banco',
        ajuda: 'Bate com o nome do banco e o cliente paga sem medo. Divergiu, ele desiste.' }) +
    '</div>' +
    '<div class="z-mt">' +
      C.campo({ id: 'rv-pix-instrucoes', rotulo: 'Instruções para o cliente', tipo: 'textarea', linhas: 4,
        valor: (pix && pix.instrucoes) || '',
        dica: 'Ex.: Faça o Pix do valor exato do plano e clique em "já fiz o Pix". Em até 1 dia útil seu acesso é liberado.',
        ajuda: 'Texto curto e humano. É a última coisa que o cliente lê antes de te mandar dinheiro.' }) +
    '</div>' +
    '<div class="z-linha" style="margin-top:16px">' +
      C.btn('Salvar Pix', { classe: 'primario', icone: 'check', acao: 'salvar-pix' }) +
      C.btn('Ver a tela do cliente', { icone: 'externo', acao: 'ver-compra' }) +
    '</div>';

  return aviso + C.card({
    tit: 'Pix manual',
    sub: 'O caminho para quem não compra por gateway: você recebe direto e libera na mão.',
    corpo: corpo,
  });
}

function salvarPix() {
  Z.apiJson('/api/admin/pagamentos/pix', 'PUT', {
    chave: String(pegar('rv-pix-chave')).trim(),
    titular: String(pegar('rv-pix-titular')).trim(),
    instrucoes: String(pegar('rv-pix-instrucoes')).trim(),
  }).then(function (r) {
    if (r.error) return Z.erro(r.error);
    Z.ok('Pix salvo. Seus clientes já veem em /comprar.html.');
    Z.recarregar();
  });
}

// ─── utilidades locais ────────────────────────────────────────────────
function pegar(id) { var el = document.getElementById(id); return el ? el.value : ''; }
// Z.esc não escapa aspas; dentro de um atributo isso deixaria uma referência
// com " quebrar a célula.
function att(v) { return Z.esc(v == null ? '' : v).replace(/"/g, '&quot;'); }

function copiar(el) {
  var feito = false;
  try { el.select(); feito = document.execCommand('copy'); } catch (e) { feito = false; }
  if (feito) return Z.ok('URL copiada — agora cole no painel do gateway.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(
      function () { Z.ok('URL copiada — agora cole no painel do gateway.'); },
      function () { Z.toast('Seu navegador bloqueou a cópia: selecione e use Ctrl+C.'); });
    return;
  }
  Z.toast('Selecione o texto e copie com Ctrl+C.');
}
})();
