# Relatorio Tecnico do Estudo de Fluxos IA + FSM

Projeto: Agente Belux  
Arquivo principal analisado: `index.js`  
Arquivos de apoio analisados: `services/gemini.js`, `services/zapi.js`, `services/woocommerce.js`, `services/conversation-memory.js`

## Objetivo deste documento

Este documento consolida o estudo dos problemas observados nos fluxos de:

- contexto da IA durante a FSM de compra
- selecao de tamanho e quantidade por texto natural
- exibicao de fotos e continuidade do catalogo
- reconhecimento de produto citado por reply
- carrinho em tempo real
- interpretacao de grades em lote como `9P 5M 3G`

O foco aqui nao e apenas listar bugs. A ideia e entregar um diagnostico que permita ao Claude Code executar as correcoes com o maximo de contexto possivel, entendendo:

- o que ja foi corrigido
- o que ainda falha
- por que falha
- quais pontos tem prioridade maior
- qual estrategia tecnica tende a ser mais robusta

---

## Resumo executivo

O projeto ja evoluiu bastante. O problema atual nao e mais "faltam funcoes basicas". A base agora tem:

- FSM de compra funcional
- contexto vivo de atendimento
- contexto adicional da FSM para a IA
- suporte melhor para tamanho e quantidade por texto
- mapeamento de mensagem enviada para produto exibido

As melhorias ja presentes resolveram uma parte importante dos erros de resposta desconectada da IA. Mesmo assim, ainda existem falhas importantes de fluxo.

### Achados principais

1. A correcao estrutural mais importante foi a criacao de `buildFsmContext()` e sua injecao em `buildAiContext()`. Isso reduziu bastante respostas fora de contexto.
2. O projeto ja possui `messageProductMap` e `registerMessageProduct()`, o que melhora a resolucao de replies em mensagens de produto.
3. O bug mais claro ainda ativo e o conflito entre "ver mais produtos" e o detector de pedido de fotos.
4. A interpretacao de grade em lote ainda e fragil. Exemplos como `9P 5M 3G` nao possuem parser robusto.
5. O caso `tem P dessa?` nao depende so da IA. Ele depende principalmente da capacidade do backend em resolver com seguranca qual produto foi citado no reply.

---

## Escopo analisado

### Arquivos

- `index.js`
- `services/gemini.js`
- `services/zapi.js`
- `services/woocommerce.js`
- `services/conversation-memory.js`

### Fluxos observados

- exibicao de catalogo e pagina seguinte
- pedido de fotos
- compra interativa por produto
- selecao de tamanho
- selecao de quantidade
- adicionar ao carrinho
- escolher outro tamanho
- continuar comprando
- finalizar pedido
- reply em foto/vitrine
- entradas de texto curto, ambiguo e natural

---

## Estado atual do codigo

### Funcoes relevantes ja existentes

Ao contrario de um diagnostico anterior mais antigo, o codigo atual ja possui funcoes centrais implementadas:

- `showProductPhotos`
- `clearCart`
- `searchAndShowProducts`
- `handoffToConsultant`
- `showNextPage`
- `sendProductPage`
- `registerMessageProduct`
- `buildFsmContext`

Isso muda o foco do problema. Hoje o desafio nao e preencher lacunas basicas de implementacao, e sim corrigir conflitos de interpretacao e pontos de integracao entre:

- webhook
- FSM
- heuristicas locais
- IA
- mapeamento de mensagens

---

## Parte 1: O que ja foi corrigido e por que isso foi importante

## 1.1. `buildFsmContext()` melhorou o contexto da IA

Funcao analisada em `index.js`.

### O que ela entrega para a IA

Quando a FSM esta ativa, o bloco inclui:

- produto em foco
- etapa atual
- tamanhos disponiveis
- instrucao de como responder com token de tamanho
- tamanho ja escolhido, quando aplicavel
- fila de compras
- carrinho atual com total

### Impacto real

Antes dessa abordagem, a IA podia responder de forma coerente com a conversa, mas incoerente com o estado exato da compra. Isso gerava respostas como:

- perguntar novamente o que o cliente queria quando ja havia produto em foco
- ignorar que a etapa era definicao de tamanho
- ignorar que havia itens no carrinho
- responder como se a conversa tivesse "reiniciado"

### Conclusao

