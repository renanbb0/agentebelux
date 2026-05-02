const HUMAN_PAUSE_MODES = new Set(['human_pending', 'manual_human_pause']);

function isBotSuspendedForHuman(session) {
  return HUMAN_PAUSE_MODES.has(session?.supportMode);
}

function shouldSkipBotAutomation(session) {
  return isBotSuspendedForHuman(session);
}

module.exports = { HUMAN_PAUSE_MODES, isBotSuspendedForHuman, shouldSkipBotAutomation };
