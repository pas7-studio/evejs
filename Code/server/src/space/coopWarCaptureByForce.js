"use strict";
// FW-035: a system changes military controller when its defending garrison is
// really destroyed - not when a timer expires.
//
// The existing structure objective needs a player-built structure and a
// sustained occupancy sample. A front that is fought by navy fleets never has
// one, so a campaign stayed in ASSAULT forever even after every defender hull in
// the system was a wreck. This adds the force-based objective path on the SAME
// authoritative core:
//
//   objective  = a casualty-ledger wreck of the defending faction in the campaign
//                system (that ledger already verified the physical native wreck)
//   capture    = the defending side holds ZERO registered hulls in that system,
//                observed twice at least 60 s apart, with that wreck present
//
// Nothing is invented: no wreck means no objective, a live defender means no
// capture, and the core still refuses a stale campaign revision.
const fs = require("node:fs");
const path = require("node:path");
const suffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const warStore = require("./coopFactionWarStore" + suffix);
const fleetStore = require("./coopWarFleetRegistry" + suffix);
const casualtyLedger = require("./coopWarCasualtyLedger" + suffix);
const core = require("./coopFactionWarCore" + suffix);
const { readRow } = require("./coopNativeRowPath" + suffix);
const pos = x => Number.isSafeInteger(x) && x > 0;
const valid = x => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);

