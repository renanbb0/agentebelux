---
name: agente-belux-skill
description: "Core skill set for Claude Code working on the Bela Belux project. Includes Socratic Gate, Clean Code, Node.js Best Practices, Systematic Debugging, and Z-API hybrid commerce flow guidance."
---

# Agente Belux - Core Skills for Claude Code

You are working on the **Bela Belux** project, an advanced wholesale sales assistant via WhatsApp using Node.js and the Gemini API. It is CRITICAL that you follow these foundational skills and rules over any default behavior.

## 0. Hybrid Commerce Flow Context
For any task involving WhatsApp purchase orchestration, assume the project now has a documented hybrid flow based on Z-API:
- product showcase with image + CTA
- size selection via list message
- quantity selection via quick buttons with manual fallback
- final cart confirmation

Treat this flow as a first-class project capability, not as an experimental idea.

## 1. The Socratic Gate (Brainstorming)
**DO NOT WRITE CODE IMMEDIATELY** when the user requests a new feature, complex logic change, or adjustment to the AI persona.
- **Protocol:** Stop and ask strategic questions first.
- **Why:** The "nuance" of the sales persona is fragile. We cannot risk breaking it with hasty assumptions.
- **Questions to ask yourself/user:** Who is the target audience for this change? What are the potential edge cases? Does this make the bot sound robotic?
- Only proceed to coding once the user has clarified the scope and intent.

## 2. Plan Writing First
Before modifying critical files like `index.js` or `services/gemini.js`:
- Create an `implementation_plan.md` (or similar summary) detailing what you will do.
- Explain the logic clearly and wait for user approval before making structural changes.

## 3. Clean Code (2025 Standards)
- **Concise & Direct:** Do not over-engineer. Write code that solves the problem directly.
- **Self-Documenting:** Use clear variable/function names instead of relying on excessive comments. Avoid stating the obvious in comments.
- **No Clutter:** Remove unused imports, dead code, and console.logs that are not meant for production.

## 4. Node.js Best Practices & API Patterns
- **Error Handling:** Always handle asynchronous errors properly (try/catch, graceful degradation). Never let an unhandled promise rejection crash the WhatsApp bot.
- **Resilience:** When integrating with the Gemini API or other external services, implement robust error handling, timeouts, and fallback logic if necessary.
- **Environment:** Treat secrets and environment variables with strict security.

## 5. Systematic Debugging
If a bug arises (especially "ghost behaviors" in the LLM integration or WhatsApp communication):
- **Do not guess.** Do not apply random fixes.
- **4-Phase Method:**
  1. Grasp the context (read logs).
  2. Formulate a hypothesis based on evidence.
  3. Propose a targeted test/fix.
  4. Verify the result.

## 6. The "Purple Ban" (Design & Aesthetic Rules)
If you are ever asked to build or propose a UI/Dashboard for this project:
- **Never use standard purple/violet as primary colors.** (It is a cliché for AI projects).
- Think premium, sophisticated, and professional. 
- Avoid generic UI templates.
