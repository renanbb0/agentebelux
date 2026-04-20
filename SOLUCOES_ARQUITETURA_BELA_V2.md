# Plano de Refatoracao Arquitetural: Agente Belux V2 (Agentic AI)

Este documento detalha o plano de evolucao tecnica da Bela, visando transforma-la de um "Bot Procedural com Arvore de Decisao Guiada por LLM" para um "Agente IA Fluido e Autonomo" (Agentic AI). O foco principal e substituir estruturas rigidas baseadas em Regex e FSM (Finite State Machine) bloqueante por capacidades nativas do Gemini (Function Calling) e roteamento de intencoes.

---

## 1. Migracao para Native Function Calling

### Analise Atual (`services/gemini.js` e `index.js`)

Atualmente, a comunicacao entre o estado do aplicativo (`index.js`) e a IA depende de **Regex Parsing**. A IA e instruida atraves de um system prompt gigante a gerar strings formatadas como `[VER_TODOS:feminino]` ou `[TAMANHO:M]`.

- **Problemas:** alto gasto de tokens, chance de alucinacao de formatacao e complexidade crescente em `parseAction`.
- O LLM e punido por ser natural se esquecer a sintaxe exata do colchete.

### Implementacao Proposta

Substituir o text-parsing por **Gemini Native Function Calling**. O modelo recebe esquemas JSON das ferramentas. Quando o modelo precisa tomar acao, ele devolve um objeto `functionCall` nativo, em vez de texto mascarado com colchetes.

#### Ferramentas (Tools) Necessarias

- `displayCatalog(categorySlug)`: substitui `[VER:*]`
- `searchProduct(query)`: substitui `[BUSCAR:*]`
- `showProductPhotos(productIndex)`: substitui `[FOTOS:*]`
- `updateCart(productId, size, quantity, action='add'|'remove')`: substitui `[TAMANHO:*]`, `[QUANTIDADE:*]`, `[REMOVER:*]` e `[COMPRAR_DIRETO:*]`
- `finalizeOrder()`: substitui `[HANDOFF]`
- `goToNextPage()`: substitui `[PROXIMOS]`

#### Snippet de Referencia

```javascript
const tools = [{
  functionDeclarations: [
    {
      name: "updateCart",
      description: "Adiciona ou atualiza um item no carrinho de compras.",
      parameters: {
        type: "OBJECT",
        properties: {
          action: { type: "STRING", enum: ["add", "remove"] },
          productId: { type: "STRING" },
          size: { type: "STRING" },
          quantity: { type: "INTEGER" }
        },
        required: ["action", "productId", "size", "quantity"]
      }
    }
  ]
}];
```

**Ganhos esperados:**

- economia relevante de tokens no prompt
- reducao radical de quebra por formatacao
- eliminacao da dependencia de `parseAction()` como centro da operacao

---

## 2. Roteador de Intencoes (Intent Resolver)

### Analise Atual

Hoje quase toda `user_message` cai no "tudo ou nada" de `gemini.js`, carregando junto bagagem de estado FSM, historico e regras tensas. Isso mistura navegacao livre com fluxo fechado.

### Implementacao Proposta

Criar `services/intent-resolver.js` como uma camada leve anterior ao fluxo principal. Ele recebe:

- mensagem nova
- resumo ativo
- estado relevante da sessao

E retorna um JSON como:

```json
{
  "intent": "buy",
  "confidence": 0.91,
  "interrupts_current_flow": false
}
```

#### Exemplo de classificacao inicial

- `progress_flow`: continua a compra, informa tamanho/quantidade, quer catalogo
- `question`: duvida sobre frete, tecido, processo comercial, empresa
- `complaint`: reclamacao ou problema
- `off_topic`: conversa lateral

### Objetivo

Desacoplar a FSM da interpretacao semantica.

Se a intencao for **question**, por exemplo, o sistema pode responder a duvida sem tratar isso como "erro de fluxo". Depois, retoma a compra de forma natural.

---

## 3. Refatoracao da FSM para um Modelo Mais Agentico

### Analise Atual

