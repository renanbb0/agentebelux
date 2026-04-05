# Relatorio de Pesquisa e Plano de Implementacao

Data: 2026-04-05
Projeto: Agente Bela Belux
Arquivo principal analisado: `index.js`

## Objetivo

Documentar a investigacao feita no fluxo de compra via WhatsApp, com foco em:

- selecao de produto
- escolha de tamanho
- escolha de quantidade
- fila de produtos (`buyQueue`)
- carrinho
- fechamento / handoff

Este relatorio tambem consolida um plano de implementacao para corrigir os erros de logica de negocio encontrados.

## Resumo Executivo

Foi identificado um bug ja corrigido no roteamento da lista interativa:

- o webhook tratava apenas `buy_`, `size_` e `qty_`
- os IDs `add_size_` e `skip_more_` escapavam da FSM e caiam na IA
- isso explicava a "alucinacao" observada na tela de `Outro Tamanho` / `Proximo Produto`

Hotfix ja aplicado em `index.js`:

- incluir `add_size_` e `skip_more_` no interceptor da FSM

Durante a revisao, surgiram mais riscos de logica de negocio que ainda merecem correcao.

## Metodologia da Pesquisa

A investigacao foi feita por leitura estatica do codigo, cruzando:

- extracao de texto do webhook
- interceptor da FSM
- `handlePurchaseFlowEvent`
- `addToCart`
- `sendPostAddMenu`
- `processNextInQueue`
- `handoffToConsultant`
- persistencia de sessao em `services/supabase.js`

Nao houve teste automatizado end-to-end neste momento. As conclusoes abaixo sao baseadas no comportamento deduzido pelo codigo atual.

## Achados

### 1. Fallback de produto pode iniciar compra do item errado

Severidade: Alta
Status: Pendente

Trecho principal:

- `index.js:1417`
- `index.js:1418`

Comportamento atual:

- ao receber `buy_{productId}`, o codigo tenta localizar o produto por ID em `session.products`
- se nao encontrar, usa `session.lastViewedProduct` como fallback

Risco de negocio:

- a cliente pode clicar em um produto antigo
- se o catalogo atual da sessao mudou, o fluxo pode abrir outro produto
- isso pode levar a carrinho com SKU diferente do clicado

Impacto:

- pedido incorreto
- divergencia entre clique e item comprado
- perda de confianca no fluxo

Recomendacao:

- remover o fallback cego para `session.lastViewedProduct`
- quando o `productId` nao for encontrado, responder com erro controlado e orientar a cliente a reabrir o catalogo
- opcionalmente, resolver o produto via `messageProductMap` se houver contexto confiavel

### 2. Protecao de fila pendente existe, mas nao esta conectada ao fluxo

Severidade: Alta
Status: Pendente

Trechos principais:

- `index.js:1364` funcao `handleQueueGuard`
- `index.js:1387` bloqueio para `cart_finalize` com fila pendente
- `index.js:315`
- `index.js:316`
- `index.js:329`

Comportamento atual:

- existe uma regra de negocio correta para impedir fechamento com produtos ainda na fila
- porem a funcao `handleQueueGuard` nao esta sendo chamada em nenhum ponto do fluxo
- ao clicar em `cart_finalize`, o evento vira texto natural (`quero finalizar o pedido`) e segue para IA

Risco de negocio:

- a cliente pode finalizar sem revisar os produtos que ela mesma deixou na fila
- o comportamento fica nao deterministico, dependendo da resposta da IA

Impacto:

- itens esquecidos
- fechamento prematuro
- comportamento inconsistente entre casos iguais

Recomendacao:

- interceptar `cart_finalize`, `queue_continue` e `queue_finalize_anyway` antes da IA
- chamar `handleQueueGuard` de forma deterministica no webhook
- manter a IA fora da decisao de bloquear ou liberar finalizacao com fila pendente

### 3. Sessao pode ficar travada para novos handoffs

Severidade: Alta
Status: Pendente

Trechos principais:

- `index.js:1921`
- `index.js:1997`

Comportamento atual:

- `handoffToConsultant` bloqueia chamadas futuras quando `session.handoffDone` esta `true`
- esse flag e marcado no primeiro handoff
- nao foi encontrada limpeza desse flag ao iniciar uma nova compra, limpar carrinho ou resetar o fluxo

Risco de negocio:

- depois de um pedido concluido, a mesma cliente pode nao conseguir concluir outro pedido na mesma sessao ativa

