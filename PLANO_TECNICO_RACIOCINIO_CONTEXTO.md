# Plano Tecnico: Raciocinio, Contexto e Interpretacao Semantica

## Objetivo

Este documento descreve o plano tecnico para fazer a Bela Belux deixar de depender de palavras exatas e passar a interpretar melhor a intencao real do usuario, mesmo com:

- giria
- abreviacao
- erro de digitacao
- frase incompleta
- mudanca de assunto no meio da compra
- pedidos implicitos
- interrupcoes humanas reais de WhatsApp

O foco principal nao e "melhorar o prompt". O foco principal e reorganizar a arquitetura para que a IA e a logica de negocio trabalhem juntas, com prioridade para intencao e contexto, e nao para regex isolada.

---

## Diagnostico Atual

### Sintomas vistos hoje

- A atendente entende bem mensagens "corretas", mas falha quando o usuario foge do vocabulario esperado.
- O fluxo de compra prende a conversa em estados como `awaiting_size`, `awaiting_quantity` e `awaiting_more_sizes`.
- O usuario muda de assunto e o sistema insiste na pergunta anterior.
- O usuario pede acao por intencao ("tira tudo ai pfv", "deixa isso", "chama uma pessoa", "quero outra linha") e o sistema nao entende.
- Em varios casos a IA nem chega a interpretar, porque o codigo decide antes.
- Em outros casos a IA interpreta, mas a resposta dela e descartada ou sobrescrita por guards.

### Problemas tecnicos centrais

1. A interpretacao esta fragmentada.

- Parte da logica esta em intercepts no webhook.
- Parte esta em regex locais na FSM.
- Parte esta no prompt da IA.
- Parte esta em guards depois da IA.

Resultado: nao existe um "cerebro unico" para decidir a intencao.

2. A FSM esta forte demais.

- O estado atual manda mais do que a intencao nova do usuario.
- O usuario fala algo fora da etapa atual e o sistema tende a reenviar menu.
- A FSM deveria orientar compra, nao aprisionar a conversa.

3. O sistema ainda depende de keyword matching.

- `limpar/esvaziar/zerar carrinho` funciona.
- `tira tudo ai`, `desfaz isso`, `errei tudo`, `cancela esse pedido` podem falhar.
- O significado e o mesmo, mas o sistema trata como diferente.

4. Contexto conversacional ainda e insuficiente para mudanca de rumo.

- O sistema sabe qual e o estado da compra.
- Mas ainda nao modela bem: "o usuario se arrependeu", "mudou de assunto", "quer interromper", "quer humano", "quer navegar".

5. A IA e chamada tarde demais em varios casos.

- Primeiro o codigo tenta decidir.
- Depois a IA e chamada.
- Depois guards podem invalidar a interpretacao da IA.

Isso reduz muito o ganho real de raciocinio.

---

## Arquivos Mais Criticos Hoje

- `D:\Projetos Antigravity\Bela Belux\index.js`
- `D:\Projetos Antigravity\Bela Belux\services\semantic.js`
- `D:\Projetos Antigravity\Bela Belux\services\conversation-memory.js`
- `D:\Projetos Antigravity\Bela Belux\services\gemini.js`
- `D:\Projetos Antigravity\Bela Belux\services\woocommerce.js`
- `D:\Projetos Antigravity\Bela Belux\services\supabase.js`

---

## Arquitetura Alvo

### Principio central

Separar o processo em 3 camadas:

1. Entender a mensagem
2. Decidir a acao
3. Responder em linguagem natural

Hoje essas 3 coisas estao misturadas.

### Novo fluxo ideal

`mensagem -> normalizacao -> interpretacao estruturada -> prioridade de intencao -> execucao de acao -> resposta natural`

### Contrato de interpretacao

A interpretacao da mensagem deve virar um objeto estruturado, por exemplo:

```json
{
  "intent": "clear_cart",
  "confidence": 0.94,
  "change_topic": true,
  "interrupts_current_flow": true,
  "target_scope": "entire_cart",
  "requested_category": null,
  "requested_product_reference": null,
  "needs_clarification": false,
  "reasoning_note": "Usuario expressou arrependimento e pedido de remocao total"
}
```

