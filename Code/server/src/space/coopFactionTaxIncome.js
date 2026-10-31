"use strict";
// FW-122: the faction that HOLDS a system takes a share of the tax its market already charges.
//
// MEASURED 2026-10-31: the market charges a sales tax (`TRANSACTION_TAX`) and debits it from the
// seller, but `marketProxyService` never credits a corporation - the ISK simply disappears. So the
// factions that own the systems earned nothing from the trade happening inside them, which is the
// owner's whole point: owning ground should pay.
//
// This module names the real recipient: the faction whose military controller holds the station's
// system, paid through the same journaled war treasury every other movement uses. It never invents
// an amount - the caller passes exactly what the sale charged - and it refuses when the system has
// no controller, when the faction has no corporation, or when the amount is not a real number.
const pos = (x) => Number.isSafeInteger(Number(x)) && Number(x) > 0;
const key = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x);

function createFactionTaxIncome({ readWarState, getStation, corporationFor, treasury,
  clock = () => Date.now() } = {}) {
  if ([readWarState, getStation, corporationFor].some((fn) => typeof fn !== "function") ||
    !treasury || typeof treasury.execute !== "function") {
    throw Error("FACTION_TAX_AUTHORITIES_REQUIRED");
  }

  // Which faction really controls the system this station stands in? A registered military
  // controller wins; an unowned system simply has nobody to pay.
  function ownerOf(stationID) {
    const id = Number(stationID);
    if (!pos(id)) return { status: "INVALID_STATION" };
    let station = null;
    try { station = getStation(id); } catch (_error) { station = null; }
    const systemID = Number(station && station.solarSystemID) || 0;
    if (!pos(systemID)) return { status: "STATION_UNKNOWN" };
    let state = null;
    try { state = readWarState(); } catch (_error) { state = null; }
    const territory = state && state.territories ? state.territories[String(systemID)] : null;
    const factionID = Number(territory && territory.militaryControllerFactionID) || 0;
    if (!pos(factionID)) return { status: "NO_SYSTEM_CONTROLLER", systemID };
    return { status: "OWNED", systemID, factionID };
  }

  function collect({ stationID, amountCents, proofID, eventID } = {}) {
    const owner = ownerOf(stationID);
    if (owner.status !== "OWNED") return { status: "REFUSED", reason: owner.status,
      systemID: owner.systemID || 0 };
    const amount = Math.round(Number(amountCents) || 0);
    if (!(amount > 0)) return { status: "REFUSED", reason: "NO_TAX_TO_COLLECT",
      systemID: owner.systemID, factionID: owner.factionID };
    if (!key(String(proofID || "")) || !key(String(eventID || "")))
      return { status: "REFUSED", reason: "TAX_PROOF_REQUIRED",
        systemID: owner.systemID, factionID: owner.factionID };
    let corporationID = 0;
    try { corporationID = Number(corporationFor(owner.factionID)) || 0; } catch (_error) { corporationID = 0; }
    if (!pos(corporationID)) return { status: "REFUSED", reason: "NO_FACTION_CORPORATION",
      systemID: owner.systemID, factionID: owner.factionID };
    let answer = null;
    try {
      answer = treasury.execute({ type: "TAX_INCOME", eventID: String(eventID),
        corporationID, factionID: owner.factionID, amountCents: amount,
        proofID: String(proofID), systemID: owner.systemID });
    } catch (error) {
      return { status: "BLOCKED", reason: "TAX_TREASURY_THREW:" +
        String((error && error.message) || error).slice(0, 60) };
    }
    const status = String((answer && answer.status) || "UNKNOWN");
    return { status: (status === "APPLIED" || status === "DUPLICATE") ? status : "BLOCKED",
      reason: (status === "APPLIED" || status === "DUPLICATE") ? "" :
        String((answer && answer.reason) || status),
      systemID: owner.systemID, factionID: owner.factionID, corporationID,
      amountCents: amount, receipt: answer && answer.receipt || null };
  }

  return Object.freeze({ collect, ownerOf });
}

module.exports = { createFactionTaxIncome };