O `index.js` possui uma FSM dura (`awaiting_size`, `awaiting_quantity`, `awaiting_more_sizes`). Em varios trechos, o contexto injeta regras do tipo "resposta sem token e bug", o que mostra que a IA esta trabalhando sob coacao estrutural.

Isso gera dois problemas:

- quando o usuario quebra o fluxo, a conversa parece burra
- quando a IA nao encaixa no formato esperado, surge reflection call ou insistencia mecanica

### Implementacao Proposta

**Rebaixar a FSM de protagonista para suporte transacional.**

O estado deixa de ser uma prisao procedural e passa a ser **contexto declarativo**, por exemplo:

- produto em foco
- slots faltantes
- fila de compra
- status do carrinho

Se faltar tamanho, o modelo pergunta.
Se o cliente interromper com uma duvida, o modelo responde.
Se o cliente quiser voltar para compra, o modelo retoma com base no contexto.

### Diretriz importante

O alvo nao deve ser "deletar toda FSM imediatamente", e sim:

- tirar da FSM o poder de interpretar a conversa
- manter nela apenas a parte de integridade operacional

---

## 4. Memoria de Longo Prazo (Extracao de Fatos)

### Analise Atual

Hoje a sessao expira ou vira um blob de historico. Isso nao ajuda a Bela a parecer acumulativa.

### Implementacao Proposta

Criar uma etapa de **Fact Extraction** em background quando a sessao terminar ou for abandonada.

Exemplo de output:

```json
{
  "preferred_sizes": ["G", "GG"],
  "business_type": "moda jovem",
  "tone_preference": "informal"
}
```

### Fluxo sugerido

1. Fim do handoff ou encerramento de sessao -> dispara `extractFacts(sessionHistory)`
2. Fatos atomicos sao gravados em `customer_knowledge`
3. Na proxima conversa, esses fatos entram como contexto de memoria

### Snippet de referencia

```javascript
async function extractLongTermFacts(history) {
  const prompt = `Leia o historico e extraia fatos perenes do cliente em JSON.`;
  const response = await model.generateContent(prompt + history);
  return JSON.parse(response.text());
}
```

---

## 5. Resumo Executivo e Ganhos

A adocao destas 4 frentes traz ganhos claros:

1. **Reducao de prompt tokens:** menos regra textual para o modelo carregar
2. **Latencia menor:** menos reflection calls e menos retries por token perdido
3. **Fluidez conversacional:** a conversa deixa de quebrar sempre que o usuario sai do trilho
4. **Atendimento consultivo:** memoria util para contextualizar futuras conversas

---

## 6. Analise Critica: Isso Garante uma Agente Mais Inteligente?

**Resposta curta: nao ainda.**

O plano atual melhora muito a base tecnica e reduz a dependencia de respostas prontas, mas **sozinho nao garante** que a Agente ficara mais inteligente de forma consistente. Ele resolve principalmente:

- fragilidade de formato
- acoplamento excessivo entre prompt e regex
- travamento da conversa por FSM dura
- perda de contexto entre sessoes

Isso ja e um salto importante. Porem, "mais inteligente" nao vem apenas de trocar regex por function calling. Para a Bela ficar realmente menos roteirizada e ainda funcional, ela precisa tambem de:

- criterios explicitos de decisao
- tratamento de incerteza
- feedback do resultado das tools
- memoria confiavel
- avaliacao objetiva de qualidade

### O que o plano atual acerta muito bem

- **Function Calling nativo:** tira a IA da prisao do token textual e reduz quebra por formatacao
- **Intent Resolver:** cria uma camada semantica antes da execucao
- **FSM como contexto e nao carcere:** aumenta fluidez real
- **Memoria de longo prazo:** ajuda a Bela a parecer consultiva e acumulativa

### O que ainda falta para garantir inteligencia real

1. **Politica de incerteza**
- O documento nao define claramente o que a Agente faz quando a intencao vier ambigua, incompleta ou com baixa confianca
- Sem isso, o risco e trocar "resposta pronta" por "acao precipitada"

2. **Loop observar -> agir -> observar**
- O documento fala das tools, mas nao explicita que o agente precisa receber o resultado da tool e decidir o proximo passo com base nisso
- Sem esse ciclo, a IA ainda funciona como classificador com ferramentas, nao como agente de verdade

