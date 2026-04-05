# Fluxo Hibrido de Compra via Z-API

> Referencia consolidada para o fluxo de compra no WhatsApp com vitrine visual, selecao de tamanho, selecao de quantidade e confirmacao de carrinho.
> Baseado no material interno de 2026-03-30 e adaptado para o contexto real do projeto Agente Belux.

## Objetivo

Implementar um fluxo conversacional de compra com a seguinte progressao:

1. Vitrine com foto do produto, nome, preco e CTA principal.
2. Escolha do tamanho via list message.
3. Escolha da quantidade via botoes rapidos com fallback para digitacao.
4. Confirmacao de item adicionado ao carrinho.

## Sequencia Recomendada

### Etapa 1 - Vitrine

- endpoint: `POST /send-button-list-image`
- enviar imagem do produto, preco e botao principal
- usar ID tecnico estavel, ex: `buy:product:{productId}`

### Etapa 2 - Escolha do tamanho

- endpoint: `POST /send-option-list`
- listar tamanhos e disponibilidade no texto de apoio
- sempre consultar estoque em tempo real antes de montar a lista
- usar IDs tecnicos, ex: `size:product:{productId}:size:{size}`

### Etapa 3 - Escolha da quantidade

- endpoint: `POST /send-button-list`
- modelo recomendado:
  - `1 peca`
  - `2 pecas`
  - `Outra qtde`
- assumir como regra segura ate 3 botoes por mensagem
- `Outra qtde` deve mover o usuario para digitacao manual

### Etapa 4 - Confirmacao

- confirmar produto, tamanho e quantidade
- opcionalmente incluir subtotal

Exemplo:

```text
✅ 2x Vestido Floral (M) adicionados ao carrinho!
```

## Maquina de Estados Recomendada

Estados base:

- `idle`
- `awaiting_buy_action`
- `awaiting_size`
- `awaiting_quantity`
- `awaiting_manual_quantity`
- `item_confirmed`

Payload minimo por sessao:

```json
{
  "state": "awaiting_quantity",
  "productId": "vestido_floral_001",
  "productName": "Vestido Floral",
  "selectedSize": "M",
  "availableStock": 3,
  "lastInteractiveVersion": "2026-03-30T22:00:00Z"
}
```

Regras:

- persistir por telefone
- usar TTL de 15 a 30 minutos
- limpar o estado quando confirmar ou expirar
- guardar versao/timestamp para invalidar menus antigos

## IDs Tecnicos

Padrao recomendado:

- botao compra: `buy:product:{productId}`
- tamanho: `size:product:{productId}:size:{size}`
- quantidade fixa: `qty:product:{productId}:size:{size}:value:{n}`
- quantidade manual: `qty:product:{productId}:size:{size}:manual`

## Webhook e Correlacao

Campos principais:

- `phone`
- `messageId`
- `fromMe`
- resposta interativa de botao
- resposta interativa de lista
- `text.message`

Regras:

- responder `200` imediatamente
- processar de forma assincrona
- ignorar `fromMe: true`
- ignorar grupos nesse fluxo
- deduplicar por `messageId`

## Regras de Negocio Criticas

- revalidar estoque na escolha do tamanho
- revalidar estoque novamente na quantidade
- aceitar quantidade manual apenas como inteiro positivo
- nao confiar no label exibido; usar apenas IDs tecnicos
- se menu antigo for clicado, avisar expiracao e reiniciar o fluxo

## Casos de Borda Obrigatorios

- tamanho sem estoque
- quantidade acima do estoque
- clique duplicado
- webhook duplicado
- mensagem fora de ordem
- abandono e retomada
- produto esgota durante o fluxo
- usuario envia texto, audio, sticker ou imagem no meio da compra

## Arquitetura Recomendada

Camadas:

1. `Webhook controller`
2. `Message normalizer`
3. `State machine / flow orchestrator`
4. `Catalog and stock service`
5. `Cart service`
6. `Z-API outbound client`
7. `Observability + idempotency store`

Persistencia:

- sessao e idempotencia em Redis
- carrinho e pedidos em banco persistente
- logs com `phone`, `messageId`, `interactiveId`, `productId`, `state`

## Plano de Testes Minimo Obrigatorio

### Funcionais

- vitrine envia imagem e CTA
- clique no CTA abre lista
- escolha de tamanho abre quantidade
- quantidade fixa confirma item
- quantidade manual valida e confirma item

### Integracao

- payload da Z-API bate com o contrato esperado
- webhook de botao e lista e parseado corretamente
- erro da Z-API gera fallback seguro

### Concorrencia

- duas compras simultaneas disputando o mesmo estoque
- webhook duplicado nao duplica carrinho
- timeout de sessao libera contexto corretamente

### UX conversacional

- mensagens curtas e objetivas
- fallback compreensivel em expiracao ou invalidez
- confirmacao final explicita item, tamanho e quantidade

## Decisoes para Claude Code

- tratar Z-API como fonte principal de contrato
- manter estado conversacional explicito
- implementar idempotencia por `messageId`
- revalidar estoque em cada etapa decisiva
- degradar com elegancia para texto quando a interacao rica falhar
