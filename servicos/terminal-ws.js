// ═══════════════════════════════════════════════════════════════════════
// NASCERA — WebSocket do terminal /ws-terminal (S4-2: extraído do server.js)
//
// Shell REAL via PTY. SÓ ADMIN (papel conferido AO VIVO por loadUsers, não pelo
// claim do token — um admin rebaixado perde o acesso na hora). No VPS abre
// `su -l claude-runner`; no desktop, o shell do usuário. Roteia input/resize/ping.
// ═══════════════════════════════════════════════════════════════════════
const WebSocket = require('ws');
const logger = require('../log.js');
const pty = require('node-pty');

function registrar(wssTerm, deps) {
  const { verifyToken, loadUsers, trackEvent } = deps;

  wssTerm.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const decoded = verifyToken(token);

    if (!decoded) {
      ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized' }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    // O terminal é um SHELL REAL. No VPS abria `su -l claude-runner` FORA do
    // cofre bwrap — o sandbox que isola cada sessão do motor não vale aqui;
    // o processo alcança ~/.claude compartilhado, o Postgres em 127.0.0.1 e o
    // código-fonte. No desktop abre o shell do próprio usuário: controle total
    // da máquina. Antes, QUALQUER usuário autenticado chegava aqui — um cliente
    // comum tinha shell no servidor. Só admin pode abrir terminal; o papel é
    // conferido AO VIVO (loadUsers), não pelo claim do token, para um admin
    // rebaixado perder o acesso na hora.
    const _termUsers = loadUsers();
    const _ehAdmin = _termUsers[decoded.user] && _termUsers[decoded.user].role === 'admin';
    if (!_ehAdmin) {
      logger.warn(`[TERM] "${decoded.user}" (não-admin) tentou abrir terminal — negado`);
      trackEvent('acesso_negado_terminal', {}, decoded.user);
      ws.send(JSON.stringify({ type: 'error', data: 'Terminal disponível apenas para administradores.' }));
      ws.close(4003, 'Forbidden');
      return;
    }

    logger.info(`[TERM] admin ${decoded.user} connected`);

    // Use appropriate shell: su claude-runner on VPS, user shell on local
    const isLocal = process.env.NASCERA_DESKTOP === 'true' || process.platform === 'darwin' || process.platform === 'win32';
    const isWin = process.platform === 'win32';
    const userShell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const shellArgs = isWin ? [] : ['-l'];
    const homeDir = process.env.HOME || require('os').homedir() || '/root';
    // Protegido: se o pty falhar ao iniciar (ex.: spawn-helper sem permissão no macOS),
    // avisa o cliente e fecha o socket — NUNCA derruba o servidor inteiro.
    let shell;
    try {
      shell = isLocal
        ? pty.spawn(userShell, shellArgs, {
            name: 'xterm-256color', cols: 120, rows: 30, cwd: homeDir,
            env: (() => { const e = { ...process.env, TERM: 'xterm-256color' }; delete e.CLAUDECODE; return e; })(),
          })
        : pty.spawn('su', ['-l', 'claude-runner'], {
            name: 'xterm-256color', cols: 120, rows: 30, cwd: '/root',
            env: { ...process.env, TERM: 'xterm-256color' },
          });
    } catch (err) {
      logger.error('[TERM] falha ao iniciar shell:', err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[31mNão foi possível abrir o terminal: ' + err.message + '\x1b[0m\r\n' }));
        ws.close(4002, 'pty spawn failed');
      }
      return;
    }

    shell.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
    });

    shell.onExit(({ exitCode }) => {
      logger.info(`[TERM] shell exited: ${exitCode}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        ws.close();
      }
    });

    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'input') shell.write(parsed.data);
        else if (parsed.type === 'resize') shell.resize(parsed.cols || 120, parsed.rows || 30);
        else if (parsed.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { shell.write(msg.toString()); }
    });

    ws.on('close', () => { logger.info(`[TERM] ${decoded.user} disconnected`); shell.kill(); });
    ws.on('error', () => { shell.kill(); });
  });
}

module.exports = { registrar };
