"use strict";
// Input supply: what the corporation must BUY so that its own blueprints can run.
//
// The loop could mine, refine, build and sell, but it could not buy: the hangar held 3.8 M
// Tritanium and zero Pyerite while every Miner I run needs 481 Pyerite and 119 Mexallon
// (measured 2026-10-31, `MATERIALS_MISSING 34:1324/3892702 35:481/0 36:119/0`). An economy
// that cannot buy its inputs is a museum.
//
// This module is pure arithmetic on purpose: given the blueprints that really sit at the
// station, the recipe of each, and what the hangar really holds, it names the exact shortfall.
// It never decides WHERE to buy or WHETHER a price is fair - the trader does that against the
// seeded book, and a station that sells nothing simply sells nothing.
const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/**
 * @param {object} input
 * @param {Array<{blueprintTypeID:number, stationID:number}>} input.blueprints
 * @param {(blueprintTypeID:number, runs:number)=>object} input.recipe
 * @param {Record<string|number, number>} input.held  hangar units per type at the station
 * @param {number} [input.runs]   how many runs of each recipe to provision (default 1)
 * @param {number} [input.maxTypes] how many material types one trip may buy (default 3)
 * @returns {{status:string, needs:Array<{typeID:number,need:number,have:number,short:number}>,
 *   refusals:Array<object>}}
 */
function planSupply({blueprints = [], recipe, held = {}, runs = 1, maxTypes = 3,
  stationID = null} = {}) {
  const want = pos(stationID);
  const list = (Array.isArray(blueprints) ? blueprints : [])
    .filter((row) => row && pos(row.blueprintTypeID))
    .filter((row) => !want || !pos(row.stationID) || pos(row.stationID) === want);
  if (!list.length) return {status: "NO_BLUEPRINTS", needs: [], refusals: []};
  if (typeof recipe !== "function") return {status: "NO_RECIPE_SOURCE", needs: [], refusals: []};
  const perRun = Math.max(1, Math.round(num(runs) || 1));
  const totals = new Map();
  const refusals = [];
  for (const row of list) {
    let plan = null;
    try { plan = recipe(pos(row.blueprintTypeID), perRun); }
    catch (error) { plan = null; }
    if (!plan || plan.status !== "READY") {
      refusals.push({blueprintTypeID: pos(row.blueprintTypeID),
        reason: String((plan && plan.status) || "RECIPE_UNAVAILABLE")});
      continue;
    }
    for (const material of plan.materials || []) {
      const typeID = pos(material && material.typeID);
      if (!typeID) continue;
      // The same material appears in several recipes: the corporation needs the SUM, not the
      // biggest single recipe, or two jobs race one stack into a shortfall.
      totals.set(typeID, (totals.get(typeID) || 0) + Math.max(1, Math.round(num(material.quantity))));
    }
  }
  const needs = [];
  for (const [typeID, need] of totals) {
    const have = Math.max(0, Math.round(num(held[typeID] !== undefined ? held[typeID] : held[String(typeID)])));
    needs.push({typeID, need, have, short: need - have});
  }
  // The biggest hole first: one trip home should carry the material that unlocks the most.
  needs.sort((left, right) => (right.short - left.short) || left.typeID - right.typeID);
  const all = needs.map((row) => ({...row}));
  const short = needs.filter((row) => row.short > 0);
  const bounded = short.slice(0, Math.max(1, Math.round(num(maxTypes) || 1)));
  if (!bounded.length) return {status: "SUPPLIED", needs: [], totals: all, refusals};
  return {status: "SHORT", needs: bounded, totals: all, refusals};
}

/** The hangar's units per type at one station, from real inventory rows. */
function heldAt({items, ownerID, stationID} = {}) {
  const owner = pos(ownerID);
  const station = pos(stationID);
  if (!owner || !station || !items || typeof items.listOwnedItems !== "function") return {};
  const answer = items.listOwnedItems(owner, {locationID: station});
  const rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  const flag = (items.ITEM_FLAGS && items.ITEM_FLAGS.HANGAR) || 4;
  const held = {};
  for (const row of rows) {
    if (Number(row.flagID === undefined ? flag : row.flagID) !== flag) continue;
    const typeID = pos(row.typeID);
    if (!typeID) continue;
    const quantity = num(row.quantity);
    const size = quantity > 0 ? quantity : (Number(row.singleton) === 1 ? 1 : 0);
    held[typeID] = (held[typeID] || 0) + size;
  }
  return held;
}

module.exports = {planSupply, heldAt};
