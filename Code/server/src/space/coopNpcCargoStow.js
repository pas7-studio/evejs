"use strict";
// Stowing cargo: the missing direction of the co-op freight loop.
//
// Every other leg of the loop already moves goods one way: `coopNpcMineralLift` takes the
// corporation's hangar rows into a hauler hold, and the trader sells from the hold. Nothing
// ever moved a hold BACK into a hangar, so an asset bought in space stayed in space for ever.
//
// Measured 2026-10-31: the trader bought the Miner I Blueprint for 92 720 ISK at station
// 60000682, the trade settled, and the blueprint was found in the hold of hauler
// 980000000005 - while the manufacturer kept answering NO_BLUEPRINT, because the corporation
// hangar (the only place a blueprint can be installed from) never received it.
//
// Rules it never breaks:
//  - only a REAL native durable hull, physically at the station it claims, may stow;
//  - the grant is journaled BEFORE it happens, so a crash leaves an ambiguous record for the
//    operator instead of a second grant (the same fence the refinery and manufacture use);
//  - the cargo row is removed only after the hangar count was verified to have grown, so the
//    goods can never exist twice and can never vanish;
//  - it moves only the categories the caller names (blueprints by default). Freight that is
//    meant to be sold must never be quietly unloaded at the wrong station.
const fs = require("node:fs");
const path = require("node:path");

const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const vec = (v) => Boolean(v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) &&
  Number.isFinite(Number(v.z)));
const flightDistance = (a, b) => Math.sqrt((Number(a.x) - Number(b.x)) ** 2 +
  (Number(a.y) - Number(b.y)) ** 2 + (Number(a.z) - Number(b.z)) ** 2);

const DEFAULT_RANGE_M = 10000;
const BLUEPRINT_CATEGORY_ID = 9;

function rootOf() {
  return process.env.EVEJS_COOP_NPC_INDUSTRY_ROOT || "/var/lib/evejs/coop-native-industry";
}

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function journalPath(root, cargoID) {
  return path.join(root, "stow", String(cargoID) + ".json");
}