Esse objeto vira a verdade operacional do sistema. A resposta textual deixa de ser a fonte principal de decisao.

---

## Metas Tecnicas

### Meta 1

Permitir que o usuario interrompa qualquer etapa da compra com linguagem natural.

### Meta 2

Fazer a intencao vencer a FSM quando houver conflito.

### Meta 3

Reduzir drasticamente dependencias de palavras exatas.

### Meta 4

Diminuir numero de "reenvio de menu" por falha de interpretacao.

### Meta 5

Criar observabilidade para aprender com conversas reais.

---

## Fase 1: Estabilizacao Imediata

Objetivo: corrigir os erros mais visiveis sem refatoracao total.

### 1.1. Tornar interrupcoes prioridade maxima

Criar uma etapa unica no topo do webhook para reconhecer:

- limpar carrinho
- desfazer compra
- cancelar fluxo atual
- falar com humano
- mudar de categoria
- ver mais produtos
- ver fotos
- revisar carrinho
- finalizar pedido

Essa etapa deve rodar antes da FSM.

### 1.2. Encerrar FSM em handoff humano

Ao executar `handoffToHuman()`:

- chamar `resetPurchaseFlow(session)`
- limpar `buyQueue`
- opcionalmente marcar `session.supportMode = "human_pending"`
- impedir menus automaticos logo apos handoff

Sem isso, o sistema continua "lembrando" do produto e repete pergunta de tamanho.

### 1.3. Expandir sinonimos de intents criticas

O resolvedor semantico precisa reconhecer variacoes reais:

- `tira tudo ai`
- `desfaz isso`
- `errei tudo`
- `apaga tudo`
- `cancela esse pedido`
- `chama uma pessoa`
- `fala comigo no humano`
- `deixa isso`
- `quero outra linha`
- `vamos pra outro produto`

### 1.4. Criar fallback mais inteligente

Quando a interpretacao vier vazia:

- usar contexto atual
- checar se ha mudanca de assunto
- checar se usuario esta corrigindo algo
- perguntar com desambiguacao curta quando necessario

Exemplo:

- "Voce quer limpar o carrinho todo ou so esse item?"
- "Voce quer ver outra categoria ou continuar nesse produto?"

### Entregaveis da Fase 1

- interrupcoes globais funcionando
- handoff humano sem herdar FSM antiga
- limpeza de carrinho com frases naturais
- menor reincidencia de menu errado

---

## Fase 2: Interpretacao Estruturada

Objetivo: centralizar a inteligencia de entendimento.

### 2.1. Criar um `intent resolver` unico

Criar um servico dedicado, por exemplo:

- `services/intent-resolver.js`

Responsabilidades:

- receber texto bruto
- normalizar linguagem
- usar contexto da sessao
- devolver `intent + entidades + confianca + flags`

### 2.2. Unificar regras espalhadas

Migrar para o resolver central a logica hoje espalhada em:

- intercepts do webhook
- regex da FSM
- `semantic.js`
- memoria conversacional
- guards de acao

### 2.3. Separar intents por tipo

Sugestao de taxonomia:

- `BROWSE_CATEGORY`
- `BROWSE_LAUNCHES`
- `BROWSE_MORE_PRODUCTS`
- `VIEW_PHOTOS`
- `SELECT_PRODUCT`
- `SET_SIZE`
- `SET_QUANTITY`
- `ADD_GRADE`
- `VIEW_CART`
- `CLEAR_CART`
- `REMOVE_ITEM`
- `CHECKOUT`
- `HUMAN_HANDOFF`
- `CHANGE_TOPIC`
- `CANCEL_CURRENT_FLOW`
- `SMALL_TALK`
- `UNKNOWN`

### 2.4. Introduzir nivel de confianca

Toda interpretacao deve trazer `confidence`.

Regras sugeridas:

- `>= 0.85`: executa direto
- `0.60 a 0.84`: executa se contexto ajudar
- `< 0.60`: pede confirmacao curta

### 2.5. Modelar entidades relevantes

Extrair tambem:

- categoria desejada
- produto citado
- item do carrinho citado
- tamanho
- quantidade
- escopo da remocao
- referencia a mensagem respondida

---

## Fase 3: FSM Subordinada a Intencao

Objetivo: fazer o fluxo obedecer ao usuario.

### 3.1. Redefinir papel da FSM

A FSM passa a ser:

- orientadora de coleta de dados
- guardia de integridade transacional
- memoria do passo atual

A FSM deixa de ser:

- principal interpretadora da conversa
- dona absoluta do fluxo

### 3.2. Criar politica de preempcao

Cada intent deve informar se interrompe a FSM atual:

- `CLEAR_CART`: sempre interrompe
- `HUMAN_HANDOFF`: sempre interrompe
- `CHANGE_TOPIC`: interrompe
- `BROWSE_CATEGORY`: interrompe
- `VIEW_PHOTOS`: pode interromper dependendo do contexto
- `SET_QUANTITY`: continua
- `SET_SIZE`: continua

### 3.3. Criar transicoes explicitas de saida

Toda etapa da FSM deve aceitar saidas formais:

- `cancel`
- `change_topic`
- `start_over`
- `go_to_catalog`
- `handoff_human`

Hoje varias dessas saidas sao improvisadas por regex.

---

## Fase 4: IA como Interpretadora Estruturada

Objetivo: usar a IA para raciocinar melhor, sem entregar o controle do sistema inteiro.

### 4.1. Mudar papel da IA

Hoje a IA faz:

- entender a mensagem
- decidir acao
- responder em linguagem natural

O ideal e dividir:

- IA 1: interpretar em JSON
- Sistema: validar e executar
- IA 2 ou template: redigir resposta final

### 4.2. Prompt especifico para classificacao

Criar um prompt curto e tecnico para a etapa de interpretacao:

- sem personagem
- sem floreio comercial
- sem resposta natural
- foco total em intent, entidades, confianca e interrupcao de fluxo

### 4.3. Validacao de schema

Toda resposta estruturada da IA deve ser validada:

- campos obrigatorios
- enums conhecidos
- confianca numerica
- payload seguro

Se invalidar, cai para heuristica local.

### 4.4. Evitar que texto da IA controle a automacao

Nao depender de texto como:

- "acho que ela quer limpar"
- "parece que ela quer mudar"

O sistema deve depender de estrutura, por exemplo:

- `intent = CLEAR_CART`
- `interrupts_current_flow = true`

---

## Fase 5: Memoria de Contexto Real

Objetivo: dar contexto util para a interpretacao, nao apenas historico bruto.

### 5.1. Evoluir a memoria da conversa

Adicionar ao estado:

- `activeTopic`
- `previousTopic`
- `currentGoal`
- `lastResolvedIntent`
- `lastInterruptedFlow`
- `userCorrectionMode`
- `pendingClarification`
- `supportMode`

### 5.2. Detectar correcoes humanas

Criar sinais para frases de correcao:

- "errei"
- "nao, pera"
- "nao e isso"
- "deixa"
- "volta"
- "muda"

Essas frases devem aumentar prioridade de:

- `CHANGE_TOPIC`
- `CLEAR_CART`
- `CANCEL_CURRENT_FLOW`

### 5.3. Tratar quoted reply como entidade forte

Quando a pessoa responde em cima de uma vitrine, foto ou resumo:

- a referencia da mensagem deve pesar muito na interpretacao
- isso vale para foto, produto, item de carrinho e correcao

---

## Fase 6: Observabilidade e Aprendizado

Objetivo: transformar erro real em melhoria continua.

### 6.1. Logar falhas de entendimento

Salvar eventos quando:

- cair em fallback contextual
- reenviar menu por ambiguidade
- o usuario repetir pedido logo depois
- o usuario corrigir a IA
- houver handoff apos frustracao

### 6.2. Criar dataset real

Montar uma base de exemplos com:

- mensagem original
- contexto da sessao
- intent escolhida
- intent correta
- resultado do sistema

### 6.3. Criar painel simples de qualidade

Metricas minimas:

