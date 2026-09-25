#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# NASCERA — instalador de VPS (Ubuntu/Debian)
#
# Deixa o servidor pronto: Node, PM2, Claude CLI, dependências, segredos
# únicos, firewall, Caddy com HTTPS automático e os domínios personalizados
# já ligados.
#
# Uso:
#   sudo bash install-vps.sh --panel-domain painel.seudominio.com \
#                            --email voce@email.com
#
# Opções:
#   --panel-domain <dom>  Domínio do painel. Sem ele o painel fica só no IP:porta.
#   --email <e>           E-mail para os avisos do Let's Encrypt (recomendado).
#   --admin-user <u>      Usuário admin inicial (padrão: admin).
#   --license-url <url>   Servidor de telemetria/licenças. Vazio = desligado.
#   --no-caddy            Não instalar/configurar o Caddy (usa outro proxy).
#   --no-firewall         Não mexer no ufw.
#
# Rodar de novo é seguro: nada de segredo, usuário ou projeto é sobrescrito.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI"

PANEL_DOMAIN=""
LE_EMAIL=""
ADMIN_USER="admin"
LICENSE_URL=""
COM_CADDY=1
COM_FIREWALL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel-domain) PANEL_DOMAIN="${2:-}"; shift 2 ;;
    --email)        LE_EMAIL="${2:-}"; shift 2 ;;
    --admin-user)   ADMIN_USER="${2:-admin}"; shift 2 ;;
    --license-url)  LICENSE_URL="${2:-}"; shift 2 ;;
    --no-caddy)     COM_CADDY=0; shift ;;
    --no-firewall)  COM_FIREWALL=0; shift ;;
    -h|--help)      sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

azul()  { printf '\033[1;35m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
erro()  { printf '  \033[0;31m✗\033[0m %s\n' "$*" >&2; }

azul ""
azul "  NASCERA — instalação do servidor"
azul ""

# ── 0. pré-requisitos ──
if [[ "$(id -u)" -ne 0 ]]; then
  erro "Rode como root:  sudo bash install-vps.sh ..."
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  erro "Este instalador é para Ubuntu/Debian (apt). Em outra distro, siga o SETUP-VPS.md."
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive

echo "→ Pacotes base"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git rsync ufw build-essential python3 bubblewrap >/dev/null
ok "curl, git, rsync, ufw, build-essential, bubblewrap"

# ── 1. Node 22.22.2+ / 24.15.0+ / 26+ (o que o package.json exige) ──
echo "→ Node.js"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$MAJOR" -ge 22 ]] && NODE_OK=1
fi
if [[ "$NODE_OK" -eq 1 ]]; then
  ok "Node $(node -v) já instalado"
else
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) instalado"
fi

# ── 2. PM2 e Claude CLI ──
echo "→ PM2 e Claude Code"
command -v pm2 >/dev/null 2>&1 || npm install -g pm2 --silent >/dev/null 2>&1
ok "PM2 $(pm2 -v 2>/dev/null || echo '?')"
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code já instalado"
else
  npm install -g @anthropic-ai/claude-code --silent >/dev/null 2>&1 || true
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code instalado"
  else
    aviso "Claude Code não instalou — rode depois: npm i -g @anthropic-ai/claude-code"
  fi
fi

# ── 2b. usuário claude-runner (sandbox de execução) ──
# Todo processo de IA (chat e terminal) roda como este usuário sem privilégio,
# nunca como root — server.js e servicos/terminal-ws.js dependem dele existir.
# /root precisa de bit de travessia (só x, sem r/w) para o claude-runner
# alcançar a pasta de projetos, que mora dentro do $HOME do root nesta VPS.
echo "→ Usuário do sandbox (claude-runner)"
if id claude-runner >/dev/null 2>&1; then
  ok "usuário claude-runner já existe"
else
  useradd -m -s /bin/bash claude-runner
  ok "usuário claude-runner criado"
fi
chmod 711 /root
ok "/root com travessia liberada para o sandbox (711)"
if [[ -f /root/.claude/.credentials.json ]]; then
  node -e "require('./claude-auth.js').propagateClaudeAuth()" 2>/dev/null \
    && ok "credencial do Claude propagada para claude-runner" \
    || aviso "não consegui propagar a credencial do Claude agora — rode depois: node -e \"require('./claude-auth.js').propagateClaudeAuth()\""