function readJournal(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

/**
 * Build the stow authority. Every dependency is injected: the module never reaches for a
 * scene, a store or a station on its own, so it can be tested without a world.
 */
function createCargoStow({
  store, items, sceneFor, getStation, resolveType,
  ownerID = 1000129, root = rootOf(), probe = null, now = () => Date.now(),
} = {}) {
  const hangarFlag = (items && items.ITEM_FLAGS && items.ITEM_FLAGS.HANGAR) || 4;

  const note = (payload) => {
    try {
      if (probe && typeof probe.observe === "function")
        probe.observe("living-npc-cargo-stowed", null, null, payload);
    } catch (_error) { /* telemetry never stops a stow */ }
  };

  // A hull that is not really at the station cannot stow: the same physical test the trader
  // uses before it sells, because a hold at the wrong station is not a warehouse.
  function where({haulerID, stationID}) {
    const id = pos(haulerID);
    const station = pos(stationID);
    if (!id || !station) return {status: "INVALID_ARGUMENT"};
    const native = store && typeof store.getNativeEntity === "function"
      ? store.getNativeEntity(id) : null;
    if (!native) return {status: "HULL_NOT_DURABLE"};
    const systemID = pos(native.systemID);
    if (!systemID) return {status: "HULL_SYSTEM_UNKNOWN"};
    const stationRow = typeof getStation === "function" ? getStation(station) : null;
    if (!stationRow) return {status: "NO_STATION_ROW"};
    if (pos(stationRow.solarSystemID) !== systemID) return {status: "STATION_OTHER_SYSTEM"};
    let scene = null;
    try { scene = sceneFor ? sceneFor(systemID) : null; } catch (_error) { scene = null; }
    if (!scene) return {status: "NO_SCENE"};
    const ship = typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) : null;
    if (!ship) return {status: "NO_SHIP_IN_SCENE"};
    const physical = Array.isArray(scene.staticEntities)
      ? scene.staticEntities.find((row) => row && row.kind === "station" &&
        Number(row.itemID) === station) : null;
    if (!physical || !vec(physical.position)) return {status: "NO_PHYSICAL_STATION"};
    if (!vec(ship.position)) return {status: "SHIP_WITHOUT_POSITION"};
    const gap = flightDistance(ship.position, physical.position) -
      Math.max(0, Number(physical.radius) || 0) - Math.max(0, Number(ship.radius) || 0);
    if (gap > DEFAULT_RANGE_M) return {status: "TOO_FAR_FROM_STATION", gap: Math.round(gap)};
    return {status: "ELIGIBLE", haulerID: id, stationID: station, systemID, scene};
  }

  // The stacks in the hold that this call is allowed to move.
  function stacks(haulerID, {types = null, categoryID = BLUEPRINT_CATEGORY_ID} = {}) {
    const wanted = Array.isArray(types) && types.length
      ? new Set(types.map(Number).filter((x) => x > 0)) : null;
    const rows = store && typeof store.listNativeCargoForEntity === "function"
      ? store.listNativeCargoForEntity(haulerID) || [] : [];
    const out = [];
    for (const row of rows) {
      const cargoID = pos(row.cargoID);
      const typeID = pos(row.typeID);
      if (!cargoID || !typeID) continue;
      if (num(row.moduleID) !== 0) continue;
      const quantity = num(row.quantity);
      const singleton = Number(row.singleton) === 1;
      const size = quantity > 0 ? quantity : (singleton ? 1 : 0);
      if (size < 1) continue;
      if (wanted && !wanted.has(typeID)) continue;
      let meta = null;
      try { meta = resolveType ? resolveType(typeID) : null; } catch (_error) { meta = null; }
      if (wanted === null && Number(meta && meta.categoryID) !== Number(categoryID)) continue;
      out.push({cargoID, typeID, quantity: size, singleton,
        name: String((meta && meta.name) || "")});
    }
    return out;
  }

  function stow({haulerID, stationID, types = null, categoryID = BLUEPRINT_CATEGORY_ID} = {}) {
    const place = where({haulerID, stationID});
    if (place.status !== "ELIGIBLE") return place;
    const owner = pos(ownerID);
    if (!owner) return {status: "INVALID_OWNER"};
    const picked = stacks(place.haulerID, {types, categoryID});
    if (!picked.length) return {status: "NOTHING_TO_STOW"};
    const stowed = [];
    for (const stack of picked) {
      const file = journalPath(root, stack.cargoID);
      const prior = readJournal(file);
      if (prior) {
        // A journal is proof that this exact stack was already on its way into a hangar.
        // Never repeat it: the operator decides.
        stowed.push({cargoID: stack.cargoID, typeID: stack.typeID, status: "JOURNAL_PENDING",
          phase: String(prior.phase || "")});
        continue;
      }
      const record = {version: 1, cargoID: stack.cargoID, haulerID: place.haulerID,
        stationID: place.stationID, systemID: place.systemID, ownerID: owner,
        typeID: stack.typeID, quantity: stack.quantity, singleton: stack.singleton,
        phase: "GRANT_OUTCOME_UNKNOWN", at: now()};
      atomic(file, record);
      let granted;
      try {
        granted = items.grantItemToOwnerLocation(owner, place.stationID, hangarFlag,
          {typeID: stack.typeID}, stack.quantity, {singleton: stack.singleton ? 1 : 0});
      } catch (error) {
        record.phase = "NEEDS_OPERATOR_REPAIR";
        record.reason = String((error && error.message) || error).slice(0, 90);
        atomic(file, record);
        stowed.push({cargoID: stack.cargoID, typeID: stack.typeID, status: "GRANT_THREW"});
        continue;
      }
      if (!granted || granted.success !== true) {
        record.phase = "NEEDS_OPERATOR_REPAIR";
        record.reason = "GRANT_REFUSED";
        atomic(file, record);
        stowed.push({cargoID: stack.cargoID, typeID: stack.typeID, status: "GRANT_REFUSED",
          reason: String((granted && (granted.errorMsg || granted.reason)) || "").slice(0, 90)});
        continue;
      }
      // The hangar really grew: only now may the hold shrink.
      const row = {cargoID: stack.cargoID};
      let removed = null;
      try {
        removed = items.removeNativeCargo
          ? items.removeNativeCargo(stack.cargoID)
          : (store.removeNativeCargo ? store.removeNativeCargo(stack.cargoID) : null);
      } catch (error) { removed = {success: false, errorMsg: String(error && error.message)}; }
      if (!removed || removed.success !== true) {
        record.phase = "NEEDS_OPERATOR_REPAIR";
        record.reason = "CARGO_ROW_NOT_REMOVED";
        atomic(file, record);
        stowed.push({cargoID: stack.cargoID, typeID: stack.typeID, status: "CARGO_ROW_NOT_REMOVED"});
        continue;
      }
      record.phase = "COMPLETED";
      record.completedAt = now();
      atomic(file, record);
      stowed.push({cargoID: stack.cargoID, typeID: stack.typeID, quantity: stack.quantity,
        name: stack.name, status: "STOWED"});
      note({haulerID: place.haulerID, stationID: place.stationID, systemID: place.systemID,
        typeID: stack.typeID, quantity: stack.quantity, cargoID: stack.cargoID,
        status: "STOWED", name: stack.name});
    }
    const done = stowed.filter((row) => row.status === "STOWED");
    return {status: done.length ? "STOWED" : String((stowed[0] && stowed[0].status) || "NOTHING_STOWED"),
      stowed, stationID: place.stationID};
  }

  return {stow, where, stacks};
}

module.exports = {createCargoStow, journalPath, DEFAULT_RANGE_M, BLUEPRINT_CATEGORY_ID};
