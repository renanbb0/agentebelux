# Relatório Qualitativo — Análise IA das Sessões de Produção

**Gerado em:** 17/04/2026, 21:50:06
**Modelo:** gemini-2.5-flash
**Sessões analisadas:** 28
**Origem:** `logs/parsed/sessions.jsonl`

---

Como arquiteto sênior de IA conversacional, analisei as 28 sessões de produção do seu bot de vendas WhatsApp B2B da Belux Moda Íntima para identificar pontos críticos e oportunidades de melhoria.

## Relatório Qualitativo: Análise de Sessões do Bot de Vendas Belux

### 1. Padrões de Falha

Após a revisão das timelines e ações, identifiquei os seguintes padrões de falha recorrentes:

#### Padrão 1: Dificuldade em Processar Pedidos Complexos ou Multi-itens em Linguagem Natural
*   **O que aconteceu:** Clientes tentam fornecer detalhes de pedidos com múltiplas peças, tamanhos ou referências em uma única mensagem ou sequência rápida, mas o bot não consegue parsear e adicionar ao carrinho (`cart_adds: 0`), frequentemente resultando em `TEXT_ONLY` ou handoff.
    *   **Exemplos:**
        *   `5585****5870` (1ª sessão): Cliente envia "Mãe 2M", "2gg", "1M", "Mãe 2G \n1G filha", "1g filha \n1gg mae". `cart_adds: 0`.
        *   `5534****3844` (1ª sessão): Cliente envia "2m,2g,2gg mãe 2m,2g,2gg Filha", "2m,2g,2gg Mãe Ref696S\nFilha Ref 796S 1m,1g,1gg, 1exg". `cart_adds: 0`, resultando em `auto_escalation`.
        *   `5511****4342`: Cliente envia "1- 4", "1- 10", "1-6". Bot responde com `TEXT_ONLY` ("Anotado aqui", "Entendido! Já anotei"), mas `cart_adds: 0`. Cliente expressa confusão ("Oshe") e pede atendente.
*   **Em quantas sessões aparece:** Claramente em 3-4 sessões de forma crítica, com indicações em outras onde a bot não consegue avançar.
*   **Causa raiz provável:** **FSM/IA:** O modelo de linguagem natural (NLU) do bot e/ou o Finite State Machine (FSM) não estão otimizados para extrair e consolidar múltiplas informações de produto (quantidade, tamanho, referência) de frases complexas e aditivas. A ausência de uma ação específica para "adicionar múltiplos itens" ou um fluxo de confirmação estruturado após tal entrada força o bot a responder genericamente (`TEXT_ONLY`) ou falhar.

#### Padrão 2: Respostas Genéricas (`VER_TODOS`) para Perguntas Específicas ou Consultivas
*   **O que aconteceu:** Clientes fazem perguntas que exigem informações específicas (ex: "status de pedido", "fotos de pacote", "entregas"), mas o bot frequentemente responde acionando a ação `VER_TODOS`, mostrando o catálogo geral ou lançamentos, o que não atende à intenção original do cliente.
    *   **Exemplos:**
        *   `5588****0051`: Cliente pergunta sobre entrega ("tem como você entregar minha encomenda amanhã"), mas o bot aciona `VER_TODOS` implicitamente após áudio transcrito. Posteriormente, cliente diz "Não quero catálogo", evidenciando a falha.
        *   `5566****0050`: Cliente pergunta "Mandou mhs coisaa", bot responde com `VER_TODOS` ("lançamentos da semana"). Cliente repete "E ai mandou msh coisas", novamente não atendido.
        *   `5582****0066`: Cliente pergunta "Me manda foto do pacote, por favor", bot responde com `VER_TODOS` ("nossos lançamentos").
