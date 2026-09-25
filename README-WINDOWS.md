# NASCERA no Windows — instalação passo a passo

Guia para Windows 10 e Windows 11. **Não** precisa de WSL, Docker, Git nem de
nenhum conhecimento técnico. Você não vai digitar nenhum comando: são dois
arquivos para dar dois cliques, e o mais demorado é uma espera.

No fim tem uma seção franca: **o que ainda não funciona no Windows**. Leia antes
de instalar, para não ter surpresa depois.

---

## Antes de começar

| Você precisa de                  | Detalhe                                    |
|----------------------------------|--------------------------------------------|
| Windows 10 ou 11, 64 bits        | Qualquer edição (Home serve)               |
| Cerca de 2 GB livres no disco    | A maior parte são as peças que o NASCERA usa |
| Internet estável por ~10 minutos | Só durante a instalação                    |
| Uma conta no Claude (Anthropic)  | É o motor de IA — veja o Passo 6           |

A instalação do Node.js (Passo 1) pode pedir a senha de administrador do
Windows — isso é normal, é o instalador oficial dele. O NASCERA em si não pede
nada disso e não é instalado como serviço do Windows: ele só roda enquanto você
mandar rodar.

---

## Passo 1 — Instalar o Node.js

O Node.js é o programa que faz o NASCERA rodar. É gratuito e é da própria
comunidade do JavaScript.

1. Abra <https://nodejs.org/pt-br/download>
2. Clique no botão **LTS** — é o que aparece como *recomendado*. A versão desse
   botão sempre serve para o NASCERA.
   **Evite a versão "Current"**: ela é a de testes, muda toda semana e passa boa
   parte do ano fora da faixa que o NASCERA aceita. Se cair numa dessas, o
   instalador recusa e você teria que baixar o Node de novo.
3. Abra o arquivo baixado e vá clicando em **Next** até o fim, sem mudar nada.
   Deixe marcada a opção que fala em *Add to PATH* — ela já vem marcada.
4. Se aparecer uma tela perguntando se você quer instalar "ferramentas para
   módulos nativos" (ela cita Chocolatey e Python), **deixe desmarcada**. São
   vários GB e quase sempre não são necessários. Se por acaso o Passo 3 falhar
   pedindo isso, o próprio erro vai te dizer.

Você **não** precisa conferir se deu certo: o instalador do NASCERA confere a
presença e a versão do Node antes de qualquer coisa, e diz o que fazer se algo
estiver errado.

---

## Passo 2 — Colocar o NASCERA numa pasta

O NASCERA chega num arquivo `.zip`. **Extraia antes de usar**: clique com o botão
direito no `.zip` → **Extrair tudo**. Dar dois cliques num arquivo de dentro do
zip, sem extrair, não funciona — o Windows copia só aquele arquivo para uma
pasta temporária, longe de todos os outros.

Extraia numa pasta de caminho **curto e sem acentos**. A melhor opção é:

```
C:\nascera
```

Por que isso importa (dois problemas clássicos do Windows, não do NASCERA):

- O Windows tem um limite antigo de 260 caracteres no caminho dos arquivos. O
  NASCERA cria pastas bem aninhadas; num caminho longo o instalador falha com
  erros que não explicam nada.
- Evite Área de Trabalho, Documentos ou qualquer pasta sincronizada pelo
  **OneDrive**. O OneDrive tenta sincronizar milhares de arquivos internos e
  trava a instalação.

---

## Passo 3 — Dois cliques em `instalar.bat`

Abra a pasta `C:\nascera` e dê **dois cliques** em:

```
instalar.bat
```

Abre uma janela preta e a instalação começa sozinha. Ela vai:

1. conferir se o Node.js está instalado e se a versão serve;
2. baixar as peças que o NASCERA usa (a espera de 3 a 10 minutos);
3. conferir se o motor de IA veio junto;
4. dizer o que fazer em seguida.

**É normal** aparecer bastante texto e algumas linhas amarelas começando com
`npm WARN`. O que importa é a mensagem do fim: *INSTALAÇÃO CONCLUÍDA*. Se der
erro, ele para na hora, explica o motivo e **espera você apertar uma tecla** —
a janela não some antes de você ler. Ele nunca finge que deu certo.

Rodar o instalador de novo é seguro: nenhum dado seu é apagado.

> **Se o Windows perguntar se você quer mesmo executar** — uma janela dizendo
> que "não foi possível verificar o editor", ou uma tela azul de
> *"O Windows protegeu o seu computador"* — é a proteção padrão para arquivo
> que veio da internet. Clique em **Executar** (na tela azul: *Mais informações*
> → *Executar assim mesmo*).

---

## Passo 4 — Dois cliques em `iniciar.bat`

