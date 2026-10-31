"use strict";
/**
 * ALIFE-17. The manufacturer had no caller.
 *
 * space/coopNpcManufacture.js does the real work (native SDE recipe, native inventory
 * primitives, exactly-once durable journal), but nothing in the server ever called it:
 * measured 2026-10-28 the server source contained ZERO references to it, so every job in
 * /var/lib/evejs/coop-native-industry came from scripts/manufacture-npc-item.cjs run by
 * hand, and an INSTALLED job could never complete on its own because tick() was never
 * called in-world.
 *
 * This is the caller, and it adds the one rule the economy needs: PRODUCE ONLY WHAT A
 * STATION REALLY BIDS FOR. A good that nobody buys is not production, it is a hangar
 * pile - the mining fleet can already hold 891 702 units of minerals that no local
 * station buys. So a job is installed only when
 *   - the corporation really owns the blueprint ITEM at that station,
 *   - the materials are physically in that station's hangar,
 *   - a seeded bid exists at that station for the product, at or above the floor,
 *   - and the product already held + in flight does not cover that bid volume.
 *
 * Default OFF (EVEJS_COOP_NPC_MANUFACTURE=1 enables it, the same flag the module checks).
 */

const FLAG = "EVEJS_COOP_NPC_MANUFACTURE";
const CORP_FLAG = "EVEJS_COOP_FACTORY_CORP_ID";
const DEFAULT_CORP_ID = 1000129;
const RUNS_FLAG = "EVEJS_COOP_NPC_MANUFACTURE_RUNS";
const MAX_RUNS_FLAG = "EVEJS_COOP_NPC_MANUFACTURE_MAX_RUNS";
const PRICE_FLOOR_FLAG = "EVEJS_COOP_NPC_MANUFACTURE_MIN_PRICE";
const REGION_FLAG = "EVEJS_COOP_NPC_MARKET_REGION";
const DEFAULT_REGION = 10000002;
const THROTTLE_MS = 5 * 60 * 1000;
const DEFAULT_MARKET_TIMEOUT_MS = 15000;
const DEFAULT_MIN_INPUT_RATIO = 0.1;
// Only judge when the inputs have a real value: a material nobody bids for is valued at
// zero, and zero must never be read as "this recipe is trivial".
function isTrivialRecipe({materialValue, productValue, minRatio = DEFAULT_MIN_INPUT_RATIO} = {}) {
  if (!(materialValue > 0)) return false;
  if (!(productValue > 0)) return false;
  return materialValue / productValue < minRatio;
}
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  return Promise.race([promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({timeout: true}), ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    })]);
}

