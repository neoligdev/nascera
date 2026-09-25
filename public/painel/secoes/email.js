/* ═══ NASCERA ADMIN v2 — E-MAIL ═════════════════════════════════════════
   A vitrine: uma grade de cartões, um por template, com mini-preview.
   Clicar no cartão abre o modal com Preview / Editar / Enviar teste.
   Abas da tela: Templates · Servidor SMTP · Envios.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

// ── Vocabulário dos eventos (o backend fala 'credito-80', o dono fala humano)
var NOMES = {
  'boas-vindas':       'Boas-vindas (compra → conta)',
  'esqueci-senha':     'Esqueci minha senha',
  'compra-confirmada': 'Compra confirmada',
  'credito-80':        'Créditos a 80%',
  'suspensao':         'Conta suspensa',
};
var CATEG = {
  'boas-vindas': 'acesso', 'esqueci-senha': 'acesso',
  'compra-confirmada': 'venda', 'credito-80': 'creditos', 'suspensao': 'cobranca',
};
var CATEG_NOME = { acesso: 'Acesso', venda: 'Venda', creditos: 'Créditos', cobranca: 'Cobrança' };
var ICONES = {
  'boas-vindas': 'usuario', 'esqueci-senha': 'bloqueio',
  'compra-confirmada': 'dinheiro', 'credito-80': 'raio', 'suspensao': 'alerta',
};
var QUANDO = {
  'boas-vindas':       'Sai assim que a compra é aprovada: dá as boas-vindas e manda o link para o cliente definir a senha e entrar. É o e-mail que decide se a venda vira cliente ou reembolso.',
  'esqueci-senha':     'Sai quando alguém pede redefinição na tela de login. O link vale 30 minutos e só funciona uma vez.',
  'compra-confirmada': 'Confirma o pagamento e avisa que o plano já está ativo. Vai para quem já tinha conta e comprou de novo.',
  'credito-80':        'Aviso amigável quando o cliente encosta no limite da semana. Sai no máximo uma vez a cada 7 dias por pessoa.',
  'suspensao':         'Avisa que a conta foi suspensa e explica o motivo — deixando claro que os projetos continuam intactos.',
};
var VARIAVEIS = [
  { v: '{{nome}}',    t: 'nome da pessoa' },
  { v: '{{usuario}}', t: 'login dela' },
  { v: '{{link}}',    t: 'link da ação' },
  { v: '{{plano}}',   t: 'plano comprado' },
  { v: '{{valor}}',   t: 'valor pago' },
  { v: '{{pct}}',     t: '% de crédito usado' },
  { v: '{{motivo}}',  t: 'motivo da suspensão' },
  { v: '{{produto}}', t: 'nome do seu produto' },
];

// ── Estado da tela (sobrevive ao recarregar da seção) ────────────────────
var D = { templates: [], log: [] };
var aba = 'templates', filtro = 'todos', termo = '';

Z.registrar('email', {
  render: function (alvo) {
    return Z.api('/api/admin/email').then(function (d) {
      d = d || {};
      if (d.error) Z.erro(d.error);
      D = d;
      D.templates = D.templates || [];
      D.log = D.log || [];

      var falhas = D.log.filter(function (e) { return e.status === 'erro'; }).length;
      var pers = D.templates.filter(function (t) { return t.personalizado; }).length;

      var html = C.cab({
        trilha: 'Sistema · Comunicação com o cliente',
        icone: 'email',
        titulo: 'E-mail',
        sub: 'Tudo que o seu cliente recebe automaticamente: boas-vindas, senha, confirmação de compra e avisos. Edite o texto, veja como fica e mande um teste antes de soltar no mundo.',
        acoes: [
          C.btn('Enviar teste', { icone: 'enviar', acao: 'ir-smtp' }),
          C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' }),
        ],
      });

      html += C.stats([
        { rot: 'Estado do envio', num: D.configurado ? 'No ar' : 'Parado', pequeno: true,
          cap: D.configurado ? Z.esc(D.host || 'servidor configurado') : 'Nenhum e-mail sai assim',
          icone: 'servidor', tom: D.configurado ? 'ok' : 'erro' },
        { rot: 'Templates', num: Z.num(D.templates.length),
          cap: pers ? pers + ' com texto seu' : 'Todos no texto padrão', icone: 'email' },
        { rot: 'Envios registrados', num: Z.num(D.log.length),
          cap: 'Os últimos que o sistema guardou', icone: 'enviar' },
        { rot: 'Falhas recentes', num: Z.num(falhas),
          cap: falhas ? 'Veja o motivo na aba Envios' : 'Nenhuma nos últimos envios',
          icone: 'alerta', tom: falhas ? 'erro' : 'ok' },
      ]);

      html += C.abas('em-abas', [
        { id: 'templates', t: 'Templates', icone: 'email' },
        { id: 'smtp',      t: 'Servidor SMTP', icone: 'servidor' },
        { id: 'envios',    t: 'Envios', icone: 'enviar' },
      ], aba);
      html += '<div id="em-painel"></div>';

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="em-raiz">' + html + '</div>';

      Z.ligarAbas('em-abas', function (id) { aba = id; pintar(); });
      Z.ligarAcoes('em-raiz', {
        'recarregar':  function () { Z.recarregar(); },
        'ir-smtp':     function () { irAba('smtp'); },
        'ir-templates':function () { irAba('templates'); },
        'abrir':       function (ev) { abrirTemplate(ev); },
        'salvar-smtp': function (_d, el) { salvarSmtp(el); },
        'testar-smtp': function (_d, el) {
          var c = document.getElementById('sm-teste');
          testar(c ? c.value.trim() : '', 'sm-teste-res', el);
        },
      });
      pintar();
    });
  },
});

// ═══ Abas da tela ═══════════════════════════════════════════════════════
function irAba(id) {
  aba = id;
  var b = document.getElementById('em-abas');
  if (b) b.querySelectorAll('[data-aba]').forEach(function (x) {
    x.classList.toggle('ativo', x.getAttribute('data-aba') === id);
  });
  pintar();
}

function pintar() {
  var cx = document.getElementById('em-painel');
  if (!cx) return;
  if (aba === 'smtp') { cx.innerHTML = viewSmtp(); return; }
  if (aba === 'envios') { cx.innerHTML = viewEnvios(); return; }

  cx.innerHTML = viewTemplates();
  var b = document.getElementById('em-busca');
  if (b) { b.value = termo; b.oninput = function () { termo = b.value; pintarGrade(); }; }
  Z.ligarFiltros('em-filtros', function (id) { filtro = id; pintarGrade(); });
}

// ═══ Aba 1 — TEMPLATES (a vitrine) ══════════════════════════════════════
function viewTemplates() {
  var h;
  if (D.configurado) {
    h = C.banner('<b>SMTP no ar.</b> Os e-mails saem por <b>' + Z.esc(D.host || '—') +
      '</b> como <b>' + Z.esc(D.remetente || '—') + '</b>. Vale mandar um teste depois de mexer nos textos.', 'ok');
  } else {
    h = C.banner('<b>Configure o SMTP para os e-mails saírem.</b> Do jeito que está, ninguém recebe ' +
      'boas-vindas, link de senha ou confirmação de compra — e cliente sem e-mail vira pedido de reembolso.' +
      '<div style="margin-top:10px">' + C.btn('Configurar agora', { classe: 'mini', icone: 'servidor', acao: 'ir-smtp' }) + '</div>', 'alerta');
  }

  var cats = {};
  D.templates.forEach(function (t) {
    var c = CATEG[t.evento] || 'outros';
    cats[c] = (cats[c] || 0) + 1;
  });
  var pilulas = [{ id: 'todos', t: 'Todos', n: D.templates.length }];
  Object.keys(CATEG_NOME).forEach(function (c) {
    if (cats[c]) pilulas.push({ id: c, t: CATEG_NOME[c], n: cats[c] });
  });
  var pers = D.templates.filter(function (t) { return t.personalizado; }).length;
  pilulas.push({ id: 'personalizados', t: 'Personalizados', n: pers });

  h += C.busca('em-busca', 'Buscar por nome, assunto ou texto do e-mail…');
  h += C.filtros('em-filtros', pilulas, filtro);
  h += '<div id="em-grade">' + gradeHtml() + '</div>';
  return h;
}

function filtrados() {
  var q = termo.trim().toLowerCase();
  return D.templates.filter(function (t) {
    if (filtro === 'personalizados' && !t.personalizado) return false;
    if (filtro !== 'todos' && filtro !== 'personalizados' && CATEG[t.evento] !== filtro) return false;
    if (!q) return true;
    return (nome(t.evento) + ' ' + t.evento + ' ' + (t.assunto || '') + ' ' + (t.corpo || ''))
      .toLowerCase().indexOf(q) !== -1;
  });
}

function pintarGrade() {
  var g = document.getElementById('em-grade');
  if (g) g.innerHTML = gradeHtml();
}

function gradeHtml() {
  var lista = filtrados();
  if (!lista.length) {
    if (termo.trim() || filtro !== 'todos') {
      return C.vazio({
        icone: 'busca', tit: 'Nenhum template com esse recorte',
        txt: 'Tente outra palavra ou volte para <b>Todos</b>.',
      });
    }
    return C.vazio({
      icone: 'email', tit: 'Nenhum template disponível',
      txt: 'O sistema não devolveu os modelos de e-mail. Recarregue a tela; se continuar assim, olhe os logs do servidor.',
      acao: C.btn('Recarregar', { classe: 'primario', icone: 'atualiza', acao: 'recarregar' }),
    });
  }
  return '<div class="z-grade">' + lista.map(cartao).join('') + '</div>';
}

function cartao(t) {
  return '<div class="z-item" data-acao="abrir" data-dado="' + Z.esc(t.evento) + '">' +
    '<div class="z-item-cab">' +
      '<div class="z-item-icone">' + Z.svg(ICONES[t.evento] || 'email') + '</div>' +
      '<div style="min-width:0"><div class="z-item-tit">' + Z.esc(nome(t.evento)) + '</div>' +
      '<div class="z-dica" style="margin-top:2px">' + Z.esc(t.evento) + '</div></div>' +
    '</div>' +
    '<div class="z-item-chips">' +
      C.chip(CATEG_NOME[CATEG[t.evento]] || 'Sistema') +
      (t.personalizado ? C.chip('personalizado', 'acento') : C.chip('padrão')) +
    '</div>' +
    mini(t) +
    '<div class="z-item-desc">' + Z.esc(t.assunto || '(sem assunto)') + '</div>' +
  '</div>';
}

// Mini-preview: o desenho do e-mail, montado a partir do texto real do template.
function mini(t) {
  var linhas = String(t.corpo || '').split('\n').filter(function (l) { return l.trim(); });
  var larg = ['c', 'm', 'p', 'm'];
  var h = '<div class="z-item-preview"><div class="l c"></div>';
  for (var i = 0; i < Math.min(linhas.length, 3); i++) h += '<div class="l ' + larg[i + 1] + '"></div>';
  if (/\{\{link\}\}/.test(t.corpo || '')) h += '<div class="b"></div>';
  return h + '</div>';
}

function nome(ev) { return NOMES[ev] || String(ev || '').replace(/-/g, ' '); }

// ═══ Modal do template — Preview / Editar / Enviar teste ════════════════
function abrirTemplate(ev) {
  var t = null;
  D.templates.forEach(function (x) { if (x.evento === ev) t = x; });
  if (!t) return Z.erro('Template não encontrado.');

  var rasc = { assunto: t.assunto || '', corpo: t.corpo || '' };
  var mAba = 'preview';

  Z.modal({
    largo: true,
    icone: ICONES[ev] || 'email',
    titulo: Z.esc(nome(ev)),
    sub: Z.esc(QUANDO[ev] || ''),
    chips: [
      C.chip(CATEG_NOME[CATEG[ev]] || 'Sistema'),
      t.personalizado ? C.chip('personalizado', 'acento') : C.chip('padrão'),
    ],
    corpo: C.abas('em-mabas', [
      { id: 'preview', t: 'Preview', icone: 'olho' },
      { id: 'editar',  t: 'Editar',  icone: 'codigo' },
      { id: 'teste',   t: 'Enviar teste', icone: 'enviar' },
    ], mAba) + '<div id="em-mpainel"></div>',
    pe: '<button class="z-btn" data-fechar>Fechar</button>',
    aoAbrir: function (m) {
      Z.ligarAbas('em-mabas', function (id) { capturar(m); mAba = id; pintarModal(m); });
      Z.ligarAcoes(m, {
        'var': function (dado) { inserir(dado); },
        'salvar-tpl': function (_d, el) { capturar(m); salvarTemplate(ev, rasc, el); },
        'restaurar-tpl': function () { restaurarTemplate(ev); },
        'testar-tpl': function (_d, el) {
          var c = m.querySelector('#tp-teste');
          testar(c ? c.value.trim() : '', 'tp-teste-res', el);
        },
        'preview-de-novo': function () { capturar(m); mAba = 'preview'; pintarModal(m); marcarAba('preview'); },
      });
      pintarModal(m);
    },
  });

  function marcarAba(id) {
    var b = document.getElementById('em-mabas');
    if (b) b.querySelectorAll('[data-aba]').forEach(function (x) {
      x.classList.toggle('ativo', x.getAttribute('data-aba') === id);
    });
  }
  function capturar(m) {
    var a = m.querySelector('#tp-assunto'), c = m.querySelector('#tp-corpo');
    if (a) rasc.assunto = a.value;
    if (c) rasc.corpo = c.value;
  }
  function inserir(txt) {
    var c = document.getElementById('tp-corpo');
    if (!c) return;
    var i = c.selectionStart == null ? c.value.length : c.selectionStart;
    var f = c.selectionEnd == null ? i : c.selectionEnd;
    c.value = c.value.slice(0, i) + txt + c.value.slice(f);
    c.focus();
    try { c.setSelectionRange(i + txt.length, i + txt.length); } catch (e) {}
    rasc.corpo = c.value;
  }
  function pintarModal(m) {
    var cx = m.querySelector('#em-mpainel');
    if (!cx) return;
    if (mAba === 'editar') { cx.innerHTML = viewEditar(rasc); return; }
    if (mAba === 'teste')  { cx.innerHTML = viewTesteTpl(); return; }

    cx.innerHTML = C.carregando('Renderizando com dados de exemplo…');
    Z.apiJson('/api/admin/email/preview', 'POST', { evento: ev, assunto: rasc.assunto, corpo: rasc.corpo })
      .then(function (p) {
        if (!document.body.contains(cx)) return;
        if (!p || p.error) {
          cx.innerHTML = C.banner(Z.esc((p && p.error) || 'Não consegui renderizar o preview.'), 'erro');
          return;
        }
        cx.innerHTML = papel(p);
      })
      .catch(function () {
        if (document.body.contains(cx)) cx.innerHTML = C.banner('Não consegui renderizar o preview agora.', 'erro');
      });
  }
}

// O "papel" do e-mail: fundo claro, texto escuro, como o cliente vê.
function papel(p) {
  var de = (D.remetenteNome ? D.remetenteNome + ' ' : '') + '<' + (D.remetente || 'remetente-nao-configurado') + '>';
  return '<span class="z-rotulo">Como chega na caixa de entrada</span>' +
    '<div style="background:#f4f5fa;border-radius:12px;padding:22px;max-width:560px;margin:0 auto;color:#1a1a2e">' +
      '<div style="font-size:11px;color:#6b7280;border-bottom:1px solid #e2e4ee;padding-bottom:11px;margin-bottom:15px;line-height:1.7">' +
        'De: <b>' + Z.esc(de) + '</b><br>Para: <b>maria@exemplo.com</b>' +
      '</div>' +
      '<div style="font-size:15.5px;font-weight:650;margin-bottom:13px;letter-spacing:-.01em">' +
        Z.esc(p.assunto || '(sem assunto)') + '</div>' +
      '<div style="font-size:13px;line-height:1.7;white-space:pre-wrap">' + Z.esc(p.corpo || '') + '</div>' +
    '</div>' +
    '<div class="z-dica" style="text-align:center;margin-top:13px">' +
      'As variáveis foram trocadas por dados de exemplo (Maria, plano Pro, R$ 600,00…).</div>';
}

function viewEditar(rasc) {
  var chips = VARIAVEIS.map(function (v) {
    return '<button class="z-chip" data-acao="var" data-dado="' + Z.esc(v.v) + '" ' +
      'title="' + Z.esc(v.t) + '" style="border:0;cursor:pointer;font-family:inherit">' +
      '<span class="z-mono">' + Z.esc(v.v) + '</span></button>';
  }).join('');

  return C.campo({ id: 'tp-assunto', rotulo: 'Assunto', valor: rasc.assunto,
                   dica: 'O que aparece na lista de e-mails do cliente' }) +
    '<div style="margin-top:14px">' +
      C.campo({ id: 'tp-corpo', rotulo: 'Corpo do e-mail', tipo: 'textarea', linhas: 12, valor: rasc.corpo,
        ajuda: 'Texto puro. As quebras de linha são respeitadas e os links viram clicáveis automaticamente.' }) +
    '</div>' +
    '<div style="margin-top:16px"><span class="z-rotulo">Variáveis disponíveis</span>' +
      '<div class="z-linha">' + chips + '</div>' +
      '<div class="z-dica">Clique numa variável para inserir onde o cursor estiver no corpo.</div>' +
    '</div>' +
    '<div class="z-sep"></div>' +
    '<div class="z-linha entre">' +
      C.btn('Restaurar padrão', { classe: 'fantasma', acao: 'restaurar-tpl',
        titulo: 'Volta ao texto embutido do Nascera' }) +
      '<div class="z-linha">' +
        C.btn('Ver preview', { icone: 'olho', acao: 'preview-de-novo' }) +
        C.btn('Salvar template', { classe: 'primario', icone: 'check', acao: 'salvar-tpl' }) +
      '</div>' +
    '</div>';
}

function viewTesteTpl() {
  var aviso = D.configurado ? '' :
    C.banner('<b>O SMTP ainda não está configurado</b> — o teste vai falhar. Configure o servidor na aba <b>Servidor SMTP</b> primeiro.', 'alerta');
  return aviso +
    '<p class="z-p z-mb">Manda o e-mail de teste do Nascera para o endereço abaixo. Serve para conferir se ' +
    'o servidor aceita os seus envios e se a mensagem cai na caixa de entrada (e não no spam).</p>' +
    C.campo({ id: 'tp-teste', rotulo: 'Enviar para', tipo: 'email', dica: 'voce@suaempresa.com' }) +
    '<div class="z-mt">' + C.btn('Enviar agora', { classe: 'primario', icone: 'enviar', acao: 'testar-tpl' }) + '</div>' +
    '<div id="tp-teste-res" class="z-mt"></div>';
}

// ═══ Aba 2 — SERVIDOR SMTP ══════════════════════════════════════════════
function viewSmtp() {
  var h = D.configurado
    ? C.banner('<b>Está funcionando.</b> Alterou alguma coisa? Salve e mande um teste logo abaixo.', 'ok')
    : C.banner('<b>Falta configurar.</b> Sem host, remetente e senha, nenhum e-mail sai do Nascera.', 'alerta');

  h += C.card({
    tit: 'Conexão com o servidor de e-mail',
    sub: 'Os dados de SMTP do seu provedor (Gmail, Zoho, Amazon SES, o e-mail do seu domínio…).',
    corpo:
      '<div class="z-campos">' +
        C.campo({ id: 'sm-host', rotulo: 'Servidor (host)', valor: D.host, dica: 'smtp.gmail.com' }) +
        C.campo({ id: 'sm-port', rotulo: 'Porta', tipo: 'number', valor: D.port || 587,
                  ajuda: '587 para STARTTLS (o normal) · 465 para SSL' }) +
        C.campo({ id: 'sm-usuario', rotulo: 'Usuário', valor: D.usuario,
                  dica: 'geralmente o próprio e-mail' }) +
        C.campo({ id: 'sm-senha', rotulo: 'Senha', tipo: 'password',
                  dica: D.senhaConfigurada ? '•••••••••• (já guardada)' : 'senha ou senha de app',
                  ajuda: D.senhaConfigurada
                    ? 'Já existe uma senha guardada no cofre. Deixe em branco para mantê-la.'
                    : 'Fica guardada no cofre do servidor, nunca em arquivo de configuração.' }) +
        C.campo({ id: 'sm-remetente', rotulo: 'Remetente (de)', valor: D.remetente,
                  dica: 'contato@suaempresa.com' }) +
        C.campo({ id: 'sm-nome', rotulo: 'Nome que aparece', valor: D.remetenteNome,
                  dica: 'Equipe Nascera' }) +
        C.campo({ id: 'sm-url', rotulo: 'URL pública do sistema', valor: D.urlBase,
                  dica: 'https://app.suaempresa.com',
                  ajuda: 'Usada para montar os links dos e-mails (definir senha, comprar). Sem ela, o link chega quebrado.' }) +
      '</div>' +
      '<div class="z-sep"></div>' +
      '<div class="z-linha">' +
        C.btn('Salvar configuração', { classe: 'primario', icone: 'check', acao: 'salvar-smtp' }) +
        '<span class="z-dica" style="margin:0">A senha só é trocada se você digitar uma nova.</span>' +
      '</div>',
  });

  h += C.card({
    tit: 'Enviar e-mail de teste',
    sub: 'A prova real: se este chegar, os e-mails dos seus clientes também chegam.',
    corpo:
      '<div class="z-campos">' +
        C.campo({ id: 'sm-teste', rotulo: 'Enviar para', tipo: 'email', dica: 'voce@suaempresa.com' }) +
      '</div>' +
      '<div class="z-mt">' + C.btn('Enviar agora', { classe: 'primario', icone: 'enviar', acao: 'testar-smtp' }) + '</div>' +
      '<div id="sm-teste-res" class="z-mt"></div>',
  });

  h += C.card({
    tit: 'Para não cair no spam',
    sub: 'Três coisas resolvem 90% dos problemas de entrega.',
    corpo:
      '<div class="z-col" style="gap:14px">' +
        bloco('Senha de app (Gmail e similares)',
          'O Gmail não aceita a sua senha normal em SMTP. Ative a verificação em duas etapas na conta Google, ' +
          'gere uma <b>senha de app</b> de 16 letras e cole ela aqui. Se aparecer <span class="z-mono">Invalid login: 535</span> ' +
          'no teste, é isso que está faltando.') +
        bloco('SPF',
          'No DNS do seu domínio, um registro TXT autorizando o servidor a enviar em seu nome — ' +
          'algo como <span class="z-mono">v=spf1 include:_spf.google.com ~all</span>. Sem SPF, provedor sério joga no spam.') +
        bloco('DKIM',
          'A assinatura criptográfica das mensagens, gerada pelo seu provedor de e-mail e publicada no DNS. ' +
          'Com SPF e DKIM no lugar, a sua taxa de entrega para de ser loteria.') +
        bloco('Remetente coerente',
          'Use um endereço do mesmo domínio do seu site. Enviar como <span class="z-mono">@gmail.com</span> ' +
          'falando de outra marca é o caminho mais curto para a caixa de spam.') +
      '</div>',
  });
  return h;
}

function bloco(tit, txt) {
  return '<div><div style="font-size:12.5px;font-weight:600;margin-bottom:4px">' + Z.esc(tit) + '</div>' +
    '<div class="z-p z-fg3">' + txt + '</div></div>';
}

// ═══ Aba 3 — ENVIOS ═════════════════════════════════════════════════════
function viewEnvios() {
  var linhas = D.log.map(function (e) {
    return '<tr>' +
      '<td class="z-fg3" style="white-space:nowrap">' + Z.data(e.ts, true) +
        '<div class="z-cel-sub">' + Z.desde(e.ts) + ' atrás</div></td>' +
      '<td class="forte">' + Z.esc(e.para || '—') + '</td>' +
      '<td>' + Z.esc(e.evento ? nome(e.evento) : 'avulso') + '</td>' +
      '<td class="z-fg3">' + Z.esc(e.assunto || '—') + '</td>' +
      '<td class="dir">' + statusChip(e) + '</td>' +
    '</tr>';
  });

  return C.banner('O Nascera guarda os últimos envios com o motivo exato da falha. ' +
    'Passe o mouse sobre um status <b>falhou</b> para ler o que o servidor respondeu.', 'info') +
    C.card({
      tit: 'Últimos envios',
      sub: 'Quem recebeu o quê, e o que deu errado quando deu.',
      acoes: [C.btn('Atualizar', { classe: 'mini', icone: 'atualiza', acao: 'recarregar' })],
      corpo: C.tabela(
        [{ t: 'Quando' }, { t: 'Para' }, { t: 'Evento' }, { t: 'Assunto' }, { t: 'Status', dir: true }],
        linhas,
        { icone: 'enviar', vazioTit: 'Nenhum e-mail saiu ainda',
          vazioTxt: 'Assim que o primeiro e-mail for enviado — nem que seja um teste — ele aparece aqui.' }),
    });
}

function statusChip(e) {
  if (e.status === 'enviado') return C.chip('enviado', 'ok');
  if (e.status === 'fake') return C.chip('simulado', 'info');
  return '<span class="z-chip erro" title="' + att(e.erro || 'sem detalhe do servidor') + '">falhou</span>';
}
// Z.esc não escapa aspas; num atributo isso deixaria uma resposta de SMTP
// (que quase sempre traz aspas) quebrar o chip.
function att(v) { return Z.esc(v == null ? '' : v).replace(/"/g, '&quot;'); }

// ═══ Ações ══════════════════════════════════════════════════════════════
function salvarSmtp(el) {
  var v = function (id) { var x = document.getElementById(id); return x ? String(x.value).trim() : ''; };
  var corpo = {
    host: v('sm-host'), port: v('sm-port') || 587, usuario: v('sm-usuario'),
    remetente: v('sm-remetente'), remetenteNome: v('sm-nome'),
    urlBase: v('sm-url'), senha: v('sm-senha'),
  };
  if (!corpo.host || !corpo.remetente) return Z.erro('Servidor (host) e remetente são obrigatórios.');
  if (!corpo.senha && !D.senhaConfigurada) return Z.erro('Informe a senha do SMTP — sem ela nada é enviado.');
  el.disabled = true;
  Z.apiJson('/api/admin/email', 'PUT', corpo).then(function (r) {
    el.disabled = false;
    if (!r || r.error) return Z.erro((r && r.error) || 'Não consegui salvar a configuração.');
    Z.ok('Servidor de e-mail salvo. Mande um teste para confirmar.');
    Z.recarregar();
  }).catch(function () { el.disabled = false; Z.erro('Falha de rede ao salvar.'); });
}

function testar(para, idRes, el) {
  var res = document.getElementById(idRes);
  if (!para) { Z.erro('Informe o e-mail de destino.'); return; }
  if (res) res.innerHTML = C.banner('Enviando… isso pode levar alguns segundos.', 'info');
  el.disabled = true;
  Z.apiJson('/api/admin/email/testar', 'POST', { para: para }).then(function (r) {
    el.disabled = false;
    if (r && r.ok) {
      if (res) res.innerHTML = C.banner('<b>Saiu.</b> Enviado para <b>' + Z.esc(para) +
        '</b>. Se não chegar em dois minutos, confira a caixa de spam.', 'ok');
      Z.ok('E-mail de teste enviado.');
    } else {
      var msg = (r && (r.error || r.erro)) || 'O servidor recusou sem dizer o motivo.';
      if (res) res.innerHTML = C.banner('<b>O servidor de e-mail recusou:</b>' +
        '<div class="z-mono" style="margin-top:7px;word-break:break-word">' + Z.esc(msg) + '</div>', 'erro');
      Z.erro('O teste falhou — veja o motivo na tela.');
    }
  }).catch(function () {
    el.disabled = false;
    if (res) res.innerHTML = C.banner('Não consegui falar com o servidor do Nascera para fazer o teste.', 'erro');
  });
}

function salvarTemplate(ev, rasc, el) {
  var a = String(rasc.assunto || '').trim(), c = String(rasc.corpo || '').trim();
  if (!a || !c) return Z.erro('Assunto e corpo precisam de texto. Para voltar ao original, use "Restaurar padrão".');
  el.disabled = true;
  Z.apiJson('/api/admin/email/templates', 'PUT', { evento: ev, assunto: a, corpo: c }).then(function (r) {
    el.disabled = false;
    if (!r || r.error) return Z.erro((r && r.error) || 'Não consegui salvar este template.');
    Z.ok('Template salvo. Já vale para o próximo e-mail.');
    Z.fecharModal();
    Z.recarregar();
  }).catch(function () { el.disabled = false; Z.erro('Falha de rede ao salvar o template.'); });
}

function restaurarTemplate(ev) {
  Z.confirmar({
    titulo: 'Voltar ao texto padrão?',
    texto: 'O seu texto de <b>' + Z.esc(nome(ev)) + '</b> é apagado e o e-mail volta a usar o modelo ' +
           'embutido do Nascera. Não dá para desfazer.',
    confirmar: 'Restaurar padrão',
    perigo: true,
    aoConfirmar: function () {
      Z.apiJson('/api/admin/email/templates', 'PUT', { evento: ev, assunto: '', corpo: '' }).then(function (r) {
        if (!r || r.error) return Z.erro((r && r.error) || 'Não consegui restaurar o padrão.');
        Z.ok('Template de volta ao texto padrão.');
        Z.fecharModal();
        Z.recarregar();
      }).catch(function () { Z.erro('Falha de rede ao restaurar o template.'); });
    },
  });
}

})();
