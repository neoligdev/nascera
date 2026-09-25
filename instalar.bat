@echo off
rem ======================================================================
rem  NASCERA - INSTALADOR DE DOIS CLIQUES - Windows 10 e 11
rem
rem  Esta e a porta de entrada de quem nao usa terminal. Dois cliques.
rem
rem  POR QUE UM .BAT, SE JA EXISTE O install.ps1
rem  O install.ps1 continua sendo o instalador de verdade. O problema nao
rem  esta nele: o Windows recusa script .ps1 de fabrica e responde com um
rem  erro em ingles sobre "execution policy". Quem comprou um infoproduto
rem  para ali e nao volta. Um .bat abre com dois cliques, sem politica e
rem  sem pedir senha de administrador. Entao a porta e este arquivo, que
rem  chama o install.ps1 ja com o -ExecutionPolicy Bypass embutido. Esse
rem  Bypass vale SO para esta execucao: nada fica afrouxado na maquina
rem  depois que o instalador termina.
rem
rem  POR QUE ELE NAO REFAZ A INSTALACAO EM BATCH
rem  Uma das tarefas do instalador e conferir se a versao do Node atende o
rem  campo "engines" do package.json, que e uma faixa de semver com OU,
rem  circunflexo e maior-ou-igual. Batch nao compara isso sem virar codigo
rem  ilegivel, e o install.ps1 ja faz essa conta. Duas implementacoes da
rem  mesma regra sairiam de sincronia na primeira vez que o engines
rem  mudasse - e a que mente e sempre a que ninguem esta olhando. Uma
rem  porta de entrada, um motor so.
rem
rem  ACENTUACAO - decisao consciente
rem  Este arquivo escreve tudo SEM acento. O console do Windows nao usa
rem  UTF-8 por padrao, e a alternativa - um chcp 65001 na primeira linha -
rem  troca o code page enquanto o proprio .bat ainda esta sendo lido do
rem  disco, o que e causa conhecida de o resto do arquivo ser interpretado
rem  errado. Texto sem acento le bem em qualquer code page e nao arrisca
rem  nada. O install.ps1 acerta o encoding por conta propria, entao a
rem  parte demorada da instalacao aparece com acento normalmente.
rem
rem  Todo caminho vai entre aspas: pasta de usuario com espaco no nome,
rem  como C:\Users\Maria Silva\Downloads\nascera, e o padrao no Windows.
rem ======================================================================

setlocal
title NASCERA - Instalacao

rem Trabalha na pasta do proprio .bat. Dois cliques nem sempre abrem o
rem prompt aqui, e sem isto o npm instalaria as dependencias em outro
rem lugar - normalmente em C:\Windows\System32.
cd /d "%~dp0"

echo.
echo  ==================================================
echo    NASCERA - instalacao no Windows
echo  ==================================================
echo.

rem Estar na pasta certa e pre-requisito de tudo. Este teste tambem pega
rem o erro mais comum de todos: dar dois cliques no .bat de DENTRO do
rem arquivo ZIP, sem extrair - o Windows copia so o .bat para uma pasta
rem temporaria e nada mais existe do lado dele.
if not exist "package.json" goto :PASTA_ERRADA
if not exist "install.ps1" goto :FALTA_PS1

rem Prefere o caminho absoluto do PowerShell a depender do PATH: PATH
rem quebrado e comum em maquina que ja passou por muita instalacao, e o
rem PowerShell 5.1 sempre mora aqui no Windows 10 e 11.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%PS%" goto :EXECUTAR
set "PS=powershell.exe"
where /q powershell.exe
if errorlevel 1 goto :FALTA_POWERSHELL

:EXECUTAR
echo  Vou instalar as pecas que o NASCERA usa. Leva de 3 a 10 minutos,
echo  dependendo da sua internet.
echo.
echo  E normal aparecer MUITO texto e algumas linhas amarelas de aviso.
echo  Nao feche esta janela ate o fim.
echo.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

rem O codigo de saida e guardado na hora: qualquer comando depois disto
rem sobrescreve o ERRORLEVEL. 0 = instalou. 2 = o install.ps1 rodou e
rem parou com um motivo que ele mesmo ja explicou na tela. Qualquer outro
rem valor significa que o script nem chegou a rodar, e ai a mensagem tem
rem de ser outra - dizer "corrija o item acima" quando nao ha item nenhum
rem acima e mandar a pessoa procurar o que nao existe.
set "CODIGO=%ERRORLEVEL%"

if "%CODIGO%"=="0" goto :PRONTO
if "%CODIGO%"=="2" goto :PAROU
goto :NAO_EXECUTOU

rem ---------------------------------------------------------------------
:PRONTO
echo.
echo  ==================================================
echo    INSTALACAO CONCLUIDA
echo  ==================================================
echo.
rem O install.ps1 so manda usar o iniciar.bat depois de conferir que ele
rem existe - o Test-Path do bloco PROXIMOS PASSOS. Esta tela aqui e
rem impressa DEPOIS da dele e e a ULTIMA que a pessoa le: sem a mesma
rem conferencia, ela desfaria a do install.ps1 e mandaria dar dois cliques
rem num arquivo que pode nao estar na pasta - no fim de uma instalacao que
rem deu certo, que e o pior lugar para mentir. Extracao incompleta do ZIP
rem e o caso real.
if not exist "iniciar.bat" goto :PRONTO_SEM_ATALHO