3. **Memoria com controle de qualidade**
- Extrair fatos e gravar no banco ajuda, mas falta governanca
- Falta definir o que e perene, o que expira, como medir confianca e como resolver conflito com conversa atual

4. **Base de conhecimento operacional**
- O plano cita responder duvidas, mas nao define uma base estruturada para politica comercial, tecido, frete, prazos e excecoes
- Sem grounding, a Bela pode soar melhor e ainda assim responder de forma insegura

5. **Avaliacao de inteligencia**
- O documento traz ganhos esperados, mas nao define uma bateria formal de evals
- Sem evals, a melhora pode parecer grande sem ser comprovada

6. **Protecao contra regressao agentica**
- Remover a FSM procedural por completo pode ser cedo demais
- Ha diferenca entre "FSM dominando a conversa" e "nenhum mecanismo protegendo transacoes"

### Conclusao desta analise

O documento atual **garante uma arquitetura menos fragil e menos engessada**, mas **nao garante sozinho uma Agente mais inteligente**.

Para essa garantia ficar muito mais forte, o plano precisa incorporar acoes adicionais que transformem a Bela em um sistema de:

- interpretacao estruturada
- decisao com confianca
- execucao observavel
- memoria auditavel
- aprendizado medido por evals

---

## 7. Acoes Adicionais Necessarias

Estas acoes complementam o plano original.

### 7.1. Criar uma Politica de Confianca e Clarificacao

Antes de qualquer execucao relevante, o sistema deve classificar a confianca da interpretacao.

**Regra operacional sugerida:**

- `confidence >= 0.85`: executa direto
- `confidence entre 0.60 e 0.84`: executa somente se o contexto fechar todas as lacunas
- `confidence < 0.60`: faz pergunta curta de desambiguacao

**Exemplos:**

- "manda mais" -> perguntar: "mais fotos ou mais modelos?"
- "tira isso" -> perguntar: "esse item ou o carrinho todo?"

**Objetivo:** impedir a troca de rigidez por impulsividade.

### 7.2. Formalizar o Loop Agentico de Execucao

O fluxo alvo nao deve ser apenas:

`mensagem -> intent -> tool -> resposta`

Deve ser:

`mensagem -> interpretar -> decidir -> chamar tool -> observar retorno -> decidir proximo passo -> responder`

**Toda tool precisa devolver observacoes estruturadas**, por exemplo:

```json
{
  "success": true,
  "stateDelta": {
    "cartItems": 3,
    "pendingSlots": ["quantity"]
  },
  "userVisibleSummary": "Tamanho M registrado para o conjunto renda."
}
```

**Objetivo:** fazer a agente raciocinar sobre o efeito da propria acao.

### 7.3. Separar Memoria em Camadas

Nao basta ter "historico" e "memoria longa". A Bela precisa de 3 camadas:

1. **Working Memory**
- produto em foco
- item citado no quote-reply
- slot faltante
- objetivo da conversa atual

2. **Session Memory**
- resumo da sessao ativa
- ultimas decisoes tomadas
- duvidas ja respondidas
- objecoes e preferencias recentes

3. **Long-Term Memory**
- tamanhos recorrentes
- perfil do lojista
- categorias mais compradas
- preferencia de tom

**Regra critica:** memoria longa nunca pode vencer contexto fresco sem checagem.

### 7.4. Criar Regras de Higiene da Memoria

Toda extracao de fatos precisa salvar junto:

- `fact`
- `source`
- `confidence`
- `last_confirmed_at`
- `ttl` ou criterio de expiracao

**Exemplo de risco real:**

- a cliente comprava `GG` meses atras
- hoje esta comprando infantil
- se a memoria antiga entrar como verdade absoluta, a Bela fica "inteligente errada"

**Objetivo:** evitar memoria contaminada e excesso de suposicao.

### 7.5. Introduzir Grounding para Duvidas Operacionais

Perguntas como:

- "esse tecido encolhe?"
- "qual o minimo?"
- "tem pronta entrega?"
- "essa renda laceia?"
- "como funciona o envio?"

Nao devem depender so de improviso do modelo.

**Acao necessaria:**