- taxa de fallback
- taxa de reenvio de menu
- taxa de handoff por frustracao
- taxa de intents nao reconhecidas
- taxa de correcoes do usuario em ate 2 mensagens

---

## Fase 7: Testes de Regressao

Objetivo: impedir que o sistema volte a ficar literal demais.

### 7.1. Suite de casos reais

Criar testes para frases como:

- `eu errei, tira tudo ai pfv`
- `desfaz isso`
- `chama uma pessoa`
- `tem de menino?`
- `quero cueca`
- `manda mais dessa`
- `me mostra melhor essa`
- `quero outra categoria`
- `deixa esse produto`
- `vamos voltar do zero`

### 7.2. Testes por contexto

A mesma frase pode significar coisas diferentes dependendo do estado:

- `manda mais`
- `segue`
- `quero esse`
- `deixa`

Os testes precisam considerar:

- sem FSM
- `awaiting_size`
- `awaiting_quantity`
- `awaiting_more_sizes`
- carrinho ativo
- apos handoff humano

### 7.3. Testes de contrato

Validar sempre:

- intent retornada
- action executada
- se interrompe FSM ou nao
- se pede clarificacao ou nao

---

## Desafios Tecnicos Esperados

### 1. Ambiguidade real de linguagem

Exemplo:

- "manda mais"

Pode significar:

- mais produtos
- mais fotos
- proximo item da fila

Solucao: resolver por contexto + confianca + clarificacao curta quando necessario.

### 2. Conflito entre heuristica local e IA

As vezes a heuristica vai dizer uma coisa e a IA outra.

Solucao:

- definir politica de precedencia
- usar intents criticas deterministicas
- usar IA para cinzas e ambiguidades

### 3. Custo e latencia

Mais interpretacao pode aumentar tempo de resposta.

Solucao:

- heuristica rapida para intents obvias
- IA apenas quando contexto exigir
- cache curto de contexto resolvido

### 4. Risco de overfitting para exemplos atuais

Se so adicionar sinonimos pontuais, o sistema volta a ficar literal.

Solucao:

- modelar intencao, nao lista infinita de palavras
- usar dataset real para generalizacao

### 5. Convivencia com legado

O projeto atual ja tem muita logica em `index.js`.

Solucao:

- migracao em camadas
- introduzir novo resolver sem quebrar o fluxo atual
- desligar regex antigas aos poucos

---

## Ordem Recomendada de Implementacao

### Sprint 1

- corrigir `handoffToHuman()` para resetar FSM
- fortalecer intents de interrupcao
- melhorar `clear cart` com linguagem natural
- impedir reenvio de menu apos handoff humano

### Sprint 2

- criar `intent-resolver.js`
- centralizar interpretacao basica
- mover regras criticas para esse resolver

### Sprint 3

- introduzir `confidence`
- criar estrategia de clarificacao curta
- reduzir regex espalhadas na FSM

### Sprint 4

- adicionar interpretacao estruturada com IA
- validar schema
- separar entendimento de resposta

### Sprint 5

- observabilidade
- dataset real
- testes de regressao por contexto

---

## Criterios de Aceite

O plano sera considerado bem sucedido quando:

- `tira tudo ai pfv` limpar o carrinho sem depender da palavra `carrinho`
- `chama uma pessoa` encerrar o fluxo atual e nao reenviar menu antigo
- `quero cueca` abrir linha masculina
- `tem infantil de menina?` abrir infantil feminino
- `manda mais dessa` diferenciar foto de navegacao com base no contexto
- o numero de reenvios de menu por ambiguidade cair de forma perceptivel
- o usuario conseguir mudar de assunto sem lutar contra a FSM

---

## Recomendacao Final

Nao continuar crescendo o sistema apenas com mais regex e mais prompt.

Esse caminho aumenta complexidade, reduz previsibilidade e mantem a sensacao de "burra fora do roteiro".

O melhor caminho e:

- centralizar interpretacao
- estruturar intents
- subordinar a FSM ao usuario
- usar IA para entender, nao para improvisar controle de fluxo
- medir erros reais e aprender com eles

Esse plano foi desenhado para ser executado em etapas, sem precisar reescrever o projeto inteiro de uma vez.
