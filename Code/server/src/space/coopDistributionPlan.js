"use strict";
// ALIFE-21. What one distribution hull should carry, from where, to where - decided from the
// real hangar rows, the real seeded buy orders and a real reciprocal gate.
//
// The pure decision lives in coopNpcDistribution.js; this module only gathers the facts it
// needs and refuses anything it cannot prove:
//   - the origin must be a station in the hull's own system that really holds the stock;
//   - the destination must be one reciprocal gate away, with a seeded bid for the product at
//     a station in that system (the seeded book is the station's own demand, not our orders);
//   - the trip must pay more than it costs to sit still (the pure planner's own rule).
//
// It reads the market database READ-ONLY: the market daemon is a separate process and its RPC
// timed out live on 2026-10-29, which must never turn a decision into a stall.
// FW-121: the deployed overlay renames siblings to .js, the archive mirror keeps .cjs.
const { plan, planBundle } = require("./coopNpcDistribution" +
  (__filename.endsWith(".js") ? "" : ".cjs"));

const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// The stations of a system, taken from the SCENE first: it is the physical truth, and the
// static station table answered zero rows live on 2026-10-30 (measured with listStations()).
function stationRowsOfSystem(worldData, systemID, scene = null) {
  const out = new Map();
  const rows = scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  for (const row of rows) {
    if (String(row.kind) !== "station") continue;
    const stationID = pos(row.itemID);
    if (!stationID) continue;
    out.set(stationID, row);
  }
  try {
    const all = typeof worldData.listStations === "function" ? worldData.listStations() : [];
    for (const row of all) {
      if (Number(row.solarSystemID) !== Number(systemID)) continue;
      const stationID = pos(row.stationID || row.itemID);
      if (stationID && !out.has(stationID)) out.set(stationID, row);
    }
  } catch (_error) { /* the scene is enough when it has them */ }
  return [...out.entries()].map(([stationID, station]) => ({ stationID, station }));
}

function gateNeighbours(scene, worldData) {
  const out = [];
  const rows = scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  for (const row of rows) {
    if (String(row.kind) !== "stargate") continue;
    const gate = typeof worldData.getStargateByID === "function"
      ? worldData.getStargateByID(row.itemID) : null;
    const destinationSystemID = pos(gate && gate.destinationSolarSystemID);
    if (!destinationSystemID) continue;
    out.push({ sourceGateID: pos(row.itemID), destinationSystemID,
      destinationGateID: pos(gate && gate.destinationID) });
  }
  return out;
}

/** Every seeded buy order in these systems, grouped by station and type. */
function seededBids(db, systemIDs) {
  const out = new Map();
  if (!db || !Array.isArray(systemIDs) || !systemIDs.length) return out;
  const placeholders = systemIDs.map(() => "?").join(",");
  let rows = [];
  try {
    rows = db.prepare("select solar_system_id, station_id, type_id, price, quantity " +
      "from seed_buy_orders where solar_system_id in (" + placeholders + ") and quantity>0")
      .all(...systemIDs);
  } catch (_error) { return out; }
  for (const row of rows) {
    const stationID = pos(row.station_id);
    const typeID = pos(row.type_id);
    if (!stationID || !typeID) continue;
    const key = stationID;
    if (!out.has(key)) out.set(key, {});
    const books = out.get(key);
    const current = books[typeID] || { price: 0, volume: 0 };
    if (num(row.price) > current.price) current.price = num(row.price);
    current.volume += num(row.quantity);
    books[typeID] = current;
  }
  return out;
}

/**
 * Choose one trip for a hull that is standing somewhere with freight around it.
 * Returns {status:"OK", trip} or {status, reason} - never a trip it cannot pay for.
 */