Essa foi uma correcao estrutural importante e correta. Nao parece ser um paliativo; ela melhora a qualidade geral da continuidade entre conversa e FSM.

---

## 1.2. Compra por texto natural ficou melhor para casos simples

Ja existe uma camada de interceptacao local para alguns casos durante a FSM:

- cliente digita tamanho diretamente, como `G`
- cliente digita indice do tamanho, como `2`
- cliente digita quantidade simples durante `awaiting_quantity`

Tambem houve ajuste no Gemini para:

- aceitar token `TAMANHO` com nome textual, nao so numero
- aceitar token `QUANTIDADE`
- limpar esses tokens da resposta visivel

### Impacto real

Isso reduz roundtrip desnecessario com a IA para casos simples e frequentes.

### Limite atual

Essa melhora cobre bem casos curtos e deterministas, mas nao cobre bem:

- grades em lote
- frases com mais de um tamanho
- frases hibridas com tamanho + quantidade + confirmacao

---

## 1.3. Carrinho em tempo real esta melhor alinhado

O estudo confirma que resumo de carrinho e contexto de memoria ja leem `session.items` vivo, sem depender de snapshot obsoleto.

Isso significa que o ganho mais importante nao foi no carrinho em si, e sim em expor esse carrinho para a IA por meio do contexto expandido.

---

## 1.4. Mapeamento de mensagem para produto ja existe

Hoje o projeto ja possui:

- `messageProductMap` persistido na sessao
- `registerMessageProduct(session, zaapId, messageId, product)`
- tentativas de resolver produto citado via:
  - `quotedMessage`
  - `referenceMessageId`
  - fallback REST
  - mapa de mensagem

### Impacto real

Essa foi uma evolucao importante para reduzir o problema de reply em cima de imagem/vitrine.

### Limitacao

Mesmo com isso, o sistema ainda depende da consistencia do ID que a Z-API envia de volta no webhook.

---

## Parte 2: Bugs confirmados ou fortemente provaveis

## 2.1. Bug confirmado: "Ver Mais Produtos" pode cair como pedido de foto

### Sintoma observado

Quando o cliente escolhe `Ver Mais Produtos`, o fluxo em alguns casos nao continua no catalogo. Em vez disso, o sistema reabre foto do ultimo produto visto e pode responder algo como:

- `Foto unica por aqui!`
- `Essa peca so tem uma foto...`

### Causa tecnica

O texto sintetico usado para o botao/lista `cart_more_products` vira:

- `quero ver mais produtos`

Ao mesmo tempo, o detector de foto considera expressões como:

- `quero ver mais`
- `ver mais`

Como esse detector roda antes da continuacao normal de catalogo, a frase de "ver mais produtos" pode ser desviada para `showProductPhotos()`.

### Impacto

- quebra a experiencia de navegacao
- faz o sistema parecer "burro"
- desvia o usuario do funil correto
- gera confusao entre intencao visual e intencao de navegacao

### Nivel de confianca

Alto. O encadeamento do bug ficou claro na leitura do fluxo.

### Prioridade

Muito alta.

---

## 2.2. Bug/gap importante: grade em lote nao tem parser robusto

### Exemplos problematicos

- `9P 5M 3G`
- `9 p / 5 m / 3 g`
- `quero 6 do G e 3 do M`
- `separa 2 P, 4 M e 1 GG`
- `manda 10 P e 8 G dessa`

### Situacao atual

O sistema lida bem com:

- um tamanho por vez
- uma quantidade por vez
- alguns casos de texto natural simples

Mas nao existe uma etapa dedicada para traduzir um bloco de grade em lote para uma estrutura interna segura.

### Risco adicional

Durante `awaiting_quantity`, o fallback simples com `parseInt(text.trim(), 10)` pode capturar apenas o primeiro numero de uma mensagem complexa e interpretar errado.

Exemplo:

- texto: `9P 5M 3G`
- risco: ler `9` como quantidade simples do tamanho atual

### Impacto

- itens adicionados errados no carrinho
- resposta incoerente com o pedido do cliente
- perda de confianca no atendimento
- necessidade de correcoes manuais por humano

### Prioridade

Muito alta.

---

## 2.3. Caso "tem P dessa?" ainda depende fortemente de identificacao correta do produto citado

### Sintoma observado

Cliente responde em cima de uma foto/vitrine com algo como:

