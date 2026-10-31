"use strict";
// ALIFE-21. One real distribution trip, end to end.
//
// The pieces already existed and were proven separately: the lift moves a hangar stack into a
// hauler's native hold (journal + receipt), the gate crossing moves that same durable hull to
// another system (SAME_NATIVE_SHIP_ARRIVED), and the arrival sale fills the seeded bids. What
// was missing is the RUN: nothing ever loaded a hull, so a "distribution" flight carried air.
//
// This module owns exactly one trip per hull, durably:
//   PLAN -> TO_ORIGIN -> LOAD -> CROSS -> TO_DEST -> SELL -> DONE
// and it stops with a reason the moment the world disagrees, because a trip that invents a
// step is worse than a trip that reports why it could not take it.
//
// Every step is somebody else's authority: the lift is coopNpcMineralLift, the crossing is
// coopNpcGateCrossing (and behind it the native transfer), the sale is sellOnArrival. This
// module only decides the order and remembers where the run is.
const fs = require("fs");
const path = require("path");

const PHASE = Object.freeze({
  PLAN: "PLAN", TO_ORIGIN: "TO_ORIGIN", LOAD: "LOAD", CROSS: "CROSS",
  TO_DEST: "TO_DEST", SELL: "SELL", SUPPLY: "SUPPLY", RETURN: "RETURN", DONE: "DONE",
  BLOCKED: "BLOCKED",
});
// How close a hull must really be before a station lift or sale is allowed to act. The
// native market refuses a sale beyond 10 km from the PHYSICAL station, so a laxer number here
// only produces NOT_AT_NATIVE_STATION (measured 2026-10-30).
const STATION_RANGE_M = 8000;
// One sale call fills at most the market's own per-order limit, so a loaded hold may need
// several; the count is bounded so a silent market cannot become an endless loop.
const MAX_SELL_CALLS = 6;
// An import run buys in bounded steps: the market caps one purchase and spaces them out, so a
// visit that keeps buying is a visit that is really filling the hold, not spinning.
const MAX_SUPPLY_TRIES = 40;
// A slow market daemon is not a failed sale: the wait is bounded by time.
const SALE_SETTLE_TIMEOUT_MS = 15 * 60 * 1000;
// How often one beat asks again while the market is still thinking, and how long it waits
// for the answer: the settled result lives for about five seconds.
// The market refuses a second trade by the same pilot inside its own cooldown window
// (EVEJS_COOP_NPC_MARKET_COOLDOWN_MS, 5 s here), so polling faster than that only collects
// COOLDOWN refusals. Measured 2026-10-30: 2.5 s polls produced a settlement of NOT_SOLD COOLDOWN.
const SALE_POLL_MS = 6000;
// The settled sale is readable for only ~5 s: read it sooner than a poll interval, or the
// amount is lost and a paid trip is recorded as an unknown price (measured 2026-10-30: 4 of 9).
const SALE_SETTLEMENT_READ_MS = 1200;
const SALE_SETTLEMENT_READS = 4;
const MAX_POLLS_PER_BEAT = 4;
// Refusals that mean "not yet" rather than "no": the run waits, bounded, instead of stopping.
// Refusals that mean "not yet": the hull is busy, being rebuilt, the daemon is away, or the
// pilot is inside the market cooldown. Measured 2026-10-30: a loaded hull was blocked
// SALE_NOT_SOLD:NATIVE_NPC_BUSY and stopped carrying 20 255 units for good.
const SALE_RETRYABLE = new Set(["NOT_AT_NATIVE_STATION", "SALE_TIMEOUT", "MARKET_UNAVAILABLE",
  "UNRESOLVED_MARKET_JOURNAL",
  "COOLDOWN", "NO_ELIGIBLE_STACK", "BOOK_UNREADABLE", "MARKET_PREFLIGHT_STALE"]);

function num(x) { return Number.isFinite(Number(x)) ? Number(x) : 0; }
const phase2 = (value) => String(value || PHASE.TO_ORIGIN);
function pos(x) { const v = num(x); return Number.isSafeInteger(v) && v > 0 ? v : 0; }

function root(env = process.env) {
  return path.join(String(env.EVEJS_COOP_NPC_MARKET_ROOT || env.EVEJS_COOP_NPC_MARKET_DIR ||
    "/var/lib/evejs/coop-native-market"), "distribution-run");
}
function fileFor(haulerID, env = process.env) {
  return path.join(root(env), String(pos(haulerID)) + ".json");
}
function read(haulerID, env = process.env) {
  try { return JSON.parse(fs.readFileSync(fileFor(haulerID, env), "utf8")); }
  catch (_error) { return null; }
}
function write(state, env = process.env) {
  const file = fileFor(state.haulerID, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 1), "utf8");
  const fd = fs.openSync(temp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  return state;
}
// Where the money from freight is written down. The economy ledger counted production and
// station sales, so a trip's ISK existed only in the pilot's balance and a treasury sweep -
// invisible exactly where the corporation's capital is accounted. One append-only row per
// settlement keeps it honest and cheap.
function freightLedgerFile(env = process.env) {
  return path.join(root(env), "..", "freight-ledger.jsonl");
}
function appendFreight(state, settlement, env = process.env) {
  try {
    const row = {
      at: new Date(num(settlement && settlement.at) || Date.now()).toISOString(),
      haulerID: pos(state.haulerID),
      fromSystemID: pos(state.fromSystemID), toSystemID: pos(state.toSystemID),
      toStationID: pos(state.toStationID),
      lines: Array.isArray(state.lifted) ? state.lifted.length : 0,
      handledAt: pos(state.toStationID),
      units: num(settlement && settlement.quantity),
      isk: num(settlement && settlement.isk),
      status: String((settlement && settlement.status) || "SOLD"),
      iskUnknown: settlement && settlement.iskUnknown === true ? true : undefined,
    };
    const file = freightLedgerFile(env);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch (_error) { return false; }
}
function list(env = process.env) {
  try {
    return fs.readdirSync(root(env)).filter((n) => /\.json$/.test(n))
      .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(root(env), n), "utf8")); }
        catch (_error) { return null; } }).filter(Boolean);
  } catch (_error) { return []; }
}

/**
 * The next thing this run may do. Pure: every fact is handed in, nothing is inferred.
 * A run never advances on hope - a missing fact is a WAIT, an impossible one is BLOCKED.
 */
