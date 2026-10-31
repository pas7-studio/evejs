"use strict";
// FW-003D: a battle-line hull that cannot fire releases its campaign slot.
//
// Why it exists: the fleet registry holds one side slot per registered hull and
// the mobiliser counts every registered hull of a side, armed or not. The native
// ammo bank debits one charge per cycle and stock loadout rows carry one charge,
// so a hull that has fired is dry forever and would block its side for the rest
// of the campaign: no armed hull could ever take that slot and fight. This module
// releases only war custody, through the registry's own RELEASE command and its
// native release proof; the hull, its modules and its cargo are untouched.
//
// The dry verdict is never this module's own opinion: it is the mobiliser's own
// muster readiness (`coopWarMusterReadiness`) reporting the ammo gate
// WAR_NO_NATIVE_LOADED_WEAPON. That keeps "may this hull fight" owned by exactly
// one rule, so a hull cannot be released by one rule and re-mobilised by another.
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const DRY_REASON = "WAR_NO_NATIVE_LOADED_WEAPON";

function createWarBattleLineRelief({
  registry,
  sceneForSystem,
  getNativeEntity,
  inspectReadiness,
  isDestroyed = () => false,
  clearOrder,
  clock = () => Date.now(),
  cooldownMs = 180000,
  maxReleases = 2,
} = {}) {
  if (!registry || typeof registry.execute !== "function" || typeof registry.snapshot !== "function" ||
    [sceneForSystem, getNativeEntity, inspectReadiness, isDestroyed, clearOrder]
      .some((fn) => typeof fn !== "function") ||
    !Number.isSafeInteger(cooldownMs) || cooldownMs < 30000 ||
    !Number.isSafeInteger(maxReleases) || maxReleases < 1 || maxReleases > 8) {
    throw Error("WAR_BATTLE_LINE_RELIEF_AUTHORITIES_REQUIRED");
  }
  const nextAt = new Map();

  // Native verdict for one registered hull, using the mobiliser's own rule.
  function inspect({ entityID, systemID } = {}) {
    const id = Number(entityID), system = Number(systemID);
    if (!pos(id) || !pos(system)) return { status: "UNVERIFIED", reason: "INVALID_HULL" };
    // A hull this process (or the durable casualty ledger) already confirmed as a
    // real native wreck is gone: its slot must be released, not held by a corpse.
    let destroyed = false;
    try {
      destroyed = isDestroyed(id) === true;
    } catch (_error) {
      destroyed = false;
    }
    if (destroyed) return { status: "DESTROYED", reason: "NATIVE_WRECK_CONFIRMED" };
    let scene = null, native = null, readiness = null;
    try {
      scene = sceneForSystem(system);
      native = getNativeEntity(id);
      const ship = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) : null;
      readiness = inspectReadiness({
        entityID: id,
        ship,
        systemID: system,
        corporationID: Number(native && native.corporationID) || 0,
      });
    } catch (_error) {
      return { status: "UNVERIFIED", reason: "NATIVE_LOOKUP_THREW" };
    }
    if (!native || Number(native.entityID) !== id || Number(native.systemID) !== system) {
      return { status: "UNVERIFIED", reason: "NATIVE_RECORD_DRIFT" };
    }
    if (!readiness || readiness.ready === true) {
      return { status: "ARMED", reason: "MUSTER_READY", armedModuleCount: Number(readiness && readiness.armedModuleCount) || 0 };
    }
    const reason = String(readiness.reason || "UNKNOWN");
    if (reason !== DRY_REASON) {
      // Never release what the readiness rule refuses for any other reason.
      return { status: "UNVERIFIED", reason };
    }
    return { status: "DRY", reason: DRY_REASON };
  }

  function tick({ systemIDs = [] } = {}) {
    if (!Array.isArray(systemIDs) || systemIDs.length > 512) {
      return { status: "INVALID_SYSTEMS", released: [], blocked: [], dry: [] };
    }
    const systems = new Set(systemIDs.map(Number).filter(pos));
    if (!systems.size) return { status: "NO_SYSTEMS", released: [], blocked: [], dry: [] };
    let state = null;
    try {
      state = registry.snapshot();
    } catch (_error) {
      state = null;
    }
    if (!state || state.status === "DISABLED" || !state.ships) {
      return { status: "FLEET_STATE_UNAVAILABLE", released: [], blocked: [], dry: [] };
    }
    const at = clock();
    const released = [], blocked = [], dry = [];
    const rows = Object.values(state.ships)
      .filter((row) => pos(row?.entityID) && pos(row.systemID) && pos(row.factionID) &&
        systems.has(Number(row.systemID)))
      .sort((a, b) => a.entityID - b.entityID)
      .slice(0, 256);
    for (const row of rows) {
      if (released.length >= maxReleases) break;
      const id = Number(row.entityID), key = String(id);
      if (nextAt.get(key) > at) continue;
      const verdict = inspect(row);
      if (verdict.status === "ARMED") {
        nextAt.delete(key);
        continue;
      }
      if (verdict.status !== "DRY" && verdict.status !== "DESTROYED") {
        blocked.push({ entityID: id, status: verdict.status, reason: verdict.reason });
        nextAt.set(key, at + cooldownMs);
        continue;
      }
      dry.push({ entityID: id, pilotID: String(row.pilotID || ""), reason: verdict.reason });
      try {
        // The registry's native release proof requires an idle hull: stop clears
        // the live target, resumeBehavior clears the manual order. Both are the
        // same native manual-order API the battle director issues orders with.
        clearOrder({ entityID: id, systemID: Number(row.systemID), owner: "WAR" });
      } catch (_error) {
        /* the release proof below refuses a hull whose order is still set */
      }
      let answer = null;
      try {
        answer = registry.execute({
          type: "RELEASE",
          eventID: "war-relief:" + String(row.campaignID || "") + ":" + id,
          entityID: id,
          pilotID: String(row.pilotID || ""),
          fleetID: String(row.fleetID || ""),
          campaignID: String(row.campaignID || ""),
          warID: String(row.warID || ""),
          systemID: Number(row.systemID),
          proofID: "native-relief:" + String(row.campaignID || "") + ":" + id,
        });
      } catch (_error) {
        answer = { status: "BLOCKED", reason: "RELEASE_THREW" };
      }
      if (answer && (answer.status === "APPLIED" || answer.status === "DUPLICATE")) {
        released.push({
          entityID: id, pilotID: String(row.pilotID || ""),
          campaignID: String(row.campaignID || ""), warID: String(row.warID || ""),
          reason: verdict.reason, receipt: answer.receipt || null,
        });
        nextAt.delete(key);
      } else {
        blocked.push({ entityID: id, status: "RELEASE_BLOCKED", reason: String(answer && answer.reason || "UNKNOWN") });
        nextAt.set(key, at + cooldownMs);
      }
    }
    if (nextAt.size > 512) for (const [key, time] of nextAt) if (time <= at) nextAt.delete(key);
    return {
      status: released.length ? "RELEASED" : dry.length ? "BLOCKED" : "NO_DRY_HULL",
      released, blocked, dry,
    };
  }

  return Object.freeze({ tick, inspect });
}

module.exports = { createWarBattleLineRelief, DRY_REASON };