- `tem P dessa?`

E o sistema responde:

- `Qual peca voce gostou?`
- `Me fala o numero dela aqui na lista`

Mesmo quando para o humano esta obvio qual produto foi citado.

### Leitura tecnica

Esse problema nao e apenas "a IA nao entendeu".

Ele nasce principalmente quando o backend nao consegue resolver, com seguranca, qual produto esta sendo citado na mensagem respondida.

Hoje existe tentativa de resolver por:

- caption da mensagem citada
- numero extraido da caption
- JSON bruto da `quotedMessage`
- REST fallback
- `messageProductMap`
- `referenceMessageId`

### O que isso significa

Se ainda esta falhando em producao, as causas mais provaveis sao:

- o webhook nao esta trazendo o ID certo do reply
- o ID enviado no showcase nao bate com o ID retornado no reply
- algum formato de mensagem interativa da Z-API nao esta sendo mapeado do jeito esperado
- existe tipo de reply que chega sem caption resolvivel e sem chave rastreavel no mapa

### Conclusao

Esse problema hoje parece mais um bug de integracao e rastreamento de mensagem do que um problema exclusivamente de prompt ou modelo.

### Prioridade

Alta.

---

## 2.4. Heuristicas locais ainda podem competir com a IA de forma errada

O sistema tem varios interceptadores locais antes da chamada para a IA.

Isso e bom quando:

- o caso e deterministico
- a resposta pode ser resolvida localmente com confianca alta

Isso e ruim quando:

- a heuristica e ampla demais
- o caso depende de contexto semantico
- um atalho local consome uma mensagem que deveria ser interpretada pela IA

### Exemplo ja confirmado

- `ver mais produtos` sendo absorvido como pedido de foto

### Exemplos de risco

- `ok`
- `sim`
- `tem P dessa?`
- `quero G e 3`
- `separa 4 da M e 2 da G`

### Conclusao

O projeto precisa de uma separacao mais clara entre:

- intents deterministicas
- intents semanticas
- intents ambíguas que exigem resolucao assistida

---

## Parte 3: Analise da ideia de usar IA para "traduzir antes"

## 3.1. A ideia e boa, mas nao como camada unica

A proposta de usar a IA para ler entradas como grade em lote e traduzi-las antes de seguir o fluxo faz sentido.

Ela pode reduzir bastante a "burrice" em frases humanas como:

- `9P 5M 3G`
- `quero 4 G e 2 GG dessa`
- `manda 6 do tamanho M e 3 do G`

### Ponto importante

Eu nao recomendaria delegar tudo para a IA desde a borda do webhook.

Se toda mensagem passar primeiro por interpretacao livre da IA, surgem custos:

- mais latencia
- mais chance de inventar estrutura
- mais pontos de falha
- menos previsibilidade em casos simples

---

## 3.2. Estrategia recomendada: arquitetura hibrida

### Camada 1: heuristica deterministica

Resolver localmente o que e obvio:

- `G`
- `GG`
- `2`
- `quero G`
- `3`
- clique interativo

### Camada 2: parser semantico controlado por IA

Quando a mensagem:

- contem mais de um par quantidade+tamanho
- mistura tamanhos em lote
- usa linguagem mais natural
- nao e bem coberta por regex simples

Nessa hora, chamar a IA como parser, nao como atendente.

### Saida esperada

A IA nao deve responder em texto livre. Ela deve devolver estrutura controlada, por exemplo:

```json
{
  "intent": "batch_size_selection",
  "items": [
    { "size": "P", "qty": 9 },
    { "size": "M", "qty": 5 },
    { "size": "G", "qty": 3 }
  ],
  "confidence": 0.97
}
```

### Vantagens

- mais inteligencia sem abrir mao de controle
- menos risco de mensagem "bonita" porem errada
- possibilidade de validar tudo contra o produto em foco
- tratamento melhor de frases humanas reais

### Guardas necessarios

- so usar esse parser quando houver produto em foco bem resolvido
- validar todos os tamanhos contra `product.sizes`
- rejeitar estrutura parcial ou ambigua
- se a confianca for baixa, pedir confirmacao ao cliente

---

## Parte 4: Diagnostico detalhado por fluxo

## 4.1. Fluxo de catalogo e paginacao

### O que esta bom