fi

# ── 3. dependências do projeto ──
echo "→ Dependências do NASCERA"
npm install --omit=dev --silent >/dev/null 2>&1
ok "node_modules pronto"

# ── 3b. navegador (extrator de UX e thumbnails) ──
# Sem isto, as duas ferramentas morrem com "Could not find Chrome". O
# chromium do apt no Ubuntu é um invólucro de snap, confinado por AppArmor —
# abre e depois falha ao escrever o perfil. O caminho que funciona é o
# Chrome for Testing que o próprio puppeteer baixa, mais as libs de sistema
# que ele linka (sem elas o processo morre com código 127, sem explicação).
echo "→ Navegador para extração e thumbnails"
apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 >/dev/null 2>&1 \
  || apt-get install -y -qq libnss3 libnspr4 libasound2 >/dev/null 2>&1 || true
if npx --yes puppeteer browsers install chrome >/dev/null 2>&1; then
  ok "Chrome instalado"
else
  aviso "Chrome não instalou — extrator de UX e thumbnails ficarão indisponíveis."
  aviso "Depois, rode: cd $(pwd) && npx puppeteer browsers install chrome"
fi

# ── 4. segredos únicos (.env) ──
echo "→ Segredos desta instalação"
if [[ -f .env ]]; then
  ok ".env já existe (preservado)"
else
  node -e "require('./ecosystem.config.js')" >/dev/null 2>&1 || true
  [[ -f .env ]] && ok ".env criado com JWT_SECRET e senha únicos" || aviso "não consegui criar .env"
fi
chmod 600 .env 2>/dev/null || true

if [[ -n "$LICENSE_URL" ]]; then
  if grep -q '^LICENSE_SERVER_URL=' .env; then
    sed -i "s|^LICENSE_SERVER_URL=.*|LICENSE_SERVER_URL=$LICENSE_URL|" .env
  else
    echo "LICENSE_SERVER_URL=$LICENSE_URL" >> .env
  fi
  ok "telemetria apontada para $LICENSE_URL"
fi

# lê as portas do .env para usar adiante
PORT="$(grep -E '^PORT=' .env | cut -d= -f2- || echo 3333)"
PUBLISH_PORT="$(grep -E '^PUBLISH_PORT=' .env | cut -d= -f2- || echo 4102)"
ADMIN_PASS="$(grep -E '^AUTH_PASS=' .env | cut -d= -f2- || echo '')"

# ── 5. usuário admin inicial ──
echo "→ Usuário administrador"
NOVO_ADMIN=0
if [[ -f users.json ]] && [[ "$(node -p "Object.keys(JSON.parse(require('fs').readFileSync('users.json','utf8'))).length" 2>/dev/null || echo 0)" -gt 0 ]]; then
  ok "users.json já tem usuários (preservado)"
else
  node -e "
    const fs=require('fs'), os=require('os'), path=require('path');
    const u='$ADMIN_USER', p='$ADMIN_PASS';
    const base=process.env.PROJECTS_BASE||path.join(os.homedir()||'/root','Nascera AI Projects');
    const users={};
    users[u]={name:'Administrador',email:'${LE_EMAIL}'||'admin@local',password:p,role:'admin',
              createdAt:new Date().toISOString(),dataDir:path.join(base,'_userdata',u)};
    fs.writeFileSync('users.json', JSON.stringify(users,null,2));
  "
  NOVO_ADMIN=1
  ok "admin '$ADMIN_USER' criado"
fi

# ── 6. firewall ──
if [[ "$COM_FIREWALL" -eq 1 ]]; then
  echo "→ Firewall"
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
  ok "22, 80 e 443 liberadas (portas internas ficam fechadas)"
fi

# ── 7. Caddy (HTTPS automático) ──
if [[ "$COM_CADDY" -eq 1 ]]; then
  echo "→ Caddy"
  if command -v caddy >/dev/null 2>&1; then
    ok "Caddy já instalado"
  else
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
    ok "Caddy instalado"
  fi
  mkdir -p /etc/caddy
  if [[ -n "$LE_EMAIL" ]]; then
    grep -q "email $LE_EMAIL" /etc/caddy/Caddyfile 2>/dev/null || true
  fi
fi

