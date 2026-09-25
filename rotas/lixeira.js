// ═══════════════════════════════════════════════════════════════════════
// NASCERA — rotas da lixeira (S4: extraído do server.js)
//
// Primeiro módulo de rota extraído do monolito. O padrão: uma função
// `registrar(app, deps)` que recebe o app do Express e as dependências
// compartilhadas por injeção — em vez de o handler alcançar o escopo do
// server.js. Assim a rota fica testável isolada e o server.js encolhe.
//
// Coberto por testes/rotas-autorizacao.js (S0-3: isolamento por dono).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const logger = require('../log.js');

// ─── dizer onde o item foi parar ─────────────────────────────────────
// Esta mensagem é o único lugar onde o cliente descobre onde procurar o que
// acabou de excluir — por isso ela não pode ser um texto fixo. Era: "está na
// Lixeira do seu computador". No Windows isso é MENTIRA: a $Recycle.Bin exige a
// API do Shell, então o item vai para a quarentena do Nascera (`.lixeira-nascera`,
// dentro da área de projetos). O cliente abriria a Lixeira, não acharia nada e
// concluiria que perdeu o projeto — chamado de suporte no melhor caso, perda de
// confiança no produto no pior.
//
// `apagarComSeguranca` devolve `metodo` exatamente para isto:
//   'lixeira'     → Lixeira do SO (macOS/Linux). A frase de sempre continua valendo.
//   'quarentena'  → pasta do Nascera (Windows e qualquer SO sem lixeira por arquivo).
//   'copia'       → mudou de volume (EXDEV) e o método de origem se perdeu no
//                   caminho; quem sabe onde o item ficou é o `destino`.
//   'inexistente' → não havia pasta no disco; só a linha da lista saiu.
function naQuarentena(seguranca, r) {
  if (r.metodo === 'quarentena') return true;
  if (r.metodo !== 'copia') return false;
  // Compara com `lixeiraDoNascera()` (API pública do módulo) em vez de procurar o
  // nome da pasta dentro do texto: o nome é detalhe interno de lá e mudaria sem
  // ninguém lembrar daqui.
  try {
    const q = seguranca.lixeiraDoNascera();
    return !!q && (r.destino === q || String(r.destino).startsWith(q + path.sep));
  } catch { return false; }   // área de projetos não configurada: não afirma o que não sabe
}

// Devolve a FRASE INTEIRA, não um complemento: quando a pasta não saiu do
// lugar, começar por "Projeto removido" já seria a mentira.
function ondeFoiParar(seguranca, r) {
  if (!r) return 'Projeto removido da lista — ele já não tinha pasta no disco.';
  if (r.recusado) {
    return 'O projeto saiu da lista, mas a pasta NÃO foi apagada: ela está fora da área de projetos e o Nascera '
         + 'não mexe em nada fora dela. O conteúdo continua exatamente onde estava.';
  }
  if (!r.ok) {
    return 'O projeto saiu da lista, mas a pasta não pôde ser movida ('
         + (r.erro || 'motivo desconhecido') + ') e continua onde estava.';
  }
  if (!r.destino || r.metodo === 'inexistente') return 'Projeto removido da lista — a pasta já não existia no disco.';
  if (naQuarentena(seguranca, r)) {
    return 'Projeto removido — ele está guardado em "' + r.destino + '", uma pasta do próprio Nascera. Neste '
         + 'sistema a Lixeira só aceita o que é jogado nela pelo Explorador de Arquivos, então o Nascera guarda '
         + 'numa pasta dele: para recuperar, mova de volta de lá; para eliminar de vez, apague por lá.';
  }
  return 'Projeto removido — está na Lixeira do seu computador, ainda dá para recuperar.';
}

function plural(n, singular, muitos) { return n === 1 ? singular : muitos; }

/**
 * Monta as rotas da lixeira (`/api/trash*`): listar, restaurar, apagar um item
 * e esvaziar. A exclusão definitiva passa pelo portão `seguranca`.
 *
 * @param {import('express').Express} app - App do Express onde as rotas são montadas.
 * @param {object} deps - Dependências injetadas pelo server.js (composition root).
 * @param {import('express').RequestHandler} deps.authMiddleware - Guarda de sessão; exige usuário logado.
 * @param {() => object[]} deps.loadTrash - Lê a lixeira.
 * @param {(itens: object[]) => void} deps.saveTrash - Grava a lixeira.
 * @param {() => object[]} deps.loadProjects - Lê a lista de projetos.
 * @param {(projs: object[]) => void} deps.saveProjects - Grava a lista de projetos.
 * @param {(proj: object, username: string) => boolean} deps.podeAcessarProjeto - O usuário pode acessar este projeto?
 * @param {object} deps.seguranca - Módulo `caminhos-seguros`: único portão de exclusão (nunca `rm -rf` fora da área de projetos).
 * @param {(evt: object) => void} deps.appendActivity - Registra um evento no log de atividade.
 * @returns {void}
 */
