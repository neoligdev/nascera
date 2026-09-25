#Requires -Version 5.1
# =======================================================================
# NASCERA — instalador para Windows 10/11 (PowerShell)
#
# Equivalente do install.sh, na mesma ordem: confere o Node, instala as
# dependências e diz o que fazer em seguida.
#
# COMO ISTO É USADO
#   O caminho normal do cliente é dar dois cliques no instalar.bat, que
#   chama este arquivo. O .bat existe porque o Windows recusa .ps1 de
#   fábrica e responde em inglês sobre "execution policy" — e quem comprou
#   um infoproduto para ali. Toda a inteligência da instalação continua
#   aqui; o .bat é só a porta.
#
#   Para quem prefere o PowerShell, dentro da pasta do NASCERA:
#     powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# O "-ExecutionPolicy Bypass" existe porque o Windows vem de fábrica
# bloqueando script .ps1 baixado da internet. Ele vale só para ESTA
# execução: não afrouxa a segurança da máquina depois que o script termina.
#
# CÓDIGOS DE SAÍDA — o instalar.bat depende deles
#   0  instalou.
#   2  este script rodou e PAROU por um motivo que ele já explicou na tela.
#   1  (ou qualquer outro) não vem daqui: é o PowerShell dizendo que nem
#      chegou a executar o arquivo — política de grupo, antivírus, script
#      ausente. Sem essa distinção o .bat mandaria a pessoa "corrigir o
#      item acima" numa tela onde não há item nenhum acima.
#
# Duas diferenças propositais em relação ao install.sh, ambas porque a
# instalação Windows é de uso PESSOAL (uma pessoa, uma máquina):
#   • Não instala PM2. No Windows o PM2 não sobe sozinho com o sistema
#     (`pm2 startup` não existe lá), então ele daria trabalho sem entregar
#     o que entrega no Linux. Aqui o jeito de subir é `npm start`.
#   • Não avisa "instale o Claude CLI": desde a v2 do motor o CLI vem
#     DENTRO da @anthropic-ai/claude-agent-sdk, num pacote por plataforma
#     (ver binarioEmbarcado em motores.js). O `npm install` abaixo já traz
#     o claude.exe; o que este script faz é CONFERIR se ele chegou.
# =======================================================================

# Para no primeiro erro de cmdlet — instalação que segue depois de falhar
# entrega uma pasta pela metade e o erro só aparece lá na frente, sem dono.
$ErrorActionPreference = 'Stop'

# O texto deste arquivo é UTF-8 (tem acento). Sem isto, um console em
# code page antiga imprime "instalaÃ§Ã£o" e assusta quem está instalando.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$LINK_NODE = 'https://nodejs.org/pt-br/download'

# ─── Auxiliares ───────────────────────────────────────────────────────

function Escrever {
    param([string]$Texto = '', [string]$Cor = 'Gray')
    Write-Host $Texto -ForegroundColor $Cor
}

# Comando nativo (node, npm) não respeita $ErrorActionPreference: quem diz
# se deu certo é o código de saída. Pior: o npm escreve aviso no stderr até
# quando dá certo, e com 'Stop' ligado isso pode virar exceção no meio de
# uma instalação saudável. Por isso afrouxamos SÓ durante a chamada e
# julgamos pelo $LASTEXITCODE, que é o único sinal confiável.
function Invoke-Nativo {
    param(
        [string]$Arquivo,
        [string[]]$Argumentos = @(),
        [string]$Falha = 'comando externo falhou'
    )
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Arquivo @Argumentos
        $codigo = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $anterior
    }
    if ($codigo -ne 0) { throw "$Falha (código de saída: $codigo)" }
}

# Igual ao de cima, mas capturando a saída em vez de imprimir.
function Get-SaidaNativa {
    param([string]$Arquivo, [string[]]$Argumentos = @())
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $saida = & $Arquivo @Argumentos 2>&1 } catch { $saida = @() } finally { $ErrorActionPreference = $anterior }
    return ((@($saida) -join "`n").Trim())
}