Impacto:

- bloqueio de vendas subsequentes
- necessidade de expirar sessao ou reiniciar manualmente

Recomendacao:

- resetar `session.handoffDone` sempre que uma nova jornada de compra realmente comecar
- pontos candidatos:
  - `startInteractivePurchase`
  - `clearCart`
  - qualquer acao que represente "novo carrinho"

### 4. IDs versionados nao sao validados

Severidade: Media
Status: Pendente

Trechos principais:

- `index.js:1661`
- `index.js:1671`
- `index.js:1491`
- `index.js:1510`
- `index.js:1528`

Comportamento atual:

- os IDs interativos carregam sufixo `_v{interactiveVersion}`
- isso indica intencao de invalidar botoes antigos
- porem os handlers nao comparam a versao recebida com a versao atual da sessao

Risco de negocio:

- a cliente pode tocar num botao antigo
- o sistema pode aplicar quantidade, tamanho ou navegacao sobre um estado novo

Impacto:

- acoes fora de contexto
- reabertura de telas antigas
- carrinho inconsistente

Recomendacao:

- extrair a versao do `eventId`
- comparar com `session.purchaseFlow.interactiveVersion`
- se a versao estiver vencida, informar que o menu expirou e reenviar o menu correto

### 5. `clearCart` esta sendo chamado, mas nao foi encontrado no runtime

Severidade: Media
Status: Pendente

Trechos principais:

- `index.js:404`
- `index.js:1192`
- `FUNCOES_AUSENTES.md:125`

Comportamento atual:

- o codigo chama `clearCart(...)` no fluxo
- nao foi encontrada implementacao dessa funcao em `index.js`
- a unica referencia encontrada foi na documentacao de funcoes ausentes

Risco de negocio:

- ao tentar limpar carrinho, o sistema pode falhar em tempo de execucao

Impacto:

- quebra direta do fluxo
- carrinho preso
- necessidade de intervencao manual

Recomendacao:

- implementar `clearCart(phone, session)`
- comportamento esperado:
  - limpar `session.items`
  - resetar `purchaseFlow`
  - limpar `currentProduct`
  - limpar `handoffDone`
  - enviar confirmacao
  - reabrir menu de categorias ou proximo passo

### 6. Persistencia de pedido final nao esta sendo usada

Severidade: Media
Status: Observacao

Trechos principais:

- `services/supabase.js:101` funcao `saveOrder`
- nao foi encontrada chamada a `saveOrder(...)` no codigo da aplicacao

Comportamento atual:

- o handoff envia resumo para cliente e admin
- mas nao persiste formalmente o pedido na tabela `orders`

Risco de negocio:

- perda de trilha operacional
- dificuldade de auditoria
- impossibilidade de reconciliar pedidos posteriormente

Impacto:

- menor confiabilidade operacional
- dependencia total do WhatsApp como registro

Recomendacao:

- decidir se o handoff sera tambem o momento oficial de persistencia do pedido
- se sim, chamar `saveOrder(...)` dentro de `handoffToConsultant`

## Ordem Recomendada de Implementacao

### Fase 1 - Correcoes criticas de fechamento e selecao

Objetivo:

- eliminar erros que podem gerar pedido errado ou travar novas vendas

Itens:

1. Remover fallback para `session.lastViewedProduct` em `buy_`
2. Conectar `handleQueueGuard` ao webhook de forma deterministica
3. Resetar `session.handoffDone` ao iniciar nova compra e ao limpar carrinho
4. Implementar `clearCart`

Resultado esperado:

- compra sempre inicia no produto correto
- fila pendente nao e ignorada
- novas compras podem ser fechadas normalmente
- limpar carrinho deixa o estado previsivel

### Fase 2 - Blindagem contra eventos antigos

Objetivo:

- impedir interacoes fora de contexto com menus antigos

Itens:

1. Criar helper para extrair versao do `eventId`
2. Validar versao em `size_`, `qty_`, `add_size_`, `skip_more_` e, se fizer sentido, `buy_`
3. Reenviar a tela correta quando o clique estiver expirado

Resultado esperado:

- botoes antigos deixam de causar efeitos colaterais
- o fluxo fica mais robusto em conversas longas

### Fase 3 - Robustez operacional

Objetivo:

- melhorar rastreabilidade e controle do processo comercial

Itens:

1. Avaliar uso de `saveOrder(...)` no handoff
2. Revisar se `buyQueue` deve ser preservada em todos os resets ou apenas em contextos especificos
3. Documentar os estados validos da FSM

