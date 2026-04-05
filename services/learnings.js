const db = require('./supabase');

/**
 * Adds a new insight to the learnings table.
 * If a very similar insight already exists (fuzzy match on first 40 chars),
 * increments its `uses` counter instead of duplicating.
 */
async function addLearning(insight) {
  await db.addLearning(insight);
  return insight;
}

/**
 * Returns the active learnings as plain strings for prompt injection.
 * Caps at 10 to avoid bloating the context.
 */
async function getActive() {
  return db.getActiveLearnings(10);
}

module.exports = { addLearning, getActive };
