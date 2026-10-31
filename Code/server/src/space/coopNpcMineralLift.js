"use strict";
/**
 * The last leg of the co-op loop: the refinery turns the corporation's own ore
 * into minerals in the station hangar, and those minerals must become ISK again.
 *
 * A hangar stack cannot be sold by the ship trader - it sells from a real native
 * cargo hold. This module performs that one custody-safe move:
 *
 *   corporation hangar stack -> exact quantity taken -> hauler native cargo row
 *
 * Every move is journalled before the hangar is debited and receipted after the
 * native cargo row is verified, so an interrupted lift is either replayed from
 * its own evidence or halted for an operator. It never invents stock, never
 * touches a stack that is not the refinery's own output of that corporation, and
 * never lifts more than the seeded bids on that very station can really absorb.
 */
const fs = require("node:fs");
const path = require("node:path");

const HANGAR = 4;
const REFINE_TAG = /^coop-refine:v1:[0-9]+:[0-9]+:mineral:[0-9]+$/;
// Static per process like every other co-op flag: read once, never per row.
const ANY_TYPE = () => String(process.env.EVEJS_COOP_LIFT_ANY_TYPE || "") === "1";
const LIFT_TAG = "coop-mineral-lift:v1";

const pos = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const stacksize = (row) => {
  if (!row || typeof row !== "object") return 0;
  return Number(row.singleton) === 1 ? 1 : pos(row.quantity !== undefined ? row.quantity : row.stacksize);
};

// Only the refinery's own output, owned by this corporation, sitting in the
// hangar of the station the hauler is docked at. Anything else is not ours.
function mineralStacks(rows, {ownerID, stationID} = {}) {
  const owner = pos(ownerID);
  const station = pos(stationID);
  return (Array.isArray(rows) ? rows : Object.values(rows || {}))
    .filter((row) => row && typeof row === "object")
    .filter((row) => !owner || pos(row.ownerID) === owner)
    .filter((row) => !station || pos(row.locationID) === station)
    .filter((row) => Number(row.flagID === undefined ? HANGAR : row.flagID) === HANGAR)
    // Refinery output is the original subject, but the economy also produces real
    // goods (manufactured modules); with EVEJS_COOP_LIFT_ANY_TYPE=1 the same custody
    // -safe load carries any of the corporation's hangar stacks that the station
    // really bids for, so a manufactured item reaches the market by the same path.
    .filter((row) => ANY_TYPE() || REFINE_TAG.test(String(row.customInfo || "")))
    .filter((row) => pos(row.itemID) > 0 && pos(row.typeID) > 0 && stacksize(row) > 0)
    .sort((left, right) => pos(left.itemID) - pos(right.itemID));
}

// The seeded bid that can really pay on THIS station, best price first, deepest
// volume breaking a tie. Same rule the trader uses; a remote bid is not a buyer.
function localBid(buys, {stationID, typeID} = {}) {
  const station = pos(stationID);
  const type = pos(typeID);
  const rows = (Array.isArray(buys) ? buys : []).filter((row) =>
    row && String(row.source || "").toLowerCase() === "seed" &&
    pos(row.station_id) === station && pos(row.type_id) === type &&
    num(row.vol_remaining) >= 1 && num(row.price) > 0 &&
    /^[0-9]+$/.test(String(row.order_id || "")));
  if (!rows.length) return null;
  return rows.sort((left, right) =>
    num(right.price) - num(left.price) || num(right.vol_remaining) - num(left.vol_remaining))[0];
}

