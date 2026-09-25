/* ═══ NASCERA ADMIN v2 — SERVIDOR & LOGS ═══════════════════════════════
   A máquina que hospeda tudo: como ela está agora, o botão de reiniciar
   (com o aviso do que isso custa) e os logs para entender o que aconteceu.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

var LOGS = {};      // { 'arquivo.log': 'conteúdo…' }
var ATIVO = '';     // arquivo mostrado agora

Z.registrar('servidor', {
  render: function (alvo) {
    return Promise.all([
      Z.api('/api/admin/overview').catch(function () { return {}; }),
      Z.api('/api/admin/logs').catch(function () { return {}; }),
      lerMetricas(),
    ]).then(function (r) {
      var o = r[0] || {}, logs = r[1] || {}, met = r[2] || {};
      var sis = o.system || {}, motor = o.engine || {};

      if (logs.error) { Z.erro(logs.error); logs = {}; }
      LOGS = {};
      Object.keys(logs).forEach(function (k) {
        if (typeof logs[k] === 'string') LOGS[k] = logs[k];
      });

      var ativas = met.nascera_sessoes_ativas != null ? met.nascera_sessoes_ativas : (motor.sessions || 0);
      var teto = met.nascera_sessoes_limite != null ? met.nascera_sessoes_limite : 0;
      var lag = met.nascera_event_loop_lag_ms || 0;
      var carga = (sis.loadAvg || [])[0];
      var rssMb = met.nascera_memoria_rss_bytes ? Math.round(met.nascera_memoria_rss_bytes / 1048576) : (sis.memoryMb || 0);
      var heapMb = met.nascera_memoria_heap_bytes ? Math.round(met.nascera_memoria_heap_bytes / 1048576) : 0;

      var html = C.cab({
        trilha: 'Sistema · A máquina',
        icone: 'servidor',
        titulo: 'Servidor & Logs',
        sub: 'Como o servidor está se comportando neste momento e o que ele andou escrevendo. É aqui que você olha quando alguém diz que "o Nascera travou".',
        acoes: [
          C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' }),
          C.btn('Reiniciar', { classe: 'perigo', icone: 'raio', acao: 'reiniciar' }),
        ],
      });

      // ── Como está agora ──
      html += '<span class="z-rotulo">Como está agora</span>';
      html += C.stats([
        { rot: 'No ar há', num: tempoDeVida(sis.uptimeSec || met.nascera_uptime_segundos),
          cap: 'Desde o último reinício', icone: 'relogio' },
        { rot: 'Memória em uso', num: Z.num(rssMb) + ' MB',
          cap: heapMb ? 'Sendo ' + Z.num(heapMb) + ' MB de heap' : 'Memória residente do processo', icone: 'caixa' },
        { rot: 'Sessões de IA', num: Z.num(ativas) + (teto ? ' / ' + Z.num(teto) : ''),
          cap: teto ? (motor.running || 0) + ' trabalhando · teto de ' + Z.num(teto) : (motor.running || 0) + ' trabalhando agora',
          icone: 'ia', tom: tomSessoes(ativas, teto) },
        { rot: 'Carga da máquina', num: carga == null ? '—' : Number(carga).toFixed(2),
          cap: (sis.loadAvg || []).length ? 'Média de 1 · 5 · 15 min: ' + sis.loadAvg.join(' · ') : 'Indisponível nesta plataforma',
          icone: 'atividade' },
      ]);

      html += '<div class="z-grid2" style="margin-top:22px">';

      // ── Ficha técnica ──
      html += C.card({
        tit: 'Ficha técnica', sub: 'O que está rodando por baixo',
        corpo: '<div class="z-col" style="gap:7px">' +
          linha('Plataforma', Z.esc(sis.platform || '—')) +
          linha('Node', Z.esc(sis.nodeVersion || '—')) +
          linha('Porta', '<span class="z-mono">' + Z.esc(sis.port || '—') + '</span>') +
          linha('Atraso do event loop', chipLag(lag)) +
          linha('Projetos no disco', Z.num((o.projects || {}).diskMb) + ' MB') +
        '</div>',
      });

      // ── Métricas cruas ──
      var chaves = Object.keys(met);
      html += C.card({
        tit: 'Métricas do processo', sub: 'Os mesmos números que um monitor externo leria em /api/metrics',
        corpo: chaves.length
          ? '<div class="z-col" style="gap:7px">' + chaves.map(function (k) {
              return linha(Z.esc(rotuloMetrica(k)), valorMetrica(k, met[k]));
            }).join('') + '</div>'
          : C.vazio({ icone: 'atividade', tit: 'Sem métricas agora',
              txt: 'A rota <span class="z-mono">/api/metrics</span> não respondeu. Isso não derruba o Nascera — só deixa o monitoramento cego.' }),
      });
      html += '</div>';

      // ── Manutenção ──
      html += '<span class="z-rotulo" style="margin-top:22px">Manutenção</span>';
      var avisoExtra = (motor.running > 0)
        ? C.banner('<b>Tem ' + Z.num(motor.running) + ' build rodando agora.</b> Se reiniciar neste instante, esse trabalho é perdido no meio.', 'erro')
        : '';
      html += C.card({
        tit: 'Reiniciar o servidor', sub: 'O caminho mais curto para destravar — e o que ele cobra por isso',
        corpo: avisoExtra +
          C.banner('<b>Todas as sessões de IA caem.</b> Quem estiver conversando com o Nascera perde o build em andamento e precisa mandar a mensagem de novo. Nada do que já foi salvo se perde: projetos, versões e arquivos ficam intactos.', 'alerta') +
          '<p class="z-p">O servidor volta sozinho em poucos segundos — o supervisor (pm2) reergue o processo. Use quando o sistema estiver lento, engasgado ou depois de trocar alguma configuração que só vale no boot.</p>' +
          '<div class="z-linha" style="justify-content:flex-end;margin-top:15px">' +
            C.btn('Reiniciar o servidor', { classe: 'perigo', icone: 'raio', acao: 'reiniciar' }) +
          '</div>',
      });

      // ── Logs ──
      html += '<span class="z-rotulo" style="margin-top:22px">Logs</span>';
      html += C.card({
        tit: 'O que o servidor andou escrevendo',
        sub: 'As últimas linhas de cada arquivo, do mais antigo (topo) ao mais recente (fim). Linhas de erro vêm em vermelho.',
        acoes: [
          C.btn('Baixar', { classe: 'mini', icone: 'baixar', acao: 'baixar-log' }),
          C.btn('Atualizar', { classe: 'mini', icone: 'atualiza', acao: 'atualizar-logs' }),
        ],
        corpo: '<div id="z-logs-corpo">' + htmlLogs() + '</div>',
      });

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="sv-raiz">' + html + '</div>';
      ligarFiltrosLog();
      rolarParaOFim();

      Z.ligarAcoes('sv-raiz', {
        'recarregar': function () { Z.recarregar(); },
        'reiniciar': pedirReinicio,
        'atualizar-logs': function (_d, el) {
          var voltar = ocupado(el, 'Buscando…');
          Z.api('/api/admin/logs').then(function (d) {
            voltar();
            if (d && d.error) return Z.erro(d.error);
            LOGS = {};
            Object.keys(d || {}).forEach(function (k) { if (typeof d[k] === 'string') LOGS[k] = d[k]; });
            var cx = document.getElementById('z-logs-corpo');
            if (cx) { cx.innerHTML = htmlLogs(); ligarFiltrosLog(); rolarParaOFim(); }
            Z.toast('Logs atualizados.');
          }).catch(function () { voltar(); Z.erro('Não consegui ler os logs agora.'); });
        },
        'baixar-log': function () {
          var texto = LOGS[ATIVO] || '';
          if (!texto.trim()) return Z.erro('Este arquivo está vazio — não há o que baixar.');
          baixarArquivo(ATIVO || 'nascera.log', texto);
          Z.ok('Arquivo salvo no seu computador.');
        },
      });
    });
  },
});

// ─── Reinício ────────────────────────────────────────────────────────
function pedirReinicio() {
  Z.confirmar({
    titulo: 'Reiniciar o servidor agora?',
    perigo: true,
    confirmar: 'Reiniciar mesmo assim',
    texto: 'As sessões de IA abertas caem na hora e os builds em andamento são perdidos — quem estava conversando vai precisar repetir a última mensagem. ' +
           'Projetos, versões e arquivos publicados não são afetados. O servidor volta sozinho em alguns segundos.',
    aoConfirmar: function () {
      Z.apiJson('/api/admin/restart', 'POST').then(function (d) {
        if (d && d.error) return Z.erro(d.error);
        Z.toast('Reiniciando… o servidor volta em alguns segundos.');
        esperarVoltar(0);
      }).catch(function () {
        // A conexão cai junto com o processo: isso é o esperado, não um erro.
        Z.toast('Reiniciando… o servidor volta em alguns segundos.');
        esperarVoltar(0);
      });
    },
  });
}

function esperarVoltar(tentativa) {
  if (tentativa > 20) {
    Z.erro('O servidor ainda não respondeu. Atualize a página em instantes — se continuar fora, veja o supervisor (pm2) na máquina.');
    return;
  }
  setTimeout(function () {
    fetch('/api/health', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('fora');
      Z.ok('Servidor de volta no ar.');
      Z.recarregar();
    }).catch(function () { esperarVoltar(tentativa + 1); });
  }, 2000);
}

// ─── Logs ────────────────────────────────────────────────────────────
function htmlLogs() {
  var arquivos = Object.keys(LOGS);
  if (!arquivos.length) {
    return C.vazio({
      icone: 'codigo', tit: 'Nenhum arquivo de log encontrado',
      txt: 'O Nascera procura os logs do supervisor em <span class="z-mono">~/.pm2/logs</span>. Se você roda o servidor de outro jeito (direto pelo terminal, por exemplo), é normal não aparecer nada aqui.',
    });
  }
  if (arquivos.indexOf(ATIVO) < 0) ATIVO = arquivos[0];

  var filtros = C.filtros('z-log-filtros', arquivos.map(function (f) {
    return { id: f, t: rotuloArquivo(f), n: contarLinhas(LOGS[f]) };
  }), ATIVO);

  var texto = LOGS[ATIVO] || '';
  if (!texto.trim()) {
    return filtros + C.vazio({
      icone: 'check', tit: 'Este arquivo está vazio',
      txt: 'Nada foi escrito em <span class="z-mono">' + Z.esc(ATIVO) + '</span> até agora — o que costuma ser uma ótima notícia quando é o arquivo de erros.',
    });
  }

  return filtros +
    '<pre id="z-log-pre" class="z-mono" style="background:rgba(0,0,0,.34);border:1px solid var(--z-line);' +
      'border-radius:10px;padding:14px 16px;max-height:420px;overflow:auto;white-space:pre-wrap;' +
      'word-break:break-word;line-height:1.65;color:var(--z-fg-2);margin:0">' + pintarLinhas(texto) + '</pre>' +
    '<div class="z-dica">Últimas ' + contarLinhas(texto) + ' linha(s) de <span class="z-mono">' + Z.esc(ATIVO) +
      '</span>. O arquivo completo continua na máquina — aqui vem só o fim dele.</div>';
}

function ligarFiltrosLog() {
  Z.ligarFiltros('z-log-filtros', function (id) {
    ATIVO = id;
    var cx = document.getElementById('z-logs-corpo');
    if (!cx) return;
    cx.innerHTML = htmlLogs();
    ligarFiltrosLog();
    rolarParaOFim();
  });
}

function rolarParaOFim() {
  var p = document.getElementById('z-log-pre');
  if (p) p.scrollTop = p.scrollHeight;
}

// Erro em vermelho, aviso em âmbar: encontrar o problema no meio de 80 linhas
// de texto cinza é metade do trabalho.
function pintarLinhas(txt) {
  return String(txt || '').replace(/\s+$/, '').split('\n').map(function (l) {
    var e = Z.esc(l);
    if (/erro|error|falh|fail|exception|refus|ECONN|EADDR/i.test(l)) return '<span style="color:var(--z-err)">' + e + '</span>';
    if (/aviso|warn|alerta|deprecat/i.test(l)) return '<span style="color:var(--z-warn)">' + e + '</span>';
    return e;
  }).join('\n');
}

function contarLinhas(t) {
  var s = String(t || '').replace(/\s+$/, '');
  return s ? s.split('\n').length : 0;
}

function rotuloArquivo(f) {
  if (/error|err/i.test(f)) return 'Erros';
  if (/out|access/i.test(f)) return 'Saída normal';
  return f.replace(/\.log$/i, '');
}

function baixarArquivo(nome, texto) {
  try {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  } catch (e) { Z.erro('Não consegui salvar o arquivo neste navegador.'); }
}

// ─── Métricas (texto Prometheus → objeto) ────────────────────────────
function lerMetricas() {
  return fetch('/api/metrics', {
    cache: 'no-store',
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('nascera_token') || '') },
  }).then(function (r) { return r.text(); }).then(function (txt) {
    var m = {};
    String(txt || '').split('\n').forEach(function (l) {
      l = l.trim();
      if (!l || l.charAt(0) === '#') return;
      var i = l.lastIndexOf(' ');
      if (i < 1) return;
      var chave = l.slice(0, i).trim();
      var valor = parseFloat(l.slice(i + 1));
      if (chave && !isNaN(valor)) m[chave] = valor;
    });
    return m;
  }).catch(function () { return {}; });
}

var ROTULO_METRICA = {
  nascera_uptime_segundos: 'Tempo de vida do processo',
  nascera_memoria_heap_bytes: 'Heap em uso',
  nascera_memoria_rss_bytes: 'Memória residente',
  nascera_event_loop_lag_ms: 'Atraso do event loop',
  nascera_sessoes_ativas: 'Sessões de IA vivas',
  nascera_sessoes_limite: 'Teto de sessões simultâneas',
  nascera_banco_ok: 'Banco respondendo',
  nascera_banco_pool_total: 'Conexões no pool do banco',
  nascera_banco_pool_esperando: 'Esperando conexão no banco',
};
function rotuloMetrica(k) { return ROTULO_METRICA[k] || String(k).replace(/^nascera_/, '').replace(/_/g, ' '); }

function valorMetrica(k, v) {
  if (k === 'nascera_banco_ok') return v ? '<span style="color:var(--z-ok)">sim</span>' : '<span style="color:var(--z-err)">não</span>';
  if (/_bytes$/.test(k)) return Z.num(Math.round(v / 1048576)) + ' MB';
  if (/_ms$/.test(k)) return Z.num(Math.round(v)) + ' ms';
  if (k === 'nascera_uptime_segundos') return tempoDeVida(v);
  return Z.num(v);
}

// ─── Miudezas ────────────────────────────────────────────────────────
function linha(rot, val) {
  return '<div class="z-linha entre" style="font-size:12.5px">' +
    '<span class="z-fg3">' + rot + '</span><span class="z-fg2">' + val + '</span></div>';
}
function chipLag(ms) {
  ms = Math.round(Number(ms) || 0);
  if (ms >= 250) return C.chip(ms + ' ms — o servidor está engasgando', 'erro');
  if (ms >= 80) return C.chip(ms + ' ms — sob pressão', 'alerta');
  return C.chip(ms + ' ms — folgado', 'ok');
}
function tomSessoes(ativas, teto) {
  if (!teto) return ativas ? 'acento' : '';
  if (ativas >= teto) return 'erro';
  if (ativas / teto >= 0.8) return 'alerta';
  return ativas ? 'acento' : '';
}
function tempoDeVida(s) {
  s = Number(s) || 0;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'min';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
// Botão ocupado: devolve a função que o destrava de volta.
function ocupado(el, texto) {
  if (!el) return function () {};
  var antes = el.innerHTML;
  el.disabled = true;
  el.textContent = texto;
  return function () { el.disabled = false; el.innerHTML = antes; };
}
})();
