"use strict";
// FW-033: a front that cannot refill is not a war, it is a one-time event.
//
// Measured: after four real warship kills the battle system held only the
// surviving hulls of one side, and nothing ever put a navy back on the other
// side. The campaign stayed in ASSAULT with an empty garrison.
//
// This module refills a side of an active assault up to `garrisonSize` hulls by
// calling the SAME sanctioned path an operator uses - `spawn_war_fleet`, which
// validates a real doctrine row, spawns a real native ship and links a real free
// pilot identity. It never invents a hull, credits ISK, deals damage or skips the
// native proof: every attempt reports the native status it received.
const enabled = env => env.EVEJS_COOP_FACTION_WAR === "1" &&
  env.EVEJS_COOP_FACTION_WAR_FLEETS === "1" &&
  env.EVEJS_COOP_WAR_GARRISON === "1";
const pos = x => Number.isSafeInteger(x) && x > 0;
const pilot = x => typeof x === "string" && /^coop-pilot-[0-9]{3,}$/.test(x);
// N5: a replacement navy costs money the faction really earned.
//
// Measured: a garrison bought a fresh hull every cooldown forever, so the
// defending side of an ASSAULT never held zero live hulls long enough and the
// force-based capture (FW-035) could only ever answer DEFENDER_STILL_PRESENT.
// It also meant an endless supply of free warships nobody paid for.
//
// The gate is a predicate over the FW-005B campaign chest
// (`coopWarChestFunding`), the one component that moves only ISK a real seeded
// market fill really paid to an NPC pilot. No commitment for this faction in
// this campaign = no replacement hull, and the refusal names that exactly.
const fundedGate = env => env.EVEJS_COOP_WAR_GARRISON_FUNDED === "1";

