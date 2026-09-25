/* ═══════════════════════════════════════════════════════════════════════
   NASCERA ADMIN v2 — NÚCLEO
   Shell, roteador, chamadas de API, componentes e utilidades. As seções
   (admin/secoes/*.js) se registram em ZAdmin.registrar() e recebem tudo
   daqui — ninguém reimplementa cartão, tabela ou modal.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

var token = localStorage.getItem('nascera_token');
if (!token) { location.href = '/'; return; }

// ─── Ícones (traço, currentColor) ─────────────────────────────────────
var ICO = {
  visao:    '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  clientes: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  receita:  '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  vendas:   '<path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.3 2.3a1 1 0 00.7 1.7H19"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
  projetos: '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>',
  ia:       '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  dominios: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>',
  email:    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>',
  aparencia:'<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="19" cy="13" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="10" cy="20" r="2.5"/><path d="M12 2a10 10 0 100 20c1 0 1.5-.7 1.5-1.5 0-1.5-1-1.5-1-3 0-1 .8-1.5 2-1.5h2A5.5 5.5 0 0022 10c0-4.4-4.5-8-10-8z"/>',
  updates:  '<path d="M21 2v6h-6M3 22v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L21 8M20.5 15a9 9 0 01-14.9 3.4L3 16"/>',
  atividade:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  servidor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  config:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 003.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H8a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V8a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  busca:    '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  atualiza: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15"/>',
  mais:     '<path d="M12 5v14M5 12h14"/>',
  usuario:  '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  dinheiro: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
  caixa:    '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  alerta:   '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  check:    '<path d="M20 6L9 17l-5-5"/>',
  disco:    '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  relogio:  '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  raio:     '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  enviar:   '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  codigo:   '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  olho:     '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  link:     '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>',
  bloqueio: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  lixeira:  '<path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
  baixar:   '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  externo:  '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  play:     '<path d="M5 3l14 9-14 9V3z"/>',
  fechado:  '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
};
function svg(nome, cls) {
  return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
         'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (ICO[nome] || '') + '</svg>';
}

// ─── API ──────────────────────────────────────────────────────────────
function api(caminho, opts) {
  opts = opts || {};
  opts.headers = Object.assign(
    { 'Authorization': 'Bearer ' + token },
    opts.body ? { 'Content-Type': 'application/json' } : {},
    opts.headers || {});
  return fetch(caminho, opts).then(function (r) {
    if (r.status === 401) { localStorage.clear(); location.href = '/'; throw new Error('nao-autorizado'); }
    if (r.status === 403) { mostrarSemAcesso(); throw new Error('sem-acesso'); }
    return r.json().catch(function () { return {}; });
  });
}
function apiJson(caminho, metodo, corpo) {
  return api(caminho, { method: metodo, body: JSON.stringify(corpo || {}) });
}

// ─── Utilidades ───────────────────────────────────────────────────────
// Escapa para HTML **e para atributo**: o innerHTML sozinho não escapa aspas,
// e o padrão do painel injeta valor em atributo (data-dado="…", title="…").
// Um nome com aspas quebraria o atributo — e abriria porta para injeção.
function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(n) { return (Number(n) || 0).toLocaleString('pt-BR'); }
function brl(n) { return 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function usd(n) { return 'US$ ' + (Number(n) || 0).toFixed(2); }
function data(iso, comHora) {
  if (!iso) return '—';
  try {
    var d = new Date(iso);
    var s = d.toLocaleDateString('pt-BR');
    return comHora ? s + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : s;
  } catch (e) { return '—'; }
}
function desde(iso) {
  if (!iso) return '—';
  var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function mb(kb) {
  var n = Number(kb) || 0;
  return n > 1024 ? (n / 1024).toFixed(1) + ' MB' : n.toFixed(0) + ' KB';
}

// ─── Toast ────────────────────────────────────────────────────────────
function toast(msg, tipo) {
  var cx = document.getElementById('z-toasts');
  var el = document.createElement('div');
  el.className = 'z-toast ' + (tipo || '');
  el.innerHTML = (tipo ? '<span class="z-ponto"></span>' : '') + '<div>' + esc(msg) + '</div>';
  cx.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0'; el.style.transform = 'translateX(14px)';
    setTimeout(function () { el.remove(); }, 260);
  }, tipo === 'erro' ? 5200 : 3200);
}
function ok(m) { toast(m, 'ok'); }
function erro(m) { toast(m, 'erro'); }

// ─── Modal ────────────────────────────────────────────────────────────
var _modalFecha = null;
function modal(cfg) {
  // cfg: {icone, titulo, sub, chips[], corpo(html), pe(html), largo, aoAbrir(el)}
  var ov = document.getElementById('z-overlay');
  ov.innerHTML =
    '<div class="z-modal' + (cfg.largo ? ' largo' : '') + '">' +
      '<div class="z-modal-cab">' +
        (cfg.icone ? '<div class="z-cab-icone">' + svg(cfg.icone) + '</div>' : '') +
        '<div class="z-card-cab-txt">' +
          '<div class="z-modal-tit">' + (cfg.titulo || '') + '</div>' +
          (cfg.chips ? '<div class="z-item-chips" style="margin:7px 0 0">' + cfg.chips.join('') + '</div>' : '') +
          (cfg.sub ? '<div class="z-modal-sub">' + cfg.sub + '</div>' : '') +
        '</div>' +
        '<button class="z-fechar" data-fechar>&times;</button>' +
      '</div>' +
      '<div class="z-modal-corpo">' + (cfg.corpo || '') + '</div>' +
      (cfg.pe ? '<div class="z-modal-pe">' + cfg.pe + '</div>' : '') +
    '</div>';
  ov.classList.add('aberto');
  ov.querySelectorAll('[data-fechar]').forEach(function (b) { b.onclick = fecharModal; });
  ov.onclick = function (e) { if (e.target === ov) fecharModal(); };
  _modalFecha = cfg.aoFechar || null;
  if (cfg.aoAbrir) cfg.aoAbrir(ov.querySelector('.z-modal'));
  return ov.querySelector('.z-modal');
}
function fecharModal() {
  var ov = document.getElementById('z-overlay');
  ov.classList.remove('aberto'); ov.innerHTML = '';
  if (_modalFecha) { var f = _modalFecha; _modalFecha = null; f(); }
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fecharModal(); });

function confirmar(cfg) {
  // cfg: {titulo, texto, confirmar, perigo, aoConfirmar}
  modal({
    icone: cfg.perigo ? 'alerta' : 'check',
    titulo: cfg.titulo,
    corpo: '<p class="z-p">' + cfg.texto + '</p>',
    pe: '<button class="z-btn" data-fechar>Cancelar</button>' +
        '<button class="z-btn ' + (cfg.perigo ? 'perigo' : 'primario') + '" id="z-conf-ok">' +
        (cfg.confirmar || 'Confirmar') + '</button>',
    aoAbrir: function (m) {
      m.querySelector('#z-conf-ok').onclick = function () { fecharModal(); cfg.aoConfirmar(); };
    },
  });
}
function perguntar(cfg) {
  // cfg: {titulo, campos:[{id,rotulo,tipo,valor,dica,opcoes}], confirmar, aoConfirmar(vals)}
  var html = cfg.campos.map(function (c) {
    var ctrl;
    if (c.tipo === 'select') {
      ctrl = '<select class="z-in" id="zc-' + c.id + '">' +
        (c.opcoes || []).map(function (o) {
          return '<option value="' + esc(o.v) + '"' + (o.v === c.valor ? ' selected' : '') + '>' + esc(o.t) + '</option>';
        }).join('') + '</select>';
    } else if (c.tipo === 'textarea') {
      ctrl = '<textarea class="z-in" id="zc-' + c.id + '" rows="4">' + esc(c.valor || '') + '</textarea>';
    } else {
      ctrl = '<input class="z-in" id="zc-' + c.id + '" type="' + (c.tipo || 'text') + '" value="' +
             esc(c.valor || '') + '" placeholder="' + esc(c.dica || '') + '">';
    }
    return '<div style="margin-bottom:13px"><label class="z-lbl">' + esc(c.rotulo) + '</label>' + ctrl +
           (c.ajuda ? '<div class="z-dica">' + c.ajuda + '</div>' : '') + '</div>';
  }).join('');
  modal({
    icone: cfg.icone || 'config', titulo: cfg.titulo, sub: cfg.sub,
    corpo: html,
    pe: '<button class="z-btn" data-fechar>Cancelar</button>' +
        '<button class="z-btn primario" id="z-perg-ok">' + (cfg.confirmar || 'Salvar') + '</button>',
    aoAbrir: function (m) {
      var primeiro = m.querySelector('.z-in'); if (primeiro) primeiro.focus();
      m.querySelector('#z-perg-ok').onclick = function () {
        var vals = {};
        cfg.campos.forEach(function (c) { vals[c.id] = m.querySelector('#zc-' + c.id).value; });
        fecharModal(); cfg.aoConfirmar(vals);
      };
    },
  });
}

// ─── Componentes (as seções montam a tela com isto) ───────────────────
var C = {
  cab: function (o) {
    // {trilha, icone, titulo, sub, acoes:[html]}
    return '<div class="z-trilha">' + esc(o.trilha || '') + '</div>' +
      '<div class="z-cab">' +
        '<div class="z-cab-icone">' + svg(o.icone || 'config') + '</div>' +
        '<div class="z-cab-txt"><h1>' + esc(o.titulo) + '</h1>' +
          (o.sub ? '<p>' + o.sub + '</p>' : '') + '</div>' +
        (o.acoes && o.acoes.length ? '<div class="z-cab-acoes">' + o.acoes.join('') + '</div>' : '') +
      '</div>';
  },
  stat: function (o) {
    // {rot, num, cap, icone, tom:'ok|alerta|erro|acento', pequeno}
    return '<div class="z-stat ' + (o.tom || '') + '">' +
      '<div class="z-stat-topo"><div class="z-stat-rot">' + esc(o.rot) + '</div>' +
        (o.icone ? '<div class="z-stat-icone">' + svg(o.icone) + '</div>' : '') + '</div>' +
      '<div class="z-stat-num' + (o.pequeno ? ' pequeno' : '') + '">' + o.num + '</div>' +
      (o.cap ? '<div class="z-stat-cap">' + o.cap + '</div>' : '') +
    '</div>';
  },
  stats: function (lista) { return '<div class="z-stats">' + lista.map(C.stat).join('') + '</div>'; },
  card: function (o) {
    // {tit, sub, acoes:[html], corpo, rotulo}
    return '<div class="z-card"' + (o.id ? ' id="' + o.id + '"' : '') + '>' +
      (o.tit || o.acoes ? '<div class="z-card-cab"><div class="z-card-cab-txt">' +
        (o.tit ? '<div class="z-card-tit">' + esc(o.tit) + '</div>' : '') +
        (o.sub ? '<div class="z-card-sub">' + o.sub + '</div>' : '') +
      '</div>' + (o.acoes && o.acoes.length ? '<div class="z-card-acoes">' + o.acoes.join('') + '</div>' : '') +
      '</div>' : '') +
      (o.rotulo ? '<span class="z-rotulo">' + esc(o.rotulo) + '</span>' : '') +
      (o.corpo || '') + '</div>';
  },
  chip: function (texto, tom) { return '<span class="z-chip ' + (tom || '') + '">' + esc(texto) + '</span>'; },
  chipPonto: function (texto, tom) {
    return '<span class="z-chip ' + (tom || '') + '"><span class="z-ponto"></span>' + esc(texto) + '</span>';
  },
  btn: function (texto, o) {
    o = o || {};
    return '<button class="z-btn ' + (o.classe || '') + '"' + (o.id ? ' id="' + o.id + '"' : '') +
      (o.acao ? ' data-acao="' + o.acao + '"' : '') + (o.dado ? ' data-dado="' + esc(o.dado) + '"' : '') +
      (o.titulo ? ' title="' + esc(o.titulo) + '"' : '') + '>' +
      (o.icone ? svg(o.icone) : '') + esc(texto) + '</button>';
  },
  busca: function (id, dica) {
    return '<div class="z-busca">' + svg('busca') +
      '<input id="' + id + '" placeholder="' + esc(dica || 'Buscar…') + '"></div>';
  },
  vazio: function (o) {
    // {icone, tit, txt, acao}
    return '<div class="z-vazio ' + (o.tom || '') + '">' +
      '<div class="z-vazio-icone">' + svg(o.icone || 'caixa') + '</div>' +
      '<h3>' + esc(o.tit) + '</h3>' + (o.txt ? '<p>' + o.txt + '</p>' : '') +
      (o.acao || '') + '</div>';
  },
  banner: function (texto, tom) {
    return '<div class="z-banner ' + (tom || '') + '">' +
      (tom ? '<span class="z-ponto"></span>' : '') + '<div>' + texto + '</div></div>';
  },
  tabela: function (colunas, linhas, o) {
    o = o || {};
    if (!linhas.length) return C.vazio({ icone: o.icone || 'caixa', tit: o.vazioTit || 'Nada aqui ainda', txt: o.vazioTxt });
    return '<div class="z-tab-wrap"><table class="z-tab"><thead><tr>' +
      colunas.map(function (c) {
        return '<th' + (c.dir ? ' class="dir"' : '') + '>' + esc(c.t || c) + '</th>';
      }).join('') + '</tr></thead><tbody>' + linhas.join('') + '</tbody></table></div>';
  },
  abas: function (id, itens, ativo) {
    return '<div class="z-abas" id="' + id + '">' + itens.map(function (t) {
      return '<button class="z-aba' + (t.id === ativo ? ' ativo' : '') + '" data-aba="' + t.id + '">' +
        (t.icone ? svg(t.icone) : '') + esc(t.t) + '</button>';
    }).join('') + '</div>';
  },
  filtros: function (id, itens, ativo) {
    return '<div class="z-filtros" id="' + id + '">' + itens.map(function (f) {
      return '<button class="z-filtro' + (f.id === ativo ? ' ativo' : '') + '" data-filtro="' + f.id + '">' +
        esc(f.t) + (f.n != null ? '<span class="z-chip-cont">' + f.n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  },
  campo: function (o) {
    // {id, rotulo, tipo, valor, dica, ajuda, opcoes}
    var ctrl;
    if (o.tipo === 'select') {
      ctrl = '<select class="z-in" id="' + o.id + '">' + (o.opcoes || []).map(function (x) {
        return '<option value="' + esc(x.v) + '"' + (String(x.v) === String(o.valor) ? ' selected' : '') + '>' + esc(x.t) + '</option>';
      }).join('') + '</select>';
    } else if (o.tipo === 'textarea') {
      ctrl = '<textarea class="z-in" id="' + o.id + '" rows="' + (o.linhas || 5) + '" placeholder="' +
             esc(o.dica || '') + '">' + esc(o.valor || '') + '</textarea>';
    } else {
      ctrl = '<input class="z-in" id="' + o.id + '" type="' + (o.tipo || 'text') + '" value="' + esc(o.valor == null ? '' : o.valor) +
             '" placeholder="' + esc(o.dica || '') + '"' + (o.auto === false ? ' autocomplete="off"' : '') + '>';
    }
    return '<div class="z-campo"><label>' + o.rotulo + '</label>' + ctrl +
           (o.ajuda ? '<div class="z-dica">' + o.ajuda + '</div>' : '') + '</div>';
  },
  switch: function (id, texto, ligado) {
    return '<label class="z-switch"><input type="checkbox" id="' + id + '"' + (ligado ? ' checked' : '') + '>' +
      '<span class="z-trilho"></span><span>' + esc(texto) + '</span></label>';
  },
  carregando: function (txt) { return '<div class="z-carregando">' + esc(txt || 'Carregando…') + '</div>'; },
};

// ─── Navegação ────────────────────────────────────────────────────────
var NAV = [
  { grupo: 'Negócio', itens: [
    { id: 'visao',     t: 'Visão Geral',     icone: 'visao' },
    { id: 'clientes',  t: 'Clientes',        icone: 'clientes' },
    { id: 'receita',   t: 'Receita & Vendas',icone: 'receita' },
    { id: 'planos',    t: 'Planos & Créditos', icone: 'dinheiro' },
  ]},
  { grupo: 'Produto', itens: [
    { id: 'projetos',  t: 'Projetos',        icone: 'projetos' },
    { id: 'ia',        t: 'IA & Motor',      icone: 'ia' },
    { id: 'dominios',  t: 'Domínios',        icone: 'dominios' },
  ]},
  { grupo: 'Sistema', itens: [
    { id: 'email',     t: 'E-mail',          icone: 'email' },
    { id: 'aparencia', t: 'Aparência',       icone: 'aparencia' },
    { id: 'updates',   t: 'Atualizações',    icone: 'updates', selo: 'upd-selo' },
    { id: 'atividade', t: 'Atividade',       icone: 'atividade' },
    { id: 'servidor',  t: 'Servidor & Logs', icone: 'servidor' },
    { id: 'config',    t: 'Configurações',   icone: 'config' },
  ]},
];

var SECOES = {};
var atual = null;

function montarNav() {
  var html = NAV.map(function (g) {
    return '<div class="z-nav-grupo">' + g.grupo + '</div>' + g.itens.map(function (i) {
      return '<div class="z-nav-item" data-sec="' + i.id + '">' + svg(i.icone) +
        '<span class="z-nav-txt">' + i.t + '</span>' +
        (i.selo ? '<span class="z-nav-selo z-oculto" id="' + i.selo + '">novo</span>' : '') + '</div>';
    }).join('');
  }).join('');
  var nav = document.getElementById('z-nav');
  nav.innerHTML = html;
  nav.querySelectorAll('[data-sec]').forEach(function (el) {
    el.onclick = function () { irPara(el.getAttribute('data-sec')); };
  });
}

function irPara(id, silencioso) {
  if (!SECOES[id]) id = 'visao';
  atual = id;
  document.querySelectorAll('.z-nav-item').forEach(function (el) {
    el.classList.toggle('ativo', el.getAttribute('data-sec') === id);
  });
  var meta = null;
  NAV.forEach(function (g) { g.itens.forEach(function (i) { if (i.id === id) meta = i; }); });
  document.getElementById('z-top-titulo').textContent = meta ? meta.t : '';
  if (!silencioso && location.hash !== '#' + id) location.hash = id;
  var alvo = document.getElementById('z-conteudo');
  alvo.innerHTML = C.carregando();
  alvo.scrollTop = 0;
  document.getElementById('z-corpo').scrollTop = 0;
  try {
    var r = SECOES[id].render(alvo);
    if (r && r.catch) r.catch(function (e) { falhaSecao(alvo, e); });
  } catch (e) { falhaSecao(alvo, e); }
}
function falhaSecao(alvo, e) {
  console.error('[admin]', e);
  alvo.innerHTML = C.vazio({
    tom: 'erro', icone: 'alerta', tit: 'Não consegui carregar esta tela',
    txt: esc(e && e.message ? e.message : 'Erro inesperado.') + ' — se persistir, veja o console.',
    acao: C.btn('Tentar novamente', { classe: 'primario', id: 'z-retry' }),
  });
  var b = document.getElementById('z-retry'); if (b) b.onclick = function () { irPara(atual); };
}
function recarregar() { irPara(atual); }

function mostrarSemAcesso() {
  document.body.innerHTML =
    '<div style="height:100vh;display:grid;place-items:center;text-align:center;padding:24px">' +
    '<div><div style="font-size:34px;margin-bottom:10px">🔒</div>' +
    '<h2 style="font-size:19px;margin-bottom:6px">Acesso restrito</h2>' +
    '<p style="color:rgba(255,255,255,.45);font-size:13.5px;margin-bottom:18px">Esta área é só para administradores.</p>' +
    '<a href="/home.html" class="z-btn primario">Voltar ao Nascera</a></div></div>';
}

// ─── API pública para as seções ───────────────────────────────────────
window.ZAdmin = {
  api: api, apiJson: apiJson, C: C, svg: svg, ICO: ICO,
  esc: esc, num: num, brl: brl, usd: usd, data: data, desde: desde, mb: mb,
  toast: toast, ok: ok, erro: erro,
  modal: modal, fecharModal: fecharModal, confirmar: confirmar, perguntar: perguntar,
  irPara: irPara, recarregar: recarregar,
  registrar: function (id, sec) { SECOES[id] = sec; },
  // liga data-aba / data-filtro sem cada seção reimplementar
  ligarAbas: function (idBarra, aoTrocar) {
    var b = document.getElementById(idBarra); if (!b) return;
    b.querySelectorAll('[data-aba]').forEach(function (el) {
      el.onclick = function () {
        b.querySelectorAll('[data-aba]').forEach(function (x) { x.classList.remove('ativo'); });
        el.classList.add('ativo'); aoTrocar(el.getAttribute('data-aba'));
      };
    });
  },
  ligarFiltros: function (idBarra, aoTrocar) {
    var b = document.getElementById(idBarra); if (!b) return;
    b.querySelectorAll('[data-filtro]').forEach(function (el) {
      el.onclick = function () {
        b.querySelectorAll('[data-filtro]').forEach(function (x) { x.classList.remove('ativo'); });
        el.classList.add('ativo'); aoTrocar(el.getAttribute('data-filtro'));
      };
    });
  },
  // delega cliques por data-acao dentro de um container
  ligarAcoes: function (raiz, mapa) {
    var el = typeof raiz === 'string' ? document.getElementById(raiz) : raiz;
    if (!el) return;
    el.addEventListener('click', function (e) {
      var alvo = e.target.closest('[data-acao]');
      if (!alvo || !el.contains(alvo)) return;
      var fn = mapa[alvo.getAttribute('data-acao')];
      if (fn) { e.preventDefault(); fn(alvo.getAttribute('data-dado'), alvo); }
    });
  },
};

// ─── Boot ─────────────────────────────────────────────────────────────
function iniciar() {
  montarNav();
  var u = localStorage.getItem('nascera_user') || 'A';
  document.getElementById('z-avatar').textContent = u.slice(0, 2).toUpperCase();
  document.getElementById('z-avatar').title = u;
  document.getElementById('z-compactar').onclick = function () {
    document.body.classList.toggle('z-compacto');
    localStorage.setItem('nascera_admin_compacto', document.body.classList.contains('z-compacto') ? '1' : '');
  };
  if (localStorage.getItem('nascera_admin_compacto')) document.body.classList.add('z-compacto');
  document.getElementById('z-recarregar').onclick = recarregar;
  window.addEventListener('hashchange', function () { irPara(location.hash.slice(1), true); });
  irPara(location.hash.slice(1) || 'visao', true);
  // selo de atualização disponível
  api('/api/admin/update/check').then(function (d) {
    if (d && d.temNova) { var s = document.getElementById('upd-selo'); if (s) s.classList.remove('z-oculto'); }
  }).catch(function () {});
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
else iniciar();

})();