function decide(state, facts = {}) {
  if (!state) return { action: "PLAN" };
  const phase = String(state.phase || PHASE.PLAN);
  if (phase === PHASE.DONE) return { action: "IDLE", reason: "DONE" };
  if (phase === PHASE.BLOCKED) return { action: "IDLE", reason: state.lastReason || "BLOCKED" };
  if (phase === PHASE.PLAN) return { action: "PLAN" };
  if (phase === PHASE.TO_ORIGIN) {
    const d = facts.distanceToOriginM;
    if (Number.isFinite(d) && d <= STATION_RANGE_M) return { action: "LIFT" };
    return { action: "GO_ORIGIN" };
  }
  if (phase === PHASE.LOAD) return { action: "LIFT" };
  if (phase === PHASE.CROSS) {
    const crossed = String(facts.crossingPhase || "");
    if (crossed === "ARRIVED") return { action: "TO_DEST" };
    if (crossed === "BLOCKED" || crossed === "ABANDONED")
      return { action: "BLOCK", reason: "CROSSING_" + crossed };
    return { action: "WAIT", reason: "CROSSING_" + (crossed || "UNPLANNED") };
  }
  if (phase === PHASE.TO_DEST) {
    const d = facts.distanceToDestinationM;
    if (Number.isFinite(d) && d <= STATION_RANGE_M) return { action: "SELL" };
    return { action: "GO_DEST" };
  }
  if (phase === PHASE.SELL) return { action: "SELL" };
  if (phase === PHASE.RETURN) {
    // Home again: the journal is reset and a fresh trip is planned from the real world.
    if (facts.hullSystemID && facts.hullSystemID === state.returnToSystemID)
      return { action: "REPLAN" };
    const crossed = String(facts.crossingPhase || "");
    if (crossed === "BLOCKED" || crossed === "ABANDONED")
      return { action: "BLOCK", reason: "RETURN_CROSSING_" + crossed };
    // A completed journal from the trip OUT is not a crossing home: only the durable record
    // saying the hull is back home is proof. Measured 2026-10-30: a stale ARRIVED kept the run
    // reporting RETURNED while the hull sat in the buyer system.
    return { action: "RETURN_CROSS", crossingPhase: crossed === "ARRIVED" ? null : (crossed || null) };
  }
  return { action: "BLOCK", reason: "UNKNOWN_PHASE:" + phase };
}

/** A trip is worth taking only when the destination really pays more than the origin. */
function worthIt(trip, minIsk = 200000) {
  const revenue = num(trip && trip.expectedIsk);
  return revenue >= Math.max(0, num(minIsk));
}

function note(observe, event, state, extra = {}) {
  try {
    if (typeof observe === "function") observe(event, null, null, {
      haulerID: pos(state && state.haulerID), phase: String((state && state.phase) || ""),
      ...extra,
    });
  } catch (_error) { /* telemetry only */ }
}

// How often the same order may be re-issued while a hull flies to a station.
const ORDER_SPACING_MS = 45000;
// A stop that stays unloaded this long is a stall, not patience (beats, not seconds).
// Measured 2026-10-30: the worst cycle in the ledger took 95 minutes, and a stall bound of 40
// beats with a 45 s beat was half an hour of a loaded hull doing nothing. 20 beats is generous
// for an in-system flight and still bounded.
const MAX_STOP_WAITS = 20;
// How long a finished run rests before it takes another load. Long enough that an operator
// sees the result, short enough that the fleet does not idle away a warehouse of minerals.
const REST_BETWEEN_CYCLES_MS = 2 * 60 * 1000;
// How many loads one hull may carry before the run reports and stops. A cycle that never
// ends is indistinguishable from one that is stuck.
const MAX_TRIPS = 5;
// One hull per budget: a hung market call must not freeze the whole phase.
const HULL_TIMEOUT_MS = 25000;
// How long a blocked run waits before one bounded retry (a slow market, not a bad trip).
const BLOCKED_RETRY_MS = 30 * 60 * 1000;

/**
 * Advance one run by at most one step. Never throws, never guesses: an authority that is
 * missing is a WAIT, and a step that failed is written down with its reason.
 */