echo  Agora e so dar DOIS CLIQUES no arquivo:
echo.
echo      iniciar.bat
echo.
echo  Ele sobe o NASCERA e abre o navegador sozinho.
echo.
echo  Na primeira vez o site pede um CODIGO DE INSTALACAO. Ele aparece
echo  na janela preta do NASCERA, na linha PRIMEIRO ACESSO.
echo.
echo  Passo a passo completo, e o que ainda nao funciona no Windows,
echo  estao no arquivo README-WINDOWS.md
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------
rem A instalacao DEU CERTO - por isso o codigo de saida continua 0. O que
rem falta e so o atalho, e a instrucao passa a nomear o caminho que existe
rem de fato nesta pasta.
:PRONTO_SEM_ATALHO
echo  As pecas do NASCERA foram instaladas.
echo.
echo  Mas o arquivo iniciar.bat nao esta nesta pasta - quase sempre a
echo  extracao do ZIP veio incompleta. Sem ele, suba o NASCERA assim:
echo.
echo    1. clique na barra de endereco desta pasta, apague o texto,
echo       escreva  powershell  e aperte Enter;
echo    2. na janela que abrir, escreva:   npm start
echo    3. deixe essa janela ABERTA e abra no navegador:
echo       http://localhost:3333
echo.
echo  Para recuperar o iniciar.bat, extraia o NASCERA de novo a partir do
echo  arquivo original.
echo.
echo  Na primeira vez o site pede um CODIGO DE INSTALACAO. Ele aparece
echo  na janela do npm start, na linha PRIMEIRO ACESSO.
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------
:PAROU
echo.
echo  ==================================================
echo    A INSTALACAO PAROU
echo  ==================================================
echo.
echo  O motivo esta escrito acima, em vermelho, com o que fazer para
echo  resolver. Role esta janela para cima se precisar reler.
echo.
echo  Depois de resolver, e so dar dois cliques no instalar.bat de novo.
echo  Repetir a instalacao e seguro: nenhum dado seu e apagado.
echo.
pause
exit /b 2

rem ---------------------------------------------------------------------
:NAO_EXECUTOU
echo.
echo  ==================================================
echo    NAO CONSEGUI RODAR O INSTALADOR
echo  ==================================================
echo.
echo  O PowerShell devolveu o codigo %CODIGO% sem que o instalador do
echo  NASCERA chegasse ao fim. Nao sei dizer o motivo exato daqui.
echo.
echo  O que costuma ser:
echo    - maquina de empresa, onde o setor de TI trava a execucao de
echo      scripts por politica de grupo. Nesse caso o Bypass e ignorado.
echo    - antivirus segurando o arquivo install.ps1.
echo    - PowerShell danificado ou removido da maquina.
echo.
echo  Como instalar na mao, se for o seu caso:
echo    1. abra a pasta do NASCERA no Explorador de Arquivos;
echo    2. clique na barra de endereco, apague, escreva  powershell
echo       e aperte Enter;
echo    3. na janela que abrir, escreva:   npm install --omit=dev
echo.
echo  Atencao: instalando na mao ninguem confere a versao do Node. Veja
echo  a versao exigida no README-WINDOWS.md antes.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------
:PASTA_ERRADA
echo.
echo  ERRO: nao achei os arquivos do NASCERA nesta pasta.
echo.
echo  Pasta em que este instalador foi executado:
rem As aspas nao sao enfeite: nome de pasta com o sinal de "e comercial"
rem faria o echo sem aspas tentar executar o pedaco seguinte como comando.
echo  "%~dp0"
echo.
echo  Quase sempre e um destes dois casos:
echo.
echo    1. Voce deu dois cliques no instalar.bat de dentro do arquivo
echo       ZIP, sem extrair. EXTRAIA a pasta primeiro - clique com o
echo       botao direito no ZIP e escolha "Extrair tudo" - e so entao
echo       de dois cliques no instalar.bat da pasta extraida.
echo.
echo    2. O instalar.bat foi copiado sozinho para outro lugar. Ele
echo       precisa ficar junto do resto dos arquivos do NASCERA.
echo.
echo  Dica: deixe a pasta em C:\nascera. Caminho curto, sem acento e fora
echo  do OneDrive evita uma lista inteira de problemas do Windows.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------
:FALTA_PS1
echo.
echo  ERRO: o arquivo install.ps1 nao esta nesta pasta.
echo.
echo  Ele faz a instalacao de verdade, e este instalar.bat sozinho nao
echo  substitui o trabalho dele. O arquivo deve ter sido apagado, ou a
echo  extracao do ZIP veio incompleta.
echo.
echo  Extraia o NASCERA de novo, a partir do arquivo original.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------
:FALTA_POWERSHELL
echo.
echo  ERRO: nao encontrei o PowerShell nesta maquina.
echo.
echo  Ele vem de fabrica no Windows 10 e no Windows 11, entao isto
echo  costuma significar que o PATH do sistema esta danificado ou que o
echo  PowerShell foi removido.
echo.
echo  Sem ele nao da para instalar o NASCERA por aqui. O caminho manual
echo  esta no README-WINDOWS.md.
echo.
pause
exit /b 1
