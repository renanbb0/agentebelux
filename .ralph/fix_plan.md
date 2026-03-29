# Ralph's Fix Plan for Bela Belux

## 🔥 High Priority (MVP)
- [ ] **Humanizing Persona**: Refactor `services/gemini.js` prompt to encourage natural, wholesale-sales reasoning.
- [ ] **Modularize index.js**: Separate the big webhook handler into smaller, testable functions in `src/handlers/`.
- [ ] **Clean Code Audit**: Remove duplicate logic (e.g., categories mapping) and hardcoded strings.

## 🛠️ Medium Priority (Improvement)
- [ ] **History Management**: Optimize session history slicing and consistency.
- [ ] **Error Resilience**: Better handling for Z-API or WooCommerce timeouts.
- [ ] **Documentation**: Update `CLAUDE.md` and inline JSDoc comments.

## 📈 Low Priority (Optimization)
- [ ] **Test Suite**: Add unit tests for `ai.parseAction` and category normalization.
- [ ] **Performance**: Analyze Supabase upsert overhead.

## ✅ Completed
- [x] Project initialization in `.ralph/`.
- [x] Setting up Ralph PowerShell Bridge (`ralph-win.ps1`).

## 📝 Notes
- Each loop should aim to close one sub-item from the high-priority list.
- Keep the WhatsApp (Z-API) response feel as the primary quality metric.