function createWarGarrison({
  readWarState,
  registry,
  listFreePilots,
  spawnFleet,
  chestCommitment = null,
  isHullLive = null,
  // FW-115: the commander's REAL earned merit, so the doctrine composition can field a
  // role-complete formation. MEASURED 2026-10-31: every garrison spawn passed merit 0, which
  // the composition reads as a recruit's single hull, so seven live campaigns fielded seven
  // identical frigates and no role mix at all while 1380 merit sat in the ledger.
  meritOf = null,
  clock = () => Date.now(),
  env = process.env,
  garrisonSize = 2,
  cooldownMs = 180000,
  maxSpawnsPerTick = 1,
  // FW-134: how many hulls this exact side already lost in this campaign. A side that
  // keeps dying refills more slowly, which is what finally lets an assault empty a
  // system for the capture sustain window instead of trading one hull forever.
  lossCount = null,
} = {}) {
  if (
    [readWarState, listFreePilots, spawnFleet].some(x => typeof x !== "function") ||
    !registry || typeof registry.snapshot !== "function" ||
    typeof clock !== "function" ||
    (isHullLive !== null && typeof isHullLive !== "function") ||
    (chestCommitment !== null && typeof chestCommitment !== "function") ||
    (meritOf !== null && typeof meritOf !== "function") ||
    (lossCount !== null && typeof lossCount !== "function") ||
    !Number.isInteger(garrisonSize) || garrisonSize < 1 || garrisonSize > 6 ||
    !Number.isSafeInteger(cooldownMs) || cooldownMs < 10000 ||
    !Number.isInteger(maxSpawnsPerTick) || maxSpawnsPerTick < 1 || maxSpawnsPerTick > 2
  ) throw Error("WAR_GARRISON_AUTHORITIES_REQUIRED");
  const nextAt = new Map();

  function tick() {
    if (!enabled(env)) return { status: "DISABLED", applied: [], skips: [] };
    let state, ships;
    try {
      state = readWarState();
      const snapshot = registry.snapshot();
      if (!snapshot || snapshot.status === "DISABLED") {
        return { status: "WAR_REGISTRY_DISABLED", applied: [], skips: [] };
      }
      ships = Object.values(snapshot.ships || {});
    } catch (_error) {
      return { status: "NATIVE_AUTHORITIES_UNAVAILABLE", applied: [], skips: [] };
    }
    if (state?.version !== 1 || !state.campaigns || !state.wars || !Array.isArray(ships)) {
      return { status: "INVALID_WAR_STATE", applied: [], skips: [] };
    }
    const now = clock();
    if (!pos(now)) return { status: "CLOCK_UNSAFE", applied: [], skips: [] };
    // A PREPARING campaign is the muster stage: without hulls on both sides it
    // can never reach ASSAULT, and a garrison that only fed ASSAULT campaigns
    // deadlocked the war (measured 2026-10-29: one PREPARING campaign, zero
    // ships, no refill, no battle, for hours on both stacks).
    const Muster = new Set(["PREPARING", "ASSAULT"]);
    const campaigns = Object.values(state.campaigns).filter(c =>
      c && Muster.has(c.state) && state.wars[c.warID]?.state === "ACTIVE" &&
      pos(Number(c.targetSystemID))).slice(0, 4);
    if (!campaigns.length) return { status: "NO_MUSTER", applied: [], skips: [] };
    let free = [];
    try { free = (listFreePilots() || []).filter(pilot); } catch (_error) { free = []; }
    const applied = [], skips = [];
    let spawned = 0;
    for (const campaign of campaigns) {
      const targetSystemID = Number(campaign.targetSystemID);
      const war = state.wars[campaign.warID];
      // FW-103: each side musters in ITS OWN system. MEASURED on the play stack
      // 2026-10-30 21:17:46Z and 21:19:09Z: this garrison spawned the attacker
      // (500004) and the defender (500001) both inside the campaign TARGET
      // (30003837), while `coopWarGateStaging` - and the mobiliser, with the very
      // same rule - need the attacker's hull in `campaign.sourceSystemID`
      // (30045344) until the campaign reaches ASSAULT. So one tick reported
      // GARRISON_APPLIED and NO_ATTACKER_SHIP_REGISTERED at the same time, the
      // front could never deploy, and it expired with NO_ASSAULT_DEPLOYMENT_PROOF.
      const attackerSystemID = String(campaign.state) === "PREPARING"
        ? (pos(Number(campaign.sourceSystemID)) ? Number(campaign.sourceSystemID) : 0)
        : targetSystemID;
      const sides = [
        { factionID: Number(war.attackerFactionID), systemID: attackerSystemID },
        { factionID: Number(war.defenderFactionID), systemID: targetSystemID },
      ].filter(side => pos(side.factionID));
      for (const side of sides) {
        if (spawned >= maxSpawnsPerTick) break;
        const factionID = side.factionID;
        const systemID = side.systemID;
        if (!pos(systemID)) {
          skips.push({ campaignID: campaign.campaignID, factionID,
            reason: "SIDE_SYSTEM_MISSING" });
          continue;
        }
        const key = systemID + "|" + factionID;
        // A registry row is custody, not a ship on the field. A hull that was
        // destroyed or despawned without a confirmed wreck keeps its row (custody
        // must not be released on absence alone), so counting rows made the
        // garrison believe a physically empty side was fully manned and it never
        // refilled. Count only hulls that are really in the scene.
        const live = (s) => {
          if (typeof isHullLive !== "function") return true;
          try { return isHullLive(systemID, Number(s.entityID)) === true; } catch (_error) { return false; }
        };
        const present = ships.filter(s => Number(s.systemID) === systemID &&
          Number(s.factionID) === factionID && live(s)).length;
        const missing = garrisonSize - present;
        if (missing <= 0) continue;
        if ((nextAt.get(key) || 0) > now) {
          skips.push({ campaignID: campaign.campaignID, systemID, factionID, reason: "GARRISON_COOLDOWN", missing });
          continue;
        }
        if (fundedGate(env)) {
          let funding = null;
          try {
            funding = typeof chestCommitment === "function"
              ? chestCommitment({ factionID, warID: campaign.warID, campaignID: campaign.campaignID })
              : null;
          } catch (_error) { funding = null; }
          if (!funding || funding.status !== "FUNDED") {
            // Retry after the same cooldown so an unfunded front costs one
            // journal read per cooldown, not one per tick.
            nextAt.set(key, now + cooldownMs);
            skips.push({
              campaignID: campaign.campaignID, systemID, factionID, missing,
              reason: String(funding && funding.reason || "GARRISON_CHEST_UNAVAILABLE").slice(0, 80),
              chestStatus: String(funding && funding.status || "UNAVAILABLE").slice(0, 40),
            });
            continue;
          }
        }
        // FW-119: the best free commander leads. MEASURED 2026-10-31: the garrison always took
        // the FIRST free identity, so a fresh pilot with merit 0 commanded a whole side and the
        // formation was one hull while veterans with 150 merit stood idle - ten registered hulls
        // and every one of them a tackle frigate. The earned rank is the thing that decides how
        // big a gang a side can field, so it decides who leads it too.
        const pickCommander = () => {
          if (!free.length) return null;
          if (typeof meritOf !== "function") return free.shift();
          let bestIndex = 0;
          let bestMerit = -1;
          for (let index = 0; index < free.length; index += 1) {
            let merit = 0;
            try { merit = Number(meritOf(free[index])) || 0; } catch (_error) { merit = 0; }
            if (merit > bestMerit) { bestMerit = merit; bestIndex = index; }
          }
          return free.splice(bestIndex, 1)[0];
        };
        const commanderPilotID = pickCommander();
        if (!commanderPilotID) {
          skips.push({ campaignID: campaign.campaignID, systemID, factionID, reason: "NO_FREE_PILOT_IDENTITY", missing });
          continue;
        }
        // FW-134: attrition costs time. A side that has already lost hulls in this
        // campaign waits longer before it can refill, so a winning attacker can hold
        // an empty, wreck-backed system for the capture window.
        let losses = 0;
        try {
          losses = typeof lossCount === "function"
            ? Number(lossCount({ campaignID: campaign.campaignID, factionID,
                warID: campaign.warID })) || 0 : 0;
        } catch (_error) { losses = 0; }
        const penalty = Math.min(6, Math.max(0, Math.trunc(losses)));
        nextAt.set(key, now + cooldownMs * (1 + penalty));
        spawned += 1;
        let ack = null, threw = "";
        let commanderMerit = 0;
        if (typeof meritOf === "function") {
          try { commanderMerit = Math.max(0, Number(meritOf(commanderPilotID)) || 0); }
          catch (_error) { commanderMerit = 0; }
        }
        try {
          ack = spawnFleet({ factionID, systemID, commanderPilotID, merit: commanderMerit });
        } catch (error) { threw = String(error?.message || error).slice(0, 120); }
        const ok = ack && ack.ok === true;
        applied.push({
          campaignID: campaign.campaignID,
          systemID,
          factionID,
          commanderPilotID,
          merit: commanderMerit,
          missing,
          fleetID: String(ack && ack.fleetID || ""),
          ships: Array.isArray(ack && ack.ships)
            ? ack.ships.map(s => Number(s.entityID) || 0).filter(pos) : [],
          status: ok ? "NATIVE_GARRISON_SPAWNED"
            : String(threw || ack && ack.error || "REFUSED").slice(0, 120),
        });
      }
    }
    return { status: applied.length ? "GARRISON_APPLIED" : "NO_CHANGE", applied, skips };
  }
  return Object.freeze({ tick });
}

module.exports = { createWarGarrison, enabled, fundedGate };