const pos = (x) => {
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

let lastRun = 0;
let running = false;
const lastNote = new Map();

function note(options, event, fields) {
  try {
    const observe = options.observe || require("./coopObserve").observe;
    const probe = options.probe || require("./coopRuntimeProbe");
    observe(probe, event, {systemID: pos(fields.systemID) || 0}, fields);
  } catch (_error) { /* telemetry only */ }
}

function once(options, key, signature) {
  if (lastNote.get(key) === signature) return false;
  lastNote.set(key, signature);
  return true;
}

/**
 * The whole economic decision, with no engine access: a candidate is refused unless the
 * buyer and the materials are both real, and the run count is bounded by what that buyer
 * can still absorb. Pure so it can be pinned by a test.
 */
function choose({candidates = [], maxRuns = 5, minPrice = 0, now = Date.now()} = {}) {
  const refusals = [];
  const usable = [];
  for (const candidate of candidates) {
    const stationID = pos(candidate && candidate.stationID);
    const blueprintTypeID = pos(candidate && candidate.blueprintTypeID);
    const perRun = Math.max(1, Math.round(num(candidate && candidate.productPerRun) || 1));
    const where = {stationID, blueprintTypeID,
      productTypeID: pos(candidate && candidate.productTypeID),
      blueprintName: String((candidate && candidate.blueprintName) || "")};
    if (!stationID || !blueprintTypeID) {
      refusals.push({...where, reason: "INVALID_CANDIDATE"});
      continue;
    }
    if (candidate.onCooldown === true) {
      refusals.push({...where, reason: "RECENTLY_INSTALLED"});
      continue;
    }
    if (candidate.jobInFlight === true) {
      refusals.push({...where, reason: "JOB_ALREADY_INSTALLED"});
      continue;
    }
    // A good nobody buys is not production. This is the rule the surplus minerals taught:
    // 891 702 units sit unsold because no local station bids for them.
    const bid = candidate.bid || null;
    if (!bid || num(bid.price) <= 0 || num(bid.volume) <= 0) {
      refusals.push({...where, reason: "NO_REAL_BUYER"});
      continue;
    }
    if (num(bid.price) < num(minPrice)) {
      refusals.push({...where, reason: "BELOW_PRICE_FLOOR", bestBid: num(bid.price)});
      continue;
    }
    const materials = Array.isArray(candidate.materials) ? candidate.materials : [];
    if (!materials.length) {
      refusals.push({...where, reason: "RECIPE_UNKNOWN"});
      continue;
    }
    // Runs the hangar really pays for, one material at a time.
    let byMaterials = Infinity;
    const shortfalls = [];
    for (const material of materials) {
      const typeID = pos(material && material.typeID);
      const need = Math.max(1, Math.round(num(material && material.quantity) || 1));
      const have = Math.max(0, num(candidate.have && candidate.have[typeID]));
      if (have < need) shortfalls.push({typeID, need, have});
      byMaterials = Math.min(byMaterials, Math.floor(have / need));
    }
    if (shortfalls.length) {
      refusals.push({...where, reason: "MATERIALS_MISSING", shortfalls});
      continue;
    }
    // Runs the buyer really absorbs: what it will still take, minus what is already held
    // and already being built, so the corporation never makes goods for its own shelves.
    const absorbed = Math.max(0, num(bid.volume) - num(candidate.heldProduct) -
      num(candidate.inFlightProduct));
    const byBuyer = Math.floor(absorbed / perRun);
    if (byBuyer < 1) {
      refusals.push({...where, reason: "BUYER_ALREADY_COVERED",
        absorbed, held: num(candidate.heldProduct), inFlight: num(candidate.inFlightProduct)});
      continue;
    }
    const runs = Math.max(1, Math.min(Math.floor(maxRuns) || 1, byMaterials, byBuyer));
    usable.push({...where, runs, quantity: runs * perRun,
      bestBid: num(bid.price), expectedRevenue: runs * perRun * num(bid.price),
      // Where the demand really is, so the job can say who it was built for.
      buyer: bid.where === "elsewhere"
        ? {systemID: pos(bid.systemID), stationID: pos(bid.stationID)} : null,
      materials: materials.map((m) => ({typeID: pos(m.typeID),
        quantity: Math.max(1, Math.round(num(m.quantity) || 1)) * runs}))});
  }
  // The best payer first: margin, not volume, chooses what the corporation builds.
  usable.sort((left, right) => right.expectedRevenue - left.expectedRevenue);
  if (!usable.length) return {status: "NO_JOB", job: null, refusals};
  return {status: "JOB", job: usable[0], refusals, alternatives: usable.slice(1)};
}

// The blueprints the corporation really holds, from the durable seed receipts.
function seededBlueprints({root, ownerID}) {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(root, "blueprints");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); }
  catch (_error) { return []; }
  const out = [];
  for (const name of names) {
    let row = null;
    try { row = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); }
    catch (_error) { continue; }
    if (!row || String(row.status) !== "SEEDED") continue;
    if (pos(row.ownerID) !== ownerID) continue;
    if (!pos(row.stationID) || !pos(row.blueprintTypeID)) continue;
    out.push({stationID: pos(row.stationID), blueprintTypeID: pos(row.blueprintTypeID)});
  }
  return out;
}

