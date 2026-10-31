"use strict";
// FW-030: an assault whose two sides materialized at different system anchors is
// mustered but un-fightable. The real doctrine guns on these hulls are
// short-range autocannons (measured: 750 m optimal, 2 500 m falloff), so a fleet
// sitting tens of AU away can never open fire even though both sides own the
// field.
//
// A real fleet warps to the enemy it was mustered against as a FLEET: every ship
// of the side arrives together in formation, and the native attack order's own
// movement flies the last leg. This module issues exactly that - one native
// warpBatchToPoints for a side of several hulls (formation offsets around a
// standoff anchor) or one warpToPoint for a lone hull. It never spawns,
// teleports, deals damage or invents a kill, and every attempt is reported with
// its own native status.
//
// A native warp refuses a short hop (measured: WARP_DISTANCE_TOO_CLOSE at 43 km
// and 90 km), so the warp is only issued beyond `warpMeters`. A manual `orbit`
// order is deliberately NOT used: it sets manualBusy, which makes the war
// director's own attack order fail with COOP_NPC_ORDER_NATIVE_COMMAND_ACTIVE.
const enabled = env => env.EVEJS_COOP_WAR_ENGAGE_WARP === "1";
const pos = x => Number.isSafeInteger(x) && x > 0;
const finite = p => p && ["x", "y", "z"].every(k => typeof p[k] === "number" && Number.isFinite(p[k]));
const warping = s => String(s?.mode || "").toUpperCase().includes("WARP") ||
  !!(s?.pendingWarp || s?.warpState || s?.isWarping);
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = v => Math.hypot(v.x, v.y, v.z);
const unit = v => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const distance = (a, b) => len(sub(a, b));

// A line abreast perpendicular to the approach bearing, with the two ranks
// slightly staggered so the arrival reads as a formation and not a single dot.
function formationOffsets(count, spacingMeters, rankDepthMeters = 250) {
  const offsets = [];
  for (let i = 0; i < count; i += 1) {
    offsets.push({
      lateral: (i - (count - 1) / 2) * spacingMeters,
      depth: (i % 2 === 0 ? -1 : 1) * rankDepthMeters,
    });
  }
  return offsets;
}