async function tick(haulerID, authorities = {}, env = process.env) {
  const id = pos(haulerID);
  if (!id) return { status: "INVALID_ARGUMENT" };
  const now = num(authorities.now) || Date.now();
  const observe = authorities.observe || null;
  let state = read(id, env);
  const planned = decide(state, {});
  // A run in PLAN (a fresh one, or one that just came home) is planned here, once per beat.
  if (!state || String(state.phase || PHASE.PLAN) === PHASE.PLAN) {
    // Nothing planned yet: planning is the authority's job and it must be real.
    if (typeof authorities.planTrip !== "function") return { status: "NO_PLANNER" };
    let trip = null;
    // Planning may read the market: awaiting it keeps a slow answer from becoming NO_TRIP.
    try { trip = await authorities.planTrip({ haulerID: id }); }
    catch (error) { trip = { status: "PLAN_THREW", reason: String((error && error.message) || error).slice(0, 80) }; }
    if (!trip || trip.status !== "OK" || !trip.trip) {
      const why = String((trip && (trip.status || trip.reason)) || "NO_TRIP");
      // No freight HERE is not the end of the work: the corporation may keep its stock in the
      // next system over. Reposition there (the return leg already knows how) and plan again.
      let home = 0;
      try {
        home = typeof authorities.homeSystemFor === "function"
          ? Number(authorities.homeSystemFor({haulerID: id})) || 0 : 0;
      } catch (_error) { home = 0; }
      if (home && home !== num(state && state.hullSystemID) && authorities.recycle === true) {
        const moving = write({ version: 1, haulerID: id, phase: PHASE.RETURN, updatedAt: now,
          trips: num(state && state.trips), isk: num(state && state.isk), returnToSystemID: home,
          lastReason: "REPOSITIONING_FOR_FREIGHT:" + why }, env);
        note(observe, "living-distribution-run", moving, { reason: moving.lastReason });
        return { status: "REPOSITIONING", reason: moving.lastReason, state: moving };
      }
      // Goods still aboard are worth more sold than parked: if the planner refuses because the
      // hold is already full, go and sell what is in it instead of ending the run.
      if (why === "HOLD_ALREADY_FULL") {
        let stationID = 0;
        try {
          stationID = typeof authorities.stationForCargo === "function"
            ? Number(authorities.stationForCargo({haulerID: id})) || 0 : 0;
        } catch (_error) { stationID = 0; }
        const hereSystemID = typeof authorities.hullSystemOf === "function"
          ? Number(authorities.hullSystemOf(id)) || 0 : 0;
        if (stationID) {
          // This path runs before any state exists, so the journal is created here.
          const sell = write({ version: 1, ...(state || {}), haulerID: id, phase: PHASE.SELL,
            updatedAt: now, toStationID: stationID, toSystemID: hereSystemID,
            sellCalls: 0, pendingSince: 0, lastReason: "LIQUIDATING_LEFTOVERS" }, env);
          note(observe, "living-distribution-run", sell, { reason: sell.lastReason });
          return { status: "LIQUIDATING", state: sell };
        }
        // Nothing here buys it, but a neighbour may. Measured 2026-10-30: ore carried in New
        // Caldari had no local buyer while Jita, one gate away, bid 4 035 826 units for it.
        // The cargo crosses first, then the ordinary TO_DEST/SELL legs take over.
        let buyer = null;
        try {
          buyer = typeof authorities.buyerForCargo === "function"
            ? authorities.buyerForCargo({haulerID: id}) : null;
        } catch (_error) { buyer = null; }
        const buyerSystemID = Number(buyer && buyer.systemID) || 0;
        if (buyer && Number(buyer.stationID) > 0 && buyerSystemID &&
          buyerSystemID !== hereSystemID) {
          let crossing = null;
          try {
            crossing = typeof authorities.planCrossingTo === "function"
              ? authorities.planCrossingTo({haulerID: id, targetSystemID: buyerSystemID}) : null;
          } catch (_error) { crossing = null; }
          const planned = Boolean(crossing && (crossing.status === "PLANNED" ||
            crossing.status === "ALREADY_PENDING"));
          if (planned) {
            const moving = write({ version: 1, ...(state || {}), haulerID: id, phase: PHASE.CROSS,
              updatedAt: now, toStationID: Number(buyer.stationID), toSystemID: buyerSystemID,
              sellCalls: 0, pendingSince: 0, lastReason: "LIQUIDATING_ACROSS:" + buyerSystemID },
              env);
            note(observe, "living-distribution-run", moving, { reason: moving.lastReason });
            return { status: "LIQUIDATING_ACROSS", state: moving };
          }
        }
      }
      // Nothing worth SHIPPING is not nothing worth doing: stock that no station bids for is
      // exactly the material a new blueprint can turn into something that sells. Buy one where
      // the stock sits, once per run, before the hull stops.
      if (!state || state.blueprintTried !== true) {
        let stationID = 0;
        try {
          stationID = typeof authorities.stockStationFor === "function"
            ? Number(authorities.stockStationFor({haulerID: id})) || 0 : 0;
        } catch (_error) { stationID = 0; }
        if (stationID && typeof authorities.buyBlueprint === "function") {
          // The trader only trades through a hull that is AT the station (measured 2026-10-31:
          // TOO_FAR_FROM_STATION). Fly there first, buy on the beat that arrives.
          const gap = typeof authorities.distanceTo === "function"
            ? authorities.distanceTo(stationID, buzzSystemID(), id) : null;
          if (Number.isFinite(gap) && gap > STATION_RANGE_M) {
            let flying = false;
            try { flying = typeof authorities.goTo === "function" &&
              authorities.goTo(stationID, id) === true; } catch (_error) { flying = false; }
            const moving = write({ ...state, updatedAt: now, buyStationID: stationID,
              lastReason: flying ? "FLYING_TO_BUY_BLUEPRINT" : "BUY_STATION_UNREACHABLE" }, env);
            note(observe, "living-distribution-run", moving, { reason: moving.lastReason });
            return { status: flying ? "BUY_FLIGHT" : "BUY_UNREACHABLE", state: moving };
          }
          if (state) write({ ...state, blueprintTried: true, updatedAt: now }, env);
          let bought = null;
          try {
            bought = await authorities.buyBlueprint({haulerID: id, stationID,
              systemID: typeof authorities.hullSystemOf === "function"
                ? Number(authorities.hullSystemOf(id)) || 0 : 0});
          } catch (_error) { bought = null; }
          if (bought) note(observe, "living-distribution-blueprint", state || {haulerID: id},
            {reason: String(bought.status || (bought.bought && (bought.bought.status + ":" + String(bought.bought.reason || ""))) || bought.reason || "").slice(0, 120)});
        }
      }
      // A second cycle that finds nothing worth shipping is the honest end of the run:
      // leaving it in PLAN would re-ask the market every beat for ever.
      if (num(state && state.trips) > 0 || authorities.recycle === true) {
        const done = { version: 1, haulerID: id, phase: PHASE.DONE, lastReason: why,
          updatedAt: now, trips: num(state && state.trips), isk: num(state && state.isk) };
        write(done, env);
        note(observe, "living-distribution-run", done, { reason: why });
        return { status: "DONE", reason: why };
      }
      return { status: why, planned: planned.action };
    }
    const row = trip.trip;
    if (!worthIt(row, authorities.minIsk) && authorities.allowSmallTrips !== true) {
      const refused = { version: 1, haulerID: id, phase: PHASE.BLOCKED,
        lastReason: "TRIP_DOES_NOT_PAY:" + num(row.expectedIsk), updatedAt: now,
        trip: row };
      write(refused, env);
      note(observe, "living-distribution-run", refused, { reason: refused.lastReason });
      return { status: "BLOCKED", reason: refused.lastReason };
    }
    // One trip may load at more than one station: the bundle picks each stack where it really
    // sits, so the run walks the stops in order instead of pretending one station holds it all.
    const stops = [];
    for (const item of (Array.isArray(row.items) ? row.items : [])) {
      const stationID = pos(item.stationID);
      if (!stationID) continue;
      const current = stops.find((stop) => stop.stationID === stationID);
      if (current) current.items.push(item);
      else stops.push({ stationID, items: [item] });
    }
    if (!stops.length && pos(row.fromStationID))
      stops.push({ stationID: pos(row.fromStationID), items: [] });
    state = write({ version: 1, haulerID: id, phase: PHASE.TO_ORIGIN, trip: row,
      cycles: num(state && state.cycles), trips: 0,
      stops, stopIndex: 0, loadedStops: [],
      // The pure planner calls the origin simply stationID; one name, one meaning.
      fromStationID: pos(row.fromStationID) || pos(row.stationID),
      fromSystemID: pos(row.fromSystemID),
      toStationID: pos(row.toStationID), toSystemID: pos(row.toSystemID),
      typeID: pos(row.typeID), quantity: num(row.quantity), expectedIsk: num(row.expectedIsk),
      gate: row.gate || null, sellCalls: 0, isk: 0, lastReason: "PLANNED", updatedAt: now }, env);
    note(observe, "living-distribution-run", state, { reason: state.lastReason });
    return { status: "PLANNED", state };
  }

  // A durable hull can outlive its scene (a restart rebuilds it). Bringing the same ship
  // back from its own record is the narrow road; anything else stays undispatched.
  if (typeof authorities.ensureLive === "function") {
    let live = false;
    try { live = authorities.ensureLive(id) === true; } catch (_error) { live = false; }
    if (!live) {
      const misses = num(state.liveMisses) + 1;
      const phase = misses >= 5 ? PHASE.BLOCKED : phase2(state.phase);
      const next = write({ ...state, liveMisses: misses, phase,
        lastReason: misses >= 5 ? "HULL_NOT_LIVE" : "WAITING_FOR_HULL",
        updatedAt: now }, env);
      note(observe, "living-distribution-run", next, { reason: next.lastReason });
      return { status: next.lastReason, state: next };
    }
    if (num(state.liveMisses) > 0) state = write({ ...state, liveMisses: 0 }, env);
  }
  // The stop being served right now (a trip may load at several stations).
  const stops = Array.isArray(state.stops) && state.stops.length ? state.stops
    : [{ stationID: state.fromStationID, items: [] }];
  const stopIndex = Math.min(Math.max(0, num(state.stopIndex)), stops.length - 1);
  const stop = stops[stopIndex] || { stationID: state.fromStationID, items: [] };
  const buzzSystemID = () => (typeof authorities.hullSystemOf === "function"
    ? Number(authorities.hullSystemOf(id)) || 0
    : Number(state && state.hullSystemID) || 0);
  const facts = {
    distanceToOriginM: typeof authorities.distanceTo === "function"
      ? authorities.distanceTo(stop.stationID, state.fromSystemID, id) : null,
    distanceToDestinationM: typeof authorities.distanceTo === "function"
      ? authorities.distanceTo(state.toStationID, state.toSystemID, id) : null,
    crossingPhase: typeof authorities.crossingPhase === "function"
      ? authorities.crossingPhase(id) : null,
    hullSystemID: typeof authorities.hullSystemOf === "function"
      ? Number(authorities.hullSystemOf(id)) || 0 : 0,
  };
  // A run blocked by an environment refusal (call limit, settlement timeout) is not a bad
  // trip: after a long cooldown it may try once more, bounded by retries so it cannot spin.
  // A finished run rests, then starts again while recycling is on.
  if (String(state.phase) === PHASE.DONE && authorities.recycle === true &&
    now - num(state.updatedAt) > REST_BETWEEN_CYCLES_MS) {
    const fresh = { version: 1, haulerID: id, phase: PHASE.PLAN, updatedAt: now,
      isk: num(state.isk), cycles: num(state.cycles) + 1, lastReason: "RESTED" };
    write(fresh, env);
    note(observe, "living-distribution-run", fresh, { reason: "RESTED" });
    return { status: "RESTED", state: fresh };
  }
  if (String(state.phase) === PHASE.BLOCKED && num(state.retries) < 2 &&
    num(state.blockedAt) > 0 && now - num(state.blockedAt) > BLOCKED_RETRY_MS &&
    typeof authorities.cargoUnits === "function" && Number(authorities.cargoUnits(id)) > 0) {
    const again = write({ ...state, phase: PHASE.SELL, updatedAt: now, sellCalls: 0,
      pendingSince: 0, retries: num(state.retries) + 1,
      lastReason: "RETRY_AFTER_COOLDOWN" }, env);
    note(observe, "living-distribution-run", again, { reason: again.lastReason });
    return { status: "RETRYING", state: again };
  }
  // A hold is not a warehouse. Whenever this hull is physically at the corporation's own
  // loading station, what only belongs on a shelf (a blueprint bought in space) goes on the
  // shelf - independently of what the run is doing, because a run with no profitable trip
  // never reaches a LIFT step and would leave the asset in the hold for ever.
  if (typeof authorities.stow === "function" && pos(state.fromStationID)) {
    let near = null;
    try {
      near = typeof authorities.distanceTo === "function"
        ? authorities.distanceTo(pos(state.fromStationID), pos(state.fromSystemID), id) : null;
    } catch (_error) { near = null; }
    if (Number.isFinite(near) && near <= STATION_RANGE_M) {
      let stored = null;
      try { stored = authorities.stow({ haulerID: id, stationID: pos(state.fromStationID) }); }
      catch (_error) { stored = null; }
      if (stored && stored.status === "STOWED") {
        const moved = (stored.stowed || []).filter((row) => row.status === "STOWED");
        const now2 = write({ ...state, updatedAt: now,
          lastReason: "STOWED:" + moved.map((row) => row.typeID).join(",") }, env);
        note(observe, "living-distribution-run", now2, { reason: now2.lastReason });
        state = now2;
      } else if (stored && stored.status && stored.status !== "NOTHING_TO_STOW") {
        // A refusal that says nothing is the same as no attempt: name every one of them.
        note(observe, "living-distribution-stow", state,
          { reason: String(stored.status).slice(0, 60), stationID: pos(state.fromStationID) });
      }
    }
  }
  // Import phase: buy what the factory lacks at the station that really sells it, bounded, then
  // go home where the hold stows into the hangar and the manufacturer can finally run.
  if (String(state.phase) === PHASE.SUPPLY && typeof authorities.buyInputs === "function") {
    let answer = null;
    try {
      answer = await authorities.buyInputs({ haulerID: id, stationID: pos(state.toStationID),
        systemID: pos(state.toSystemID) });
    } catch (_error) { answer = { status: "BUY_THREW" }; }
    const status = String(answer && answer.status || "NO_ANSWER");
    const tries = num(state.supplyTries) + 1;
    if ((status === "BOUGHT" || status === "COOLDOWN") && tries < MAX_SUPPLY_TRIES) {
      const waiting = write({ ...state, phase: PHASE.SUPPLY, supplyTries: tries, updatedAt: now,
        lastReason: status === "BOUGHT"
          ? "SUPPLIED:" + num(answer.typeID) + "x" + num(answer.quantity)
          : "SUPPLY_COOLDOWN" }, env);
      note(observe, "living-distribution-run", waiting, { reason: waiting.lastReason });
      return { status: waiting.lastReason, state: waiting };
    }
    const reason = status === "BOUGHT" || status === "NOTHING_TO_BUY" || status === "COOLDOWN"
      ? "SUPPLIED_ALL" : "SUPPLY_STOPPED:" + status.slice(0, 40);
    const home = write({ ...state, phase: PHASE.RETURN, supplyTries: 0, updatedAt: now,
      lastReason: reason, crossAt: 0, returnToSystemID: pos(state.fromSystemID),
      returnStationID: pos(state.fromStationID) }, env);
    note(observe, "living-distribution-run", home, { reason });
    return { status: "RETURN", reason, state: home };
  }  const step = decide(state, facts);
  const finish = (phase, reason, extra = {}) => {
    const stamp = phase === PHASE.BLOCKED ? { blockedAt: now } : {};
    const next = write({ ...state, ...stamp, ...extra, phase, lastReason: reason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason });
    return { status: phase, reason, state: next };
  };

  if (step.action === "BLOCK") return finish(PHASE.BLOCKED, String(step.reason || "BLOCKED"));
  if (step.action === "WAIT") return { status: "WAITING", reason: step.reason, state };
  if (step.action === "PLAN") return { status: "PLAN_REQUIRED" };

  if (step.action === "GO_ORIGIN" || step.action === "GO_DEST") {
    const stationID = step.action === "GO_ORIGIN" ? (stop.stationID || state.fromStationID)
      : state.toStationID;
    // A hull that keeps being ordered to a station is not "flying": it may not be moving at
    // all. Measured 2026-10-30: four hulls reported FLYING_TO_ORIGIN for over half an hour and
    // loaded nothing. The wait is counted per stop, reported with the distance we actually
    // measured, and finally given up on - a phase that looks healthy for ever is a lie.
    const waits = num(state.stopWaits) + 1;
    if (waits % 5 === 0) {
      note(observe, "living-distribution-run-waiting", {
        haulerID: id, phase: state.phase, stop: stationID, waits,
        distanceM: facts.distanceToOriginM === null ? null : Math.round(facts.distanceToOriginM),
        hullSystemID: facts.hullSystemID || 0, toSystemID: state.fromSystemID || 0});
    }
    if (waits >= MAX_STOP_WAITS) {
      return finish(PHASE.BLOCKED, "STALLED_AT_STOP:" + stationID,
        {stopWaits: waits, distanceM: facts.distanceToOriginM});
    }
    state = write({ ...state, stopWaits: waits, updatedAt: now }, env);
    // "Never ordered" is not "ordered just now": a run starts with no timestamp at all.
    if (num(state.orderAt) > 0 && now - num(state.orderAt) < ORDER_SPACING_MS)
      return { status: "FLYING", state };
    let issued = false;
    try { issued = typeof authorities.goTo === "function" && authorities.goTo(stationID, id) === true; }
    catch (_error) { issued = false; }
    const reason = issued ? (step.action === "GO_ORIGIN" ? "FLYING_TO_ORIGIN" : "FLYING_TO_DESTINATION")
      : "ORDER_REFUSED";
    const next = write({ ...state, orderAt: now, lastReason: reason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason });
    return { status: issued ? "ORDERED" : "ORDER_REFUSED", reason, state: next };
  }

  if (step.action === "LIFT") {
    if (typeof authorities.lift !== "function") return { status: "NO_LIFT" };
    // A hold is not a warehouse. Anything the corporation bought in space (the measured case:
    // the Miner I Blueprint bought for 92 720 ISK on 2026-10-31) has to reach the hangar before
    // it can be built from, so every loading stop first stows what only belongs on a shelf.
    if (typeof authorities.stow === "function") {
      let stored = null;
      try { stored = authorities.stow({ haulerID: id, stationID: stop.stationID }); }
      catch (_error) { stored = null; }
      if (stored && stored.status === "STOWED") {
        const moved = (stored.stowed || []).filter((row) => row.status === "STOWED");
        note(observe, "living-distribution-run", state,
          { reason: "STOWED:" + moved.map((row) => row.typeID).join(",") });
      } else if (stored && stored.status && stored.status !== "NOTHING_TO_STOW") {
        note(observe, "living-distribution-stow", state,
          { reason: String(stored.status).slice(0, 60), stationID: stop.stationID });
      }
    }
    // Buy a blueprint where the hull LOADS: that is the station the corporation keeps its
    // materials at, so a new blueprint can be built at once instead of needing a second haul.
    if (!state.blueprintTried && typeof authorities.buyBlueprint === "function") {
      state = write({ ...state, blueprintTried: true, updatedAt: now }, env);
      let bought = null;
      try {
        bought = await authorities.buyBlueprint({haulerID: id, stationID: stop.stationID,
          systemID: state.fromSystemID});
      } catch (_error) { bought = null; }
      if (bought) note(observe, "living-distribution-blueprint", state,
        {reason: String(bought.status || (bought.bought && (bought.bought.status + ":" + String(bought.bought.reason || ""))) || bought.reason || "").slice(0, 120)});
    }
    let answer = null;
    // The demand of THIS stop only: the types that really sit at this station.
    const stopDemand = {};
    for (const item of stop.items) {
      stopDemand[pos(item.typeID)] = {price: num(item.price), volume: num(item.quantity)};
    }
    const demand = Object.keys(stopDemand).length ? stopDemand
      : (state.demand || (state.trip && state.trip.demand) || null);
    try { answer = await authorities.lift({ haulerID: id, stationID: stop.stationID,
      systemID: state.fromSystemID, demand,
      cap: state.quantity || authorities.capacityM3 || 1e6,
      capM3: typeof authorities.capacityM3 === "function" ? authorities.capacityM3(id) : 0 }); }
    catch (error) { answer = { status: "LIFT_THREW", reason: String((error && error.message) || error).slice(0, 80) }; }
    const status = String((answer && answer.status) || "LIFT_UNKNOWN");
    // A stop whose goods moved away must not kill a trip that has already loaded elsewhere.
    // Measured 2026-10-30: two hulls were refused NO_LOCAL_BID at their second stop and the
    // whole journey stopped with one stop's cargo still aboard.
    const EMPTY_STOP = new Set(["NO_LOCAL_BID", "NO_MINERAL_STOCK", "STACK_CHANGED",
      "DOES_NOT_FIT_HOLD"]);
    if (status !== "LIFTED" && EMPTY_STOP.has(status)) {
      const skippedStops = [...(state.skippedStops || []), {stationID: stop.stationID,
        status}];
      const nextEmpty = stopIndex + 1;
      if (nextEmpty < stops.length) {
        const moving = write({ ...state, phase: PHASE.TO_ORIGIN, stopIndex: nextEmpty,
          stopWaits: 0, orderAt: 0, skippedStops,
          lastReason: "EMPTY_STOP:" + stop.stationID + ":" + status, updatedAt: now }, env);
        note(observe, "living-distribution-run", moving, { reason: moving.lastReason });
        return { status: "EMPTY_STOP", state: moving };
      }
      // Nothing left to load anywhere: if the hull carries anything at all, fly and sell it.
      const aboard = typeof authorities.cargoUnits === "function" ? authorities.cargoUnits(id) : 0;
      if (!(Number(aboard) > 0)) {
        return finish(PHASE.BLOCKED, "NO_CARGO_AT_ANY_STOP", {skippedStops});
      }
      let crossing = null;
      try {
        crossing = typeof authorities.planCrossing === "function"
          ? authorities.planCrossing({haulerID: id, gate: state.gate}) : null;
      } catch (_error) { crossing = null; }
      const ok = Boolean(crossing && (crossing.status === "PLANNED" ||
        crossing.status === "ALREADY_PENDING"));
      if (!ok) return finish(PHASE.BLOCKED, "CROSSING_UNPLANNED", {skippedStops});
      return finish(PHASE.CROSS, "LOADED_PARTIAL", {skippedStops, quantity: num(state.quantity),
        lifted: state.liftedAll || state.lifted || []});
    }
    if (status !== "LIFTED") return finish(PHASE.BLOCKED, status);
    const lifted = Array.isArray(answer.lifted) ? answer.lifted : [];
    const quantity = lifted.reduce((sum, row) => sum + num(row.quantity), 0);
    const loadedStops = [...(state.loadedStops || []), stop.stationID];
    const nextIndex = stopIndex + 1;
    if (nextIndex < stops.length) {
      // Another station holds part of this load: go there before leaving the system.
      const moving = write({ ...state, phase: PHASE.TO_ORIGIN, stopIndex: nextIndex, stopWaits: 0,
        loadedStops, liftedAll: [...(state.liftedAll || []), ...lifted], orderAt: 0,
        lastReason: "LOADED_STOP:" + stop.stationID, updatedAt: now },
        env);
      note(observe, "living-distribution-run", moving, { reason: moving.lastReason });
      return { status: "NEXT_STOP", state: moving };
    }
    // The crossing is planned by the loop's own gate machinery, not by this module.
    let crossing = null;
    try {
      crossing = typeof authorities.planCrossing === "function"
        ? authorities.planCrossing({ haulerID: id, gate: state.gate }) : null;
    } catch (error) { crossing = { status: "CROSSING_PLAN_THREW" }; }
    const plannedOk = Boolean(crossing && (crossing.status === "PLANNED" ||
      crossing.status === "ALREADY_PENDING"));
    if (!plannedOk) {
      return finish(PHASE.BLOCKED, "CROSSING_" + String((crossing && (crossing.status || crossing.reason)) || "UNPLANNED"),
        { lifted, quantity });
    }
    // Every stop's cargo, accumulated: measured 2026-10-30 the ledger reported "lines: 1" for
    // trips that really loaded at four stations, because only the LAST lift was kept.
    const liftedAll = [...(state.liftedAll || []), ...lifted];
    return finish(PHASE.CROSS, "LOADED", { lifted: liftedAll, liftedAll,
      quantity: liftedAll.reduce((sum, row) => sum + num(row.quantity), 0),
      loadedAt: now });
  }

  if (step.action === "TO_DEST") return finish(PHASE.TO_DEST, "CROSSED");

  if (step.action === "SELL") {
    // The empty hold is proof enough and needs no market at all, so it is asked FIRST.
    const held = typeof authorities.cargoUnits === "function" ? authorities.cargoUnits(id) : null;
    if (Number.isFinite(held) && held === 0 && (num(state.quantity) > 0 || num(state.isk) > 0)) {
      // The goods are gone, but this is NOT a payment row: measured 2026-10-30 the ledger got
      // rows from here that no settlement could ever back, and the cross-check called it out.
      // The run records the delivery in its own journal instead.
      // ...and the same hull is the one that can carry the factory's inputs home.
      if (typeof authorities.buyInputs === "function" &&
        num(state.supplyTries) < MAX_SUPPLY_TRIES) {
        const importing = write({ ...state, phase: PHASE.SUPPLY, supplyTries: 0, updatedAt: now,
          soldAt: now, lastReason: "IMPORTING_INPUTS", pendingSince: 0 }, env);
        note(observe, "living-distribution-run", importing, { reason: importing.lastReason });
        return { status: "IMPORTING", state: importing };
      }
      return finish(PHASE.DONE, "SOLD_VERIFIED_BY_HOLD", { soldAt: now, iskUnknown: true });
    }
    if (typeof authorities.sell !== "function") return { status: "NO_SELL" };
    // The settled answer is only readable for about five seconds after it lands (the drain
    // polls every 3 s for exactly this reason), so a run that asks once a minute can never
    // see it. Measured 2026-10-30: six calls in an hour, every one PENDING, cargo untouched.
    const wait = typeof authorities.wait === "function" ? authorities.wait
      : (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
    // A hull that drifted away (or was rebuilt out of its scene) cannot sell: measured
    // 2026-10-30 the market answered NOT_AT_NATIVE_STATION while the run believed the hull
    // was at the station because the phase said so. Fly again instead of asking.
    const atStation = typeof authorities.distanceTo === "function"
      ? authorities.distanceTo(state.toStationID, state.toSystemID, id) : null;
    if (Number.isFinite(atStation) && atStation > STATION_RANGE_M) {
      return finish(PHASE.TO_DEST, "NOT_AT_STATION");
    }
    // The market fills in bounded settlements (MAX_SELL_QTY is 100 000 here), so the budget
    // grows with the load instead of stopping a real haul at a fixed number of calls.
    const load = Math.max(num(state.quantity), num(state.cargoUnits));
    const callBudget = Math.max(MAX_SELL_CALLS, Math.ceil(load / 100000) + 2);
    let calls = num(state.sellCalls);
    let isk = num(state.isk);
    let settled = null;
    let lastReason = "PENDING";
    // A hold that is empty is the strongest proof there is: the goods really left the ship.
    const cargoNow = typeof authorities.cargoUnits === "function" ? authorities.cargoUnits(id) : null;
    if (Number.isFinite(cargoNow) && cargoNow === 0 && (num(state.quantity) > 0 || num(state.isk) > 0)) {
      // The empty hold proves the goods left; it does NOT prove the amount paid, so the ISK is
      // recorded as unknown rather than as a misleading zero.
      return finish(PHASE.DONE, "SOLD_VERIFIED_BY_HOLD", { soldAt: now, sellCalls: calls, iskUnknown: true });
    }
    for (let attempt = 0; attempt < MAX_POLLS_PER_BEAT && !settled && calls < callBudget;
      attempt += 1) {
      let answer = null;
      try {
        answer = await authorities.sell({ haulerID: id, stationID: state.toStationID,
          systemID: state.toSystemID });
      } catch (error) {
        answer = { status: "SALE_THREW", reason: String((error && error.message) || error).slice(0, 80) };
      }
      const status = String((answer && answer.status) || "SALE_UNKNOWN");
      // The budget counts SETTLED attempts, not polls: measured 2026-10-30, four PENDING polls
      // per beat burned the whole budget while the market was simply slow, and two hulls were
      // blocked SALE_STOPPED:CALL_LIMIT with their cargo still aboard.
      if (status === "SOLD") {
        calls += 1;
        settled = { status: "SOLD", isk: num(answer && answer.isk) };
        break;
      }
      if (status === "NOT_SOLD") {
        calls += 1;
        settled = { status: "NOT_SOLD", reason: String((answer && answer.reason) || "") };
        break;
      }
      if (status === "SALE_THREW") { lastReason = String((answer && answer.reason) || status); break; }
      // PENDING: the job is running. The settled answer is dropped about five seconds after it
      // lands, so waiting a whole cooldown-sized beat before looking (6 s) MISSED it - that is
      // exactly why four of nine trips recorded no price. Read the settlement itself, often,
      // and only ask the market again once those reads are exhausted.
      for (let read = 0; read < SALE_SETTLEMENT_READS && !settled; read += 1) {
        await wait(SALE_SETTLEMENT_READ_MS);
        const proof = typeof authorities.saleSettlement === "function"
          ? authorities.saleSettlement(id, state.toStationID) : null;
        if (proof && proof.status) settled = proof;
      }
      if (!settled) lastReason = "SALE_PENDING";
    }
    if (settled && settled.status === "SOLD") {
      const paid = isk + num(settled.isk);
      // A hull standing at the buyer's station is the one place a blueprint can be bought (the
      // native trader needs a real ship there). One attempt per trip, and only when the world
      // says the purchase feature is on - the decision itself is coopBlueprintPurchase.choose.

      // The market fills in bounded settlements, so a load can be sold in parts. Measured
      // 2026-10-30: 37 428 units settled while 35 629 stayed aboard, and the run went home
      // with them. A trip ends when the HOLD is empty, not when one settlement says SOLD.
      const leftAboard = typeof authorities.cargoUnits === "function" ? authorities.cargoUnits(id) : null;
      if (Number.isFinite(leftAboard) && leftAboard > 0) {
        const next = write({ ...state, phase: PHASE.SELL, sellCalls: calls, isk: paid,
          pendingSince: 0, lastReason: "PARTIALLY_SOLD:" + leftAboard, updatedAt: now }, env);
        note(observe, "living-distribution-run", next, { reason: next.lastReason });
        return { status: "PARTIALLY_SOLD", state: next };
      }
      const trips = num(state.trips) + 1;
      const settlement = { quantity: num(settled.quantity), isk: num(settled.isk), at: now,
        status: "SOLD" };
      appendFreight(state, settlement, env);
      // A hull that sits in the buyer system with an empty hold is dead freight: it goes home
      // and takes another load, bounded by a trip count so a cycle cannot run for ever.
      // The corporation imports what this system cannot make: measured 2026-10-31 the refinery
      // here only ever saw Veldspar (`refined 17471 -> 1 mineral`), so the Pyerite and Mexallon
      // the factory needs exist only at a station that really sells them. A hull standing at the
      // buyer's station with an empty hold is exactly the ship that can carry them home.
      if (typeof authorities.buyInputs === "function" &&
        num(state.supplyTries) < MAX_SUPPLY_TRIES) {
        const buying = write({ ...state, phase: PHASE.SUPPLY, sellCalls: 0, isk: paid, trips,
          settlement, soldAt: now, pendingSince: 0, supplyTries: 0,
          lastReason: "IMPORTING_INPUTS", updatedAt: now }, env);
        note(observe, "living-distribution-run", buying, { reason: buying.lastReason });
        return { status: "IMPORTING", state: buying };
      }
      if (authorities.recycle !== true || trips >= MAX_TRIPS) {
        return finish(PHASE.DONE, "SOLD", { isk: paid, sellCalls: calls, soldAt: now,
          trips, settlement });
      }
      return finish(PHASE.RETURN, "SOLD_RETURNING", { isk: paid, sellCalls: 0, trips,
        settlement, soldAt: now, pendingSince: 0, crossAt: 0,
        returnToSystemID: pos(state.fromSystemID), returnStationID: pos(state.fromStationID) });
    }
    if (settled && settled.status === "NOT_SOLD") {
      const why = String(settled.reason || "").slice(0, 50);
      // A refusal that only says "not yet" is not an answer: the hull is being rebuilt,
      // the market daemon is away, or the visit timed out. Those retry; a real refusal stops.
      // Anything the world reports as BUSY is "not yet", whatever its exact spelling: measured
      // 2026-10-30 NATIVE_NPC_BUSY and TRADE_BUSY in the same afternoon, each blocking a loaded
      // hull until an operator reset it.
      const whyText = String(settled.reason || "");
      const retryable = SALE_RETRYABLE.has(whyText) || /_BUSY$/.test(whyText) ||
        /IN_FLIGHT$/.test(whyText);
      // An empty hold means the trip is over: measured 2026-10-31 a hull blocked here for good
      // after its cargo had already left.
      if (String(settled.reason || "") === "NO_REAL_NATIVE_CARGO") {
        return finish(PHASE.DONE, "SOLD_VERIFIED_BY_HOLD", { soldAt: now, sellCalls: calls, isk });
      }
      if (!retryable) {
        return finish(PHASE.BLOCKED, "SALE_NOT_SOLD:" + why, { sellCalls: calls, isk });
      }
      const since = num(state.pendingSince) || now;
      if (now - since > SALE_SETTLE_TIMEOUT_MS) {
        return finish(PHASE.BLOCKED, "SALE_NOT_SOLD:" + why, { sellCalls: calls, isk });
      }
      const next = write({ ...state, phase: PHASE.SELL, pendingSince: since,
        sellCalls: calls, isk, lastReason: "WAITING_FOR_SALE:" + why, updatedAt: now }, env);
      return { status: "WAITING_FOR_SALE", reason: why, state: next };
    }
    // A big load needs more than a fixed handful of settlements: the market fills at most
    // MAX_SELL_QTY per call, so the budget grows with the load.
    if (calls >= callBudget) {
      return finish(PHASE.BLOCKED, "SALE_STOPPED:CALL_LIMIT", {sellCalls: calls, isk, callBudget});
    }
    const since = num(state.pendingSince) || now;
    if (now - since > SALE_SETTLE_TIMEOUT_MS) {
      return finish(PHASE.BLOCKED, "SALE_SETTLE_TIMEOUT", { pendingSince: since, sellCalls: calls });
    }
    const next = write({ ...state, phase: PHASE.SELL, pendingSince: since,
      sellCalls: calls, isk, lastReason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason: lastReason });
    return { status: "SALE_PENDING", reason: lastReason, state: next };
  }

  if (step.action === "REPLAN") {
    // The next beat plans a new trip; only the identity of the run survives.
    const fresh = { version: 1, haulerID: id, phase: PHASE.PLAN, updatedAt: now,
      trips: num(state.trips), isk: num(state.isk), lastReason: "HOME_AGAIN" };
    write(fresh, env);
    note(observe, "living-distribution-run", fresh, { reason: "HOME_AGAIN" });
    return { status: "REPLANNING", state: fresh };
  }
  if (step.action === "RETURN_CROSS") {
    if (num(state.crossAt) > 0 && now - num(state.crossAt) < ORDER_SPACING_MS)
      return { status: "RETURNING", state };
    let plannedCrossing = null;
    try {
      plannedCrossing = typeof authorities.planCrossingTo === "function"
        ? authorities.planCrossingTo({haulerID: id, targetSystemID: state.returnToSystemID,
          operatorKind: authorities.operatorKind}) : null;
    } catch (_error) { plannedCrossing = null; }
    const plannedOk = Boolean(plannedCrossing && (plannedCrossing.status === "PLANNED" ||
      plannedCrossing.status === "ALREADY_PENDING"));
    const reason = plannedOk ? "RETURN_CROSSING_PLANNED"
      : "RETURN_NO_GATE:" + String((plannedCrossing && (plannedCrossing.status || plannedCrossing.reason)) || "UNPLANNED");
    const next = write({ ...state, crossAt: now, lastReason: reason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason });
    return { status: plannedOk ? "RETURN_CROSSING" : "RETURN_NO_GATE", reason, state: next };
  }
  return { status: "IDLE", reason: step.reason || null, state };
}


/** Advance every distribution hull the world has. One hull, one trip, one truth. */
async function tickAll(authorities = {}, env = process.env) {
  const hulls = typeof authorities.hulls === "function" ? authorities.hulls() : [];
  const results = [];
  // One hull must never stall the others: a market call that never answers would otherwise
  // keep the whole phase marked in flight for ever (measured 2026-10-30: no run event for
  // minutes while three hulls waited behind one hung promise).
  const budget = Math.max(1000, Number(authorities.hullTimeoutMs) || HULL_TIMEOUT_MS);
  for (const haulerID of Array.isArray(hulls) ? hulls : []) {
    try {
      const answer = await Promise.race([
        tick(haulerID, authorities, env),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ status: "HULL_TIMEOUT" }), budget);
          if (timer && typeof timer.unref === "function") timer.unref();
        }),
      ]);
      const outcome = answer || { status: "NO_ANSWER" };
      // A hull that times out must not look busy for ever: measured 2026-10-31 two hulls sat in
      // SELL for 21 minutes with nothing written, because every beat hit the per-hull budget.
      if (String(outcome.status) === "HULL_TIMEOUT") {
        const current = read(haulerID, env);
        if (current) {
          const timeouts = num(current.timeouts) + 1;
          const next = timeouts >= 3
            ? { ...current, phase: PHASE.BLOCKED, timeouts, blockedAt: Date.now(),
                lastReason: "HULL_TIMEOUT_THREE_TIMES" }
            : { ...current, timeouts, lastReason: "HULL_TIMEOUT" };
          write(next, env);
          note(authorities.observe, "living-distribution-run", next,
            { reason: next.lastReason });
          outcome.timeouts = timeouts;
        }
      } else if (num((read(haulerID, env) || {}).timeouts) > 0) {
        const current = read(haulerID, env);
        write({ ...current, timeouts: 0 }, env);
      }
      results.push({ haulerID, ...outcome });
    } catch (error) {
      results.push({ haulerID, status: "THREW",
        reason: String((error && error.message) || error).slice(0, 90) });
    }
  }
  return results;
}
module.exports = { REST_BETWEEN_CYCLES_MS, SALE_SETTLEMENT_READ_MS, SALE_SETTLEMENT_READS, MAX_STOP_WAITS, freightLedgerFile, appendFreight, PHASE, MAX_TRIPS, HULL_TIMEOUT_MS, BLOCKED_RETRY_MS, STATION_RANGE_M, MAX_SELL_CALLS, SALE_SETTLE_TIMEOUT_MS,
  SALE_POLL_MS, MAX_POLLS_PER_BEAT, SALE_RETRYABLE, ORDER_SPACING_MS, root, fileFor,
  read, write, list, decide, worthIt, note, tick, tickAll };
