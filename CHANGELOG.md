# Changelog

Mudanças relevantes do NASCERA. As versões seguem [versionamento semântico](https://semver.org/lang/pt-BR/).

## 1.5.0 — 13 de agosto de 2026

A maior atualização do NASCERA até hoje. Motor de vendas automático com quatro
gateways, e-mail transacional, um novo painel do dono e suporte nativo a Windows,
macOS e Linux — tudo sobre uma base reconstruída por dentro e coberta por 282
testes automatizados.

### Destaques

- **Vendas no automático** com Hotmart, Kiwify, Asaas e Mercado Pago: pagamento aprovado cria o cliente, aplica o plano e envia o e-mail de boas-vindas sozinho.
- **E-mail transacional** próprio (boas-vindas, cobrança, recuperação de senha) com templates editáveis.
- **Novo painel do dono** com métricas de negócio: receita, reembolsos, clientes, projetos e saúde do servidor numa tela.
- **Roda em Windows, macOS e Linux** — e ficou mais rápido nos três.
- **Base reconstruída**: 24 módulos de rota, 11 serviços, banco PostgreSQL e 282 testes.

---

### Vendas no automático — 4 gateways nativos

- **Hotmart, Kiwify, Asaas e Mercado Pago integrados de fábrica.** Venda aprovada → cliente criado, plano aplicado e e-mail enviado, em segundos, sem intervenção.
- **Assinatura de cada gateway conferida antes de processar.** Só é aceito o aviso que veio comprovadamente da plataforma; sem segredo configurado, o webhook fica desligado em vez de aceitar qualquer coisa.
- **Sem cobrança em duplicidade.** Cada venda é registrada pela chave única da transação. Os gateways reenviam o mesmo aviso por dias — o NASCERA reconhece e não credita duas vezes.
- **Configuração no painel, em minutos.** Cada meio de pagamento tem seu cartão com o logo, o endereço do webhook (copia com um clique) e o passo a passo de onde colar cada chave. Sem documentação externa.
- **Vários gateways ao mesmo tempo.** Vender na Hotmart e na Kiwify entra no mesmo fluxo, com o mesmo tratamento.
- **Mapa de ofertas.** Diga qual código de oferta libera qual plano e o NASCERA resolve o resto.
- **Histórico que não reescreve o passado.** Reembolso vira status, não sumiço — a linha do tempo de cada venda fica inteira. Reembolso suspende o acesso sem apagar nada; se a pessoa voltar, está tudo lá.
- **Pix manual.** Cadastre sua chave, o cliente avisa que pagou, você confere e libera com um clique — sem depender de gateway.

### E-mail e onboarding automático

- **SMTP configurado uma vez, o resto é automático:** boas-vindas, confirmação de compra, aviso de crédito acabando, suspensão e recuperação de senha.
- **Templates editáveis com pré-visualização**, para você escrever com a sua voz. Se um template falhar, o NASCERA usa a versão embutida e o e-mail sai mesmo assim.
- **Entrega com nova tentativa.** Falhou no servidor de e-mail? O NASCERA tenta de novo com espera crescente e registra tudo. Um botão de teste mostra o erro exato da configuração.
- **Primeiro acesso do comprador 100% automático:** ele recebe um link de uso único para definir a própria senha, entra e começa a usar.
- **"Esqueci minha senha" de ponta a ponta**, com link de uso único e validade curta.

### Painel do dono, reconstruído

- **Painel novo com sistema de design próprio** e navegação em três frentes — Negócio, Produto e Sistema — somando 13 áreas.
- **Visão de negócio numa tela:** receita do mês, receita total, reembolsos, clientes, projetos, sessões de IA ativas, consumo de disco e saúde do servidor.
- **Gestão completa de clientes:** plano, saldo, suspensão, extrato de consumo turno a turno e link de primeiro acesso para enviar a quem comprou.
- **IA própria do cliente.** Você decide se o usuário conecta a chave de IA dele — e aí o consumo sai do bolso dele, não do seu. É a alavanca que transforma o NASCERA numa plataforma que você revende sem pagar o uso.

### Segurança de nível empresarial

Endurecimento completo com auditoria adversarial — testadores independentes tentando
quebrar o sistema de propósito — e cada defesa fixada por um teste automatizado.

- **Senhas protegidas com `scrypt`** (hashing com sal aleatório e custo de memória). Nem você, dono do sistema, consegue ler a senha de um cliente.
- **Cofre de segredos cifrado com AES-256-GCM.** Chaves de API, senha de e-mail e credenciais dos gateways ficam criptografadas; no painel aparecem mascaradas — você vê os últimos dígitos, nunca o valor inteiro.
- **Cada cliente enxerga só o que é dele.** Todo projeto tem dono, e o portão que confere isso é único e obrigatório — vale para a tela, a API e o chat ao vivo.
- **Sessões com validade real:** login assinado, com verificação de origem, destino e prazo.
- **Primeiro acesso por código de instalação** impresso no terminal, conferido em tempo constante — só quem tem acesso à máquina cria o administrador.
- **Barreiras contra ataques automatizados:** freio de tentativas no login, limite de tamanho das requisições, cabeçalhos de segurança e sanitização de todo conteúdo gerado por IA antes de chegar à tela.
- **Isolamento por sandbox no Linux:** cada sessão de IA roda numa caixa separada — um projeto não enxerga o outro nem o resto da máquina.
- **Exclusão com portão único.** Fora da área de projetos, o NASCERA se recusa a apagar; se não conseguir mover um arquivo com segurança, ele para e deixa tudo no lugar.

### Seus dados, com confiabilidade

- **PostgreSQL como fonte da verdade**, com isolamento por linha (RLS) — cada cliente lê apenas o próprio dado, garantido no banco.
- **Cópia contínua em arquivo.** Se o banco ficar indisponível, o NASCERA continua de pé e se reconcilia sozinho quando ele volta.
- **Gravação atômica:** toda escrita importante vai para um arquivo temporário, é confirmada no disco e só então trocada no lugar, com backup. Queda de energia no meio da gravação deixa de ser problema.
- **Dinheiro nunca processado no escuro:** com o banco fora do ar, o webhook recusa e pede reenvio em vez de arriscar um crédito parcial.

### Windows, macOS e Linux

- **Suporte nativo ao Windows 10 e 11** — não uma adaptação por cima. O sistema foi reescrito para falar a língua de cada sistema operacional com recursos nativos do Node.
- **Mais rápido nos três:** a cópia de arquivos ao publicar deixou de depender de programa externo e a detecção de servidores de projeto ficou instantânea.
- **Instalação em dois cliques no Windows** (`instalar.bat` e `iniciar.bat`), que abrem o navegador sozinhos e explicam em português quando algo dá errado.
- **Guia próprio para Windows** (`README-WINDOWS.md`), escrito para quem nunca abriu um terminal.
- **Diagnóstico inteligente do motor de IA:** se algo impede o motor de subir, o NASCERA lê o arquivo, identifica a causa exata — arquitetura, permissão ou bloqueio de segurança do macOS — e mostra o comando que resolve, em vez de um erro genérico.

### Arquitetura e qualidade

- **Motor reorganizado em 24 módulos de rota e 11 serviços independentes**, cada um com responsabilidade única: funcionalidade nova entra mais rápido e um problema numa área não contamina as outras (`server.js` saiu de 6.286 para 2.820 linhas).
- **Rede de testes que simula uma conversa completa com a IA**, do início ao fim, sem gastar crédito — toda mudança no coração do produto é validada antes de chegar a um cliente.
- **282 testes automatizados** rodam a cada mudança, mais verificação de tipos e uma auditoria de segurança antes de qualquer versão sair. Cada teste nasceu de um caso real de uso.
- **Trava de privacidade no empacotamento:** antes de gerar uma versão, o NASCERA inspeciona todos os arquivos do pacote e recusa se encontrar qualquer dado, segredo ou projeto de instalação. O que chega ao cliente é código puro.

---

### No forno

- Instalador com Node embutido, para dispensar o pré-requisito abaixo
- Aplicativo de desktop para Mac e Windows — já construído, aguardando certificação digital
- Checkout self-service dentro do NASCERA
- Relatórios de faturamento recorrente (MRR, LTV)

### Antes de instalar

O NASCERA precisa do Node.js (versão 22.22.2 ou superior) na máquina. É gratuito,
leva dois minutos e está em [nodejs.org](https://nodejs.org/). Depois disso, é
rodar o instalador e usar.