É assim que você liga o NASCERA, hoje e todos os outros dias:

```
iniciar.bat
```

O que acontece:

- abre uma janela preta cujo nome começa com **NASCERA - SERVIDOR** (o título
  inteiro é *NASCERA - SERVIDOR - NAO FECHE ESTA JANELA*). Essa janela **é** o
  NASCERA rodando: deixe ela aberta enquanto estiver usando o sistema;
- uns 10 segundos depois, o navegador abre sozinho em <http://localhost:3333>;
- a outra janela, a que você abriu com o duplo clique, já cumpriu o papel dela e
  pode ser fechada.

**Se o navegador disser que não conseguiu acessar a página**, espere alguns
segundos e atualize com **F5**. Em máquina mais lenta, o NASCERA demora um pouco
mais para subir do que a espera do `iniciar.bat`.

Para desligar: feche a janela **NASCERA - SERVIDOR** (ou aperte **Ctrl + C**
nela). Nada se perde — seus projetos ficam no disco.

Você não precisa editar nenhum arquivo de configuração. A chave de segurança da
sua sessão é criada sozinha na primeira vez, e o NASCERA escuta **só nesta
máquina** — ninguém na sua rede ou na internet alcança o endereço. Por isso o
Windows também não pergunta nada sobre firewall.

---

## Passo 5 — Criar sua conta

1. Na tela que abriu no navegador, o NASCERA pede um **código de instalação**.
2. Esse código está na janela **NASCERA - SERVIDOR**, na linha `PRIMEIRO ACESSO`.
3. Copie o código, cole na tela e crie seu usuário e senha de administrador.

Esse código existe por um motivo simples: ele garante que **você** cria a conta
de dono, e não outra pessoa que chegue antes na mesma máquina. Ele só aparece
enquanto não existir nenhum administrador.

---

## Passo 6 — Conectar o motor de IA (Claude)

O NASCERA já vem com o motor de IA embutido — você **não** precisa instalar mais
nada. O que falta é dizer a ele qual é a sua conta.

1. Dentro do NASCERA, clique em **Conectar Claude**.
2. Clique em **Gerar Link de Login**. Uma página da Anthropic abre no navegador.
3. Entre com a sua conta e autorize.
4. A Anthropic mostra um **código**. Copie e cole de volta na tela do NASCERA.

Pronto — o chat de IA está funcionando.

Isso exige uma conta na Anthropic com Claude Code liberado (plano pago ou
créditos de API). Sem ela, o NASCERA abre e o painel funciona, mas o chat não
responde.

---

## Se você prefere o PowerShell

Os dois `.bat` são só a porta de entrada. Quem faz a instalação de verdade é o
`install.ps1`, e ele continua ali para ser usado direto — é o mesmo instalador,
com as mesmas conferências.

1. Abra a pasta do NASCERA no Explorador de Arquivos.
2. Clique na **barra de endereço**, apague o texto, digite `powershell` e aperte
   **Enter**. Abre uma janela já posicionada na pasta certa.
3. Instale:

```
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

4. Suba o NASCERA:

```
npm start
```

5. Abra <http://localhost:3333> no navegador.

**Por que esse comando é comprido?** De fábrica, o Windows bloqueia qualquer
script `.ps1` que veio da internet — inclusive os legítimos. O trecho
`-ExecutionPolicy Bypass` autoriza **só esta execução, só agora**. Ele não
afrouxa nada na sua máquina depois que o instalador termina. É exatamente isso
que o `instalar.bat` faz por você: arquivo `.bat` não passa por essa política,
então ele abre com dois cliques e chama o `install.ps1` já autorizado.

> Se você tentou dar dois cliques no `install.ps1` e nada aconteceu, ou apareceu
> a mensagem *"a execução de scripts foi desabilitada neste sistema"*, é
> exatamente isso: use o comando acima — ou o `instalar.bat`.

---

## O que ainda NÃO funciona no Windows

Esta é a parte honesta. Quatro recursos do NASCERA **não** funcionam numa
instalação Windows, e não é descuido: eles dependem de peças que só existem em
servidor Linux. Se você precisa de algum deles, o lugar certo é um VPS Linux
(veja o `SETUP-VPS.md`).

**1. Domínio próprio com HTTPS automático**
Publicar um site em `www.seudominio.com.br`, com cadeado, direto do NASCERA.
Isso é feito por dois programas de servidor Linux (o Caddy, que cuida do
certificado, e o systemd, que cuida dos serviços). Não existem no Windows. No
Windows o NASCERA vive em `http://localhost:3333` e pronto.