*   **Em quantas sessões aparece:** Pelo menos 5-6 sessões com `VER_TODOS` sendo a ação inadequada. (Já mapeado como "top action errada").
*   **Causa raiz provável:** **IA/KB/Prompt:** O modelo de IA não está distinguindo corretamente as intenções de "ver catálogo" de outras intenções mais específicas (como "status do pedido" ou "detalhes de entrega"). A Base de Conhecimento (KB) pode ser deficiente em respostas para essas perguntas, ou o prompt da IA pode ter um viés excessivo para a ação `VER_TODOS` como fallback.

#### Padrão 3: Frustração e Handoff Explícito após Iterações Ineficazes
*   **O que aconteceu:** Clientes tentam interagir com o bot, mas após algumas tentativas infrutíferas de obter informações ou realizar ações, eles solicitam explicitamente um atendente humano.
    *   **Exemplos:**
        *   `5585****7537`: Cliente pede "Falar com vendedora humana" após um "Bom dia!!", indicando uma preferência imediata ou falha anterior em outro canal.
        *   `5588****0051`: Cliente pede atendente várias vezes, mesmo após a bot tentar mostrar produtos, o que leva à frustração.
        *   `5563****6356`: Cliente passa 61 minutos e, após não ter seu pedido aceito e receber `VER_TODOS` para uma pergunta de preço, finaliza com "Ficou horrível esse atendimento robotizado".
        *   `5511****4342`: Após a bot não adicionar itens ao carrinho, cliente diz "Oshe" e pede "Quero falar com a atendente".
*   **Em quantas sessões aparece:** Pelo menos 5-6 sessões de handoff são precedidas por tentativas frustradas do cliente.
*   **Causa raiz provável:** **IA/FSM:** A IA não está conseguindo resolver a intenção primária do cliente, ou o FSM não oferece caminhos alternativos eficazes. A ausência de um mecanismo de "escape" ou "fallback" suave para o humano, ou a recusa do bot em transferir prontamente, amplifica a frustração.

### 2. Sessões Críticas que Merecem Atenção Manual

Aqui estão até 5 sessões que exigem uma análise aprofundada:

1.  **`5534****3844` (1ª sessão: 110 min, auto_escalation):** Esta sessão é um excelente caso de estudo. O cliente tenta montar um pedido detalhado por texto ("2m,2g,2gg mãe...", "Ref696S", "Ref 796S") e posteriormente expressa uma necessidade ("Preciso de pijamas Inverno adulto e infantil", "Tem como me enviar por aqui"). A bot falha repetidamente em compreender ou agir sobre o pedido, levando à auto-escalation. Revela falhas na gestão de pedidos complexos e na proatividade do bot em oferecer ajuda ou catálogo relevante.
2.  **`5588****0051` (83 min, handoff):** Uma sessão de alta frustração. O cliente pergunta sobre uma entrega urgente ("entregar minha encomenda amanhã"), o que já indica uma necessidade específica fora do fluxo de vendas. O bot ignora, aciona `VER_TODOS` (inapropriadamente) e, mesmo após múltiplas solicitações explícitas de handoff ("Quero falar com atendente", "Não quero catálogo", "Quero falar com a atendente"), a bot tenta "descontrair" e continua a oferecer catálogo. Isso mostra uma falha crítica na priorização de `wantsHuman` e na adequação das ações.
3.  **`5563****6356` (61 min, sem handoff, sem conversão):** O cliente pergunta "Posso mandar meu pedido?" e "Qual a diferença de preço pelo site e aqui?". O bot responde com `TEXT_ONLY` e `VER_TODOS`. Após um longo período de inatividade do bot, o cliente expressa descontentamento explícito: "Ficou horrível esse atendimento robotizado". Essa sessão demonstra um colapso total da experiência, onde a ineficácia do bot leva à crítica direta e abandono.
4.  **`5511****4342` (39 min, handoff):** O cliente tenta adicionar múltiplos itens e quantidades ("1- 4", "1- 10", "1-6"). A bot responde que "anotou", mas não há `cart_adds`. A reação do cliente ("Oshe") e o pedido de handoff logo em seguida mostram a lacuna entre a percepção do bot de ter "anotado" e a ação real que o cliente esperava (adicionar ao carrinho).
5.  **`5585****5870` (1ª sessão: 6 min, sem handoff, sem conversão):** Apesar de ser curta, esta sessão é crítica por ser um exemplo direto de cliente tentando colocar um pedido com múltiplos itens e tamanhos ("Mãe 2M", "2gg", etc.) e a bot falhar completamente em adicionar ao carrinho. É uma clara falha no core business de vendas.

