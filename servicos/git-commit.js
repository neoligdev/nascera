// ═══════════════════════════════════════════════════════════════════════
// NASCERA — helpers de git por projeto (S4-2: extraído do server.js)
//
// autoCommit (síncrono), autoCommitAsync (S2-2: assíncrono e SERIALIZADO por
// projeto — git não é seguro com 2 processos no mesmo repo — para tirar o git
// do caminho quente do turno), getNextVersion e getCurrentVersion (por tags).
// Fábrica criar({ git }). Injetados em projetos-versao (publish/versions) e
// motor-canal (autoCommitAsync/getCurrentVersion no fim do turno). Cobertos
// por projetos-versao.test.js e test:fake.
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const logger = require('../log.js');
const path = require('path');

function criar(deps) {
  const { git } = deps;

  // Auto-commit changes in a project
  function autoCommit(projectPath, message) {
    if (!projectPath || !fs.existsSync(path.join(projectPath, '.git'))) return;
    const status = git(['status','--porcelain'], projectPath);
    if (status) {
      git(['add','-A'], projectPath);
      git(['commit','-m',String(message||'Atualização')], projectPath);
    }
  }

  // S2-2: versão ASSÍNCRONA e SERIALIZADA por projeto do autoCommit.
  // O autoCommit síncrono disparava 3 execFileSync (status+add+commit) DENTRO do
  // handler do resultado do turno — bloqueando o event loop inteiro a cada
  // mensagem finalizada. Aqui o git roda fora do caminho de resposta, via
  // execFile assíncrono, e commits do MESMO projeto viram fila (git não é seguro
  // com dois processos concorrentes no mesmo repo).
  const _gitFilas = new Map();   // projectPath → cauda da fila
  function _gitAsync(args, cwd) {
    return new Promise((resolve) => {
      require('child_process').execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 },
        (err, out) => resolve(err ? null : String(out).trim()));
    });
  }
  function autoCommitAsync(projectPath, message) {
    if (!projectPath) return Promise.resolve();
    const anterior = _gitFilas.get(projectPath) || Promise.resolve();
    const atual = anterior.then(async () => {
      if (!fs.existsSync(path.join(projectPath, '.git'))) return;
      const status = await _gitAsync(['status', '--porcelain'], projectPath);
      if (status) {
        await _gitAsync(['add', '-A'], projectPath);
        await _gitAsync(['commit', '-m', String(message || 'Atualização')], projectPath);
      }
    }).catch((e) => { logger.error('[git] autoCommit assíncrono falhou:', e.message); });
    _gitFilas.set(projectPath, atual);
    atual.finally(() => { if (_gitFilas.get(projectPath) === atual) _gitFilas.delete(projectPath); });
    return atual;
  }

  // Get next version number from git tags
  function getNextVersion(projectPath) {
    const tags = git(['tag','-l','v*','--sort=-version:refname'], projectPath);
    if (!tags) return 1;
    const latest = tags.split('\n')[0];
    const num = parseInt(latest.replace('v', ''), 10);
    return isNaN(num) ? 1 : num + 1;
  }

  // Get current version (latest commit count or tag)
  function getCurrentVersion(projectPath) {
    if (!fs.existsSync(path.join(projectPath, '.git'))) return 0;
    const count = git(['rev-list','--count','HEAD'], projectPath);
    return count ? parseInt(count, 10) : 0;
  }

  return { autoCommit, autoCommitAsync, getNextVersion, getCurrentVersion };
}

module.exports = { criar };