function createWarEngagementWarp({
  readWarState,
  registry,
  sceneForSystem,
  getController,
  warpToPoint,
  warpBatchToPoints = null,
  clock = () => Date.now(),
  env = process.env,
  warpMeters = 150000,
  standoffMeters = 50000,
  formationSpacingMeters = 800,
  formationRankDepthMeters = 250,
  cooldownMs = 60000,
} = {}) {
  if (
    [readWarState, sceneForSystem, getController, warpToPoint].some(x => typeof x !== "function") ||
    !registry || typeof registry.snapshot !== "function" ||
    typeof clock !== "function" ||
    (warpBatchToPoints !== null && typeof warpBatchToPoints !== "function") ||
    !Number.isSafeInteger(warpMeters) || warpMeters < 50000 ||
    !Number.isSafeInteger(standoffMeters) || standoffMeters < 1000 || standoffMeters >= warpMeters ||
    !Number.isSafeInteger(formationSpacingMeters) || formationSpacingMeters < 100 ||
    !Number.isSafeInteger(formationRankDepthMeters) || formationRankDepthMeters < 0 ||
    !Number.isSafeInteger(cooldownMs) || cooldownMs < 10000
  ) throw Error("WAR_ENGAGEMENT_WARP_AUTHORITIES_REQUIRED");
  const nextAt = new Map();

  function closeOnFleet(side, nearestEnemy) {
    // Formation points around a standoff anchor: the side lands together, in a
    // line abreast across the approach bearing.
    const anchor = nearestEnemy.position;
    const centroid = side.reduce((acc, entry) => add(acc, entry.me.position), { x: 0, y: 0, z: 0 });
    const center = mul(centroid, 1 / side.length);
    const bearing = unit(sub(anchor, center));
    const perp = cross(bearing, { x: 0, y: 0, z: 1 });
    const lateralAxis = len(perp) > 0 ? unit(perp) : { x: 1, y: 0, z: 0 };
    const base = add(anchor, mul(bearing, -standoffMeters));
    const offsets = formationOffsets(side.length, formationSpacingMeters, formationRankDepthMeters);
    return side.map((entry, index) => ({
      entry,
      point: add(add(base, mul(lateralAxis, offsets[index].lateral)),
        mul(bearing, offsets[index].depth)),
    }));
  }

  function tick({ systemIDs = [] } = {}) {
    if (!enabled(env)) return { status: "DISABLED", orders: [], skips: [] };
    if (!Array.isArray(systemIDs) || systemIDs.length > 512) {
      return { status: "INVALID_SYSTEMS", orders: [], skips: [] };
    }
    let state, ships;
    try {
      state = readWarState();
      ships = Object.values(registry.snapshot()?.ships || {});
    } catch (_error) {
      return { status: "NATIVE_AUTHORITIES_UNAVAILABLE", orders: [], skips: [] };
    }
    if (state?.version !== 1 || !state.campaigns || !state.wars || !Array.isArray(ships)) {
      return { status: "INVALID_WAR_STATE", orders: [], skips: [] };
    }
    const now = clock();
    if (!pos(now)) return { status: "CLOCK_UNSAFE", orders: [], skips: [] };
    const campaigns = Object.values(state.campaigns).filter(c =>
      c && c.state === "ASSAULT" && state.wars[c.warID]?.state === "ACTIVE" &&
      pos(Number(c.targetSystemID))).slice(0, 8);
    if (!campaigns.length) return { status: "NO_ASSAULT", orders: [], skips: [] };
    const orders = [], skips = [];
    for (const campaign of campaigns) {
      const systemID = Number(campaign.targetSystemID);
      const attackerFactionID = Number(state.wars[campaign.warID]?.attackerFactionID);
      if (!pos(attackerFactionID)) {
        skips.push({ campaignID: campaign.campaignID, reason: "NO_ATTACKER_FACTION" });
        continue;
      }
      let scene = null;
      try { scene = sceneForSystem(systemID); } catch (_error) { scene = null; }
      if (scene?.systemID !== systemID || typeof scene.getEntityByID !== "function") {
        skips.push({ campaignID: campaign.campaignID, reason: "NO_NATIVE_SCENE" });
        continue;
      }
      const inSystem = ships.filter(s => Number(s.systemID) === systemID);
      const sides = new Map();
      for (const ship of inSystem) {
        const id = Number(ship.entityID);
        if (!pos(id)) continue;
        if ((nextAt.get(id) || 0) > now) continue;
        const me = scene.getEntityByID(id);
        if (!me || me.kind !== "ship" || me.nativeNpc !== true || me.session?.characterID) continue;
        if (!finite(me.position) || warping(me)) continue;
        let controller = null;
        try { controller = getController(id); } catch (_error) { controller = null; }
        if (!controller || controller.entityID !== id || Number(controller.systemID) !== systemID) continue;
        // Another director already has a target: the native loop owns the approach.
        if (Number(controller.currentTargetID) > 0) continue;
        const manual = controller.manualOrder;
        const orderedTargetID = manual && manual.type === "attack"
          ? Number(manual.targetID) || 0 : 0;
        // A hull holding an accepted attack order but no target is outside real gun
        // range: it closes on the ship it was ordered to kill. Any other hull is
        // closed on only by the assaulting side.
        if (manual && !orderedTargetID) continue;
        if (!orderedTargetID && Number(ship.factionID) !== attackerFactionID) continue;
        const enemies = inSystem
          .filter(o => Number(o.entityID) !== id &&
            Number(o.factionID) !== Number(ship.factionID) &&
            String(o.campaignID) === String(ship.campaignID))
          .map(row => ({ entityID: Number(row.entityID), entity: scene.getEntityByID(Number(row.entityID)) }))
          .filter(x => x.entity && x.entity.nativeNpc === true && finite(x.entity.position) &&
            !warping(x.entity))
          .map(x => ({
            entityID: x.entityID,
            position: x.entity.position,
            distance: distance(x.entity.position, me.position),
          }))
          .filter(x => Number.isFinite(x.distance))
          .sort((a, b) => a.distance - b.distance || a.entityID - b.entityID);
        if (!enemies.length) {
          skips.push({ campaignID: campaign.campaignID, entityID: id, reason: "NO_ENEMY_IN_SYSTEM" });
          continue;
        }
        const nearest = (orderedTargetID
          ? enemies.find(x => x.entityID === orderedTargetID) || null : null) || enemies[0];
        // Inside the last leg the native attack-order movement flies it sublight.
        if (nearest.distance <= warpMeters) continue;
        const sideKey = campaign.campaignID + "|" + Number(ship.factionID);
        if (!sides.has(sideKey)) sides.set(sideKey, { campaign, ship, factionID: Number(ship.factionID), entries: [] });
        sides.get(sideKey).entries.push({ ship, me, nearest });
      }
      for (const side of sides.values()) {
        const entries = side.entries;
        if (entries.length > 1 && typeof warpBatchToPoints === "function") {
          const leader = entries[0];
          const plan = closeOnFleet(entries, leader.nearest);
          for (const step of plan) nextAt.set(Number(step.entry.ship.entityID), now + cooldownMs);
          let ack = null, threw = "";
          try {
            ack = warpBatchToPoints(
              plan.map(step => ({ entityID: Number(step.entry.ship.entityID), point: step.point })),
              { forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true },
            );
          } catch (error) { threw = String(error?.message || error).slice(0, 120); }
          for (const step of plan) {
            orders.push({
              entityID: Number(step.entry.ship.entityID),
              targetID: step.entry.nearest.entityID,
              campaignID: side.campaign.campaignID,
              factionID: side.factionID,
              systemID,
              formation: entries.length,
              distanceMeters: Math.round(step.entry.nearest.distance),
              status: ack?.success === true ? "NATIVE_FORMATION_WARP_STARTED"
                : String(threw || ack?.errorMsg || "REFUSED").slice(0, 120),
            });
          }
          continue;
        }
        for (const entry of entries) {
          const id = Number(entry.ship.entityID);
          nextAt.set(id, now + cooldownMs);
          // Land `standoffMeters` short of the enemy on the attacker's own bearing:
          // a warp to the exact position would collide with the target.
          const bearing = unit(sub(entry.nearest.position, entry.me.position));
          const point = add(entry.nearest.position, mul(bearing, -standoffMeters));
          let ack = null, threw = "";
          try {
            ack = warpToPoint(id, point, {
              forceImmediateStart: true,
              broadcastWarpStartToVisibleSessions: true,
            });
          } catch (error) { threw = String(error?.message || error).slice(0, 120); }
          orders.push({
            entityID: id,
            targetID: entry.nearest.entityID,
            campaignID: side.campaign.campaignID,
            factionID: side.factionID,
            systemID,
            distanceMeters: Math.round(entry.nearest.distance),
            status: ack?.success === true ? "NATIVE_WARP_STARTED"
              : String(threw || ack?.errorMsg || "REFUSED").slice(0, 120),
          });
        }
      }
    }
    return { status: orders.length ? "WARP_ORDERED" : "NO_ORDER", orders, skips };
  }
  return Object.freeze({ tick });
}

module.exports = { createWarEngagementWarp, enabled, formationOffsets };
