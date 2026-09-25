#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Instalador — Sistema Nascera (servidor web)
#
# Instala as dependências e explica como subir. Nada aqui cria usuário nem
# senha: a conta de administrador nasce na PRIMEIRA TELA do NASCERA, com o
# código de instalação que o próprio servidor imprime no terminal.
#
# Por que isto está escrito aqui: até esta versão o passo final mandava
# "troque AUTH_PASS" e prometia login com AUTH_USER/AUTH_PASS. Nenhum dos
# dois autentica coisa alguma — `process.env.AUTH_PASS` não é lido em ponto
# nenhum do servidor, e o login real é `users.json` + scrypt (`senhas.js`).
# O resultado prático foi um cliente recebendo por escrito uma senha que
# não funcionava e ficando trancado para fora do próprio sistema.
#
# Instalação completa de VPS (Node, PM2, firewall, Caddy com HTTPS e os
# domínios personalizados) é o `install-vps.sh`, não este arquivo.
# ═══════════════════════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")"

echo "==> Sistema Nascera — instalação"

if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não encontrado. Instale Node 18+ antes de continuar." >&2
  exit 1
fi

echo "==> Instalando dependências (npm install)..."
npm install --omit=dev

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> PM2 não encontrado. Instalando globalmente..."
  npm install -g pm2 || echo "AVISO: não consegui instalar PM2 globalmente. Rode: npm i -g pm2"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "AVISO: Claude Code CLI ('claude') não encontrado no PATH."
  echo "       O sistema precisa dele como motor de IA. Veja https://docs.claude.com/claude-code"
fi

# ─── Em qual porta o painel vai atender ────────────────────────────────
# A mesma ordem de precedência do server.js (ambiente > .env > 3333), pela
# mesma razão do iniciar.bat do Windows: se a mensagem final chutar um
# número, ela manda o cliente para uma página de erro. Instalação nova ainda
# não tem .env (ele nasce no primeiro `pm2 start`) e cai no padrão; VPS que
# já roda em 3334 tem a linha gravada e continua nela.
PORTA="${PORT:-}"
if [ -z "$PORTA" ] && [ -f .env ]; then
  PORTA="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'"'"']\{0,1\}\([^"'"'"']*\).*/\1/p' .env | tail -n 1 | tr -d '[:space:]')"
fi
[ -n "$PORTA" ] || PORTA=3333

# Só número vira endereço. Qualquer outra coisa no .env (variável, lixo) e a
# instrução passa a mandar ler o log — melhor do que imprimir um endereço
# que não existe.
case "$PORTA" in
  *[!0-9]*|'') ENDERECO='' ;;
  *)           ENDERECO="http://SEU-IP:$PORTA" ;;
esac

echo ""
echo "==> Dependências instaladas."
echo ""
echo "    PRÓXIMOS PASSOS:"
echo "    1) pm2 start ecosystem.config.js && pm2 save"
if [ -f .env ]; then
  # Reinstalação: o .env desta máquina já existe e NÃO é tocado. Dizer
  # "cria o .env" aqui daria a entender que os segredos foram trocados —
  # e quem lesse isso poderia sair procurando a senha nova.
  echo "       O .env desta máquina já existe e é preservado: os segredos e a"
  echo "       porta continuam os mesmos."
else
  echo "       A primeira subida cria o .env com os segredos ÚNICOS desta"
  echo "       máquina. Não há arquivo de configuração para editar à mão."
fi
if [ -n "$ENDERECO" ]; then
  echo "    2) Abra no navegador:  $ENDERECO"
else
  echo "    2) Abra o endereço que aparece no log, na linha que começa com"
  echo "       'Main:'  —  pm2 logs nascera --lines 40"
fi
echo "    3) A tela pede um CÓDIGO DE INSTALAÇÃO, e com ele VOCÊ cria a"
echo "       conta de administrador (usuário e senha escolhidos por você)."
echo ""
echo "       O código não aparece aqui e não vem por e-mail: quem o imprime"
echo "       é o servidor ao subir, na linha 'PRIMEIRO ACESSO'. Para ver:"
echo "          pm2 logs nascera --lines 40"
echo ""
echo "    NÃO existe senha padrão. Se alguém te entregou uma, ela não vale."
echo ""
echo "    Opcional: para ligar a telemetria/licenças, grave a linha"
echo "    LICENSE_SERVER_URL=https://... no .env e rode  pm2 restart nascera."
