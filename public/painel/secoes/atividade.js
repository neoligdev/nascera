/* ═══ NASCERA ADMIN v2 — ATIVIDADE ═════════════════════════════════════
   O diário do sistema: quem entrou, quem comprou, quem criou, o que o
   admin mexeu. Cada evento vira uma frase em português — ninguém deveria
   precisar decorar nome de código para entender o próprio negócio.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
var Z = window.ZAdmin, C = Z.C;

// tipo → [frase em português, família, tom do chip]
// Famílias: acesso · vendas · clientes · projetos · sistema
var EVENTOS = {
  // ── Acesso ──
  login:                      ['entrou no sistema', 'acesso', 'ok'],
  login_failed:               ['errou a senha', 'acesso', 'alerta'],
  login_blocked_bruteforce:   ['login travado por tentativas demais', 'acesso', 'erro'],
  login_blocked_suspenso:     ['login barrado — conta suspensa', 'acesso', 'erro'],
  acesso_negado_projeto:      ['tentou abrir projeto de outra pessoa', 'acesso', 'erro'],
  acesso_negado_terminal:     ['tentou usar o terminal sem permissão', 'acesso', 'erro'],
  primeiro_acesso_concluido:  ['definiu a senha e entrou pela primeira vez', 'acesso', 'ok'],
  esqueci_senha_pedido:       ['pediu para redefinir a senha', 'acesso', ''],
  admin_link_acesso:          ['link de acesso gerado para um cliente', 'acesso', ''],
  admin_criado:               ['conta de administrador criada', 'acesso', 'acento'],

  // ── Vendas ──
  venda_hotmart:              ['venda aprovada na Hotmart', 'vendas', 'ok'],
  venda_hotmart_pendente:     ['venda Hotmart sem plano mapeado', 'vendas', 'alerta'],
  venda_confirmada:           ['venda confirmada na mão', 'vendas', 'ok'],
  intencao_pix:               ['cliente avisou que pagou por Pix', 'vendas', 'acento'],
  reembolso_hotmart:          ['reembolso ou chargeback na Hotmart', 'vendas', 'erro'],
  webhook_hotmart_erro:       ['webhook da Hotmart falhou', 'vendas', 'erro'],
  webhook_hotmart_ignorado:   ['evento da Hotmart ignorado', 'vendas', ''],
  webhook_hottok_invalido:    ['webhook chegou com token inválido', 'vendas', 'erro'],
  admin_webhook_hotmart_config: ['webhook da Hotmart configurado', 'vendas', ''],
  admin_pix_config:           ['Pix configurado', 'vendas', ''],
  admin_billing_config:       ['regras de cobrança alteradas', 'vendas', ''],

  // ── Clientes ──
  admin_user_created:         ['cliente criado', 'clientes', ''],
  admin_user_updated:         ['cliente editado', 'clientes', ''],
  admin_user_deleted:         ['cliente excluído', 'clientes', 'erro'],
  admin_user_suspenso:        ['cliente suspenso', 'clientes', 'alerta'],
  admin_user_reativado:       ['cliente reativado', 'clientes', 'ok'],
  admin_billing_user:         ['crédito ou plano do cliente alterado', 'clientes', 'acento'],
  ia_propria_conectada:       ['cliente conectou a própria IA', 'clientes', ''],
  ia_propria_desconectada:    ['cliente desconectou a própria IA', 'clientes', ''],
  admin_ia_propria:           ['permissão de IA própria alterada', 'clientes', ''],

  // ── Projetos ──
  project_created:            ['criou um projeto', 'projetos', 'acento'],
  projeto_motor_alterado:     ['trocou o motor do projeto', 'projetos', ''],
  trash_purged:               ['apagou um projeto da lixeira', 'projetos', 'alerta'],
  trash_emptied:              ['esvaziou a lixeira', 'projetos', 'alerta'],
  domain_added:               ['domínio adicionado', 'projetos', ''],
  domain_verified:            ['domínio verificado e no ar', 'projetos', 'ok'],
  domain_removed:             ['domínio removido', 'projetos', 'alerta'],
  imagem_gerada:              ['gerou uma imagem', 'projetos', ''],
  tool_extract_started:       ['começou a clonar um site', 'projetos', ''],
  tool_extract_done:          ['terminou de clonar um site', 'projetos', 'ok'],
  tool_extract_installed:     ['instalou o site clonado', 'projetos', 'ok'],
  tool_extract_uninstalled:   ['removeu o site clonado', 'projetos', ''],
  admin_session_closed:       ['sessão de IA encerrada pelo admin', 'projetos', 'alerta'],

  // ── Sistema ──
  admin_config_updated:       ['configurações do sistema salvas', 'sistema', ''],
  admin_restart:              ['servidor reiniciado', 'sistema', 'alerta'],
  admin_theme_updated:        ['aparência alterada', 'sistema', ''],
  admin_theme_image_uploaded: ['imagem da marca trocada', 'sistema', ''],
  admin_theme_reset:          ['aparência voltou ao padrão', 'sistema', ''],
  admin_update_started:       ['atualização do sistema iniciada', 'sistema', 'acento'],
  platform_updated:           ['sistema atualizado', 'sistema', 'ok'],
  admin_email_config:         ['e-mail (SMTP) configurado', 'sistema', ''],
  admin_domains_config:       ['configuração de domínios alterada', 'sistema', ''],
  motor_alterado:             ['motor de IA trocado', 'sistema', 'acento'],
  motor_instalando:           ['instalando um motor de IA', 'sistema', ''],
  modelo_local_download:      ['baixando um modelo local', 'sistema', ''],
  modelo_local_selecionado:   ['modelo local selecionado', 'sistema', ''],
  imagens_chave_alterada:     ['chave do gerador de imagens alterada', 'sistema', ''],
  imagens_modelo_alterado:    ['modelo de imagens alterado', 'sistema', ''],
  processo_fatal:             ['o servidor caiu', 'sistema', 'erro'],
};

var FAMILIAS = [
  { id: 'tudo',     t: 'Tudo' },
  { id: 'acesso',   t: 'Acesso' },
  { id: 'vendas',   t: 'Vendas' },
  { id: 'clientes', t: 'Clientes' },
  { id: 'projetos', t: 'Projetos' },
  { id: 'sistema',  t: 'Sistema' },
];

// Rótulos amigáveis para os campos que vêm em `data`.
var ROTULOS = {
  username: 'usuário', plano: 'plano', plan: 'plano', valor: 'valor', valorPagoBrl: 'valor pago',
  domain: 'domínio', slug: 'slug', name: 'nome', motivo: 'motivo', erro: 'erro', evento: 'evento',
  txId: 'transação', vendaId: 'venda', referencia: 'referência', motor: 'motor', modelo: 'modelo',
  qualidade: 'qualidade', projectId: 'projeto', count: 'itens', recusados: 'recusados', tipo: 'tipo',
  de: 'de', para: 'para', key: 'sessão', host: 'servidor', ip: 'IP', mode: 'modo', sslMode: 'SSL',
  ssl: 'SSL', theme: 'tema', chave: 'campo', criado: 'conta criada', byAdmin: 'pelo admin',
  configurada: 'configurada', permitir: 'permitir', planoPadrao: 'plano padrão', url: 'endereço',
  path: 'caminho', id: 'id', grantCredits: 'créditos do plano', addBalanceCredits: 'créditos avulsos',
  resetSpend: 'zerou o consumo', defaultBuildModel: 'modelo padrão', defaultBuildLevel: 'nível padrão',
  trashRetentionDays: 'retenção da lixeira (dias)', telemetryEnabled: 'telemetria',
};
var DINHEIRO = { valor: 1, valorPagoBrl: 1, priceBrl: 1 };

Z.registrar('atividade', {
  render: function (alvo) {
    return Z.api('/api/admin/activity').then(function (d) {
      var cab = C.cab({
        trilha: 'Sistema · Diário de bordo',
        icone: 'atividade',
        titulo: 'Atividade',
        sub: 'Tudo o que aconteceu por aqui, do mais recente para o mais antigo. Serve para responder "quem mexeu nisso?" sem adivinhação.',
        acoes: [C.btn('Atualizar', { icone: 'atualiza', acao: 'recarregar' })],
      });

      if (!Array.isArray(d)) {
        var msg = (d && d.error) || 'O servidor não devolveu o registro de atividade.';
        Z.erro(msg);
        alvo.innerHTML = '<div id="at-raiz">' + cab + C.vazio({
          tom: 'erro', icone: 'alerta', tit: 'Não consegui ler o registro',
          txt: Z.esc(msg),
          acao: C.btn('Tentar de novo', { classe: 'primario', acao: 'recarregar' }),
        }) + '</div>';
        Z.ligarAcoes(document.getElementById('at-raiz'), { 'recarregar': function () { Z.recarregar(); } });
        return;
      }

      // Pré-mastiga cada evento uma vez só: frase, família, tom e detalhe.
      var lista = d.map(function (a) {
        var meta = EVENTOS[a.type] || null;
        var rot = meta ? meta[0] : String(a.type || 'evento desconhecido').replace(/_/g, ' ');
        var det = detalhe(a.data);
        return {
          tipo: String(a.type || ''),
          rot: rot,
          fam: meta ? meta[1] : 'sistema',
          tom: meta ? meta[2] : '',
          quem: a.user || (a.data && a.data.username) || '',
          det: det,
          at: a.at || null,
          busca: (rot + ' ' + (a.type || '') + ' ' + (a.user || '') + ' ' + det).toLowerCase(),
        };
      });

      var agora = Date.now();
      var recentes = lista.filter(function (e) {
        var t = e.at ? new Date(e.at).getTime() : 0;
        return t && (agora - t) < 86400000;
      }).length;
      var problemas = lista.filter(function (e) { return e.tom === 'erro'; }).length;

      var html = cab;

      html += C.stats([
        { rot: 'Eventos no registro', num: Z.num(lista.length), cap: 'O sistema guarda os 120 mais recentes', icone: 'atividade' },
        { rot: 'Últimas 24 horas', num: Z.num(recentes), cap: recentes ? 'Movimento recente' : 'Nada aconteceu hoje', icone: 'relogio', tom: recentes ? 'acento' : '' },
        { rot: 'Problemas', num: Z.num(problemas), cap: problemas ? 'Falhas, bloqueios e recusas' : 'Nenhuma falha registrada', icone: 'alerta', tom: problemas ? 'erro' : 'ok' },
        { rot: 'Último evento', num: Z.desde(lista.length ? lista[0].at : null), pequeno: true,
          cap: lista.length ? Z.esc(lista[0].rot) : 'Registro vazio', icone: 'raio' },
      ]);

      var filtros = FAMILIAS.map(function (f) {
        return {
          id: f.id, t: f.t,
          n: f.id === 'tudo' ? lista.length : lista.filter(function (e) { return e.fam === f.id; }).length,
        };
      });

      html += '<span class="z-rotulo" style="margin-top:22px">Linha do tempo</span>';
      html += C.card({
        tit: 'Últimos acontecimentos',
        sub: 'Filtre pela família do evento ou busque por qualquer palavra — nome do cliente, domínio, plano, motivo.',
        corpo:
          C.busca('at-busca', 'Buscar por pessoa, evento ou detalhe…') +
          C.filtros('at-filtros', filtros, 'tudo') +
          '<div id="at-lista"></div>',
      });

      // Container próprio: o roteador reaproveita #z-conteudo, então prender
      // os cliques aqui evita empilhar ouvintes a cada visita à seção.
      alvo.innerHTML = '<div id="at-raiz">' + html + '</div>';

      var estado = { fam: 'tudo', busca: '' };

      function passa(e) {
        if (estado.fam !== 'tudo' && e.fam !== estado.fam) return false;
        if (!estado.busca) return true;
        return e.busca.indexOf(estado.busca) >= 0;
      }

      function pintar() {
        var linhas = lista.filter(passa).map(linhaEvento);
        var vazio = lista.length
          ? { tit: 'Nenhum evento com esse recorte', txt: 'Troque a família ou limpe a busca para ver o resto.' }
          : { tit: 'Nada aconteceu ainda', txt: 'Os eventos aparecem aqui conforme você e seus clientes usam o sistema.' };
        document.getElementById('at-lista').innerHTML = C.tabela([
          { t: 'Evento' }, { t: 'Quem' }, { t: 'Detalhe' }, { t: 'Quando', dir: true },
        ], linhas, { icone: 'atividade', vazioTit: vazio.tit, vazioTxt: vazio.txt });
      }

      pintar();

      Z.ligarFiltros('at-filtros', function (f) { estado.fam = f; pintar(); });
      var campo = document.getElementById('at-busca');
      campo.oninput = function () { estado.busca = campo.value.trim().toLowerCase(); pintar(); };

      Z.ligarAcoes(document.getElementById('at-raiz'), {
        'recarregar': function () { Z.recarregar(); },
      });
    });
  },
});

function linhaEvento(e) {
  // Só o que exige olhar ganha chip — assim o problema salta em vez de se
  // perder no meio de cinquenta logins bem-sucedidos.
  var selo = e.tom === 'erro' ? C.chipPonto('falha', 'erro')
           : e.tom === 'alerta' ? C.chipPonto('atenção', 'alerta') : '';

  return '<tr>' +
    '<td class="forte">' +
      '<div class="z-linha" style="gap:7px">' + Z.esc(e.rot) + selo + '</div>' +
      '<div class="z-cel-sub z-mono">' + Z.esc(e.tipo) + '</div></td>' +
    '<td>' + (e.quem ? Z.esc(e.quem) : '<span class="z-fg3">o sistema</span>') + '</td>' +
    '<td class="z-fg3" title="' + att(e.det) + '">' + Z.esc(corta(e.det, 68)) + '</td>' +
    '<td class="dir">' + Z.data(e.at, true) +
      (e.at ? '<div class="z-cel-sub">há ' + Z.desde(e.at) + '</div>' : '') + '</td>' +
  '</tr>';
}

// Transforma o `data` do evento numa frase curta e legível (3 campos no máximo).
function detalhe(dados) {
  if (!dados || typeof dados !== 'object') return '—';
  var partes = [];
  Object.keys(dados).forEach(function (k) {
    if (partes.length >= 3) return;
    var v = dados[k];
    if (v === null || v === undefined || v === '' || typeof v === 'object') return;
    if (typeof v === 'boolean') v = v ? 'sim' : 'não';
    else if (typeof v === 'number' && DINHEIRO[k]) v = Z.brl(v);
    else v = String(v);
    partes.push((ROTULOS[k] || k.replace(/_/g, ' ')) + ': ' + corta(v, 54));
  });
  return partes.length ? partes.join(' · ') : '—';
}
function corta(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
// Z.esc não escapa aspas; dentro de um atributo isso deixaria um detalhe
// com " quebrar a célula.
function att(v) { return Z.esc(v == null ? '' : v).replace(/"/g, '&quot;'); }

})();
