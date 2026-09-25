/* ═══ NASCERA ADMIN v2 — CONFIGURAÇÕES ═════════════════════════════════
   As decisões que valem para o sistema inteiro: como os builds nascem,
   quanto tempo a lixeira guarda, o que sai daqui em telemetria e quem
   gera as imagens dos sites. Um bloco, um botão de salvar.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

// O painel escolhe o modelo pelo apelido que o motor entende — o mesmo
// conjunto que o cliente vê no chat.
var MODELOS_BUILD = [
  { v: '',                   t: 'Automático — o padrão da conta conectada' },
  { v: 'default',            t: 'Default da conta (recomendado)' },
  { v: 'sonnet',             t: 'Sonnet — rápido e ótimo para sites' },
  { v: 'opus[1m]',           t: 'Opus — 1 milhão de contexto' },
  { v: 'claude-fable-5[1m]', t: 'Fable — o mais capaz' },
  { v: 'haiku',              t: 'Haiku — o mais rápido e barato' },
];
var NIVEIS = [
  { v: '1', t: '1 — Rascunho · uma página com o essencial' },
  { v: '2', t: '2 — Enxuto · até 3 seções' },
  { v: '3', t: '3 — Equilibrado · landing completa (padrão)' },
  { v: '4', t: '4 — Completo · 7+ seções e acabamento' },
  { v: '5', t: '5 — Máximo · multi-página, com tudo' },
];
var NOME_NIVEL = { 1: 'Rascunho', 2: 'Enxuto', 3: 'Equilibrado', 4: 'Completo', 5: 'Máximo' };
var NOME_QUALIDADE = {
  auto:   'Automática — o modelo decide',
  low:    'Baixa — a mais barata',
  medium: 'Média — equilíbrio de custo',
  high:   'Alta — a mais cara',
};

var MODELOS_IMG = [];   // catálogo devolvido por /api/admin/imagens

Z.registrar('config', {
  render: function (alvo) {
    return Promise.all([
      Z.api('/api/admin/config').catch(function () { return {}; }),
      Z.api('/api/admin/imagens').catch(function () { return null; }),
    ]).then(function (r) {
      var cfg = r[0] || {}, img = r[1];
      if (cfg.error) { Z.erro(cfg.error); cfg = {}; }
      // Rota fora do ar devolve {} (o núcleo engole JSON inválido): sem o bloco
      // `openai` não há o que configurar, então isso vale como falha.
      if (!img || !img.openai) img = null;

      var oa = (img && img.openai) || {};
      MODELOS_IMG = oa.modelos || [];
      var nivel = String(cfg.defaultBuildLevel || 3);
      var dias = cfg.trashRetentionDays || 7;
      var telemetria = cfg.telemetryEnabled !== false;
      var temChave = !!oa.configurada;

      var html = C.cab({
        trilha: 'Sistema · Preferências',
        icone: 'config',
        titulo: 'Configurações',
        sub: 'O que vale para o sistema inteiro. Cada bloco aqui muda o comportamento padrão de todos os projetos — o cliente ainda pode escolher diferente dentro do chat dele.',
        acoes: [C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' })],
      });

      html += C.stats([
        { rot: 'Modelo padrão', num: Z.esc(rotuloModelo(cfg.defaultBuildModel)), cap: 'Quando o projeto não escolhe', icone: 'ia', pequeno: true },
        { rot: 'Nível de detalhe', num: Z.esc(NOME_NIVEL[nivel] || 'Equilibrado'), cap: 'Nível ' + Z.esc(nivel) + ' de 5', icone: 'raio', pequeno: true },
        { rot: 'Lixeira', num: Z.num(dias) + ' dias', cap: 'Depois disso, some de vez', icone: 'lixeira', pequeno: true },
        { rot: 'Imagens', num: !img ? 'Indisponível' : (temChave ? 'Sob medida' : 'Banco de fotos'),
          cap: !img ? 'Não consegui consultar' : (temChave ? 'Geradas pela OpenAI' : 'Sem chave configurada'),
          icone: 'aparencia', pequeno: true, tom: !img ? 'erro' : (temChave ? 'ok' : 'alerta') },
      ]);

      // ── Build padrão ──
      html += '<span class="z-rotulo" style="margin-top:22px">Build padrão</span>';
      html += C.card({
        tit: 'Como os sites nascem',
        sub: 'Vale para todo projeto que não escolheu nada. Quem estiver no chat pode trocar a qualquer momento — isto é só o ponto de partida.',
        corpo: '<div class="z-campos">' +
            C.campo({ id: 'cfg-modelo', rotulo: 'Modelo padrão dos builds', tipo: 'select',
              valor: cfg.defaultBuildModel || '', opcoes: opcoesModelo(cfg.defaultBuildModel),
              ajuda: 'Modelo mais capaz entrega melhor e custa mais por build. Na dúvida, deixe no padrão da conta.' }) +
            C.campo({ id: 'cfg-nivel', rotulo: 'Nível de detalhe padrão', tipo: 'select',
              valor: nivel, opcoes: NIVEIS,
              ajuda: 'Quanto maior o nível, mais seções e mais capricho — e mais tempo e crédito o build consome.' }) +
          '</div>' +
          '<div class="z-linha" style="justify-content:flex-end;margin-top:15px">' +
            C.btn('Salvar build padrão', { classe: 'primario', icone: 'check', acao: 'salvar-build' }) +
          '</div>',
      });

      // ── Lixeira ──
      html += '<span class="z-rotulo" style="margin-top:22px">Lixeira</span>';
      html += C.card({
        tit: 'Quanto tempo um projeto excluído fica recuperável',
        sub: 'Enquanto está na lixeira, o projeto ainda ocupa disco e pode voltar inteiro. Passado o prazo, ele é apagado de verdade e não tem como desfazer.',
        corpo: '<div class="z-campos">' +
            C.campo({ id: 'cfg-lixeira', rotulo: 'Dias de retenção', tipo: 'number', valor: dias,
              ajuda: 'Entre 1 e 90 dias. O padrão é 7 — costuma bastar para alguém perceber que apagou errado.' }) +
          '</div>' +
          '<div class="z-linha" style="justify-content:flex-end;margin-top:15px">' +
            C.btn('Salvar retenção', { classe: 'primario', icone: 'check', acao: 'salvar-lixeira' }) +
          '</div>',
      });

      // ── Telemetria ──
      html += '<span class="z-rotulo" style="margin-top:22px">Telemetria</span>';
      html += C.card({
        tit: 'O que esta instalação conta para o servidor de licenças',
        sub: 'Sem meias-palavras: abaixo está exatamente o que sai daqui quando isto está ligado.',
        corpo: C.switch('cfg-telemetria', 'Enviar telemetria para o servidor de licenças', telemetria) +
          '<div class="z-sep"></div>' +
          '<div class="z-grid2">' +
            '<div><span class="z-rotulo">O que sai daqui</span><div class="z-col" style="gap:8px">' +
              item('Um identificador desta instalação (não é o seu nome nem o do seu cliente).', 'ok') +
              item('O e-mail dos administradores desta conta e o domínio principal publicado.', 'ok') +
              item('Quantos usuários e quantos projetos existem — só a contagem.', 'ok') +
              item('Sistema operacional e versão do Nascera instalada.', 'ok') +
              item('Eventos de uso: login, projeto criado, venda confirmada, domínio verificado.', 'ok') +
            '</div></div>' +
            '<div><span class="z-rotulo">O que nunca sai</span><div class="z-col" style="gap:8px">' +
              item('O conteúdo dos sites e o código gerado.', 'erro') +
              item('As conversas dos seus clientes com a IA.', 'erro') +
              item('Senhas, chaves de API ou tokens de qualquer tipo.', 'erro') +
              item('Arquivos dos projetos — nada de disco é enviado.', 'erro') +
            '</div></div>' +
          '</div>' +
          '<div class="z-dica" style="margin-top:14px">Desligar não bloqueia nada e não apaga o que já foi enviado: só interrompe o envio daqui para frente. O registro de <b>Atividade</b> continua funcionando normalmente dentro desta instalação.</div>' +
          '<div class="z-linha" style="justify-content:flex-end;margin-top:15px">' +
            C.btn('Salvar telemetria', { classe: 'primario', icone: 'check', acao: 'salvar-telemetria' }) +
          '</div>',
      });

      // ── Geração de imagens ──
      html += '<span class="z-rotulo" style="margin-top:22px">Geração de imagens</span>';
      html += C.card({
        tit: 'Quem faz as imagens dos sites',
        sub: 'Nenhum motor de IA gera imagem — isso é outro serviço. Sem chave da OpenAI, o Nascera usa fotos de banco: não é sob medida, mas é infinitamente melhor que um quadrado cinza.',
        corpo: img ? corpoImagens(img, oa, temChave)
          : C.vazio({ tom: 'erro', icone: 'alerta', tit: 'Não consegui ler a configuração de imagens',
              txt: 'A rota <span class="z-mono">/api/admin/imagens</span> não respondeu. Os sites continuam saindo com fotos de banco enquanto isso.' }),
      });

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="cfg-raiz">' + html + '</div>';
      if (img) ligarNotaDeMedida();

      Z.ligarAcoes('cfg-raiz', {
        'recarregar': function () { Z.recarregar(); },

        'salvar-build': function (_d, el) {
          salvarConfig(el, {
            defaultBuildModel: valor('cfg-modelo'),
            defaultBuildLevel: parseInt(valor('cfg-nivel'), 10) || 3,
          }, 'Build padrão salvo. Vale para os próximos projetos.');
        },

        'salvar-lixeira': function (_d, el) {
          var d = parseInt(valor('cfg-lixeira'), 10);
          if (!(d >= 1 && d <= 90)) return Z.erro('A retenção precisa ficar entre 1 e 90 dias.');
          salvarConfig(el, { trashRetentionDays: d }, 'Lixeira agora guarda por ' + d + ' dia(s).');
        },

        'salvar-telemetria': function (_d, el) {
          var lig = !!(document.getElementById('cfg-telemetria') || {}).checked;
          salvarConfig(el, { telemetryEnabled: lig },
            lig ? 'Telemetria ligada.' : 'Telemetria desligada. Nada mais sai daqui.');
        },

        'trocar-chave': function () {
          Z.perguntar({
            icone: 'bloqueio', titulo: 'Chave da OpenAI',
            sub: 'Ela fica guardada só nesta máquina, com permissão restrita, e nunca volta inteira para a tela.',
            campos: [{ id: 'chave', rotulo: 'Chave', tipo: 'password', dica: 'sk-…',
              ajuda: 'Pegue em platform.openai.com → API keys. A conta precisa ter crédito: chave válida sem saldo falha só na hora de gerar.' }],
            confirmar: 'Salvar chave',
            aoConfirmar: function (v) {
              Z.apiJson('/api/admin/imagens/chave', 'PUT', { chave: (v.chave || '').trim() }).then(function (d) {
                if (d && d.error) return Z.erro(d.error);
                Z.ok('Chave salva. Use o botão Testar para confirmar que ela funciona de verdade.');
                Z.recarregar();
              }).catch(function () { Z.erro('Não consegui salvar a chave agora.'); });
            },
          });
        },

        'remover-chave': function () {
          Z.confirmar({
            titulo: 'Remover a chave da OpenAI?', perigo: true, confirmar: 'Remover a chave',
            texto: 'As imagens voltam a vir do banco de fotos, sem custo nenhum — só deixam de ser feitas sob medida para cada site. Você pode configurar outra chave quando quiser.',
            aoConfirmar: function () {
              Z.apiJson('/api/admin/imagens/chave', 'PUT', { chave: '' }).then(function (d) {
                if (d && d.error) return Z.erro(d.error);
                Z.ok('Chave removida. As imagens voltaram para o banco de fotos.');
                Z.recarregar();
              }).catch(function () { Z.erro('Não consegui remover a chave agora.'); });
            },
          });
        },

        'salvar-imagem': function (_d, el) {
          var voltar = ocupado(el, 'Salvando…');
          Z.apiJson('/api/admin/imagens/modelo', 'PUT', {
            modelo: valor('img-modelo'), qualidade: valor('img-qualidade'),
          }).then(function (d) {
            voltar();
            if (d && d.error) return Z.erro(d.error);
            Z.ok('Modelo e qualidade salvos.');
            Z.recarregar();
          }).catch(function () { voltar(); Z.erro('Não consegui salvar agora.'); });
        },

        'testar-imagem': function (_d, el) {
          var voltar = ocupado(el, 'Gerando…');
          Z.toast('Gerando uma imagem de exemplo… isso leva alguns segundos.');
          Z.apiJson('/api/admin/imagens/testar', 'POST', { prompt: 'um quadrado azul simples, minimalista' })
            .then(function (d) { voltar(); mostrarTeste(d || {}); })
            .catch(function () { voltar(); Z.erro('O teste não completou. Veja os logs em Servidor & Logs.'); });
        },
      });
    });
  },
});

// ─── Bloco de imagens ────────────────────────────────────────────────
function corpoImagens(img, oa, temChave) {
  var qualidades = (oa.qualidades && oa.qualidades.length ? oa.qualidades : ['auto', 'low', 'medium', 'high'])
    .map(function (q) { return { v: q, t: NOME_QUALIDADE[q] || q }; });

  var topo = '<div class="z-linha" style="margin-bottom:12px">' +
      (temChave ? C.chipPonto('OpenAI conectada', 'ok') : C.chipPonto('Banco de fotos', 'alerta')) +
      C.chip(String(img.provedor || '—'), 'acento') +
    '</div>' +
    '<p class="z-p">' + Z.esc(img.explicacao || '') + '</p>';

  var chave = temChave
    ? '<div class="z-linha entre" style="margin-top:14px">' +
        '<div><div class="z-fg3" style="font-size:11.5px">Chave configurada</div>' +
          '<div class="z-mono" style="margin-top:3px">' + Z.esc(oa.mascarada || '••••') + '</div></div>' +
        '<div class="z-linha">' +
          C.btn('Trocar chave', { classe: 'mini', icone: 'bloqueio', acao: 'trocar-chave' }) +
          C.btn('Remover', { classe: 'mini perigo', icone: 'lixeira', acao: 'remover-chave' }) +
        '</div>' +
      '</div>'
    : C.banner('<b>Sem chave da OpenAI.</b> Os sites saem com fotos de banco público — de graça, porém genéricas. Configure a chave para cada imagem nascer sob medida para o conteúdo do site.', 'alerta') +
      '<div class="z-linha" style="justify-content:flex-end">' +
        C.btn('Configurar chave', { classe: 'primario', icone: 'bloqueio', acao: 'trocar-chave' }) +
      '</div>';

  return topo + chave + '<div class="z-sep"></div>' +
    '<div class="z-campos">' +
      C.campo({ id: 'img-modelo', rotulo: 'Modelo de imagem', tipo: 'select',
        valor: oa.modelo || '', opcoes: MODELOS_IMG.map(function (m) {
          return { v: m.id, t: m.nome + (m.recomendado ? ' — recomendado' : '') };
        }),
        ajuda: '<span id="img-medida">' + Z.esc(medidaDo(oa.modelo)) + '</span>' }) +
      C.campo({ id: 'img-qualidade', rotulo: 'Qualidade', tipo: 'select',
        valor: oa.qualidade || 'auto', opcoes: qualidades,
        ajuda: 'Qualidade mais alta custa mais por imagem. Em site, "automática" costuma resolver.' }) +
    '</div>' +
    '<div class="z-linha" style="justify-content:flex-end;margin-top:15px">' +
      C.btn('Testar geração', { icone: 'play', acao: 'testar-imagem' }) +
      C.btn('Salvar modelo', { classe: 'primario', icone: 'check', acao: 'salvar-imagem' }) +
    '</div>';
}

// A medida que o modelo aceita não é detalhe: modelo de medida fixa devolve
// imagem fora do layout, e imagem paga fora do layout costuma ser descartada.
function medidaDo(id) {
  for (var i = 0; i < MODELOS_IMG.length; i++) {
    if (MODELOS_IMG[i].id === id) return 'Aceita ' + MODELOS_IMG[i].medida + '.';
  }
  return 'Escolha o modelo para ver as medidas que ele aceita.';
}
function ligarNotaDeMedida() {
  var sel = document.getElementById('img-modelo');
  var nota = document.getElementById('img-medida');
  if (!sel || !nota) return;
  sel.onchange = function () { nota.textContent = medidaDo(sel.value); };
}

function mostrarTeste(d) {
  var okOpenai = d.ok && d.provedor === 'openai';
  var banner = d.ok
    ? (okOpenai
        ? C.banner('<b>Funcionou.</b> A imagem foi gerada sob medida pela OpenAI — a chave é válida e tem crédito.', 'ok')
        : C.banner('<b>A imagem veio do banco de fotos.</b> ' + Z.esc(d.aviso || 'Sem chave da OpenAI configurada, é este o caminho.'), 'alerta'))
    : C.banner('<b>O teste falhou.</b> ' + Z.esc(d.erro || 'A geração não completou.'), 'erro');

  var detalhes = '<div class="z-col" style="gap:7px;margin-top:4px">' +
    linhaInfo('Provedor que atendeu', Z.esc(d.provedor || '—')) +
    linhaInfo('Peso da imagem', d.bytes ? Z.mb(Math.round(d.bytes / 1024)) : '—') +
    linhaInfo('Prompt usado', 'um quadrado azul simples, minimalista') +
  '</div>';

  var explicacao = d.ok
    ? '<p class="z-p" style="margin-top:14px">A imagem de teste foi gerada e descartada em seguida — nenhum projeto foi tocado.</p>'
    : '<p class="z-p" style="margin-top:14px">Confira se a chave está correta e se a conta da OpenAI tem crédito. Salvar a chave não prova nada: só a geração de verdade prova.</p>';

  Z.modal({
    icone: d.ok ? 'aparencia' : 'alerta',
    titulo: 'Teste de geração de imagem',
    sub: 'Uma imagem de exemplo, gerada agora, com a configuração que está salva.',
    corpo: banner + detalhes + explicacao,
    pe: '<button class="z-btn" data-fechar>Fechar</button>',
  });
}

// ─── Salvar (a config toda passa pelo mesmo PUT) ─────────────────────
function salvarConfig(el, corpo, mensagem) {
  var voltar = ocupado(el, 'Salvando…');
  Z.apiJson('/api/admin/config', 'PUT', corpo).then(function (d) {
    voltar();
    if (d && d.error) return Z.erro(d.error);
    Z.ok(mensagem);
    Z.recarregar();
  }).catch(function () { voltar(); Z.erro('Não consegui salvar agora. Tente de novo em instantes.'); });
}

// ─── Miudezas ────────────────────────────────────────────────────────
function opcoesModelo(atual) {
  var lista = MODELOS_BUILD.slice();
  var achou = false;
  for (var i = 0; i < lista.length; i++) if (lista[i].v === (atual || '')) achou = true;
  // Modelo definido fora do painel não pode sumir só porque não está na lista.
  if (!achou && atual) lista.push({ v: atual, t: atual + ' — definido fora do painel' });
  return lista;
}
function rotuloModelo(v) {
  for (var i = 0; i < MODELOS_BUILD.length; i++) {
    if (MODELOS_BUILD[i].v === (v || '')) return String(MODELOS_BUILD[i].t).split(' — ')[0].split(' (')[0];
  }
  return v || 'Automático';
}
function item(txt, tom) {
  return '<div class="z-linha" style="gap:9px;align-items:flex-start;flex-wrap:nowrap">' +
    '<span class="z-ponto" style="margin-top:7px;color:var(--z-' + (tom === 'ok' ? 'ok' : 'err') + ')"></span>' +
    '<span class="z-p" style="flex:1">' + txt + '</span></div>';
}
function linhaInfo(rot, val) {
  return '<div class="z-linha entre" style="font-size:12.5px">' +
    '<span class="z-fg3">' + rot + '</span><span class="z-fg2">' + val + '</span></div>';
}
function valor(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function ocupado(el, texto) {
  if (!el) return function () {};
  var antes = el.innerHTML;
  el.disabled = true;
  el.textContent = texto;
  return function () { el.disabled = false; el.innerHTML = antes; };
}
})();