function planTrip({ haulerID, store, items, inventory, db, worldData, connectedGates,
  scene = null, corpID = 1000129, minIsk = 200000, maxSystems = 6, reserve = null } = {}) {
  const id = pos(haulerID);
  if (!id) return { status: "INVALID_ARGUMENT" };
  const native = store && typeof store.getNativeEntity === "function" ? store.getNativeEntity(id) : null;
  if (!native) return { status: "HULL_NOT_DURABLE" };
  const systemID = pos(native.systemID);
  if (!systemID) return { status: "HULL_SYSTEM_UNKNOWN" };
  const type = inventory && typeof inventory.resolveItemByTypeID === "function"
    ? inventory.resolveItemByTypeID(pos(native.shipTypeID || native.typeID)) : null;
  const capacityM3 = Math.max(0, num(type && type.capacity));
  if (!capacityM3) return { status: "HOLD_CAPACITY_UNKNOWN" };
  // What is already aboard is not available for the next load: measured 2026-10-30 a hull
  // went back out with 35 629 units still in the hold and planned a full-size trip anyway.
  let usedM3 = 0;
  try {
    for (const row of store.listNativeCargoForEntity(id) || []) {
      const meta = inventory.resolveItemByTypeID(pos(row.typeID)) || {};
      usedM3 += num(row.quantity) * num(meta.volume);
    }
  } catch (_error) { usedM3 = 0; }
  const freeM3 = Math.max(0, capacityM3 - usedM3);
  if (freeM3 < 1) return { status: "HOLD_ALREADY_FULL", systemID };

  // The corporation's real hangar rows, grouped by the station that holds them.
  let owned = [];
  try {
    const answer = items.listOwnedItems(corpID, { locationID: undefined });
    owned = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  } catch (_error) { return { status: "HANGAR_UNREADABLE" }; }
  const stations = new Map(stationRowsOfSystem(worldData, systemID, scene)
    .map((row) => [row.stationID, row.station]));
  const stacks = [];
  for (const row of owned) {
    const stationID = pos(row.locationID);
    if (!stationID || !stations.has(stationID)) continue;
    if (Number(row.flagID) !== 4 || !(num(row.quantity) > 0)) continue;
    const typeID = pos(row.typeID);
    const meta = inventory.resolveItemByTypeID(typeID) || {};
    // What the corporation's own blueprints still need at this station stays home: the
    // factory and the merchant used to compete for the same Pyerite and the merchant won.
    // The reserve may be a plain map or a resolver, because only the caller knows which
    // stations it must ask about (the factory's own station is the only one that answers).
    const held = (typeof reserve === "function" ? (reserve(stationID) || {})
      : (reserve && (reserve[stationID] || reserve[String(stationID)]))) || {};
    const needed = num(held[typeID] !== undefined ? held[typeID] : held[String(typeID)]);
    const shippable = Math.max(0, num(row.quantity) - Math.max(0, Math.round(needed)));
    if (!shippable) continue;
    stacks.push({ stationID, typeID, quantity: shippable,
      m3PerUnit: num(meta.volume) });
  }
  if (!stacks.length) return { status: "NO_STOCK_IN_SYSTEM", systemID };

  const neighbours = gateNeighbours(scene, worldData)
    .filter((row) => row.destinationSystemID && row.destinationSystemID !== systemID);
  if (!neighbours.length) return { status: "NO_GATE_OUT", systemID };
  const targetSystems = [...new Set(neighbours.map((row) => row.destinationSystemID))]
    .slice(0, Math.max(1, num(maxSystems)));
  const bidsByStation = seededBids(db, targetSystems);
  if (!bidsByStation.size) return { status: "NO_BUYER_ONE_GATE_AWAY", systemID };

  let best = null;
  const refusals = [];
  for (const [stationID, bids] of bidsByStation) {
    const stationRow = typeof worldData.getStationByID === "function"
      ? worldData.getStationByID(stationID) : null;
    const destinationSystemID = pos(stationRow && stationRow.solarSystemID);
    if (!destinationSystemID || !targetSystems.includes(destinationSystemID)) continue;
    const gate = typeof connectedGates === "function"
      ? connectedGates({ sourceSystemID: systemID, targetSystemID: destinationSystemID })
      : null;
    if (!gate) { refusals.push({ stationID, reason: "NO_RECIPROCAL_GATE" }); continue; }
    // A trip fills the hold with the densest cargo it can carry, so ammunition does not ride
    // alone while 3 099 m3 of hold flies empty.
    const answer = planBundle({
      stacks,
      destination: { systemID: destinationSystemID, stationID, bids },
      local: { stationID: 0, bids: {} },
      capacityM3: freeM3, minIsk,
    });
    if (answer && answer.status === "TRIP" && answer.items.length) {
      const total = num(answer.totalIsk);
      if (!best || total > best.expectedIsk) {
        const demand = {};
        for (const item of answer.items) demand[pos(item.typeID)] = { price: num(item.price),
          volume: num(item.quantity) };
        const first = answer.items[0] || {};
        best = { ...first, items: answer.items, demand, expectedIsk: total,
          fromSystemID: systemID, fromStationID: pos(first.stationID || stationID),
          quantity: answer.items.reduce((sum, item) => sum + num(item.quantity), 0),
          m3: num(answer.m3), toStationID: stationID,
          toSystemID: destinationSystemID, gate: {
            sourceGateID: pos(gate.sourceGateID), destinationGateID: pos(gate.destinationGateID),
            sourceSystemID: systemID, destinationSystemID,
          } };
      }
    } else if (answer && Array.isArray(answer.refusals)) {
      refusals.push(...answer.refusals.slice(0, 3));
    }
  }
  if (!best) return { status: "NO_TRIP_WORTH_TAKING", systemID, refusals: refusals.slice(0, 6) };
  return { status: "OK", trip: best };
}