# ── 8. IP público + config de domínios ──
echo "→ Configuração de domínios"
IP_PUB=""
for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
  IP_PUB="$(curl -fsS --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$IP_PUB" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || IP_PUB=""
done
[[ -n "$IP_PUB" ]] && ok "IP público: $IP_PUB" || aviso "não descobri o IP público (preencha no painel)"

AUTO_CADDY="false"; [[ "$COM_CADDY" -eq 1 ]] && AUTO_CADDY="true"
node -e "
  const fs=require('fs');
  let cfg={}; try{cfg=JSON.parse(fs.readFileSync('nascera-config.json','utf8'));}catch{}
  cfg.domains = Object.assign({}, cfg.domains, {
    serverIp: '$IP_PUB' || (cfg.domains&&cfg.domains.serverIp) || '',
    panelDomain: '$PANEL_DOMAIN' || (cfg.domains&&cfg.domains.panelDomain) || '',
    panelPort: parseInt('$PORT',10)||3333,
    publishPort: parseInt('$PUBLISH_PORT',10)||4102,
    sslMode: 'proxy',
    autoCaddy: $AUTO_CADDY,
    caddyfilePath: '/etc/caddy/Caddyfile',
    leEmail: '$LE_EMAIL' || (cfg.domains&&cfg.domains.leEmail) || ''
  });
  fs.writeFileSync('nascera-config.json', JSON.stringify(cfg,null,2));
"
ok "nascera-config.json atualizado"

# ── 9. Caddyfile inicial ──
# Gerado pelo próprio motor (inclusive o bloco do e-mail), porque o arquivo é
# reescrito a cada domínio verificado — nada aqui pode ser feito à mão.
if [[ "$COM_CADDY" -eq 1 ]]; then
  node -e "
    const d=require('./domains.js'); const fs=require('fs');
    fs.writeFileSync('/etc/caddy/Caddyfile', d.caddyfile());
  "
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy >/dev/null 2>&1 || aviso "Caddy não reiniciou — veja: journalctl -u caddy -n 30"
  ok "Caddyfile aplicado"
fi

# ── 10. subir os processos ──
echo "→ Processos (PM2)"
pm2 delete nascera nascera-preview nascera-publish >/dev/null 2>&1 || true
pm2 start ecosystem.config.js >/dev/null 2>&1
pm2 save >/dev/null 2>&1
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
ok "nascera, nascera-preview e nascera-publish no ar"

# ── 11. conferência ──
echo "→ Conferência"
sleep 3
SAUDE="$(curl -fsS --max-time 8 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo '')"
if [[ "$SAUDE" == *'"ok"'* ]]; then ok "painel respondendo na porta $PORT"; else erro "painel não respondeu — pm2 logs nascera"; fi
PUB="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PUBLISH_PORT/" 2>/dev/null || echo '000')"
[[ "$PUB" != "000" ]] && ok "servidor de sites respondendo na porta $PUBLISH_PORT" || erro "servidor de sites mudo — pm2 logs nascera-publish"

azul ""
azul "  ════════════════════════════════════════════════"
azul "   NASCERA instalado"
azul "  ════════════════════════════════════════════════"
echo ""
if [[ -n "$PANEL_DOMAIN" ]]; then
  echo "   Painel:   https://$PANEL_DOMAIN"
  echo "             (aponte um registro A de $PANEL_DOMAIN para $IP_PUB)"
else
  echo "   Painel:   http://$IP_PUB:$PORT"
  echo "             (sem domínio do painel: rode de novo com --panel-domain para ter HTTPS)"
fi
if [[ "$NOVO_ADMIN" -eq 1 ]]; then
  echo ""
  echo "   Usuário:  $ADMIN_USER"
  echo "   Senha:    $ADMIN_PASS"
  echo "   ↑ anote agora: esta senha está no .env e não será mostrada de novo"
fi
echo ""
echo "   Sites dos clientes: apontar registro A para  $IP_PUB"
echo "   HTTPS: automático — cada domínio verificado no painel entra no Caddy sozinho."
echo ""
echo "   Comandos úteis:"
echo "     pm2 logs nascera          # o que o painel está fazendo"
echo "     pm2 restart nascera       # reiniciar"
echo "     systemctl status caddy  # estado do HTTPS"
echo ""
