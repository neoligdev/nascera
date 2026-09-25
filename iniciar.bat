@echo off
rem ======================================================================
rem  NASCERA - LIGAR O SISTEMA - Windows 10 e 11
rem
rem  Dois cliques aqui e o NASCERA sobe e o navegador abre sozinho, no
rem  endereco certo. Use este arquivo todo dia; o instalar.bat e so na
rem  primeira vez.
rem
rem  ACENTUACAO: mesma decisao do instalar.bat - tudo sem acento, de
rem  proposito. O console do Windows nao usa UTF-8 por padrao, e um
rem  chcp 65001 na primeira linha troca o code page enquanto o proprio
rem  .bat ainda esta sendo lido do disco. Texto sem acento le bem em
rem  qualquer code page e nao arrisca a leitura do arquivo.
rem
rem  DUAS JANELAS, DE PROPOSITO: o servidor vai para uma janela propria,
rem  com nome, porque ele precisa ficar aberto enquanto a pessoa usa o
rem  sistema. Esta janela aqui so espera, abre o navegador e explica o
rem  que aconteceu. Subir o servidor nesta mesma janela obrigaria a abrir
rem  o navegador ANTES de o servidor existir, e a primeira coisa que o
rem  cliente veria seria a pagina de erro do navegador.
rem ======================================================================

setlocal
title NASCERA - Iniciando

rem Trabalha na pasta do proprio .bat, com aspas por causa de caminho com
rem espaco. Sem isto o npm start rodaria de onde o Windows resolveu abrir
rem o prompt e nao acharia o server.js.
cd /d "%~dp0"

echo.
echo  ==================================================
echo    NASCERA - ligando
echo  ==================================================
echo.

if not exist "package.json" goto :PASTA_ERRADA
if not exist "server.js" goto :PASTA_ERRADA
if not exist "node_modules" goto :FALTA_INSTALAR

rem O erro do Node fora do PATH apareceria dentro da OUTRA janela, em
rem ingles, e a pessoa nao faria a ligacao. Melhor conferir aqui.
where /q node
if errorlevel 1 goto :FALTA_NODE
where /q npm
if errorlevel 1 goto :FALTA_NODE

rem ---------------------------------------------------------------------
rem  Descobrir a porta - de novo, sem inventar numero.
rem
rem  No server.js a porta e process.env.PORT, ou 3333 quando nao houver,
rem  e antes disso ele carrega o .env pelo dotenv, que NAO sobrescreve
rem  variavel que ja existe no ambiente. Logo a ordem de quem manda e:
rem      1. PORT do ambiente
rem      2. PORT escrito no arquivo .env
rem      3. 3333
rem  E exatamente essa ordem que esta reproduzida abaixo. Se um dia o
rem  server.js mudar de porta padrao, esta linha tem de mudar junto.
rem ---------------------------------------------------------------------
set "PORTA=3333"

if not exist ".env" goto :SEM_ENV
rem eol=# pula as linhas de comentario do .env; delims== separa a chave do
rem valor; tokens=1,* mantem inteiro o que vier depois do primeiro sinal.
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" set "PORTA=%%B"
:SEM_ENV

if defined PORT set "PORTA=%PORT%"

rem Tira espaco sobrando em volta do valor - "PORT=3400 " no .env e comum.
for /f "tokens=1 delims= " %%C in ("%PORTA%") do set "PORTA=%%C"

rem PORT vazio no ambiente ou no .env e valor falso para o server.js, que
rem cai no 3333. Aqui tem de cair igual, senao a mensagem mentiria.
if not defined PORTA set "PORTA=3333"