### 3. Gap de Conversão

A discrepância entre 25% de handoff e 3.6% de conversão é alarmante, especialmente porque a única sessão convertida (`5585****8890`) tem `cart_adds: 2` com `msgs_received: 0`, indicando que a conversão veio de um fluxo FSM determinístico, não de uma interação conversacional natural.

**Por que 25% de Handoff?**
A maioria dos handoffs (observado em `5585****7537`, `5534****3844` (2ª sessão), `5588****0051`, `5511****4342`, `5531****0566`) é desencadeada por `SEMANTICA_WANTS_HUMAN`. Isso ocorre porque:
*   **Frustração com pedidos/consultas específicas:** Clientes tentam dar pedidos ou fazer perguntas que a IA não consegue processar ou responder adequadamente (ex: `5534****3844` tentando fazer pedido, `5588****0051` perguntando sobre entrega).
*   **Incapacidade de lidar com fluxos não padrão:** O bot não tem ações para "consultar status de pedido", "ver fotos de produtos específicos" ou "entender lógicas complexas de entrega/preço", forçando o cliente a buscar um humano.
*   **Handoffs proativos do cliente:** Alguns clientes podem preferir um atendente desde o início ou após uma interação inicial curta e sem sucesso.

**O que as outras 70% das sessões fizeram?**
A maioria dessas sessões se enquadra em dois grupos:
1.  **Abandono precoce/Inatividade (aprox. 40-50%):** Muitas sessões são muito curtas (ex: `5585****5870` - 0 min, `5511****5496` - 1 min) ou o cliente envia pouquíssimas mensagens após a saudação inicial (ex: `5585****5870` - 39 min, 1 msg). Isso sugere que os clientes iniciaram o contato, mas não engajaram com o bot ou abandonaram rapidamente, talvez por não encontrar o que procuravam ou por não entender como interagir.
2.  **Exploração sem Conversão (aprox. 20-30%):** Outras sessões envolvem alguma interação com o bot, mas não progridem para adicionar itens ao carrinho. Isso é evidente em sessões onde o bot aciona `VER_TODOS` (ex: `5566****0050`, `5582****0066`, `5588****5536`), mas o cliente não seleciona produtos ou não consegue avançar no processo de compra. O bot mostra o catálogo, mas falha em guiar o cliente do "olhar" para o "comprar". A percepção de "atendimento robotizado" mencionada na sessão `5563****6356` reforça essa falha em criar uma experiência de compra fluida.

### 4. Quick Wins

Aqui estão 3 mudanças com potencial de impacto imediato:

1.  **Priorizar Handoff para Intenções `wantsHuman` e `AUTO_ESCALATION`:**
    *   **Mudança:** Ajustar o FSM e/ou as instruções do prompt da IA para que qualquer detecção de `wantsHuman` (ou gatilhos determinísticos de handoff) e `AUTO_ESCALATION` tenha prioridade máxima sobre qualquer outra ação, incluindo `VER_TODOS`. Ao detectar `wantsHuman`, o bot deve imediatamente confirmar o encaminhamento para um humano.
    *   **Justificativa (Sessão):** `5588****0051`. O cliente explicitamente pediu um atendente três vezes ("Quero falar com atendente", "Não quero catálogo", "Quero falar com a atendente"), mas o bot continuou a oferecer o catálogo, escalando a frustração desnecessariamente.