// What can be lifted right now: never more than the stack, never more than the
// station's own real demand, never more than the caller's cap per type.
// A demand map is a DISTRIBUTION lift: the stack is taken because the DESTINATION pays for it,
// not because this station bids. Measured 2026-10-30, every station that holds the
// corporation's minerals bids for none of them, so a lift that insists on a local bid can
// never load a freight run - while Jita buys the same Tritanium at 4 ISK x 4 000 000.
function planLift({stacks, buys, stationID, cap = 1e6, demand = null, capM3 = 0,
  volumeOf = null, reserve = null} = {}) {
  const budget = new Map();
  const out = [];
  // A hold is VOLUME, not a per-type unit count: with a demand map the old cap let a bundle
  // take cap units of every type and overbook the ship. When the caller can measure volume,
  // the plan is bounded by the m3 that are really free.
  let leftM3 = num(capM3);
  const demandMap = demand && typeof demand === "object" ? demand : null;
  for (const stack of Array.isArray(stacks) ? stacks : []) {
    const typeID = pos(stack.typeID);
    const raw = pos(stack.quantity !== undefined ? stack.quantity : stack.stacksize);
    if (!typeID || !raw) continue;
    // What the corporation's own blueprints still need at this station is not freight. Measured
    // 2026-10-31: the merchant sold every unit of Pyerite and Mexallon the factory needed, so the
    // hangar held 3.8 M Tritanium and the manufacturer answered MATERIALS_MISSING 35:481/0.
    const reserved = num(reserve && (reserve[typeID] !== undefined ? reserve[typeID]
      : reserve[String(typeID)]));
    const available = Math.max(0, raw - reserved);
    if (!available) continue;
    const target = demandMap ? demandMap[typeID] || demandMap[String(typeID)] || null : null;
    const bid = target ? {price: num(target.price), vol_remaining: num(target.volume || target.vol_remaining), order_id: ""} : localBid(buys, {stationID, typeID});
    if (!bid || !(num(bid.vol_remaining) > 0)) continue;
    const already = budget.get(typeID) || 0;
    const perUnit = typeof volumeOf === "function" ? Math.max(0, num(volumeOf(typeID))) : 0;
    const byHold = perUnit > 0 && leftM3 > 0 ? Math.floor(leftM3 / perUnit) : Infinity;
    const wanted = Math.max(0, Math.min(available, Math.floor(num(bid.vol_remaining)) - already,
      Math.floor(num(cap)) - already, byHold));
    if (wanted < 1) continue;
    budget.set(typeID, already + wanted);
    if (perUnit > 0) leftM3 = Math.max(0, leftM3 - wanted * perUnit);
    out.push({itemID: pos(stack.itemID), typeID, quantity: wanted,
      price: num(bid.price), orderID: String(bid.order_id || "")});
  }
  return out;
}