rem So numero vira endereco. Se sobrou qualquer outra coisa - aspas, nome
rem de variavel, lixo - e melhor nao abrir navegador nenhum do que abrir
rem um endereco errado e a pessoa achar que o NASCERA nao subiu.
rem
rem Como o teste abaixo funciona: os dez digitos estao declarados como
rem SEPARADORES. Valor so de digitos nao sobra token nenhum e o corpo do
rem for nem roda; qualquer caractere estranho vira token e o desvio
rem acontece. Aqui, com o valor entre aspas e sem nenhum outro comando na
rem linha, o desvio e seguro.
rem
rem LIMITE CONHECIDO - e ele nao esta neste teste, esta na LEITURA DO .ENV
rem la em cima. O batch monta a linha com o valor ja substituido dentro e
rem so entao a executa. Um valor com um numero IMPAR de aspas, somado a um
rem e-comercial ou a um sinal de maior-que, sai do par de aspas e vira
rem comando ou redirecionamento. E a leitura passa por TODAS as linhas do
rem arquivo .env, nao so pela linha do PORT: uma senha de SMTP com aspas
rem cairia nesse mesmo caminho. Nao existe forma de
rem batch puro que feche isso por completo; o que reduz de verdade e
rem entregar ao for so a linha do PORT, com
rem     findstr /b /i /c:"PORT=" ".env"
rem no lugar do arquivo inteiro - mudanca que precisa de uma maquina
rem Windows para ser conferida antes de entrar. Nao ha travessia de
rem privilegio: o .env e arquivo local do dono da maquina, que ja poderia
rem trocar este proprio .bat. Fica registrado para quem mexer aqui nao
rem confiar numa protecao que e parcial, e nao total.
for /f "delims=0123456789" %%D in ("%PORTA%") do goto :SUBIR_SEM_NAVEGADOR
goto :SUBIR

:SUBIR_SEM_NAVEGADOR
set "PORTA="

:SUBIR
echo  Abrindo o NASCERA numa janela propria, chamada NASCERA - SERVIDOR.
echo.
start "NASCERA - SERVIDOR - NAO FECHE ESTA JANELA" cmd /k npm start

if not defined PORTA goto :SEM_NAVEGADOR

echo  Esperando o NASCERA subir. Sao uns 10 segundos.
timeout /t 10 /nobreak >nul
start "" "http://localhost:%PORTA%"

echo.
echo  ==================================================
echo    O NASCERA ESTA RODANDO
echo  ==================================================
echo.
echo  Endereco:  http://localhost:%PORTA%
echo.
echo  A janela chamada NASCERA - SERVIDOR e o NASCERA ligado. Deixe ELA
echo  aberta enquanto estiver usando o sistema. Fechar aquela janela
echo  desliga o NASCERA, e nada se perde: seus projetos ficam no disco.
echo.
echo  Se o navegador disser que nao conseguiu acessar a pagina, espere
echo  alguns segundos e atualize com a tecla F5. Em maquina mais lenta o
echo  NASCERA demora um pouco mais para subir do que a espera daqui.
echo.
echo  Na primeira vez, o site pede um CODIGO DE INSTALACAO. Ele aparece
echo  na janela NASCERA - SERVIDOR, na linha PRIMEIRO ACESSO.
echo.
echo  Esta janela ja fez o trabalho dela e pode ser fechada.
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------
:SEM_NAVEGADOR
echo.
echo  AVISO: o NASCERA esta subindo, mas nao consegui descobrir em qual
echo  porta ele vai atender.
echo.
echo  Isso acontece quando existe um arquivo .env nesta pasta com a
echo  linha PORT escrita de um jeito que nao e so um numero.
echo.
echo  O endereco certo aparece na janela NASCERA - SERVIDOR, na linha que
echo  comeca com  Main:  - copie de la para o navegador.
echo.
pause
exit /b 0

rem ---------------------------------------------------------------------
:FALTA_INSTALAR
echo  ERRO: o NASCERA ainda nao foi instalado nesta pasta.
echo.
echo  Falta a pasta node_modules, que e onde ficam as pecas que ele usa.
echo.
echo  De dois cliques primeiro em:
echo.
echo      instalar.bat
echo.
echo  Quando ele terminar, volte e de dois cliques neste iniciar.bat.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------
:FALTA_NODE
echo  ERRO: o Node.js nao esta instalado, ou nao esta no PATH do Windows.
echo.
echo  O Node.js e o programa que faz o NASCERA rodar.
echo.
echo  De dois cliques em  instalar.bat  - ele explica exatamente onde
echo  baixar e qual versao serve.
echo.
echo  Se voce acabou de instalar o Node, feche esta janela e tente de
echo  novo: o Windows so enxerga um programa novo em janelas abertas
echo  depois da instalacao dele.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------
:PASTA_ERRADA
echo  ERRO: nao achei os arquivos do NASCERA nesta pasta.
echo.
echo  Pasta em que este arquivo foi executado:
rem Aspas por causa de nome de pasta com o sinal de "e comercial", que
rem sem elas faria o echo executar o pedaco seguinte como comando.
echo  "%~dp0"
echo.
echo  O iniciar.bat precisa ficar dentro da pasta do NASCERA, junto do
echo  server.js. Se voce o copiou sozinho para a Area de Trabalho, use o
echo  que esta na pasta original.
echo.
pause
exit /b 1