function hangarHeld(items, ownerID, stationID) {
  const answer = items.listOwnedItems(ownerID, {locationID: stationID});
  const rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  const have = {};
  const flag = (items.ITEM_FLAGS && items.ITEM_FLAGS.HANGAR) || 4;
  for (const row of rows) {
    if (Number(row.flagID === undefined ? flag : row.flagID) !== flag) continue;
    const typeID = pos(row.typeID);
    if (!typeID) continue;
    const quantity = num(row.quantity);
    const size = quantity > 0 ? quantity : (Number(row.singleton) === 1 ? 1 : 0);
    have[typeID] = (have[typeID] || 0) + size;
  }
  return have;
}

// Everything already being built or already on the shelf for one product at one station.
function productCoverage({manufacture, root, ownerID, stationID, productTypeID}) {
  const fs = require("node:fs");
  const path = require("node:path");
  let inFlight = 0;
  try {
    for (const name of fs.readdirSync(path.join(root, "jobs"))) {
      let job = null;
      try { job = JSON.parse(fs.readFileSync(path.join(root, "jobs", name), "utf8")); }
      catch (_error) { continue; }
      if (!job || String(job.status) !== "INSTALLED") continue;
      if (pos(job.ownerID) !== ownerID || pos(job.stationID) !== stationID) continue;
      if (pos(job.productTypeID) !== productTypeID) continue;
      inFlight += num(job.quantity);
    }
  } catch (_error) { /* no jobs dir is a valid state */ }
  return inFlight;
}

async function bestSeededBid({region, stationID, productTypeID, call}) {
  const answer = await call("GetOrders", {region_id: region, type_id: productTypeID});
  const buys = (answer && (answer.buys || answer.data)) || [];
  const matching = (Array.isArray(buys) ? buys : [])
    .filter((row) => row && Number(row.station_id) === Number(stationID))
    // A seeded order is the station's own demand. A player/NPC order of ours is not a
    // reason to build more of the same good.
    .filter((row) => String(row.source || "seed") === "seed")
    .filter((row) => num(row.price) > 0 && num(row.vol_remaining !== undefined ? row.vol_remaining : row.volume) > 0)
    .sort((left, right) => num(right.price) - num(left.price));
  if (!matching.length) return null;
  const best = matching[0];
  return {price: num(best.price),
    volume: num(best.vol_remaining !== undefined ? best.vol_remaining : best.volume)};
}