- criar base estruturada de conhecimento comercial e tecnico
- resposta da IA deve se apoiar nessa base sempre que a pergunta for factual
- se a base nao cobrir, a Bela deve admitir incerteza e escalar ou confirmar

**Objetivo:** ficar menos roteirizada sem ficar menos confiavel.

### 7.6. Definir Hierarquia de Decisao

Para a agente ser funcional, precisa haver uma ordem clara de autoridade:

1. Regras de negocio criticas
2. Estado transacional valido
3. Intent estruturada
4. Memoria de sessao
5. Memoria de longo prazo
6. Resposta natural

**Exemplos:**

- se a memoria disser que a cliente gosta de `G`, mas a mensagem atual disser `M`, vence a mensagem atual
- se a IA quiser fechar pedido, mas o carrinho estiver vazio, a regra transacional bloqueia

**Objetivo:** inteligencia com limites saudaveis.

### 7.7. Adicionar Evals de Inteligencia Conversacional

Criar uma bateria fixa de testes com mensagens reais e ambiguas.

**Medir no minimo:**

- taxa de entendimento correto de intencao
- taxa de acao correta em contexto ambiguo
- taxa de perguntas de clarificacao desnecessarias
- taxa de handoff por frustracao
- taxa de alucinacao factual
- taxa de recuperacao apos quebra de fluxo

**Conjunto de casos obrigatorios:**

- interrupcao no meio da compra
- mudanca de assunto
- linguagem curta e ambigua
- correcao do proprio usuario
- quote-reply em produto antigo
- pedido implicito sem palavra-chave exata

**Objetivo:** provar evolucao, nao apenas senti-la.

### 7.8. Fazer Rollout Progressivo com Observabilidade

Essa migracao nao deve entrar em modo big bang.

**Acao necessaria:**

- feature flags por bloco arquitetural
- log de cada decisao do intent resolver
- log de cada tool call e retorno
- comparacao entre fluxo antigo e fluxo novo
- dashboard de erro semantico e erro transacional

**Objetivo:** preservar funcionalidade enquanto a autonomia aumenta.

### 7.9. Manter a FSM como Guarda Transacional Temporaria

Em vez de "deletar o bloqueio de FSM procedural" de uma vez, a recomendacao mais segura e:

- remover o poder da FSM sobre interpretacao semantica
- manter a FSM apenas como guarda de integridade do fluxo
- desligar travas antigas em etapas, com metricas

**A FSM deve continuar protegendo:**

- consistencia do carrinho
- tamanho/quantidade validos
- fila de produtos
- expiracao de menu interativo
- handoff humano sem heranca de estado incorreto

**Objetivo:** aumentar inteligencia sem perder previsibilidade operacional.

---

## 7.10. Prioridades Escolhidas Agora: Respostas Abertas Naturais + Memoria de Contexto

Como prioridade pratica para aproximar a Bela de uma experiencia mais parecida com ChatGPT, as duas frentes com maior retorno agora sao:

- responder perguntas abertas com naturalidade real
- lembrar contexto e perfil do cliente entre conversas sem ficar robotica

Essas duas frentes devem entrar no plano como **prioridade de implementacao**, antes de qualquer tentativa de "humanizar texto" apenas por prompt.

### 7.10.1. Fazer a Bela Responder como Conversa Real, Nao como Script

Hoje o maior risco nao e so parecer bot. E parecer que a resposta ja estava pronta antes de entender a mensagem.

Para reduzir isso, a resposta final nao deve nascer direto do prompt grande. Ela deve nascer de uma estrutura intermediaria.

**Fluxo recomendado:**

`mensagem do usuario -> interpretacao estruturada -> plano de resposta -> resposta natural`

#### Estrutura intermediaria sugerida

Antes de redigir a mensagem final, o sistema deve montar um objeto como:

```json
{
  "userGoal": "tirar_duvida",
  "answerMode": "consultivo",
  "topic": "tecido e encolhimento",
  "factsToUse": ["produto X", "politica de tecido", "historico recente"],
  "pendingQuestion": null,
  "nextBestStep": "retomar venda se a duvida for respondida"
}
```

Isso faz a IA responder com base no que entendeu, e nao puxar uma fala pronta do repertorio.