**2. Projeto que roda num servidor remoto por SSH**
Conectar o NASCERA num servidor seu e deixar a IA trabalhar lá dentro. O NASCERA
monta esse acesso com ferramentas de linha de comando do Unix (`ssh` e
`sshpass`) que o Windows não tem. Projetos locais, na sua própria máquina,
funcionam normalmente.

**3. Backup automático agendado**
O backup que roda sozinho todo dia de madrugada é um script de Linux acionado
pelo agendador de lá (cron). No Windows ele não roda.
**O que fazer no lugar:** com o NASCERA desligado, copie a pasta inteira
(`C:\nascera`) para um HD externo ou para a nuvem, de tempos em tempos. É a cópia
completa — projetos, contas e configurações. Guarde num lugar seguro: essa cópia
contém as suas senhas e chaves.

**4. Não existe isolamento entre usuários (sandbox)**
No servidor Linux, cada sessão da IA roda dentro de uma "caixa" que a impede de
enxergar o resto da máquina. Essa caixa é uma tecnologia do Linux e não tem
equivalente aqui.

Na prática, isto significa: **a instalação Windows é de uso pessoal — uma
pessoa, uma máquina.** A IA e o terminal do NASCERA têm o mesmo poder que o seu
usuário do Windows tem: seus arquivos, seus programas. Isso é ótimo para
trabalhar sozinho, e é exatamente por isso que **você não deve** usar esta
instalação para atender clientes, colegas ou alunos com contas separadas. Para
várias pessoas, use um servidor Linux.

---

## Problemas comuns

**A janela abriu e fechou na hora, sem dar tempo de ler**
Isso não deveria acontecer: os dois `.bat` param e esperam uma tecla em qualquer
erro. Se aconteceu mesmo assim, quase sempre é antivírus encerrando o arquivo.
Rode pelo caminho do PowerShell (seção acima) para ver a mensagem inteira.

**"Não achei os arquivos do NASCERA nesta pasta"**
Você deu dois cliques no `.bat` de dentro do `.zip`, sem extrair, ou copiou só o
`.bat` para outro lugar. Volte ao Passo 2 e extraia a pasta inteira.

**"O NASCERA ainda não foi instalado nesta pasta"**
O `iniciar.bat` foi executado antes do `instalar.bat`. Rode o `instalar.bat`
primeiro e espere ele terminar.

**"A execução de scripts foi desabilitada neste sistema"**
Use o `instalar.bat`, que já resolve isso. Se você estiver num computador de
empresa, essa trava pode vir de uma política do setor de TI — nesse caso nem o
`instalar.bat` passa, e o próprio `instalar.bat` te avisa disso e mostra o
caminho manual.

**`node` ou `npm` "não é reconhecido como um comando"**
O Node não está instalado, ou esta janela foi aberta antes de instalá-lo. Feche
a janela, abra outra e tente de novo.

**O instalador diz que a versão do Node não serve**
Você provavelmente baixou a versão "Current". Volte ao Passo 1 e pegue a **LTS**.
O NASCERA trava nesse ponto de propósito: nas versões de fora da faixa, a peça que
redimensiona imagem (serviço pago) e a que grava seus dados com segurança não
têm suporte.

**O `npm install` falhou citando "node-gyp", "MSBuild" ou "Visual Studio"**
Alguma peça precisou ser compilada na sua máquina. Instale o **Visual Studio
Build Tools** com a carga *Desktop development with C++* e o **Python 3**, e
rode o instalador de novo.

**O `npm install` falhou por outro motivo**
Quase sempre é internet que caiu no meio, proxy de empresa ou antivírus
segurando arquivo. Apague a pasta `node_modules` e rode o instalador de novo.

**"porta 3333 já está em uso"**
Ou o NASCERA já está aberto em outra janela, ou outro programa ocupou a porta.
Feche a outra janela. Se precisar mudar a porta de vez, crie um arquivo chamado
`.env` na pasta do NASCERA com uma linha:

```
PORT=3400
```

O `iniciar.bat` lê esse arquivo e abre o navegador no endereço certo sozinho.

**O navegador abriu em "não foi possível acessar esse site"**
O NASCERA ainda estava subindo. Espere alguns segundos e aperte **F5**. Se depois
de um minuto continuar assim, olhe a janela **NASCERA - SERVIDOR**: a mensagem de
erro está lá.

**Deu erro estranho de arquivo no meio da instalação**
Verifique se o NASCERA está numa pasta de caminho curto e fora do OneDrive
(Passo 2).

---

## Resumo (para colar na parede)

```
1ª vez:   dois cliques em  instalar.bat
Sempre:   dois cliques em  iniciar.bat
Abrir:    http://localhost:3333   (abre sozinho)
Desligar: fechar a janela NASCERA - SERVIDOR
```