function createWarCaptureByForce({
  gameStore,
  isHullLive = null,
  clock = () => Date.now(),
  env = process.env,
  sustainMs = 60000,
} = {}) {
  if (typeof gameStore?.coopAtomicNativeRows?.transact !== "function" ||
    typeof clock !== "function" ||
    (isHullLive !== null && typeof isHullLive !== "function") ||
    !Number.isSafeInteger(sustainMs) || sustainMs < 10000 || sustainMs > 3600000) {
    throw Error("WAR_CAPTURE_BY_FORCE_AUTHORITIES_REQUIRED");
  }
  const enabled = () => env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_FACTION_WAR_FLEETS === "1" &&
    env.EVEJS_COOP_WAR_CAPTURE_BY_FORCE === "1" &&
    env.EVEJS_COOP_NATIVE_ATOMIC_ROWS === "1";
  // campaignID -> {since, wrecks}
  const series = new Map();
  const transact = fn => gameStore.coopAtomicNativeRows.transact([warStore.TABLE], fn);

  function tick() {
    if (!enabled()) return { status: "DISABLED", captured: [], skips: [] };
    const now = clock();
    if (!pos(now)) return { status: "CLOCK_UNSAFE", captured: [], skips: [] };
    try {
      return transact(tx => {
        const war = tx.get(warStore.TABLE, warStore.KEY);
        if (!war || war.version !== 1) return { status: "WAR_STATE_UNAVAILABLE", captured: [], skips: [] };
        core.validateState(war);
        const fleet = tx.get(warStore.TABLE, fleetStore.KEY);
        const ships = fleet && fleet.version === 1 ? Object.values(fleet.ships || {}) : [];
        // FW-136: read the ledger through its own authority. A flat row that is missing
        // from SQLite while a validated copy exists in the cache is healed here, instead
        // of answering NO_DEFENDER_WRECK on five fronts that each hold a real wreck.
        const casualties = typeof casualtyLedger.readLedgerRow === "function"
          ? casualtyLedger.readLedgerRow({ tx, gameStore })
          : tx.get(warStore.TABLE, casualtyLedger.KEY);
        const wrecks = casualties && casualties.version === 1
          ? Object.values(casualties.byWreck || {}) : [];
        const captured = [], skips = [];
        for (const campaign of Object.values(war.campaigns || {})) {
          if (!campaign || campaign.state !== "ASSAULT") continue;
          const active = war.wars[campaign.warID];
          const systemID = Number(campaign.targetSystemID);
          if (!active || active.state !== "ACTIVE" || !pos(systemID)) continue;
          const territory = war.territories[String(systemID)];
          const defenderFactionID = Number(active.defenderFactionID);
          if (!territory || territory.militaryControllerFactionID !== defenderFactionID) {
            skips.push({ campaignID: campaign.campaignID, reason: "NOT_DEFENDER_CONTROLLED" });
            continue;
          }
          // 1. The objective: a real defending wreck in THIS campaign and system.
          const defenderWrecks = wrecks.filter(w => w.campaignID === campaign.campaignID &&
            Number(w.systemID) === systemID &&
            Number(w.victimFactionID) === defenderFactionID);
          if (!defenderWrecks.length) {
            series.delete(campaign.campaignID);
            skips.push({ campaignID: campaign.campaignID, reason: "NO_DEFENDER_WRECK" });
            continue;
          }
          // 2. No live defender hull may remain in the system. A registry row is
          //    custody, not a ship on the field: FW-032 keeps a row until a
          //    confirmed wreck releases it, and a hull can be gone from every
          //    scene while its row waits for reconciliation. Counting rows made
          //    a physically empty, wreck-backed system un-capturable forever
          //    (measured: DEFENDER_STILL_PRESENT with three ghost hulls and two
          //    real defender wrecks). When a liveness authority is supplied only
          //    hulls really present in the scene count - the same rule FW-033
          //    already applies to the garrison.
          const liveOf = (s) => {
            if (typeof isHullLive !== "function") return true;
            try { return isHullLive(systemID, Number(s.entityID)) === true; }
            catch (_error) { return false; }
          };
          const defenderRows = ships.filter(s => Number(s.systemID) === systemID &&
            Number(s.factionID) === defenderFactionID);
          const liveDefenders = defenderRows.filter(liveOf).length;
          const ghostDefenders = defenderRows.length - liveDefenders;
          if (liveDefenders > 0) {
            series.delete(campaign.campaignID);
            skips.push({ campaignID: campaign.campaignID, reason: "DEFENDER_STILL_PRESENT", liveDefenders, ghostDefenders });
            continue;
          }
          // 3. Sustained: the same empty, wreck-backed state for `sustainMs`.
          const witness = defenderWrecks
            .slice()
            .sort((a, b) => Number(b.observedAt) - Number(a.observedAt))[0];
          const entry = series.get(campaign.campaignID);
          const sameWreck = entry && entry.wreckID === Number(witness.wreckID);
          if (!sameWreck) {
            series.set(campaign.campaignID, { since: now, wreckID: Number(witness.wreckID) });
            skips.push({ campaignID: campaign.campaignID, reason: "CAPTURE_SUSTAIN_STARTED", wreckID: Number(witness.wreckID) });
            continue;
          }
          if (now - entry.since < sustainMs) {
            skips.push({ campaignID: campaign.campaignID, reason: "CAPTURE_SUSTAIN_PENDING", elapsedMs: now - entry.since });
            continue;
          }
          const objectiveID = "warship:" + Number(witness.wreckID);
          const proofID = "force:" + campaign.campaignID + ":" + Number(witness.wreckID);
          if (!valid(objectiveID) || !valid(proofID)) {
            skips.push({ campaignID: campaign.campaignID, reason: "PROOF_ID_INVALID" });
            continue;
          }
          const expectedRevision = campaign.revision;
          // Record the objective once; a replay is the core's own DUPLICATE.
          if (!campaign.objectiveEvidence.some(x => x.objectiveID === objectiveID)) {
            const recorded = core.transition(war, {
              type: "RECORD_OBJECTIVE",
              eventID: "fwo-force:" + campaign.campaignID + ":" + witness.wreckID,
              campaignID: campaign.campaignID,
              objectiveID,
              proofID,
            }, {
              now,
              proofs: {
                objective: ({ campaign: c, objectiveID: id, proofID: p }) =>
                  c.campaignID === campaign.campaignID &&
                  id === objectiveID && p === proofID,
              },
            });
            if (recorded.status !== "APPLIED") {
              skips.push({ campaignID: campaign.campaignID, reason: "OBJECTIVE_REJECTED", core: recorded.reason || recorded.status });
              continue;
            }
            tx.put(warStore.TABLE, warStore.KEY, recorded.state);
            captured.push({ campaignID: campaign.campaignID, kind: "OBJECTIVE_RECORDED", objectiveID, wreckID: Number(witness.wreckID) });
            // The capture itself is attempted on the next tick with the new revision.
            continue;
          }
          const result = core.transition(war, {
            type: "CAPTURE_TERRITORY",
            eventID: "fwc-force:" + campaign.campaignID + ":" + witness.wreckID,
            campaignID: campaign.campaignID,
            proofID,
          }, {
            now,
            proofs: {
              capture: ({ campaign: c, war: w, territory: t, proofID: p }) =>
                c.campaignID === campaign.campaignID &&
                c.revision === expectedRevision &&
                w.warID === campaign.warID &&
                t.revision === territory.revision &&
                t.militaryControllerFactionID === defenderFactionID &&
                p === proofID,
            },
          });
          if (result.status !== "APPLIED") {
            skips.push({ campaignID: campaign.campaignID, reason: "CAPTURE_REJECTED", core: result.reason || result.status });
            continue;
          }
          tx.put(warStore.TABLE, warStore.KEY, result.state);
          series.delete(campaign.campaignID);
          captured.push({
            campaignID: campaign.campaignID,
            kind: "CAPTURED",
            systemID,
            wreckID: Number(witness.wreckID),
            receipt: result.receipt,
          });
        }
        return { status: captured.length ? "CAPTURE_APPLIED" : "NO_CHANGE", captured, skips };
      });
    } catch (error) {
      return { status: "BLOCKED", reason: String(error?.message || error).slice(0, 120), captured: [], skips: [] };
    }
  }

  return Object.freeze({ tick, enabled });
}

module.exports = { createWarCaptureByForce };