- existe pagina seguinte
- existe acumulacao em `session.products`
- existe envio de showcase
- existe mapeamento de mensagem para produto

### O que esta fraco

- termos como `ver mais` se chocam com pedido de foto
- a semantica de catalogo e foto ainda esta misturada em algumas heuristicas

### Acao recomendada

- separar explicitamente intents de navegacao de intents visuais
- deixar o detector de foto dependente de sinais visuais mais fortes como `foto`, `imagem`, `mais fotos`

---

## 4.2. Fluxo de fotos

### O que esta bom

- o sistema trata produto com 1 foto
- o sistema trata produto com varias fotos
- atualiza `lastViewedProduct`
- tenta fechar com showcase interativo

### O que esta fraco

- alguns pedidos curtos ou replies ainda dependem de identificacao correta do produto
- o fluxo de foto ainda pode ser acionado por termos vagos demais

### Acao recomendada

- reduzir o escopo do detector de foto
- preferir evidencias fortes de intencao visual
- auditar em log todos os casos em que `showProductPhotos()` e disparado sem numero explicito

---

## 4.3. Fluxo de reply em imagem/vitrine

### O que esta bom

- hoje ja existe tentativa forte de recuperar o produto citado
- ha `messageProductMap`
- ha fallback por `referenceMessageId`
- ha fallback por `quotedMessage`

### O que ainda pode falhar

- divergencia entre `messageId`, `zaapId`, `referenceMessageId` e IDs retornados pela Z-API
- formatos de reply diferentes para imagem, button-list e option-list

### Acao recomendada

- registrar em log, com clareza, os IDs de ida e volta
- medir qual ID efetivamente reaparece no webhook
- priorizar a chave mais estavel no `messageProductMap`

---

## 4.4. Fluxo de compra interativa

### O que esta bom

- fila de compras
- selecao de tamanho
- selecao de quantidade
- outro tamanho
- passagem para proximo produto
- carrinho atualizado

### O que ainda falta

- interpretacao robusta de grade em lote
- protecao contra textos complexos caindo no fallback simples de quantidade

### Acao recomendada

- bloquear `parseInt` cego em mensagens alfanumericas quando houver letras de tamanho
- antes de assumir quantidade simples, verificar se a mensagem contem padrao de grade

---

## Parte 5: Plano de acao recomendado

## Prioridade 1: corrigir conflito entre foto e paginacao

### Objetivo

Impedir que `Ver Mais Produtos` seja tratado como pedido de foto.

### Direcao tecnica

- remover `ver mais` e `quero ver mais` do detector de foto
- tratar `cart_more_products` explicitamente como navegacao
- revisar outros textos sinteticos semelhantes para evitar colisao semantica

### Resultado esperado

Fluxo de catalogo fica previsivel e deixa de "voltar" para a foto do ultimo item.

---

## Prioridade 2: criar parser robusto de grade em lote

### Objetivo

Entender mensagens com multiplos tamanhos e quantidades sem depender de clices sequenciais ou de uma unica regex fragil.

### Direcao tecnica

Criar um pipeline em 3 etapas:

1. detector local de possivel grade em lote
2. parser semantico por IA, retornando JSON controlado
3. validacao local contra o produto em foco e os tamanhos disponiveis

### Resultado esperado

Mensagens como `9P 5M 3G` deixam de ser tratadas como ruído ou quantidade unica.

---

## Prioridade 3: fortalecer o fluxo de reply em produto

### Objetivo

Garantir que mensagens como `tem P dessa?` resolvam automaticamente o produto citado sempre que houver referencia suficiente.

### Direcao tecnica

- auditar todos os IDs retornados pelo envio e pelo webhook
- validar o caminho `message sent -> map stored -> reply received -> product resolved`
- identificar quais tipos de mensagem da Z-API retornam IDs consistentes

### Resultado esperado

Perguntas curtas em reply passam a manter contexto de produto com muito mais frequencia.

---

## Prioridade 4: separar melhor heuristica local e interpretacao semantica

### Objetivo

Evitar que atalhos locais "roubem" mensagens que exigem interpretacao contextual.

### Direcao tecnica

- manter no codigo apenas o que for muito confiavel
- mandar para parser semantico os casos de linguagem natural mais flexivel
- revisar interceptadores amplos demais

---

## Parte 6: Hipoteses tecnicas importantes para validacao

