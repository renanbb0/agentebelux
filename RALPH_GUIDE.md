# 🎩 Guia do Ralph (Sidekick para Claude Code) no Bela Belux

O **Ralph** é uma camada de automação para o Claude Code que permite realizar ciclos de desenvolvimento autônomos. Ele lê instruções de objetivos, executa o Claude, analisa o resultado e repete o processo até que todas as tarefas sejam concluídas.

Como o Ralph original é focado em Bash/Linux, configuramos uma versão local otimizada para o seu **Windows**.

## 🚀 Como Executar

Abra o seu terminal (PowerShell) na raiz do projeto `Bela Belux` e execute:

```powershell
.\ralph-win.ps1
```

O script fará o seguinte:
1.  Lerá as instruções de `PROMPT.md`.
2.  Consultará o status das tarefas em `fix_plan.md`.
3.  Chamará o `claude` CLI para trabalhar em uma tarefa por vez.
4.  Gará o log de tudo em `.ralph/logs/ralph-win.log`.

## 📂 Estrutura de Arquivos

-   `.ralph/PROMPT.md`: As instruções de "quem é a Bela" e como o Ralph deve agir. **Edite este arquivo para mudar a personalidade da Bela.**
-   `.ralph/fix_plan.md`: A lista de tarefas (TODO). O Ralph tentará completar os itens marcados com `[ ]`. **Adicione novas tarefas aqui.**
-   `.ralph/AGENT.md`: Instruções técnicas sobre como rodar e testar o projeto (npm start, etc).
-   `.ralph/logs/`: O histórico de tudo o que o Ralph fez em cada loop.

## 🛠️ Personalização

Se você quiser que o Ralph foque em algo específico (ex: "corrigir o cálculo de frete"), adicione isso ao topo do arquivo `.ralph/fix_plan.md` na seção **High Priority**.

> [!TIP]
> **Acompanhamento**: Você pode abrir o arquivo `.ralph/logs/ralph-win.log` em tempo real para ver o "raciocínio" do Ralph enquanto ele trabalha.

> [!IMPORTANT]
> **Claude CLI**: Certifique-se de que o comando `claude` está funcionando no seu terminal antes de iniciar o Ralph.
