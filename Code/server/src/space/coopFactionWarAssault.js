"use strict";
// A campaign leaves PREPARING only when real native ships are assigned to it.
//
// The mobiliser reserves existing native patrols into the war fleet registry.
// That reservation is the evidence: once the attacker has ships on its own side
// of the border and the defender has ships on its side, the campaign can legally
// become an ASSAULT. No ships, no assault - never a timer, never a guess.
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const core = require("./coopFactionWarCore" + siblingSuffix);

const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});

// Reads only the registry rows that belong to a real PREPARING campaign and
// counts them per side, in the system that side is supposed to hold.
function campaignReadiness({ state, ships, minPerSide = 1 } = {}) {
  if (!state || typeof state !== "object" || !state.campaigns || !state.wars)
    return refuse("NO_WAR_STATE");
  const rows = ships && typeof ships === "object" ? Object.values(ships) : [];
  const campaigns = Object.values(state.campaigns)
    .filter((campaign) => campaign && campaign.state === "PREPARING")
    .sort((a, b) => String(a.campaignID).localeCompare(String(b.campaignID)));
  if (!campaigns.length) return refuse("NO_PREPARING_CAMPAIGN");
  const required = Math.max(1, Math.trunc(num(minPerSide) || 1));
  // Every preparing campaign is checked: one un-winnable border must never hide
  // another border whose two sides really are mustered. A campaign is still only
  // READY with real ships on both of ITS sides.
  const waiting = [];
  for (const campaign of campaigns) {
    const war = state.wars[campaign.warID];
    if (!war || war.state !== "ACTIVE") continue;
    const onSide = (factionID, systemID) => rows.filter((row) =>
      row && row.campaignID === campaign.campaignID &&
      num(row.factionID) === num(factionID) && num(row.systemID) === num(systemID));
    // FW-131 (measured 2026-10-31T14:59Z): a campaign only became an ASSAULT when the
    // attacker had a hull in its SOURCE system, but the garrison musters both sides in
    // the TARGET system - so every new front waited for a staging hull that never came,
    // expired after the stall, and the war never fought. A real hull of the attacking
    // faction inside the campaign target is a stronger muster than one waiting at home.
    const attacker = [...onSide(war.attackerFactionID, campaign.sourceSystemID),
      ...onSide(war.attackerFactionID, campaign.targetSystemID)];
    const defender = onSide(war.defenderFactionID, campaign.targetSystemID);
    const base = {
      campaignID: campaign.campaignID,
      warID: war.warID,
      sourceSystemID: num(campaign.sourceSystemID),
      targetSystemID: num(campaign.targetSystemID),
      required,
    };
    if (attacker.length >= required && defender.length >= required) {
      return Object.assign({
        status: "READY",
        attackerShips: attacker.map((row) => num(row.entityID)).filter(pos),
        defenderShips: defender.map((row) => num(row.entityID)).filter(pos),
        evidence: "REAL_NATIVE_PATROLS_RESERVED_ON_BOTH_SIDES",
      }, base);
    }
    waiting.push(Object.assign({
      status: "WAITING",
      attackerShips: attacker.length,
      defenderShips: defender.length,
    }, base));
  }
  if (!waiting.length) return refuse("NO_ACTIVE_WAR_FOR_CAMPAIGN");
  return Object.assign({}, waiting[0], { waiting });
}

// Applies BEGIN_ASSAULT through the authoritative core with the muster as proof.
function beginAssault({ state, readiness, nowMs } = {}) {
  if (!readiness || readiness.status !== "READY") return refuse("MUSTER_NOT_READY");
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  const proofID = "native-muster:" + readiness.campaignID;
  const proofs = {
    deployment: ({ campaign, proofID: claimed }) =>
      Boolean(campaign) && campaign.campaignID === readiness.campaignID && claimed === proofID &&
      readiness.attackerShips.length >= readiness.required &&
      readiness.defenderShips.length >= readiness.required,
  };
  const result = core.transition(state, {
    type: "BEGIN_ASSAULT",
    eventID: "assault:" + readiness.campaignID,
    campaignID: readiness.campaignID,
    proofID,
  }, { now: at, proofs });
  if (result.status !== "APPLIED" && result.status !== "DUPLICATE")
    return refuse(result.reason || "BEGIN_ASSAULT_BLOCKED", { receipt: result.receipt });
  return {
    status: "ASSAULT_BEGUN",
    state: result.state,
    campaignID: readiness.campaignID,
    warID: readiness.warID,
    proofID,
    attackerShips: readiness.attackerShips,
    defenderShips: readiness.defenderShips,
    evidence: "REAL_NATIVE_MUSTER_ON_BOTH_SIDES",
  };
}

module.exports = { campaignReadiness, beginAssault };