async function runOnce(options = {}) {
  const env = options.env || process.env;
  if (String(env[FLAG] || "") !== "1") return {status: "DISABLED"};
  const ownerID = pos(env[CORP_FLAG]) || DEFAULT_CORP_ID;
  const maxRuns = Math.max(1, Math.min(20, Math.round(num(env[RUNS_FLAG]) || num(env[MAX_RUNS_FLAG]) || 5)));
  const minPrice = Math.max(0, num(env[PRICE_FLOOR_FLAG]));
  const region = pos(env[REGION_FLAG]) || DEFAULT_REGION;
  const minRatio = num(env.EVEJS_COOP_NPC_MANUFACTURE_MIN_INPUT_RATIO) || DEFAULT_MIN_INPUT_RATIO;
  const valueCache = new Map();
  const marketTimeoutMs = Math.max(0, num(env.EVEJS_COOP_NPC_MANUFACTURE_MARKET_TIMEOUT_MS)
    || DEFAULT_MARKET_TIMEOUT_MS);
  const manufacture = options.manufacture || require("./coopNpcManufacture");
  const items = options.items || require("../services/inventory/itemStore");
  const root = options.root || manufacture.root();
  const now = Number(options.now) || Date.now();
  // Completing finished jobs is free and must never wait for a buyer: the goods are
  // already built, so leaving them INSTALLED only hides them from the hangar.
  let completed = [];
  try { completed = (manufacture.tick({now}) || {}).completed || []; }
  catch (error) {
    const reason = String((error && error.message) || error).slice(0, 90);
    // A silent early return is indistinguishable from the caller never running: that is
    // exactly how this phase looked for its first minutes (no event, no journal, no clue).
    note(options, "living-npc-manufacture-skipped", {systemID: options.systemID,
      status: "TICK_THREW", reason});
    return {status: "TICK_THREW", reason};
  }
  for (const job of completed)
    note(options, "living-npc-manufactured", {systemID: options.systemID,
      stationID: pos(job.stationID) || (options.stationID || 0), jobID: String(job.jobID || ""),
      productTypeID: pos(job.productTypeID), quantity: num(job.quantity)});

  // A blueprint the corporation physically holds IS an asset: the durable receipts are only
  // its record, and nothing but the manual seeding step ever wrote one, so a PURCHASED
  // blueprint could never be built (measured 2026-10-31: Miner I Blueprint bought for
  // 92 720 ISK, manufacturer answering NO_BLUEPRINT). Adopt what the hangar proves first.
  let adopted = [];
  try {
    adopted = (manufacture.adoptHeldBlueprints({ownerID, items, now}) || {}).adopted || [];
  } catch (_error) { adopted = []; }
  for (const row of adopted)
    note(options, "living-npc-blueprint-adopted", {systemID: options.systemID,
      stationID: pos(row.stationID), typeID: pos(row.blueprintTypeID),
      status: "ADOPTED", reason: String(row.blueprintName || "").slice(0, 60)});

  const blueprints = seededBlueprints({root, ownerID});
  if (!blueprints.length) {
    note(options, "living-npc-manufacture-skipped", {systemID: options.systemID,
      status: "NO_BLUEPRINT", ownerID});
    return {status: "NO_BLUEPRINT", completed};
  }
  const candidates = [];
  for (const blueprint of blueprints) {
    let plan = null;
    try { plan = manufacture.recipe(blueprint.blueprintTypeID, 1); }
    catch (error) {
      plan = {status: "RECIPE_THREW",
        reason: String((error && error.message) || error).slice(0, 70)};
    }
    if (!plan || plan.status !== "READY") {
      // A dropped candidate was indistinguishable from a phase that never ran: the
      // recipe itself has to say why it is not READY, or the silence is a lie.
      candidates.push({stationID: blueprint.stationID,
        blueprintTypeID: blueprint.blueprintTypeID, recipeRejected: true,
        reason: String((plan && plan.status) || "NO_PLAN"),
        detail: String((plan && plan.reason) || "").slice(0, 70)});
      continue;
    }
    const have = hangarHeld(items, ownerID, blueprint.stationID);
    const inFlight = productCoverage({manufacture, root, ownerID,
      stationID: blueprint.stationID, productTypeID: plan.productTypeID});
    let bid = null;
    let materialValue = 0;
    try {
      // Bound on purpose: marketDaemonClient.call dereferences `this` to reach the socket.
      const call = options.call ||
        ((method, params) => require("../services/market/marketDaemonClient")
          .marketDaemonClient.call(method, params));
      const answer = await withTimeout(bestSeededBid({region,
        stationID: blueprint.stationID, productTypeID: plan.productTypeID, call}),
        marketTimeoutMs);
      if (answer && answer.timeout === true) throw Error("MARKET_TIMEOUT");
      bid = answer;
      if (answer && answer.price > 0) {
        for (const material of plan.materials) {
          materialValue += material.quantity * await regionalValue({region,
            typeID: material.typeID, call, cache: valueCache, timeoutMs: marketTimeoutMs});
        }
      }
    } catch (error) {
      // An unreachable market is not a buyer: build nothing rather than guess demand.
      bid = null;
      if (once(options, "market:" + blueprint.stationID, String((error && error.message) || error).slice(0, 60)))
        note(options, "living-npc-manufacture-blocked", {systemID: options.systemID,
          stationID: blueprint.stationID, status: "MARKET_UNREACHABLE",
          reason: String((error && error.message) || error).slice(0, 90)});
    }
    // A station that bids for nothing here is not the end of the story: the corporation now
    // flies its goods to a buyer one gate away, so demand there is real demand. Measured
    // 2026-10-30: every local station reported NO_REAL_BUYER while Jita bid 560 000 for the
    // ammunition the corporation had already produced.
    if (!bid && typeof options.bidElsewhere === "function") {
      try {
        const elsewhere = await options.bidElsewhere({stationID: blueprint.stationID,
          productTypeID: plan.productTypeID});
        if (elsewhere && num(elsewhere.price) > 0 && num(elsewhere.volume) > 0) {
          bid = {...elsewhere, where: "elsewhere"};
          note(options, "living-npc-manufacture-buyer-elsewhere", {systemID: options.systemID,
            stationID: blueprint.stationID, productTypeID: plan.productTypeID,
            status: "BUYER_ELSEWHERE", reason: "system " + num(elsewhere.systemID)});
        }
      } catch (_error) { /* no neighbour is no buyer */ }
    }
    const productValue = bid && bid.price > 0 ? plan.productPerRun * bid.price : 0;
    if (isTrivialRecipe({materialValue, productValue, minRatio})) {
      candidates.push({stationID: blueprint.stationID,
        blueprintTypeID: blueprint.blueprintTypeID, recipeRejected: true,
        reason: "TRIVIAL_RECIPE",
        detail: "inputs " + Math.round(materialValue) + " vs product " +
          Math.round(productValue)});
      continue;
    }
    candidates.push({
      stationID: blueprint.stationID,
      blueprintTypeID: plan.blueprintTypeID,
      blueprintName: plan.blueprintName,
      productTypeID: plan.productTypeID,
      productPerRun: plan.productPerRun,
      materials: plan.materials,
      have,
      bid,
      heldProduct: have[plan.productTypeID] || 0,
      inFlightProduct: inFlight,
      // Two live jobs for one recipe can race the same hangar stack into a shortfall,
      // so a recipe with a job in flight waits for that job instead of starting another.
      jobInFlight: inFlight > 0,
    });
  }
  const ready = candidates.filter((c) => c.recipeRejected !== true);
  // A ceiling nobody names looks like a healthy loop: measured 2026-10-30 the corporation could
  // build three products while the buyer system carried thousands of real bids it cannot answer.
  // When no job is possible, say what the corporation CANNOT make (at most once per half hour).
  // NB: this must live AFTER `ready`; checking it before the declaration threw
  // "Cannot access 'ready' before initialization" and stopped the manufacturer for hours.
  if (!ready.length && typeof options.demandGap === "function") {
    const last = Number(options.gapReportedAt || 0);
    if (Date.now() - (Number.isFinite(last) ? last : 0) > 30 * 60 * 1000) {
      let answer = null;
      try { answer = await options.demandGap({limit: 5}); }
      catch (_error) { answer = null; }
      if (answer && answer.status === "GAP") {
        note(options, "living-npc-manufacture-demand-gap", {systemID: options.systemID,
          status: "DEMAND_WITHOUT_BLUEPRINT", reason: String(answer.gapValue) + " ISK across " +
            String(answer.gap.length) + " named products"});
      }
    }
  }
  note(options, "living-npc-manufacture-attempt", {systemID: options.systemID,
    blueprints: blueprints.length, candidates: candidates.length, ready: ready.length,
    rejected: candidates.filter((c) => c.recipeRejected === true)
      .map((c) => c.stationID + ":" + c.blueprintTypeID + ":" + c.reason)});
  const decision = choose({candidates: ready, maxRuns, minPrice, now});
  if (decision.status !== "JOB") {
    for (const refusal of decision.refusals) {
      const key = "manufacture:" + refusal.stationID + ":" + refusal.blueprintTypeID + ":" + refusal.reason;
      if (once(options, key, refusal.reason + ":" + JSON.stringify(refusal.shortfalls || refusal.absorbed || "")))
        note(options, "living-npc-manufacture-blocked", {systemID: options.systemID,
          ...refusal});
    }
    return {status: decision.status, completed, refusals: decision.refusals};
  }
  const job = decision.job;
  let installed = null;
  try {
    installed = manufacture.install({ownerID, stationID: job.stationID,
      blueprintTypeID: job.blueprintTypeID, runs: job.runs, systemID: options.systemID,
      buyer: job.buyer || null});
  } catch (error) {
    installed = {status: "INSTALL_THREW", reason: String((error && error.message) || error).slice(0, 90)};
  }
  const status = String((installed && installed.status) || "UNKNOWN");
  note(options, status === "INSTALLED" ? "living-npc-manufacture-installed"
    : "living-npc-manufacture-blocked", {systemID: options.systemID,
    stationID: job.stationID, blueprintTypeID: job.blueprintTypeID,
    productTypeID: job.productTypeID, runs: job.runs, quantity: job.quantity,
    bestBid: job.bestBid, expectedRevenue: Math.round(job.expectedRevenue),
    buyerSystemID: Number(job.buyer && job.buyer.systemID) || 0,
    status, reason: installed && installed.reason ? String(installed.reason).slice(0, 90) : null,
    jobID: installed && installed.jobID ? String(installed.jobID) : null});
  return {status, installed, job, completed, refusals: decision.refusals};
}

