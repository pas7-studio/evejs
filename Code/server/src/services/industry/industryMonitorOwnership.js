// COOP_MONITOR_OWNER_V1
//
// An industry monitor is a client-side "track this job" row. Until now the row
// had no owner and `IndustryMonitor.DisconnectJob` deleted whatever id it was
// given - the handler did not even receive the session - so a second client could
// detach the first client's tracked job, and a stale id could never be told apart
// from a live one. The rules are pure so they can be tested without a gameStore:
//
//  - a monitor is attributed to exactly one character;
//  - a row that carries no owner can never be detached (it cannot be attributed);
//  - connecting the same (character, activity, blueprint) again reuses the row
//    instead of leaking a new id on every industry-window refresh.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function monitorOwnerID(monitor) {
  return toInt(monitor && monitor.characterID, 0);
}

function monitorBelongsTo(monitor, characterID) {
  const owner = monitorOwnerID(monitor);
  const who = toInt(characterID, 0);
  return owner > 0 && who > 0 && owner === who;
}

function isSameMonitor(monitor, { characterID, activityID, blueprintID } = {}) {
  if (!monitorBelongsTo(monitor, characterID)) return false;
  return (
    toInt(monitor.activityID, 0) === toInt(activityID, 0) &&
    toInt(monitor.blueprintID, 0) === toInt(blueprintID, 0)
  );
}

// Only a row that is attributed to this exact character may be removed.
function canDisconnect(monitor, characterID) {
  return monitorBelongsTo(monitor, characterID);
}

// Rows written before the owner was stamped are dropped on load: they cannot be
// attributed, so keeping them would leave ids no client is allowed to detach.
function isAttributableMonitor(monitor) {
  return monitorOwnerID(monitor) > 0;
}

module.exports = {
  monitorOwnerID,
  monitorBelongsTo,
  isSameMonitor,
  canDisconnect,
  isAttributableMonitor,
};