/** The station in this system whose seeded book takes the most of what the hull carries. */
function stationForTypes({ db, systemID, typeIDs = [] } = {}) {
  const system = pos(systemID);
  const want = (Array.isArray(typeIDs) ? typeIDs : []).map(Number).filter(Boolean);
  if (!db || !system || !want.length) return { status: "UNKNOWN", stationID: 0 };
  let rows = [];
  try {
    rows = db.prepare("select station_id, type_id, sum(quantity) as volume " +
      "from seed_buy_orders where solar_system_id=? and quantity>0 " +
      "group by station_id, type_id").all(system);
  } catch (_error) { return { status: "BOOK_UNREADABLE", stationID: 0 }; }
  let best = 0;
  let units = 0;
  for (const row of rows) {
    if (!want.includes(Number(row.type_id))) continue;
    // The seeded book is read with a sum() alias; a plain row count is equally valid.
    const volume = num(row.volume !== undefined ? row.volume : row.quantity);
    if (volume > units) { best = pos(row.station_id); units = volume; }
  }
  return best ? { status: "OK", stationID: best, units } : { status: "NO_BUYER_FOR_CARGO", stationID: 0 };
}

/**
 * Where the corporation actually holds hangar stock, by system - the answer to "where does this
 * hull have to go to find freight?". Measured 2026-10-30: a distribution hull parked in Jita has
 * nothing to load and the run could only report NO_STOCK_IN_SYSTEM.
 */
function stockSystems({ items, worldData, corpID = 1000129 } = {}) {
  const totals = new Map();
  let owned = [];
  try {
    const answer = items.listOwnedItems(corpID, { locationID: undefined });
    owned = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  } catch (_error) { return []; }
  for (const row of owned) {
    const stationID = pos(row.locationID);
    if (!stationID || Number(row.flagID) !== 4 || !(num(row.quantity) > 0)) continue;
    const station = worldData.getStationByID(stationID);
    const systemID = pos(station && station.solarSystemID);
    if (!systemID) continue;
    const current = totals.get(systemID) || { systemID, units: 0, stations: 0 };
    current.units += num(row.quantity);
    current.stations += 1;
    totals.set(systemID, current);
  }
  return [...totals.values()].sort((a, b) => b.units - a.units);
}

/**
 * FW-121: the NEAREST station that really bids for what a hull is carrying, by gate hops.
 *
 * MEASURED on the play stack 2026-10-31: 1 576 native cargo rows across 19 types sat in NPC
 * holds, and NOT ONE of those types had a seeded buyer in any of the six war or mining systems.
 * Selling therefore always means travelling, and the only buyer finder in the server looked a
 * single gate away. This walks the real gate graph ring by ring and asks the seeded book for
 * each ring in ONE query, so the answer is the nearest real market, not the nearest guess.
 *
 * Returns {status:"OK", systemID, stationID, hops, volume, price} or {status:"NO_BUYER"}.
 * It reads only the market book and the adjacency it is handed; it moves nothing.
 */
function nearestBuyerForTypes({ db, fromSystemID, typeIDs = [], neighbours, maxHops = 12,
  maxSystems = 600 } = {}) {
  const from = pos(fromSystemID);
  const want = [...new Set((Array.isArray(typeIDs) ? typeIDs : []).map(Number).filter(Boolean))];
  if (!db || !from || !want.length) return { status: "UNKNOWN", stationID: 0 };
  if (typeof neighbours !== "function") return { status: "NO_GATE_GRAPH", stationID: 0 };
  const hopLimit = Math.max(0, Math.min(32, Number(maxHops) || 12));
  const budget = Math.max(1, Math.min(4000, Number(maxSystems) || 600));
  const seen = new Set([from]);
  let ring = [from];
  let hops = 0;
  let visited = 0;
  const typePlaceholders = want.map(() => "?").join(",");
  while (ring.length && hops <= hopLimit && visited < budget) {
    const ask = ring.slice(0, Math.max(1, budget - visited));
    visited += ask.length;
    let rows = [];
    try {
      rows = db.prepare("select solar_system_id as sys, station_id as station, " +
        "sum(quantity) as volume, max(price) as price from seed_buy_orders " +
        "where quantity>0 and solar_system_id in (" + ask.map(() => "?").join(",") + ") " +
        "and type_id in (" + typePlaceholders + ") " +
        "group by sys, station").all(...ask, ...want);
    } catch (_error) { return { status: "BOOK_UNREADABLE", stationID: 0 }; }
    let best = null;
    for (const row of rows) {
      const stationID = pos(row && row.station);
      const systemID = pos(row && row.sys);
      const volume = num(row && row.volume);
      if (!stationID || !systemID || volume <= 0) continue;
      if (!best || volume > best.volume ||
        (volume === best.volume && stationID < best.stationID)) {
        best = { systemID, stationID, volume, price: num(row && row.price) };
      }
    }
    if (best) return { status: "OK", hops, ...best };
    const next = [];
    for (const systemID of ask) {
      let list = [];
      try { list = neighbours(systemID) || []; } catch (_error) { list = []; }
      for (const raw of list) {
        const id = Number(raw);
        if (!pos(id) || seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
    }
    ring = next.sort((a, b) => a - b);
    hops += 1;
  }
  return { status: "NO_BUYER", stationID: 0, hopsSearched: hops - 1, systemsVisited: visited };
}

module.exports = { stationForTypes, stockSystems, planTrip, gateNeighbours, seededBids,
  stationRowsOfSystem, nearestBuyerForTypes };