# "v22.22.3" -> [version] 22.22.3. Sufixo de pré-lançamento ("-nightly")
# é descartado: para decidir se a versão serve, só os números importam.
function ConvertTo-Versao {
    param([string]$Texto)
    if ([string]::IsNullOrWhiteSpace($Texto)) { return $null }
    $t = $Texto.Trim()
    $t = $t -replace '^[v=\s]+', ''
    $t = $t -replace '[-+].*$', ''
    $numeros = @()
    foreach ($parte in ($t -split '\.')) {
        if ($parte -match '^\d+$') { $numeros += [int]$parte } else { return $null }
    }
    if ($numeros.Count -eq 0) { return $null }
    while ($numeros.Count -lt 3) { $numeros += 0 }
    return [version]::new($numeros[0], $numeros[1], $numeros[2])
}

# Um comparador só ("^22.22.2", ">=26.0.0"). Devolve $true, $false — ou
# $null quando NÃO souber ler a exigência. Esse terceiro estado importa:
# sem ele, uma sintaxe nova no package.json viraria "sua versão não serve"
# e travaria a instalação de um cliente por um bug nosso.
function Test-Comparador {
    param([version]$Versao, [string]$Comparador)

    $c = $Comparador.Trim()
    if ($c -eq '') { return $null }

    if ($c.StartsWith('^')) {
        $minimo = ConvertTo-Versao ($c.Substring(1))
        if ($null -eq $minimo) { return $null }
        $teto = [version]::new(($minimo.Major + 1), 0, 0)
        return ($Versao -ge $minimo -and $Versao -lt $teto)
    }
    if ($c.StartsWith('~')) {
        $minimo = ConvertTo-Versao ($c.Substring(1))
        if ($null -eq $minimo) { return $null }
        $teto = [version]::new($minimo.Major, ($minimo.Minor + 1), 0)
        return ($Versao -ge $minimo -and $Versao -lt $teto)
    }
    foreach ($op in @('>=', '<=', '>', '<', '=')) {
        if ($c.StartsWith($op)) {
            $alvo = ConvertTo-Versao ($c.Substring($op.Length))
            if ($null -eq $alvo) { return $null }
            if ($op -eq '>=') { return ($Versao -ge $alvo) }
            if ($op -eq '<=') { return ($Versao -le $alvo) }
            if ($op -eq '>')  { return ($Versao -gt $alvo) }
            if ($op -eq '<')  { return ($Versao -lt $alvo) }
            return ($Versao -eq $alvo)
        }
    }
    $alvo = ConvertTo-Versao $c
    if ($null -eq $alvo) { return $null }
    return ($Versao -eq $alvo)
}

# A faixa inteira do "engines.node" — cláusulas separadas por "||" (OU),
# comparadores separados por espaço dentro da cláusula (E).
# Devolve 'ok', 'nao' ou 'ilegivel'.
function Test-Engines {
    param([version]$Versao, [string]$Faixa)

    $ilegivel = $false
    foreach ($clausula in ($Faixa -split '\|\|')) {
        $comparadores = @($clausula.Trim() -split '\s+' | Where-Object { $_ -ne '' })
        if ($comparadores.Count -eq 0) { continue }
        $cumpreTodos = $true
        foreach ($cmp in $comparadores) {
            $r = Test-Comparador -Versao $Versao -Comparador $cmp
            if ($null -eq $r) { $ilegivel = $true; $cumpreTodos = $false; break }
            if (-not $r) { $cumpreTodos = $false; break }
        }
        if ($cumpreTodos) { return 'ok' }
    }
    if ($ilegivel) { return 'ilegivel' }
    return 'nao'
}