function registrar(app, deps) {
  const {
    authMiddleware, loadTrash, saveTrash, loadProjects, saveProjects,
    podeAcessarProjeto, seguranca, appendActivity,
  } = deps;

  // Auto-purge expired trash (runs every hour)
  setInterval(() => {
    const trash = loadTrash();
    const now = new Date();
    const remaining = [];
    for (const item of trash) {
      if (new Date(item.expiresAt) <= now) {
        // A purga automática é a exclusão mais perigosa do sistema: roda sozinha,
        // sem ninguém olhando. Passa pelo portão como todas as outras e o item
        // continua recuperável — na Lixeira do SO (macOS/Linux) ou na quarentena
        // do Nascera (Windows). Ninguém está olhando a tela aqui, então o `metodo`
        // vai para o log: é por ele que o suporte descobre onde o item foi parar.
        if (item.trashPath) {
          const r = seguranca.apagarComSeguranca(item.trashPath, 'purga automática');
          if (!r.ok) {
            logger.error('[TRASH] purga automática recusada para ' + item.name + ':', r.erro);
            remaining.push(item);   // não conseguiu remover: mantém na lista
            continue;
          }
          logger.info(`[TRASH] Auto-purged: ${item.name} (expired, ${r.metodo}) → ${r.destino || '—'}`);
        } else {
          logger.info(`[TRASH] Auto-purged: ${item.name} (expired, sem pasta no disco)`);
        }
      } else {
        remaining.push(item);
      }
    }
    if (remaining.length !== trash.length) saveTrash(remaining);
  }, 60 * 60 * 1000); // every hour

  // API: List trash
  app.get('/api/trash', authMiddleware, (req, res) => {
    // S0-3: a lixeira também é por dono. Antes devolvia a de TODO mundo — e as
    // rotas de restaurar/apagar aceitavam id alheio. Item carrega `owner` (vem
    // de `...proj`), então o mesmo portão dos projetos vale aqui.
    const trash = loadTrash().filter(t => podeAcessarProjeto(t, req.user.user));
    res.json(trash.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      deletedAt: t.deletedAt,
      expiresAt: t.expiresAt,
      daysLeft: Math.max(0, Math.ceil((new Date(t.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000))),
    })));
  });

  // API: Restore from trash
  app.post('/api/trash/:id/restore', authMiddleware, (req, res) => {
    let trash = loadTrash();
    const item = trash.find(t => t.id === req.params.id);
    // 404 (não 403) para item alheio: não confirma que ele existe. (S0-3)
    if (!item || !podeAcessarProjeto(item, req.user.user)) {
      return res.status(404).json({ error: 'Item não encontrado na lixeira' });
    }

    // Move files back. O destino também passa pelo portão: um item de lixeira
    // com `path` apontando para fora da área faria a restauração apagar o que
    // estivesse lá — o mesmo acidente, só que de trás para frente.
    if (item.trashPath && fs.existsSync(item.trashPath) && item.path) {
      if (!seguranca.dentroDaAreaDeProjetos(item.path)) {
        return res.status(400).json({
          error: 'O destino da restauração está fora da área de projetos. Nada foi alterado.',
        });
      }
      if (fs.existsSync(item.path)) {
        const r = seguranca.apagarComSeguranca(item.path, 'abrir espaço para restaurar');
        if (!r.ok) return res.status(500).json({ error: 'Já existe uma pasta no destino e não consegui movê-la: ' + r.erro });
      }
      try {
        fs.renameSync(item.trashPath, item.path);
      } catch (err) {
        // Sem `cp -a` + `rm -rf` de consolo: falhou, avisa e não mexe em nada.
        return res.status(500).json({
          error: 'Não consegui restaurar a pasta (' + err.code + '). O projeto continua na lixeira, intacto.',
        });
      }
    }

    // Remove from trash, add back to projects
    trash = trash.filter(t => t.id !== req.params.id);
    saveTrash(trash);

    const projects = loadProjects();
    const restored = { ...item };
    delete restored.deletedAt;
    delete restored.expiresAt;
    delete restored.trashPath;
    delete restored._trashPath;
    projects.push(restored);
    saveProjects(projects);

    res.json({ ok: true, message: 'Projeto restaurado' });
  });

  // API: Permanently delete from trash
  app.delete('/api/trash/:id', authMiddleware, (req, res) => {
    let trash = loadTrash();
    const item = trash.find(t => t.id === req.params.id);
    if (!item || !podeAcessarProjeto(item, req.user.user)) {   // (S0-3)
      return res.status(404).json({ error: 'Item não encontrado na lixeira' });
    }

    // Camada 6: "definitivo" exige digitar o nome do projeto. Sem isso, um
    // clique errado é indistinguível de uma decisão.
    const confirmacao = (req.query.confirmar || (req.body && req.body.confirmar) || '').trim();
    if (confirmacao !== (item.name || '').trim()) {
      return res.status(400).json({
        error: 'Para excluir em definitivo, confirme digitando o nome do projeto.',
        precisaConfirmar: item.name,
      });
    }

    // Camada 5: vai para a lixeira do sistema (ou para a quarentena do Nascera,
    // onde não existe uma), não para o vazio. O portão recusa qualquer caminho
    // fora da área de projetos.
    let r = null;
    if (item.trashPath) {
      r = seguranca.apagarComSeguranca(item.trashPath, 'excluir definitivo');
      if (!r.ok && !r.recusado) return res.status(500).json({ error: r.erro });
    }

    trash = trash.filter(t => t.id !== req.params.id);
    saveTrash(trash);
    appendActivity({
      type: 'trash_purged', user: req.user.user, at: new Date().toISOString(),
      // `metodo` e `destino` no log de atividade porque a primeira pergunta de
      // um chamado é "para onde foi?" — e a resposta não é mais sempre a mesma.
      data: { name: item.name, path: item.trashPath, metodo: r ? r.metodo : null, destino: r ? r.destino : null },
    });
    res.json({ ok: true, message: ondeFoiParar(seguranca, r) });
  });

  // API: Empty entire trash
  app.delete('/api/trash', authMiddleware, (req, res) => {
    if ((req.query.confirmar || '') !== 'ESVAZIAR') {
      return res.status(400).json({ error: 'Confirme o esvaziamento da lixeira.', precisaConfirmar: 'ESVAZIAR' });
    }
    // S0-3: esvazia só a lixeira do PRÓPRIO usuário; a dos outros fica intacta.
    const trash = loadTrash();
    const meus = trash.filter(t => podeAcessarProjeto(t, req.user.user));
    // Contas separadas porque o destino não é mais um só, e porque "recusado
    // por estar fora da área" e "não consegui mover" eram somados no mesmo
    // balde — a tela acusava o cliente de ter conectado pasta errada quando na
    // verdade o disco tinha dado erro.
    let paraLixeira = 0, paraQuarentena = 0, semPasta = 0, recusados = 0, falhas = 0;
    let pastaQuarentena = null;
    for (const item of meus) {
      if (!item.trashPath) { semPasta++; continue; }
      const r = seguranca.apagarComSeguranca(item.trashPath, 'esvaziar lixeira');
      // `ok` sem `destino` é o caso "a pasta já não estava lá": contar isso
      // como "foi para a Lixeira" mandaria o cliente procurar o que nunca
      // chegou a existir.
      if (!r.ok) { if (r.recusado) recusados++; else falhas++; }
      else if (!r.destino) semPasta++;
      else if (naQuarentena(seguranca, r)) { paraQuarentena++; pastaQuarentena = path.dirname(r.destino); }
      else paraLixeira++;
    }
    const idsMeus = new Set(meus.map(t => t.id));
    saveTrash(trash.filter(t => !idsMeus.has(t.id)));
    appendActivity({
      type: 'trash_emptied', user: req.user.user, at: new Date().toISOString(),
      data: { count: paraLixeira + paraQuarentena, quarentena: paraQuarentena, semPasta, recusados, falhas },
    });

    const partes = [];
    if (paraLixeira) partes.push(`${paraLixeira} ${plural(paraLixeira, 'projeto foi', 'projetos foram')} para a Lixeira do computador`);
    if (paraQuarentena) {
      partes.push(`${paraQuarentena} ${plural(paraQuarentena, 'projeto foi', 'projetos foram')} para a pasta de guarda do Nascera`
        + (pastaQuarentena ? ` ("${pastaQuarentena}"), porque neste sistema a Lixeira não aceita arquivo movido por um programa` : ''));
    }
    // Estes dois continuam NO DISCO. Antes a frase dizia que tudo tinha ido
    // para a Lixeira e o cliente ficava sem saber que sobrou coisa ocupando
    // espaço — e a lista já não mostra mais esses itens para ele.
    if (recusados) {
      partes.push(`${recusados} ${plural(recusados, 'não foi tocado', 'não foram tocados')} por `
        + `${plural(recusados, 'estar', 'estarem')} fora da área de projetos e `
        + `${plural(recusados, 'continua', 'continuam')} onde ${plural(recusados, 'estava', 'estavam')}`);
    }
    if (falhas) {
      partes.push(`${falhas} não ${plural(falhas, 'pôde', 'puderam')} ser ${plural(falhas, 'movido', 'movidos')} `
        + `e ${plural(falhas, 'continua', 'continuam')} no disco`);
    }
    if (!partes.length) {
      partes.push(semPasta ? `${semPasta} ${plural(semPasta, 'item já não tinha', 'itens já não tinham')} pasta no disco` : 'não havia nada para remover');
    }
    res.json({ ok: true, message: 'Lixeira esvaziada: ' + partes.join('; ') + '.' });
  });
}

module.exports = { registrar };
