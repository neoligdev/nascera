/* ═══ NASCERA ADMIN v2 — APARÊNCIA ══════════════════════════════════════
   A cara do sistema: cores, vídeo de fundo, imagens e formas. Tudo o que
   é mexido aqui vira /theme.css na próxima requisição — nenhum arquivo
   precisa ser editado.

   A prévia é feita ESCREVENDO as variáveis --zh-* no :root desta página.
   Como o painel consome exatamente as mesmas variáveis do resto do NASCERA,
   o que aparece aqui é o que o cliente vai ver. Nada é salvo até o dono
   mandar salvar — e ao trocar de tela a prévia é desfeita.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var HEX = /^#[0-9a-fA-F]{6}$/;
var MAX_UPLOAD = 5 * 1024 * 1024;

var COR = [
  { k: 'accent',  rot: 'Destaque principal', dica: 'Botões, foco e brilhos — a cor da marca' },
  { k: 'accent2', rot: 'Destaque claro',     dica: 'Links, ícones e textos de realce' },
  { k: 'grad1',   rot: 'Gradiente — início', dica: 'A ponta rosa dos títulos grandes' },
  { k: 'grad2',   rot: 'Gradiente — fim',    dica: 'A ponta azul dos títulos grandes' },
  { k: 'bg',      rot: 'Fundo',              dica: 'O preto profundo por trás de tudo' },
  { k: 'surface', rot: 'Superfície',         dica: 'Cartões, barras e painéis' },
  { k: 'text',    rot: 'Texto',              dica: 'A cor base da tipografia' },
  { k: 'success', rot: 'Sucesso',            dica: 'Confirmações e status positivo' },
  { k: 'danger',  rot: 'Erro',               dica: 'Falhas, remoções e bloqueios' },
  { k: 'warning', rot: 'Atenção',            dica: 'Avisos e limites chegando perto' },
  { k: 'info',    rot: 'Informação',         dica: 'Dicas e estados neutros' },
];

var VIDEO = [
  { k: 'hue',        rot: 'Matiz',      min: -180, max: 180, un: '°',  dica: 'Gira a roda de cores — é o que troca o roxo por outra cor' },
  { k: 'saturation', rot: 'Saturação',  min: 0,    max: 300, un: '%',  dica: '0 deixa em preto e branco' },
  { k: 'brightness', rot: 'Brilho',     min: 0,    max: 200, un: '%',  dica: '' },
  { k: 'contrast',   rot: 'Contraste',  min: 0,    max: 200, un: '%',  dica: '' },
  { k: 'blur',       rot: 'Desfoque',   min: 0,    max: 20,  un: 'px', dica: 'Borra o vídeo para o texto respirar por cima' },
  { k: 'opacity',    rot: 'Opacidade',  min: 0,    max: 100, un: '%',  dica: 'Quanto do vídeo aparece por trás do conteúdo' },
];

var IMGS = [
  { k: 'logo',       rot: 'Logotipo',              icone: 'aparencia', dica: 'Aparece no topo da barra lateral e no login' },
  { k: 'favicon',    rot: 'Favicon',               icone: 'link',      dica: 'O ícone da aba do navegador' },
  { k: 'heroSkills', rot: 'Fundo de Skills',       icone: 'raio',      dica: 'Imagem do topo das páginas de skills e ferramentas' },
  { k: 'loading',    rot: 'Fundo de carregamento', icone: 'relogio',   dica: 'O que o cliente vê enquanto o projeto abre' },
];

var FORMA = [
  { k: 'radius', rot: 'Arredondamento dos cartões', min: 0, max: 40,  un: 'px', dica: '0 deixa tudo quadrado; 40 arredonda bastante' },
  { k: 'glow',   rot: 'Intensidade dos brilhos',    min: 0, max: 200, un: '%',  dica: 'Os halos coloridos por trás dos elementos' },
];

var tema = null;

Z.registrar('aparencia', {
  render: function (alvo) {
    limparPreview();
    return Z.api('/api/admin/theme').then(function (d) {
      d = d || {};
      if (d.error || (!d.theme && !d.defaults)) {
        alvo.innerHTML = raiz(cabecalho() + C.vazio({
          tom: 'erro', icone: 'alerta', tit: 'Não consegui ler a aparência atual',
          txt: Z.esc(d.error || 'O servidor não devolveu o tema.') + ' Nada foi alterado.',
          acao: C.btn('Tentar de novo', { classe: 'primario', acao: 'recarregar' }),
        }));
        Z.ligarAcoes('ap-raiz', { 'recarregar': function () { Z.recarregar(); } });
        return;
      }

      var t = d.theme || {}, p = d.defaults || {};
      tema = {
        colors: mesclar(p.colors, t.colors),
        video:  mesclar(p.video,  t.video),
        images: mesclar(p.images, t.images),
        ui:     mesclar(p.ui,     t.ui),
      };

      var html = cabecalho();

      html += C.banner(
        'O que você mexe aqui é aplicado <b>só nesta tela</b> como prévia. Quando clicar em ' +
        '<b>Salvar aparência</b>, vale para todo o sistema e para todos os seus clientes na hora.', 'info');

      // ── Cores ──
      html += '<span class="z-rotulo">Cores</span>';
      html += C.card({ corpo: '<div class="z-campos">' + COR.map(campoCor).join('') + '</div>' });

      // ── Vídeo de fundo ──
      html += '<span class="z-rotulo" style="margin-top:22px">Vídeo de fundo</span>';
      html += C.card({
        tit: 'O vídeo do buraco negro',
        sub: 'Ele é recolorido por filtro — o arquivo nunca é reprocessado, então dá para testar à vontade. A faixa abaixo mostra o efeito na hora.',
        corpo:
          '<div id="ap-amostra" style="height:72px;border-radius:11px;margin-bottom:16px;' +
            'background:linear-gradient(115deg,var(--z-acc),var(--z-acc2) 55%,#FFDF9C);' +
            'transition:filter .18s var(--z-ease),opacity .18s var(--z-ease)"></div>' +
          '<div class="z-mb">' + C.switch('ap-video-on', 'Mostrar o vídeo de fundo para os clientes', !!tema.video.enabled) + '</div>' +
          '<div class="z-sep"></div>' +
          '<div class="z-grid2">' + VIDEO.map(function (c) { return controle('vid', c, tema.video[c.k]); }).join('') + '</div>',
      });

      // ── Imagens ──
      html += '<span class="z-rotulo" style="margin-top:22px">Imagens</span>';
      html += '<div class="z-grade">' + IMGS.map(cartaoImagem).join('') + '</div>';
      html += '<div class="z-dica" style="margin-top:10px">PNG, JPG, WEBP, GIF ou ICO — até 5 MB. ' +
              'O arquivo antigo é apagado do servidor assim que o novo entra.</div>';

      // ── Formas ──
      html += '<span class="z-rotulo" style="margin-top:22px">Formas</span>';
      html += C.card({
        tit: 'Cantos e brilhos',
        sub: 'Valem para as telas do cliente — o painel admin tem forma própria e não muda com isto.',
        corpo: '<div class="z-grid2">' + FORMA.map(function (c) { return controle('ui', c, tema.ui[c.k]); }).join('') + '</div>',
      });

      // ── Barra de ações ──
      html += '<div class="z-card" style="margin-top:22px"><div class="z-linha entre">' +
        '<div style="min-width:220px"><div class="z-card-tit">Pronto para valer para todo mundo?</div>' +
        '<div class="z-card-sub">Salvar aplica a aparência em todas as telas na hora. Restaurar volta o NASCERA de fábrica.</div></div>' +
        '<div class="z-linha">' +
          C.btn('Restaurar padrão', { classe: 'perigo', icone: 'atualiza', acao: 'restaurar' }) +
          C.btn('Salvar aparência', { classe: 'primario', icone: 'check', acao: 'salvar' }) +
        '</div></div></div>';

      html += '<input type="file" id="ap-arquivo" accept="image/*" class="z-oculto">';

      alvo.innerHTML = raiz(html);
      ligarCores();
      ligarControles();
      pintarImagens();
      aplicarPreview();

      Z.ligarAcoes('ap-raiz', {
        'salvar': salvar,
        'restaurar': restaurar,
        'trocar-img': function (chave) { escolherImagem(chave); },
        'recarregar': function () { Z.recarregar(); },
      });
    });
  },
});

// O #z-conteudo é o MESMO elemento entre telas — só o innerHTML troca. Se a
// gente pendurasse os cliques nele, cada visita empilharia mais um ouvinte e
// um clique em "Salvar" viraria três PUT. Esta raiz nasce a cada render, então
// os ouvintes antigos morrem junto com ela.
function raiz(html) { return '<div id="ap-raiz">' + html + '</div>'; }

// ─── Cabeçalho ───────────────────────────────────────────────────────
function cabecalho() {
  return C.cab({
    trilha: 'Sistema · Identidade visual',
    icone: 'aparencia',
    titulo: 'Aparência',
    sub: 'As cores, o vídeo de fundo e as imagens que seus clientes veem. Mexa aqui e o sistema inteiro muda — sem editar arquivo nenhum.',
    acoes: [
      C.btn('Restaurar padrão', { acao: 'restaurar' }),
      C.btn('Salvar aparência', { classe: 'primario', icone: 'check', acao: 'salvar' }),
    ],
  });
}

// ─── Pedaços de tela ─────────────────────────────────────────────────
function campoCor(c) {
  var v = String((tema.colors && tema.colors[c.k]) || '#000000');
  if (!HEX.test(v)) v = '#000000';
  return '<div class="z-campo"><label>' + Z.esc(c.rot) + '</label>' +
    '<div class="z-linha" style="gap:9px;flex-wrap:nowrap">' +
      '<input type="color" id="ap-cor-' + c.k + '" value="' + Z.esc(v) + '" ' +
        'title="' + Z.esc(c.rot) + '" ' +
        'style="width:42px;height:36px;flex-shrink:0;padding:3px;border-radius:9px;' +
        'background:rgba(0,0,0,.28);border:1px solid var(--z-line);cursor:pointer">' +
      '<input class="z-in z-mono" type="text" id="ap-hex-' + c.k + '" value="' + Z.esc(v) + '" ' +
        'spellcheck="false" maxlength="7" style="flex:1;min-width:0">' +
    '</div>' +
    '<div class="z-dica">' + Z.esc(c.dica) + '</div></div>';
}

function controle(pre, c, valor) {
  var id = 'ap-' + pre + '-' + c.k;
  var v = Number(valor) || 0;
  return '<div>' +
    '<div class="z-linha entre" style="margin-bottom:7px">' +
      '<span class="z-fg2" style="font-size:12px">' + Z.esc(c.rot) + '</span>' +
      '<span class="z-mono" id="' + id + '-val" style="color:var(--z-acc2)">' + v + c.un + '</span>' +
    '</div>' +
    '<input type="range" id="' + id + '" min="' + c.min + '" max="' + c.max + '" value="' + v + '" ' +
      'style="width:100%;accent-color:var(--z-acc);cursor:pointer">' +
    (c.dica ? '<div class="z-dica">' + Z.esc(c.dica) + '</div>' : '') +
  '</div>';
}

function cartaoImagem(c) {
  return '<div class="z-item" data-acao="trocar-img" data-dado="' + c.k + '" title="Clique para trocar">' +
    '<div style="height:94px;border-radius:10px;margin-bottom:12px;background:rgba(0,0,0,.32);' +
      'border:1px solid var(--z-line-soft);display:grid;place-items:center;overflow:hidden">' +
      '<img id="ap-img-' + c.k + '" alt="" style="max-width:100%;max-height:100%;object-fit:contain">' +
    '</div>' +
    '<div class="z-item-cab">' +
      '<div class="z-item-icone">' + Z.svg(c.icone) + '</div>' +
      '<div style="min-width:0"><div class="z-item-tit">' + Z.esc(c.rot) + '</div></div>' +
    '</div>' +
    '<div class="z-item-desc">' + Z.esc(c.dica) + '</div>' +
    '<div class="z-mono z-fg3" id="ap-cam-' + c.k + '" style="margin-top:9px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap"></div>' +
    '<div class="z-mt">' + C.btn('Trocar imagem', { classe: 'mini', icone: 'enviar', id: 'ap-btn-' + c.k }) + '</div>' +
  '</div>';
}

// ─── Ligações ────────────────────────────────────────────────────────
function ligarCores() {
  COR.forEach(function (c) {
    var picker = document.getElementById('ap-cor-' + c.k);
    var texto  = document.getElementById('ap-hex-' + c.k);
    if (!picker || !texto) return;
    picker.oninput = function () {
      tema.colors[c.k] = picker.value.toLowerCase();
      texto.value = tema.colors[c.k];
      aplicarPreview();
    };
    texto.onchange = function () {
      var v = String(texto.value || '').trim().toLowerCase();
      if (v.charAt(0) !== '#') v = '#' + v;
      if (!HEX.test(v)) {
        Z.erro('A cor "' + c.rot + '" precisa estar no formato #rrggbb — ex.: #99FF00.');
        texto.value = tema.colors[c.k];
        return;
      }
      tema.colors[c.k] = v;
      texto.value = v;
      picker.value = v;
      aplicarPreview();
    };
  });
}

function ligarControles() {
  VIDEO.forEach(function (c) { ligarSlider('vid', c, tema.video); });
  FORMA.forEach(function (c) { ligarSlider('ui', c, tema.ui); });
  var sw = document.getElementById('ap-video-on');
  if (sw) sw.onchange = function () { tema.video.enabled = sw.checked; aplicarPreview(); };
}

function ligarSlider(pre, c, alvoObj) {
  var id = 'ap-' + pre + '-' + c.k;
  var el = document.getElementById(id), val = document.getElementById(id + '-val');
  if (!el) return;
  el.oninput = function () {
    alvoObj[c.k] = parseFloat(el.value);
    if (val) val.textContent = el.value + c.un;
    aplicarPreview();
  };
}

// ─── Imagens ─────────────────────────────────────────────────────────
function pintarImagens() {
  IMGS.forEach(function (c) {
    var url = String((tema.images && tema.images[c.k]) || '');
    var img = document.getElementById('ap-img-' + c.k);
    // src vazio faria o navegador pedir a própria página — só mexe se tem URL.
    if (img && url) { img.src = url; img.style.display = ''; }
    else if (img) { img.style.display = 'none'; }
    var cam = document.getElementById('ap-cam-' + c.k);
    if (cam) cam.textContent = url || 'sem imagem';
  });
}

function escolherImagem(chave) {
  var inp = document.getElementById('ap-arquivo');
  if (!inp) return;
  inp.value = '';
  inp.onchange = function () { if (inp.files && inp.files[0]) enviarImagem(chave, inp.files[0]); };
  inp.click();
}

// O arquivo vai CRU no corpo do POST (sem multipart, sem base64): o servidor
// confere os bytes, grava em /uploads e devolve o tema já salvo.
function enviarImagem(chave, arquivo) {
  if (arquivo.size > MAX_UPLOAD) { Z.erro('Imagem muito grande — o limite é 5 MB.'); return; }
  var btn = document.getElementById('ap-btn-' + chave);
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  var devolver = function () {
    if (btn) { btn.disabled = false; btn.innerHTML = Z.svg('enviar') + 'Trocar imagem'; }
  };
  Z.api('/api/admin/theme/upload/' + encodeURIComponent(chave), {
    method: 'POST',
    body: arquivo,
    headers: { 'Content-Type': arquivo.type || 'application/octet-stream' },
  }).then(function (d) {
    devolver();
    if (!d || d.error) { Z.erro((d && d.error) || 'Não deu para enviar a imagem.'); return; }
    if (d.theme && d.theme.images) tema.images = mesclar(tema.images, d.theme.images);
    pintarImagens();
    atualizarMarca();
    Z.ok('Imagem enviada e já salva — as outras mudanças desta tela continuam esperando o Salvar.');
  }).catch(function () {
    devolver();
    Z.erro('Não deu para enviar a imagem. Tente de novo.');
  });
}

// ─── Prévia ao vivo ──────────────────────────────────────────────────
function aplicarPreview() {
  if (!tema) return;
  var raiz = document.documentElement.style;
  COR.forEach(function (c) {
    var v = tema.colors[c.k];
    if (!HEX.test(String(v))) return;
    raiz.setProperty('--zh-' + c.k, v);
    raiz.setProperty('--zh-' + c.k + '-rgb', hexRgb(v));
  });
  raiz.setProperty('--zh-radius', (Number(tema.ui.radius) || 0) + 'px');
  raiz.setProperty('--zh-glow', String((Number(tema.ui.glow) || 0) / 100));

  var am = document.getElementById('ap-amostra');
  if (am) {
    var v = tema.video;
    var f = [
      v.hue ? 'hue-rotate(' + v.hue + 'deg)' : '',
      Number(v.saturation) !== 100 ? 'saturate(' + v.saturation + '%)' : '',
      Number(v.brightness) !== 100 ? 'brightness(' + v.brightness + '%)' : '',
      Number(v.contrast) !== 100 ? 'contrast(' + v.contrast + '%)' : '',
      v.blur ? 'blur(' + v.blur + 'px)' : '',
    ].filter(Boolean).join(' ') || 'none';
    am.style.filter = f;
    am.style.opacity = v.enabled ? (Number(v.opacity) || 0) / 100 : 0.08;
  }
}

// Se o dono mexeu, não salvou e foi para outra tela, a prévia não pode viajar
// junto — o painel inteiro ficaria com uma cor que não é a do sistema.
window.addEventListener('hashchange', function () {
  if (location.hash.slice(1) !== 'aparencia') limparPreview();
});

function limparPreview() {
  var raiz = document.documentElement.style;
  COR.forEach(function (c) {
    raiz.removeProperty('--zh-' + c.k);
    raiz.removeProperty('--zh-' + c.k + '-rgb');
  });
  raiz.removeProperty('--zh-radius');
  raiz.removeProperty('--zh-glow');
}

// ─── Salvar / restaurar ──────────────────────────────────────────────
function salvar() {
  for (var i = 0; i < COR.length; i++) {
    if (!HEX.test(String(tema.colors[COR[i].k]))) {
      Z.erro('A cor "' + COR[i].rot + '" está fora do formato #rrggbb. Corrija antes de salvar.');
      return;
    }
  }
  Z.apiJson('/api/admin/theme', 'PUT', {
    colors: tema.colors, video: tema.video, images: tema.images, ui: tema.ui,
  }).then(function (r) {
    if (!r || r.error) { Z.erro((r && r.error) || 'Não deu para salvar a aparência.'); return; }
    if (r.theme) tema = r.theme;
    limparPreview();
    recarregarCss();
    atualizarMarca();
    Z.ok('Aparência salva. Todo o sistema já está com a cara nova.');
    Z.recarregar();
  }).catch(function () {
    Z.erro('Não deu para salvar a aparência. Tente de novo.');
  });
}

function restaurar() {
  Z.confirmar({
    titulo: 'Voltar a aparência de fábrica?',
    texto: 'As cores, o vídeo, as imagens e as formas voltam ao padrão do NASCERA. ' +
           'As imagens que você enviou são apagadas do servidor — isso não tem desfazer.',
    confirmar: 'Restaurar padrão',
    perigo: true,
    aoConfirmar: function () {
      Z.api('/api/admin/theme/reset', { method: 'POST' }).then(function (r) {
        if (!r || r.error) { Z.erro((r && r.error) || 'Não deu para restaurar a aparência.'); return; }
        if (r.theme) tema = r.theme;
        limparPreview();
        recarregarCss();
        atualizarMarca();
        Z.ok('Aparência restaurada ao padrão do NASCERA.');
        Z.recarregar();
      }).catch(function () {
        Z.erro('Não deu para restaurar a aparência. Tente de novo.');
      });
    },
  });
}

// O /theme.css é gerado pelo servidor: trocar o href com ?v= faz o painel
// já mostrar o tema novo sem F5.
function recarregarCss() {
  var l = document.querySelector('link[href*="theme.css"]');
  if (l) l.href = '/theme.css?v=' + Date.now();
}

// A logo da barra lateral e o favicon estão cravados no HTML — depois de
// trocar a imagem, eles precisam apontar para o arquivo novo sem F5.
function atualizarMarca() {
  if (!tema || !tema.images) return;
  var img = document.querySelector('.z-marca img');
  if (img && tema.images.logo) img.src = tema.images.logo;
  var fav = document.querySelector('link[rel~="icon"]');
  if (fav && tema.images.favicon) fav.href = tema.images.favicon;
}

// ─── Utilidades ──────────────────────────────────────────────────────
function mesclar(base, novo) {
  var o = {}, k;
  base = base || {}; novo = novo || {};
  for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
  for (k in novo) if (Object.prototype.hasOwnProperty.call(novo, k) && novo[k] !== undefined) o[k] = novo[k];
  return o;
}
function hexRgb(hex) {
  var h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].join(',');
}
})();