function createMineralLift({store, items, call, getStation, resolveType, corpID,
  root = "/var/lib/evejs/coop-mineral-lift", probe = null, clock = () => Date.now()} = {}) {
  const journalDir = path.join(root, "journal");
  const receiptDir = path.join(root, "receipts");
  const journalFile = (id) => path.join(journalDir, id + ".json");
  const receiptFile = (id) => path.join(receiptDir, id + ".json");
  let blocked = null;

  function atomic(file, value) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(value, null, 1), "utf8");
    const fd = fs.openSync(temp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  function observe(event, detail, extra) {
    try { probe?.observe(event, null, {...(extra || {}), spaceState: {detail}}); } catch (_) {}
  }

  function rows() {
    const answer = items.listOwnedItems(corpID, {locationID: undefined});
    const list = Array.isArray(answer) ? answer : (Array.isArray(answer?.data) ? answer.data : []);
    return list;
  }

  function findCargo(entityID, tag) {
    const list = store.listNativeCargoForEntity(entityID) || [];
    return list.find((row) => String(row.customInfo || "") === tag) || null;
  }

  // An interrupted lift is settled from its own evidence: a verified cargo row
  // means the freight is really aboard; an untouched stack means nothing was
  // taken. Anything in between needs a human, never a guess.
  function recover() {
    let files = [];
    try { files = fs.readdirSync(journalDir).filter((name) => /\.json$/.test(name)); }
    catch (error) {
      if (error.code === "ENOENT") return {status: "CLEAN", recovered: 0};
      throw error;
    }
    let recovered = 0;
    const pending = [];
    for (const name of files) {
      const file = path.join(journalDir, name);
      let journal;
      try { journal = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (_) { pending.push({file: name, reason: "CORRUPT_JOURNAL"}); continue; }
      const cargo = findCargo(journal.haulerID, journal.cargoTag);
      if (cargo && pos(cargo.quantity) === pos(journal.quantity)) {
        atomic(receiptFile(journal.journalID), {...journal, phase: "SETTLED",
          settledAt: new Date(clock()).toISOString(), recovered: true,
          cargoID: pos(cargo.cargoID)});
        fs.unlinkSync(file);
        recovered += 1;
        continue;
      }
      const current = rows().find((row) => pos(row.itemID) === pos(journal.itemID));
      if (!current || stacksize(current) === pos(journal.afterQuantity)) {
        fs.unlinkSync(file);
        recovered += 1;
        continue;
      }
      pending.push({file: name, reason: "STOCK_AND_CARGO_DISAGREE"});
    }
    if (pending.length) blocked = "NEEDS_OPERATOR_REPAIR";
    return {status: pending.length ? "NEEDS_OPERATOR_REPAIR" : files.length ? "RECOVERED" : "CLEAN",
      recovered, pending};
  }

  async function lift({systemID, stationID, haulerID, cap = 1e6, demand = null, capM3 = 0,
  reserve = null,
   volumeOf = null} = {}) {
    if (blocked) return {status: blocked};
    const system = pos(systemID);
    const station = pos(stationID);
    const hauler = pos(haulerID);
    if (!system || !station || !hauler) return {status: "INVALID_ARGUMENT"};
    const native = store.getNativeEntity(hauler);
    if (!native || Number(native.systemID) !== system)
      return {status: "HAULER_NOT_HERE"};
    if (!native.typeID || !resolveType(native.typeID)) return {status: "HAULER_TYPE_UNKNOWN"};
    const stacks = mineralStacks(rows(), {ownerID: corpID, stationID: station});
    if (!stacks.length) return {status: "NO_MINERAL_STOCK"};
    const info = getStation(station) || {};
    const regionID = pos(info.regionID);
    if (!regionID) return {status: "STATION_REGION_UNAVAILABLE"};
    const buys = [];
    for (const typeID of [...new Set(stacks.map((row) => pos(row.typeID)))]) {
      const book = await call("GetOrders", {region_id: regionID, type_id: typeID});
      buys.push(...(Array.isArray(book?.buys) ? book.buys : []));
    }
    const plan = planLift({stacks, buys, stationID: station, cap, demand, capM3, volumeOf, reserve});
    if (!plan.length) return {status: "NO_LOCAL_BID", stacks: stacks.length};
    const lifted = [];
    for (const step of plan) {
      const journalID = [corpID, hauler, step.itemID, clock()].join("-");
      const cargoTag = LIFT_TAG + ":" + journalID;
      const before = stacks.find((row) => pos(row.itemID) === step.itemID);
      const beforeQuantity = stacksize(before);
      const afterQuantity = beforeQuantity - step.quantity;
      if (afterQuantity < 0) return {status: "STACK_CHANGED", itemID: step.itemID};
      const journal = {version: 1, phase: "PREPARED", journalID, corpID, systemID: system,
        stationID: station, haulerID: hauler, itemID: step.itemID, typeID: step.typeID,
        quantity: step.quantity, beforeQuantity, afterQuantity, price: step.price,
        orderID: step.orderID, cargoTag, at: new Date(clock()).toISOString()};
      atomic(journalFile(journalID), journal);
      const type = resolveType(step.typeID);
      if (!type) return {status: "UNKNOWN_MINERAL_TYPE", typeID: step.typeID};
      const updated = afterQuantity === 0
        ? items.removeInventoryItem(step.itemID, {removeContents: true})
        : items.updateInventoryItem(step.itemID, (row) => ({...row,
          quantity: afterQuantity, stacksize: afterQuantity, singleton: 0}));
      if (updated?.success !== true) return {status: "HANGAR_DEBIT_FAILED", itemID: step.itemID};
      const allocated = store.allocateCargoID({transient: false});
      if (allocated?.success !== true || !pos(allocated.data))
        return {status: "CARGO_ID_ALLOCATION_FAILED"};
      const written = store.upsertNativeCargo({cargoID: pos(allocated.data),
        entityID: hauler, ownerID: pos(native.ownerID), moduleID: 0, typeID: step.typeID,
        groupID: pos(type.groupID), categoryID: pos(type.categoryID),
        itemName: String(type.name || ""), quantity: step.quantity, singleton: false,
        flagID: 5, customInfo: cargoTag}, {transient: false});
      if (written?.success !== true) return {status: "NATIVE_CARGO_WRITE_FAILED"};
      const settled = findCargo(hauler, cargoTag);
      if (!settled || pos(settled.quantity) !== step.quantity)
        return {status: "NATIVE_CARGO_UNVERIFIED"};
      atomic(receiptFile(journalID), {...journal, phase: "SETTLED",
        cargoID: pos(settled.cargoID), settledAt: new Date(clock()).toISOString()});
      fs.unlinkSync(journalFile(journalID));
      lifted.push({itemID: step.itemID, typeID: step.typeID, quantity: step.quantity,
        price: step.price, orderID: step.orderID, cargoID: pos(settled.cargoID)});
    }
    const isk = Math.round(lifted.reduce((sum, row) => sum + row.price * row.quantity, 0) * 100) / 100;
    observe("living-npc-mineral-lifted", {systemID: system, stationID: station,
      haulerID: hauler, lifted: lifted.length, isk},
      {spaceState: {sys: system, station: station, hauler}});
    return {status: "LIFTED", lifted, isk};
  }

  return {lift, recover, mineralStacks, planLift, localBid,
    get status() { return blocked || "READY"; }};
}

module.exports = {HANGAR, REFINE_TAG, LIFT_TAG, mineralStacks, localBid, planLift,
  createMineralLift};