2.  **Melhorar o Parsing e Confirmação de Pedidos em Linguagem Natural:**
    *   **Mudança:**
        *   **Curto Prazo (Prompt):** Melhorar as instruções do prompt da IA para `addToCart` ou ação similar, para que ela seja mais robusta na extração de múltiplos itens, quantidades, tamanhos e referências de frases complexas.
        *   **Médio Prazo (FSM):** Introduzir um micro-FSM ou um prompt de follow-up que, ao receber um pedido complexo, o bot liste os itens *que entendeu* e peça confirmação ("Entendi que você quer 'X' de 'Y' e 'A' de 'B'. Confirma?"). Se não entender, deve guiar o cliente para adicionar um item por vez ou oferecer handoff.
    *   **Justificativa (Sessões):** `5534****3844` (1ª sessão) e `5511****4342`. Em ambas, os clientes tentaram fornecer pedidos detalhados, mas o bot falhou em adicionar ao carrinho, levando a frustração e handoff/auto-escalation.

3.  **Criar Ações Específicas para Consultas Pós-Venda ou de Logística:**
    *   **Mudança:** Desenvolver ações específicas (ou aprimorar o prompt para reconhecer e responder) para intenções como "status do pedido", "detalhes de entrega/frete", "fotos de produtos específicos" ou "informações de rastreio". Se a informação não estiver disponível para a IA, a ação deve ser "oferecer handoff para um atendente humano especializado nessa consulta".
    *   **Justificativa (Sessões):** `5588****0051` (pergunta sobre entrega) e `5566****0050` (pergunta "Mandou mhs coisaa"). O bot respondeu com `VER_TODOS` em ambos os casos, uma ação irrelevante para a consulta original do cliente, demonstrando a falta de um caminho adequado para essas intenções.

### 5. Insights Inesperados

1.  **A Conversão "Conversacional" é Quase Zero:** O dado de `cart_adds: 2` na sessão `5585****8890` com `msgs_received: 0` e `fsm_events: 16` é extremamente revelador. Isso sugere que a única conversão registrada veio de um fluxo puramente determinístico do FSM, sem entrada de mensagem do cliente que a IA pudesse ter interpretado. Isso implica que a **taxa de conversão por interação de linguagem natural do usuário é, na prática, próxima de 0%**, o que muda drasticamente a interpretação da taxa de 3.6% e a urgência em melhorar a IA.
2.  **O STT Funciona, Mas a Compreensão Falha:** Várias sessões (ex: `5588****0051`, `5585****3914` (2ª sessão), `5588****5536`) mostram áudios sendo transcritos com sucesso (`[Intercept] Áudio transcrito com sucesso`). No entanto, a presença de áudios não correlaciona com maior sucesso ou conversão, muitas vezes resultando em `TEXT_ONLY` ou handoff. Isso indica que a tecnologia Speech-to-Text está funcional, mas o NLU da IA ainda luta para interpretar a complexidade e a variedade das intenções expressas em áudios, ou não há ações apropriadas para o que é dito.
3.  **A Percepção de "Robotizado" é um Gatilho de Abandono Crítico:** A observação direta do cliente em `5563****6356` ("Ficou horrível esse atendimento robotizado") após tentativas frustradas de fazer um pedido e receber respostas genéricas (`VER_TODOS`) é um insight poderoso. Mostra que o bot não apenas falha em cumprir sua função, mas também cria uma experiência negativa que afasta o cliente. A falta de empatia e a rigidez da interação são percebidas como "robotizadas", e isso é um fator de abandono explícito para o público B2B.

Espero que este relatório forneça insights valiosos para a equipe de produto.

---

*Este relatório foi gerado automaticamente pelo `scripts/analyze-with-ai.js`.*
*Para o relatório quantitativo, ver `RELATORIO_PRODUCAO.md`.*