# Em qual porta o painel vai atender. Mesma ordem de precedência do
# server.js — ambiente > .env > 3333 — e a mesma que o iniciar.bat já
# reproduz. Devolve $null quando o .env traz um PORT que não é número:
# nesse caso a instrução manda ler o log em vez de imprimir um endereço
# inventado, porque mandar o cliente para a página de erro do navegador no
# fim de uma instalação que deu certo é o pior momento possível para errar.
#
# 3333 é a porta ÚNICA do NASCERA (ver o cabeçalho do ecosystem.config.js).
# Se um dia o padrão do server.js mudar, esta constante muda junto —
# testes/porta-unica.test.js falha se elas se separarem.
function Obter-Porta {
    param([string]$Raiz)

    $valor = $env:PORT
    if ([string]::IsNullOrWhiteSpace($valor)) {
        $envFile = Join-Path $Raiz '.env'
        if (Test-Path -LiteralPath $envFile) {
            foreach ($linha in (Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue)) {
                $t = $linha.Trim()
                if ($t -eq '' -or $t.StartsWith('#')) { continue }
                if ($t -match '^PORT\s*=\s*(.*)$') { $valor = $Matches[1].Trim().Trim('"').Trim("'") }
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($valor)) { return '3333' }
    if ($valor -match '^\d+$') { return $valor }
    return $null
}

# ─── Instalação ───────────────────────────────────────────────────────

try {
    # Roda a partir da pasta do próprio script, não de onde o PowerShell
    # foi aberto — senão o npm instalaria as dependências no lugar errado.
    # $PSScriptRoot vem vazio quando alguém cola o conteúdo do arquivo na
    # janela em vez de executá-lo; aí a pasta atual é o melhor palpite, e
    # o teste do package.json logo abaixo pega o caso de ser a pasta errada.
    $RAIZ = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($RAIZ)) { $RAIZ = (Get-Location).Path }
    # -LiteralPath porque o caminho pode ter espaço ou acento.
    Set-Location -LiteralPath $RAIZ

    Escrever ''
    Escrever '==> Sistema Nascera — instalação (Windows)' 'Cyan'
    Escrever "    Pasta: $RAIZ"
    Escrever ''

    # O Windows tem limite histórico de 260 caracteres no caminho, e a
    # node_modules aninha fundo. Numa pasta longa o npm falha com erros
    # incompreensíveis (ENOENT em arquivo que existe) — avisar antes é
    # mais barato que depurar depois.
    if ($RAIZ.Length -gt 90) {
        Escrever '  !  O caminho desta pasta é longo. Se o npm falhar com erros' 'Yellow'
        Escrever '     estranhos de arquivo, mova o NASCERA para algo curto como C:\nascera' 'Yellow'
        Escrever ''
    }

    # ─── 1. Node.js presente? ─────────────────────────────────────────
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Escrever 'ERRO: o Node.js não está instalado (ou não está no PATH).' 'Red'
        Escrever ''
        Escrever '  Como resolver:' 'Yellow'
        Escrever "    1) Baixe o Node.js em $LINK_NODE"
        Escrever '       Clique no botão LTS (o recomendado), NÃO no "Current".'
        Escrever '    2) Instale com as opções padrão (deixe marcado "Add to PATH").'
        # "esta janela" e não "esta janela do PowerShell": quando o cliente
        # veio pelo instalar.bat, a janela na frente dele é a do prompt.
        Escrever '    3) FECHE esta janela — o PATH só vale para janelas abertas'
        Escrever '       depois da instalação do Node.'
        Escrever '    4) Rode o instalador de novo: dois cliques no instalar.bat.'
        Escrever ''
        exit 2
    }

    # ─── 2. A versão do Node atende o engines do package.json? ────────
    $pkgPath = Join-Path $RAIZ 'package.json'
    if (-not (Test-Path -LiteralPath $pkgPath)) {
        throw "package.json não encontrado em $RAIZ — o install.ps1 precisa rodar de dentro da pasta do NASCERA."
    }
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $faixa = $null
    if ($pkg.PSObject.Properties.Name -contains 'engines' -and $pkg.engines) {
        $faixa = [string]$pkg.engines.node
    }

    $nodeVersaoTexto = Get-SaidaNativa 'node' @('--version')
    $nodeVersao = ConvertTo-Versao $nodeVersaoTexto

    if ($null -eq $nodeVersao) {
        # O `node --version` respondeu, mas com algo que não é versão.
        # Isso é um Node quebrado — seguir daqui só empurra o erro adiante.
        throw "não consegui ler a versão do Node.js (resposta: '$nodeVersaoTexto'). Reinstale o Node por $LINK_NODE."
    }

    Escrever "  -  Node.js encontrado: $nodeVersaoTexto  ($($nodeCmd.Source))"

    if ([string]::IsNullOrWhiteSpace($faixa)) {
        Escrever '  !  O package.json não declara "engines.node" — seguindo sem conferir a versão.' 'Yellow'
    } else {
        $veredito = Test-Engines -Versao $nodeVersao -Faixa $faixa
        if ($veredito -eq 'nao') {
            Escrever ''
            Escrever 'ERRO: esta versão do Node.js não serve para o NASCERA.' 'Red'
            Escrever ''
            Escrever "    Instalada:  $nodeVersaoTexto"
            Escrever "    Necessária: $faixa"
            Escrever ''
            Escrever '  Por que isto é bloqueio e não aviso:' 'Yellow'
            Escrever '    O NASCERA redimensiona imagem (que é serviço PAGO) com a biblioteca'
            Escrever '    sharp, e grava o estado — projetos, saldo, usuários — com escrita'
            Escrever '    atômica. Nenhuma das duas tem suporte fora dessa faixa. Instalar'
            Escrever '    assim mesmo entregaria imagem na medida errada e risco de perder'
            Escrever '    arquivo de estado numa queda de energia.'
            Escrever ''
            Escrever '  Como resolver:' 'Yellow'
            Escrever "    1) Baixe o Node.js em $LINK_NODE"
            Escrever '       Clique no botão LTS (o recomendado): a LTS que está no ar'
            Escrever '       hoje sempre atende a faixa acima. A "Current" é de testes e'
            Escrever '       pode ou não atender, dependendo do mês — não vale o risco.'
            Escrever '    2) Instale por cima (ele substitui a versão antiga).'
            Escrever '    3) FECHE esta janela.'
            Escrever '    4) Rode o instalador de novo: dois cliques no instalar.bat.'
            Escrever ''
            exit 2
        } elseif ($veredito -eq 'ilegivel') {
            Escrever "  !  Não consegui interpretar a exigência de versão ('$faixa')." 'Yellow'
            Escrever '     Seguindo assim mesmo. Se algo falhar adiante, é por aqui que se começa.' 'Yellow'
        } else {
            Escrever "  -  Versão compatível com a exigência do projeto ($faixa)" 'Green'
        }
    }

    # ─── 3. npm presente? ─────────────────────────────────────────────
    # O npm vem junto com o Node; se sumiu, a instalação do Node está pela
    # metade e é melhor dizer isso do que estourar no meio do download.
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        Escrever ''
        Escrever 'ERRO: o npm não foi encontrado, mesmo com o Node instalado.' 'Red'
        Escrever "     Reinstale o Node.js por $LINK_NODE e abra um PowerShell novo." 'Red'
        Escrever ''
        exit 2
    }

    # ─── 4. Dependências ──────────────────────────────────────────────
    Escrever ''
    Escrever '==> Instalando dependências (npm install --omit=dev)...' 'Cyan'
    Escrever '    São várias centenas de megabytes: leva de 3 a 10 minutos.'
    Escrever '    É normal aparecer aviso amarelo (npm WARN) pelo caminho.'
    Escrever ''
    try {
        Invoke-Nativo -Arquivo 'npm' -Argumentos @('install', '--omit=dev') -Falha 'o npm install falhou'
    } catch {
        Escrever ''
        Escrever "ERRO: $($_.Exception.Message)" 'Red'
        Escrever ''
        Escrever '  O que costuma ser:' 'Yellow'
        Escrever '    • Internet caiu no meio / proxy da empresa bloqueando: rode de novo.'
        Escrever '    • Antivírus segurando arquivo dentro de node_modules: apague a pasta'
        Escrever '      node_modules e rode de novo.'
        Escrever '    • Erro citando "node-gyp", "MSBuild" ou "Visual Studio": alguma peça'
        Escrever '      precisou ser compilada na sua máquina. Instale o "Visual Studio'
        Escrever '      Build Tools" com a carga "Desktop development with C++" e o Python 3,'
        Escrever '      depois rode o instalador de novo.'
        Escrever ''
        exit 2
    }

    # ─── 5. O motor de IA veio junto? ─────────────────────────────────
    # Conferir agora, e não na primeira conversa do cliente: um pacote de
    # plataforma que não chegou vira "o NASCERA não responde" lá na frente,
    # sem pista nenhuma de causa.
    $arch = Get-SaidaNativa 'node' @('-p', 'process.arch')
    $cliEmbarcado = Join-Path $RAIZ ("node_modules\@anthropic-ai\claude-agent-sdk-win32-$arch\claude.exe")
    if (Test-Path -LiteralPath $cliEmbarcado) {
        Escrever ''
        Escrever '  -  Motor de IA (Claude CLI) instalado junto com o NASCERA.' 'Green'
    } elseif (Get-Command claude -ErrorAction SilentlyContinue) {
        Escrever ''
        Escrever '  !  O CLI que vem junto com o NASCERA não apareceu, mas existe um' 'Yellow'
        Escrever '     "claude" instalado na máquina. O NASCERA vai usar esse.' 'Yellow'
    } else {
        Escrever ''
        Escrever '  !  AVISO: não encontrei o motor de IA (claude.exe).' 'Yellow'
        Escrever "     Esperava em: $cliEmbarcado" 'Yellow'
        Escrever '     O NASCERA sobe assim mesmo e o painel mostra o diagnóstico, mas o' 'Yellow'
        Escrever '     chat de IA não vai funcionar. Rodar o instalador de novo com a' 'Yellow'
        Escrever '     internet estável costuma resolver.' 'Yellow'
    }

    # ─── 6. Próximos passos ───────────────────────────────────────────
    # A instrução muda conforme o que existe NA PASTA. Mandar dar dois
    # cliques num arquivo que não está ali seria a pior mentira possível:
    # logo no fim de uma instalação que deu certo, com a pessoa animada.
    $temIniciarBat = Test-Path -LiteralPath (Join-Path $RAIZ 'iniciar.bat')
    # O endereço não pode ser chutado: numa pasta com .env que já traga
    # PORT=3400, dizer "3333" manda a pessoa para a página de erro.
    $porta = Obter-Porta -Raiz $RAIZ

    Escrever ''
    Escrever '==> Dependências instaladas.' 'Green'
    Escrever ''
    Escrever '    PRÓXIMOS PASSOS:' 'Cyan'
    if ($temIniciarBat) {
        Escrever '    1) Feche esta janela e dê DOIS CLIQUES no arquivo:'
        Escrever '           iniciar.bat'
        Escrever '       Ele sobe o NASCERA e abre o navegador sozinho.'
        Escrever '    2) O NASCERA passa a rodar numa janela chamada NASCERA - SERVIDOR.'
        Escrever '       Deixe ELA aberta: fechá-la desliga o NASCERA.'
        Escrever '    3) Na primeira vez, essa janela mostra um CÓDIGO DE INSTALAÇÃO,'
        Escrever '       na linha PRIMEIRO ACESSO. Digite-o na tela de criação da'
        Escrever '       conta e escolha ali o seu usuário e a sua senha.'
    } else {
        Escrever '    1) Suba o NASCERA, nesta mesma janela:'
        Escrever '           npm start'
        Escrever '    2) Deixe a janela ABERTA. Fechar a janela desliga o NASCERA.'
        if ($porta) {
            Escrever "    3) Abra no navegador:  http://localhost:$porta"
        } else {
            Escrever '    3) Abra o endereço que a janela mostrar na linha  Main:'
            Escrever '       (o .env desta pasta tem um PORT que não é um número).'
        }
        Escrever '    4) Na primeira vez, o terminal mostra um CÓDIGO DE INSTALAÇÃO,'
        Escrever '       na linha PRIMEIRO ACESSO. Digite-o na tela de criação da'
        Escrever '       conta e escolha ali o seu usuário e a sua senha.'
    }
    Escrever ''
    Escrever '    NÃO existe senha padrão, e nenhum arquivo de configuração' 'Cyan'
    Escrever '    precisa ser editado: a chave de sessão é criada sozinha e o' 'Cyan'
    Escrever '    NASCERA escuta só nesta máquina (localhost), sem abrir nada' 'Cyan'
    Escrever '    para a rede. Se alguém te entregou uma senha pronta, ela' 'Cyan'
    Escrever '    não vale — quem cria a conta é você, com o código acima.' 'Cyan'
    Escrever ''
    Escrever '    Passo a passo completo (e o que ainda não funciona no Windows):'
    Escrever '    README-WINDOWS.md'
    Escrever ''
}
catch {
    # Rede de segurança: qualquer erro não previsto acima chega aqui com
    # mensagem visível e código de saída 2 — nunca "terminou" em silêncio.
    Escrever ''
    Escrever 'A INSTALAÇÃO PAROU.' 'Red'
    Escrever "  $($_.Exception.Message)" 'Red'
    Escrever ''
    Escrever '  Nada ficou pela metade de propósito: corrija o item acima e rode' 'Yellow'
    Escrever '  o instalador de novo — repetir a instalação é seguro.' 'Yellow'
    Escrever ''
    exit 2
}

exit 0
