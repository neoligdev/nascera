# Logos dos meios de pagamento

Marcas de terceiros, usadas só para **identificar a integração** na tela
"Receita & Vendas → Meios de pagamento" do painel. Uso nominativo: cada logo
aparece ao lado do nome da empresa, indicando que o NASCERA conversa com ela.
Nenhum deles é marca do NASCERA, e nenhum sugere patrocínio ou parceria.

Se a empresa pedir a remoção, basta apagar o arquivo: o card cai sozinho para a
inicial colorida (`onerror` em `secoes/receita.js`), sem quebrar nada.

| Arquivo | Origem | Conferência |
|---|---|---|
| `hotmart.svg` | `hotmart.com/static/app-hotmart-next/images/hotmart-new-logo.svg` | SHA-256 idêntico ao do CDN oficial |
| `kiwify.svg` | `kiwify.com.br/_astro/logo.Bi70aw49.svg` | MD5 idêntico ao byte servido pelo site |
| `asaas.svg` | asset de marca do Asaas (app-icon) | desenho conferido contra a identidade oficial |
| `mercadopago.svg` | favicon/símbolo oficial do Mercado Pago | desenho conferido contra a identidade oficial |

Todos passaram por varredura antes de entrar: nenhum tem `<script>`, `onload`,
`<foreignObject>`, `<image>` nem URL externa embutida. Ainda assim são servidos
via `<img src>`, e não inlinados — assim o `<style>` interno deles (os arquivos
da Kiwify e do Mercado Pago trazem classes genéricas do Illustrator, `.st0` e
`.st1`) fica isolado e não vaza para o CSS do painel.

## Enquadramento

Cada arte enquadra diferente dentro do próprio `viewBox`, então a escala é
compensada em `servicos/gateways.js` (`logoEscala`) para os quatro parecerem do
mesmo tamanho na fileira:

- **Hotmart** — 1,0. Símbolo alto (23×32); o `object-fit: contain` resolve.
- **Kiwify** — 0,92. A arte encosta na borda do `viewBox` (500 de 512).
- **Asaas** — `logoSangra`. É app-icon com fundo azul próprio: preenche o
  quadradinho inteiro, senão vira quadrado dentro de quadrado.
- **Mercado Pago** — 1,24. O oval ocupa só ~69% da altura do `viewBox`.