#### Regras para resposta aberta mais natural

- responder primeiro ao que o usuario realmente perguntou
- nao forcar CTA comercial em toda mensagem
- so puxar venda quando a duvida ja tiver sido atendida
- evitar respostas em formato de FAQ ou menu escondido
- usar exemplos de tom como referencia, nao como molde fixo
- permitir respostas curtas, medias ou um pouco mais explicativas conforme a pergunta

#### Separar "estilo" de "decisao"

O estilo da Bela pode continuar humano e comercial, mas ele nao deve controlar a interpretacao.

**Camadas sugeridas:**

1. interpretacao da mensagem
2. decisao do que responder
3. redacao final no tom da Bela

Isso evita o problema de a agente ficar "bonita no texto" e burra na logica.

#### Tipos de pergunta aberta que precisam virar primeira classe

- duvida factual: "isso encolhe?", "tem bojo?", "qual o minimo?"
- duvida comparativa: "qual gira mais?", "qual compensa mais?"
- duvida consultiva: "o que voce me indica pra começar?"
- duvida contextual: "essa linha serve mais pra que publico?"
- interrupcao natural no meio da compra: "mas esse tecido presta?"

Para cada tipo, a Bela precisa escolher um `answerMode` diferente, em vez de reutilizar uma resposta coringa.

#### Anti-padrao a evitar

Nao resolver isso criando mais 20 respostas prontas "humanizadas".

Isso melhora a superficie, mas nao melhora entendimento.

### 7.10.2. Fazer a Bela Lembrar Contexto como uma Atendente Real

Uma atendente real nao lembra tudo. Ela lembra o que importa e o que foi recorrente.

Por isso, memoria boa nao e memoria gigante. E memoria **selecionada, confiavel e recuperavel no momento certo**.

#### Tipos de memoria que precisam existir

**1. Memoria imediata da conversa**
- produto em foco
- duvida atual
- objecao atual
- ultimo passo pendente
- mensagem citada por quote-reply

**2. Memoria da sessao**
- resumo do que o cliente ja viu
- categorias ja mostradas
- duvidas ja respondidas
- preferencia mostrada nesta conversa
- ultimo objetivo detectado

**3. Memoria de perfil do cliente**
- categorias que mais compra
- tamanhos recorrentes
- faixa de ticket observada
- tom preferido
- padrao de compra inicial vs reposicao

#### Regra principal da memoria

A memoria antiga ajuda, mas **nunca manda mais que a conversa atual**.

Exemplos:

- se o historico diz que a cliente costuma comprar `G`, mas hoje ela pediu `M`, vence `M`
- se o historico diz que ela compra feminino adulto, mas hoje pediu infantil, a Bela nao deve insistir no perfil antigo

#### O que deve ser salvo como memoria util

Salvar apenas fatos que sejam:

- recorrentes
- confirmados
- relevantes para venda futura
- pouco provaveis de mudar a cada mensagem

#### O que nao deve virar memoria longa

- chute do modelo
- inferencia fraca
- emocao momentanea
- preferencia nao confirmada
- detalhe de uma unica mensagem sem repeticao

#### Recuperacao de contexto entre conversas

Quando uma nova conversa comecar, o sistema nao deve jogar "historico bruto" no prompt.

Deve montar um contexto enxuto com:

- resumo da ultima sessao
- fatos relevantes de perfil
- ultimo ponto pendente, se houver
- conflitos ou incertezas ainda abertas

**Exemplo de contexto de entrada ideal:**

```text
Resumo da ultima sessao:
- Viu linha feminina renda e kits basicos
- Perguntou sobre giro e pedido minimo
- Demonstrou interesse maior em kits de reposicao

Perfil conhecido:
- Costuma comprar tamanhos M e G
- Tom de conversa informal
- Perfil de recompra, nao primeira compra

Pendencia aberta:
- Nao respondeu ainda se queria ver kits ou avulsos
```

Isso aproxima muito mais de uma conversa real do que despejar historico inteiro.

### 7.10.3. Mecanismo de Recuperacao Semantica

Para a Bela parecer contextual de verdade, ela precisa recuperar **o que e relevante agora**, e nao apenas o que foi dito antes.

**Camada sugerida:**