Resultado esperado:

- operacao mais auditavel
- menos ambiguidade sobre encerramento de carrinho

## Plano Tecnico Proposto

### Passo 1 - Corrigir roteamento deterministico do fechamento

Alteracoes propostas:

- interceptar no webhook os eventos:
  - `cart_finalize`
  - `queue_continue`
  - `queue_finalize_anyway`
- resolver estes casos antes da IA

Validacao:

- fila com itens pendentes deve sempre mostrar aviso antes do fechamento
- `queue_continue` deve abrir o proximo produto
- `queue_finalize_anyway` deve limpar fila e finalizar

### Passo 2 - Corrigir o inicio de compra por produto

Alteracoes propostas:

- em `handlePurchaseFlowEvent`, no bloco `buy_`, remover fallback automatico para `session.lastViewedProduct`
- responder com erro amigavel quando o produto nao for encontrado no contexto atual

Validacao:

- clique em card antigo nao pode abrir outro produto
- clique invalido deve falhar com mensagem segura

### Passo 3 - Implementar `clearCart`

Alteracoes propostas:

- criar funcao real no runtime
- resetar:
  - `session.items`
  - `session.currentProduct`
  - `session.handoffDone`
- chamar `resetPurchaseFlow(session)`
- confirmar para a cliente

Validacao:

- comando textual de limpar carrinho deve funcionar
- acao `LIMPAR_CARRINHO` tambem
- apos limpar, novo fluxo deve iniciar do zero

### Passo 4 - Resetar `handoffDone` no momento certo

Alteracoes propostas:

- limpar o flag em `startInteractivePurchase`
- limpar o flag em `clearCart`
- revisar se deve ser limpo tambem ao adicionar primeiro item em carrinho vazio

Validacao:

- cliente deve conseguir concluir dois pedidos consecutivos na mesma sessao

### Passo 5 - Validar `interactiveVersion`

Alteracoes propostas:

- criar helper:
  - `extractInteractiveVersion(eventId)`
  - `isStaleInteractiveEvent(eventId, session)`
- rejeitar eventos antigos com mensagem clara

Validacao:

- clicar em menu velho nao pode alterar estado atual
- sistema deve reenviar o menu correto

## Cenarios de Teste Recomendados

### Fluxo 1 - Compra simples

1. Abrir produto
2. Escolher tamanho
3. Escolher quantidade
4. Ver carrinho
5. Finalizar

### Fluxo 2 - Compra com varios tamanhos do mesmo produto

1. Comprar produto A tamanho M
2. Escolher `Outro Tamanho`
3. Comprar tamanho G
4. Confirmar que M nao reaparece na lista se essa for a regra desejada

### Fluxo 3 - Compra com fila

1. Abrir produto A
2. Antes de concluir, clicar produto B
3. Confirmar que B entra em `buyQueue`
4. Tentar finalizar com fila pendente
5. Confirmar que aparece o aviso da fila

### Fluxo 4 - Handoff repetido

1. Concluir um pedido
2. Iniciar nova compra na mesma sessao
3. Tentar concluir novamente
4. Confirmar que o segundo handoff acontece normalmente

### Fluxo 5 - Botao expirado

1. Abrir um menu de quantidade
2. Avancar o estado para outro produto
3. Clicar no botao antigo
4. Confirmar que o sistema rejeita o clique expirado

## Riscos e Cuidados na Implementacao

- nao quebrar o parser semantico de grade
- nao remover o uso util de `messageProductMap`
- nao deixar a IA decidir regras que precisam ser deterministicas
- tomar cuidado com sessoes ja persistidas no Supabase contendo estados antigos

## Proposta de Execucao

Sugestao de implementacao em 1 lote pequeno e seguro:

1. ligar `handleQueueGuard`
2. remover fallback de `lastViewedProduct` no `buy_`
3. implementar `clearCart`
4. resetar `handoffDone`
5. validar `interactiveVersion`

## Conclusao

O fluxo principal esta perto de ficar bem robusto, mas ainda ha alguns pontos em que regras de negocio importantes estao delegadas a comportamento implicito ou a IA. O caminho mais seguro e tornar fechamento, fila, limpeza de carrinho e invalidacao de menus completamente deterministicos.

O bug da lista observado no teste foi real e ja foi corrigido. Este documento registra os proximos ajustes recomendados para estabilizar o fluxo comercial.