As seguintes hipoteses devem ser validadas durante a implementacao:

1. O `messageProductMap` realmente esta recebendo a chave que reaparece no reply do webhook.
2. `zaapId` e `messageId` podem nao representar a mesma coisa em todos os endpoints da Z-API.
3. O fluxo de vitrine interativa pode gerar replies com estrutura diferente do fluxo de imagem simples.
4. A Z-API pode entregar `quotedMessage` incompleto em alguns cenarios.
5. O fallback de quantidade simples pode estar gerando erro silencioso em mensagens de grade.

---

## Parte 7: Riscos de implementacao

## 7.1. Risco de deixar a IA solta demais

Se o parser semantico de grade for implementado como resposta livre, o sistema pode:

- inventar pares tamanho/quantidade
- interpretar produto errado
- responder bonito, mas estruturalmente errado

### Mitigacao

- obrigar saida estruturada
- validar localmente tudo
- ignorar parser com baixa confianca

---

## 7.2. Risco de heuristica apertada demais

Se as regexs e guardas ficarem restritivas demais, o sistema perde naturalidade e volta a pedir confirmacao em excesso.

### Mitigacao

- usar estrategia hibrida
- deixar a IA assumir apenas os casos realmente semanticos

---

## 7.3. Risco de corrigir um fluxo e quebrar outro

Foto, catalogo, reply e compra compartilham muitas entradas curtas:

- `sim`
- `mais`
- `ver mais`
- `essa`
- `quero essa`

### Mitigacao

- revisar ordem dos interceptadores
- criar testes de regressao por frase curta

---

## Parte 8: Casos de teste recomendados

## 8.1. Catalogo e paginacao

- `quero ver mais produtos`
- clique em `Ver Mais Produtos`
- `me mostra mais dessa categoria`
- `proximos`

## 8.2. Fotos

- `tem mais fotos?`
- `quero ver foto dessa`
- `me manda mais imagens`
- reply curto em cima da imagem: `mais`

## 8.3. Reply em produto

- reply em vitrine com `tem P dessa?`
- reply em foto simples com `tem M?`
- reply em button-list com `quero essa`
- reply sem numero explicito, mas com referencia consistente

## 8.4. Compra simples

- `G`
- `2`
- `quero G`
- `3`

## 8.5. Grade em lote

- `9P 5M 3G`
- `9 p 5 m 3 g`
- `quero 2 P e 4 M`
- `manda 6 do G e 2 do GG`
- `10 m dessa`
- `2 G e 3 dessa`

## 8.6. Casos ambiguos

- `ok`
- `sim`
- `essa`
- `mais`
- `pode ser`

---

## Parte 9: Conclusao final

O sistema ja saiu da fase de falhas basicas e entrou numa fase mais sensivel: agora os erros mais importantes sao de interpretacao, continuidade e integracao entre canais.

### O que ja esta forte

- FSM de compra
- contexto vivo de atendimento
- contexto adicional da FSM para a IA
- carrinho em tempo real
- mapeamento de mensagem para produto

### O que mais precisa de atencao agora

1. corrigir a colisao entre `ver mais produtos` e pedido de foto
2. criar parser robusto para grade em lote
3. fortalecer a resolucao de replies em imagem/vitrine
4. organizar melhor a fronteira entre heuristica local e interpretacao semantica por IA

### Direcao recomendada para implementacao

Usar uma estrategia hibrida:

- codigo para o que e deterministico
- IA como parser semantico controlado para o que e humano e variavel
- validacao local obrigatoria antes de alterar carrinho ou FSM

Essa abordagem tende a resolver a "burrice" percebida sem abrir mao de previsibilidade operacional.

---

## Anexo: orientacao direta para o Claude Code

Se este documento for usado como base de implementacao, a ordem recomendada e:

1. Corrigir o detector de foto para nao capturar `ver mais produtos`.
2. Instrumentar logs de reply com IDs completos para auditar `messageProductMap`.
3. Implementar parser de grade em lote com saida estruturada.
4. Bloquear fallback de quantidade simples quando o texto parecer grade.
5. Rodar testes de regressao nos fluxos de foto, paginacao, reply e compra.

O ponto mais importante e nao tratar tudo como prompt. Parte relevante do problema esta na resolucao deterministica do contexto, especialmente produto citado e intencao real da mensagem.