- indexar resumos de conversas passadas
- recuperar por similaridade semantica
- filtrar por recencia, relevancia e confianca
- injetar so 3 a 5 fatos realmente uteis

Isso evita dois extremos:

- esquecer tudo
- lembrar coisa demais e responder torto

### 7.10.4. Evals Especificos Dessas Duas Frentes

Para validar se a Bela esta menos "pronta", medir explicitamente:

- se respondeu a pergunta aberta antes de vender
- se usou contexto certo da conversa atual
- se reutilizou memoria de perfil sem distorcer o pedido atual
- se retomou a venda com naturalidade depois de responder a duvida
- se evitou responder com frase-coringa quando a pergunta exigia raciocinio

#### Casos obrigatorios de teste

- "esse tecido encolhe mesmo?"
- "qual voce me indica pra começar?"
- "na outra vez voce me mostrou uns kits, tem ainda?"
- "eu compro mais M e G, mas hoje quero infantil"
- "essa linha gira mais que a outra?"
- "me explica rapidinho como funciona, que eu nunca comprei"

### 7.10.5. Ordem Recomendada para Implementar Essas Prioridades

1. criar `answer planner` estruturado para perguntas abertas
2. separar interpretacao, decisao e redacao final
3. criar memoria em 3 camadas
4. adicionar regras de higiene e confianca da memoria
5. montar contexto enxuto de entrada por sessao
6. adicionar recuperacao semantica de memorias relevantes
7. medir com evals focadas em pergunta aberta + memoria contextual

**Resultado esperado:** a Bela para de parecer um bot com falas prontas e passa a soar como uma atendente que ouviu, entendeu, lembrou e respondeu em cima do que o cliente realmente quis dizer.

---

## 8. Recomendacao Final Atualizada

Se o objetivo e deixar a Bela **mais inteligente, menos dependente de respostas prontas, porem funcional**, o caminho correto nao e apenas:

- trocar regex por function calling
- afrouxar a FSM
- guardar memoria longa

O caminho correto e combinar:

- interpretacao estruturada
- execucao por tools com retorno estruturado
- clarificacao por confianca
- grounding factual
- memoria auditavel
- evals e rollout progressivo

Em resumo:

- o plano atual e **bom e necessario**
- ele **nao e suficiente sozinho**
- com as acoes desta secao, ele passa a mirar nao so uma IA mais fluida, mas uma **agente realmente mais inteligente e operacionalmente segura**

---

## 9. Revisao com Dados Reais de Producao (2026-04-17)

> Este documento foi escrito antes de qualquer dado de producao. Apos 8h de
> atendimento real com monitoramento ativo, esta secao registra o que os dados
> **confirmaram**, o que **elevam em prioridade** e o que esta **completamente
> ausente** do plano original.

---

### 9.1 O que a producao confirmou

| Dado observado | Secao confirmada |
|----------------|-----------------|
| IA respondeu comparacao de preco com `VER_TODOS` (acao errada) | §2 Intent Resolver |
| Cliente disse "ficou horrivel esse atendimento robotizado" | §7.10 Answer Planner |
| ~54% de handoff rate (taxa alta para bot de vendas) | §7.5 Grounding |
| Cliente acionou FALAR_ATENDENTE por conta propria | §7.1 Politica de confianca |
| `[AI] Falha — First content should be with role 'user'` (bug ativo) | §7.8 Rollout progressivo — divida tecnica bloqueadora |

---

### 9.2 O que a producao eleva em prioridade

**§7.5 Grounding vira prioridade #1** (estava no meio da lista)

O Grounding foi tratado como "acao adicional". Os dados mostram que e a causa
raiz da maioria dos handoffs. Perguntas que geraram escalonamento hoje:
- Comparacao de preco entre produtos → IA mandou VER_TODOS (errado)
- Rastreio/entrega → IA nao tem base nenhuma
- Qualidade de tecido → IA improvisa ou escala

**§7.10.1 Answer Planner vira prioridade #2**

"Atendimento robotizado" nao e problema de Function Calling. E a resposta
nascendo antes de a pergunta ser entendida. O Answer Planner e a solucao certa
mas estava listado como item tardio.