/**
 * Called from the mining fleet tick. The buyer lookup is a market call, so the work runs
 * off the synchronous hook; a module-level guard makes sure two overlapping runs can never
 * install the same recipe twice (each install also writes its own durable journal).
 */
function tick(options = {}) {
  const env = options.env || process.env;
  if (String(env[FLAG] || "") !== "1") return {status: "DISABLED"};
  const now = Number(options.now) || Date.now();
  if (running) {
    if (once(options, "busy", String(Math.floor(now / THROTTLE_MS))))
      note(options, "living-npc-manufacture-skipped", {systemID: options.systemID,
        status: "BUSY"});
    return {status: "BUSY"};
  }
  if (lastRun && now - lastRun < THROTTLE_MS) return {status: "THROTTLED"};
  lastRun = now;
  running = true;
  const promise = (async () => {
    try { return await runOnce({...options, env, now}); }
    catch (error) {
      note(options, "living-npc-manufacture-blocked", {systemID: options.systemID,
        status: "RUN_THREW", reason: String((error && error.message) || error).slice(0, 90)});
      return {status: "RUN_THREW"};
    } finally { running = false; }
  })();
  return {status: "STARTED", promise};
}

function resetForTests() {
  lastRun = 0;
  running = false;
  lastNote.clear();
}

// The regional best bid for one type, memoised per run: the sanity check below asks about
// the inputs, and a recipe has very few of them.
async function regionalValue({region, typeID, call, cache, timeoutMs}) {
  if (cache.has(typeID)) return cache.get(typeID);
  let value = 0;
  try {
    const answer = await withTimeout(call("GetOrders", {region_id: region, type_id: typeID}),
      timeoutMs);
    if (!(answer && answer.timeout === true)) {
      const buys = (answer && (answer.buys || answer.data)) || [];
      for (const row of Array.isArray(buys) ? buys : []) {
        if (num(row && row.price) > value) value = num(row.price);
      }
    }
  } catch (_error) { value = 0; }
  cache.set(typeID, value);
  return value;
}

module.exports = {FLAG, CORP_FLAG, DEFAULT_CORP_ID, THROTTLE_MS, choose, isTrivialRecipe,
  seededBlueprints, hangarHeld, productCoverage, bestSeededBid, runOnce, tick, resetForTests};