**§2 Intent Resolver vira prioridade #3**

Dado concreto: pergunta de comparacao de preco → retornou `VER_TODOS`. O Intent
Resolver foi criado exatamente para esse tipo de roteamento errado.

---

### 9.3 O que esta AUSENTE do plano e se mostrou critico

**A) Captura de `customerName` — gap basico de CRM**

`customerName: null` em 100% das sessoes de hoje. O bot nao captura o nome em
momento algum. Contribui diretamente para a sensacao de "atendimento robotizado".
- Acao: capturar nome no inicio da sessao (payload Z-API ou primeira mensagem)
- Arquivo: `index.js` (inicio do fluxo de nova sessao)
- Risco: zero

**B) Botao "Devolver pra Bela" — ciclo de handoff incompleto**

O monitor.js tem o botao de handoff (pausar bot). Mas nao ha o caminho inverso.
Depois que a vendedora conclui, o bot nao volta. Sessoes ficam presas em
`support_mode = 'human_pending'` para sempre.
- Acao: endpoint `POST /api/resume/:phone` no `monitor.js`
- Risco: baixo

**C) Pipeline de analise pos-sessao — logs existem mas nao viram aprendizado**

8h de logs com [Semantic], [AI] Decisao, [Session/Load], [Intercept] gerados.
Esse dado existe mas nao alimenta nada. O V2 fala em memoria longa, mas nao
descreve como o dado bruto vira input de aprendizado.
- Acao: `scripts/analyze-session.js` (logs → JSONL → Gemini → Obsidian → learnings)
- Risco: zero (script offline, nao toca no bot)

**D) Bug bloqueador em `gemini.js` — precede Function Calling**

`services/gemini.js` ~linha 274: historico pode comecar com `role: 'model'`,
causando erro na API Gemini. Precisa ser corrigido ANTES de qualquer migracao
para Function Calling (§1). O V2 assume que gemini.js esta estavel — nao esta.
- Acao: filtrar historico para garantir primeiro item com `role: 'user'`
- Risco: baixo, mudanca cirurgica

---

### 9.4 Ordem de implementacao corrigida por ROI real

| Prioridade | Item | Fonte | Risco |
|-----------|------|-------|-------|
| **1** | Grounding KB (entrega, tecido, FAQ comercial) | 54% handoff por duvidas respondíveis | Baixo |
| **2** | Captura de `customerName` | 100% null em producao | Zero |
| **3** | Fix bug `gemini.js` history role | Erro ativo em producao | Zero |
| **4** | Answer Planner (interpretacao → plano → resposta) | "Atendimento robotizado" | Medio |
| **5** | Intent Resolver (`services/intent-resolver.js`) | VER_TODOS em comparacao de preco | Medio |
| **6** | Pipeline offline (logs → insights → Obsidian) | 8h de dado sem usar | Zero |
| **7** | Botao "Devolver pra Bela" no monitor | Handoff sem retorno | Baixo |
| **8** | Function Calling nativo (§1 original) | V2 original | Alto |
| **9** | Memoria em 3 camadas (§7.3 original) | V2 original | Medio |
| **10** | Evals battery (§7.7 original) | V2 original | Baixo |

**Regra:** itens 1–7 entram antes de qualquer grande refatoracao porque tem
risco zero/baixo e impacto imediato no que a producao revelou. Itens 8–10
sao o nucleo do V2 original — continuam validos, so saem do topo da fila.

---

### 9.5 O que o V2 acerta e nao muda

- **Function Calling nativo** → valido e necessario, agora e prioridade 8 e nao 1
- **FSM como guarda transacional** (§7.9) → confirmado: grade B2B funcionou perfeitamente hoje
- **Politica de confianca** (§7.1) → confirmado pelo cliente que acionou handoff por incerteza da IA
- **Rollout progressivo com feature flags** (§7.8) → obrigatorio dado o volume de logica em `index.js`
- **Memoria em 3 camadas** (§7.3) → design correto; doc `20 - Plano IA Adaptativa` ja complementa

---

*Secao adicionada em 2026-04-17 apos primeira sessao de producao monitorada.*
*Nenhuma alteracao no bot foi feita — apenas registro para implementacao futura.*
