"use strict";
// NPC manufacturing for the co-op economy: real blueprint recipe, real materials,
// real product, journaled exactly once.
//
// Why not the native job pipeline: `quoteIndustryJob(session, ...)` derives the owner,
// facility access, blueprint access and job slots FROM A CLIENT SESSION. There is no
// client in this world and forging one is forbidden, so this module performs the same
// production step with the native SDE recipe and the native inventory primitives
// (takeItemTypeFromOwnerLocation / grantItemToOwnerLocation) - the same pattern the
// co-op refinery already uses for ore -> minerals.
//
// Rules it never breaks:
//  - the corporation must own the blueprint ITEM for that station (no invented capability);
//  - the materials must be physically in the corporation hangar at that station;
//  - materials are taken once, from a durable journal, and the product is granted once;
//  - a crash leaves an INSTALLED journal that completes or reports, never duplicates.
//
// OFF unless EVEJS_COOP_NPC_MANUFACTURE=1.
const fs = require("node:fs");
const path = require("node:path");

const ENABLED = () => String(process.env.EVEJS_COOP_NPC_MANUFACTURE || "") === "1";
const ACTIVITY = "manufacturing";
const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

function root() {
  return process.env.EVEJS_COOP_NPC_INDUSTRY_ROOT || "/var/lib/evejs/coop-native-industry";
}
function timeScale() {
  const value = Number(process.env.EVEJS_COOP_INDUSTRY_TIME_SCALE || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}
function note(reason, payload = {}) {
  try {
    require("./coopRuntimeProbe").observe("living-npc-manufacture", null,
      { spaceState: { systemID: num(payload.systemID) } }, { reason, ...payload });
  } catch (_error) { /* telemetry never stops production */ }
}

// The recipe exactly as the native static data defines it.
function recipe(blueprintTypeID, runs) {
  const staticData = require("../services/industry/industryStaticData");
  const definition = staticData.getBlueprintDefinitionByTypeID(pos(blueprintTypeID));
  if (!definition) return { status: "UNKNOWN_BLUEPRINT", blueprintTypeID: pos(blueprintTypeID) };
  const activity = (definition.activities || definition.activity || {})[ACTIVITY];
  if (!activity) return { status: "BLUEPRINT_NOT_MANUFACTURABLE", blueprintTypeID: definition.blueprintTypeID };
  const runsWanted = Math.max(1, Math.round(num(runs) || 1));
  const limit = Math.max(1, num(definition.maxProductionLimit) || runsWanted);
  if (runsWanted > limit) return { status: "RUNS_OVER_LIMIT", runs: runsWanted, limit };
  const materials = (activity.materials || []).map((material) => ({
    typeID: pos(material.typeID),
    quantity: Math.max(1, Math.round(num(material.quantity))) * runsWanted,
    perRun: Math.max(1, Math.round(num(material.quantity))),
  }));
  if (!materials.length || materials.some((material) => !material.typeID)) {
    return { status: "RECIPE_MATERIALS_UNAVAILABLE", blueprintTypeID: definition.blueprintTypeID };
  }
  const product = (activity.products || [])[0] || null;
  const productTypeID = pos((product && product.typeID) || definition.productTypeID);
  if (!productTypeID) return { status: "RECIPE_PRODUCT_UNAVAILABLE", blueprintTypeID: definition.blueprintTypeID };
  const perRun = Math.max(1, Math.round(num(product && product.quantity) || 1));
  return {
    status: "READY",
    blueprintTypeID: definition.blueprintTypeID,
    blueprintName: String(definition.blueprintName || ""),
    productTypeID,
    productName: String(definition.productName || ""),
    productPerRun: perRun,
    quantity: perRun * runsWanted,
    runs: runsWanted,
    timeSeconds: Math.max(1, Math.round(num(activity.time) || 1)),
    materials,
  };
}

function hangarFlag(items) {
  return (items.ITEM_FLAGS && items.ITEM_FLAGS.HANGAR) || 4;
}

function ownedAt(ownerID, stationID, typeID) {
  const items = require("../services/inventory/itemStore");
  const answer = items.listOwnedItems(ownerID, { locationID: stationID });
  const rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  const matching = rows.filter((row) => Number(row.typeID) === Number(typeID));
  // A singleton (a blueprint, a rig) reports quantity -1, so it is counted as ONE
  // asset, never as a negative amount.
  const size = (row) => {
    const quantity = num(row && row.quantity);
    if (quantity > 0) return quantity;
    return Number(row && row.singleton) === 1 ? 1 : 0;
  };
  return { items, rows: matching,
    quantity: matching.reduce((sum, row) => sum + size(row), 0) };
}

// Adopt the blueprints the corporation PHYSICALLY holds.
//
// Measured 2026-10-31: the trader bought the Miner I Blueprint for 92 720 ISK, the trade
// settled, and the manufacturer still answered NO_BLUEPRINT for hours. The hangar row is the
// asset and the receipt is only its record, but the ONLY writer of receipts was `seedBlueprint`
// - a manual seeding step - so a PURCHASED blueprint could never be built, and the whole
// "acquire a blueprint, then produce" half of the economy was dead by construction.
//
// Adoption invents nothing: it reads the real hangar rows of the real owner and records one
// receipt per (station, blueprint) that has none. It never grants an item and never touches a
// row it did not find.
const BLUEPRINT_CATEGORY_ID = 9;
function adoptHeldBlueprints({ownerID, items = null, now = Date.now(), systemID = 0,
  root: overrideRoot = null} = {}) {
  const owner = pos(ownerID);
  if (!owner) return {status: "INVALID_ARGUMENT", adopted: []};
  const inventory = items || require("../services/inventory/itemStore");
  let rows = [];
  try {
    const answer = inventory.listOwnedItems(owner, {locationID: undefined});
    rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  } catch (_error) { return {status: "HANGAR_UNREADABLE", adopted: []}; }
  const seen = new Map();
  for (const row of rows) {
    if (Number(row && row.categoryID) !== BLUEPRINT_CATEGORY_ID) continue;
    const stationID = pos(row.locationID);
    const typeID = pos(row.typeID);
    if (!stationID || !typeID) continue;
    const quantity = num(row.quantity);
    const size = quantity > 0 ? quantity : (Number(row.singleton) === 1 ? 1 : 0);
    if (size < 1) continue;
    const key = stationID + ":" + typeID;
    if (!seen.has(key)) seen.set(key, {stationID, typeID, itemID: pos(row.itemID), size});
  }
  const dir = path.join(overrideRoot || root(), "blueprints");
  const adopted = [];
  for (const row of seen.values()) {
    const receiptID = "seed:" + owner + ":" + row.stationID + ":" + row.typeID;
    const file = path.join(dir, receiptID.replace(/:/g, "_") + ".json");
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_error) { prior = null; }
    if (prior && String(prior.status) === "SEEDED" && pos(prior.ownerID) === owner) continue;
    const plan = (() => { try { return recipe(row.typeID, 1); } catch (_error) { return null; } })();
    const receipt = {version: 1, status: "SEEDED", ownerID: owner,
      stationID: row.stationID, blueprintTypeID: row.typeID,
      blueprintName: String((plan && plan.blueprintName) || ""),
      itemID: row.itemID || 0, source: "hangar", at: now};
    try { atomic(file, receipt); } catch (_error) { continue; }
    adopted.push({stationID: row.stationID, blueprintTypeID: row.typeID,
      blueprintName: receipt.blueprintName, itemID: receipt.itemID});
    note("BLUEPRINT_ADOPTED", {systemID, ownerID: owner, stationID: row.stationID,
      blueprintTypeID: row.typeID, blueprintName: receipt.blueprintName});
  }
  return {status: adopted.length ? "ADOPTED" : "NOTHING_NEW", adopted};
}

// Give the corporation one REAL blueprint item so it can manufacture at all. This is
// a seeding step like the seed market, and it refuses to run twice.
function seedBlueprint({ ownerID, stationID, blueprintTypeID, systemID } = {}) {
  if (!ENABLED()) return { status: "DISABLED" };
  const plan = recipe(blueprintTypeID, 1);
  if (plan.status !== "READY") return plan;
  const owner = pos(ownerID), station = pos(stationID);
  if (!owner || !station) return { status: "INVALID_ARGUMENT" };
  const held = ownedAt(owner, station, plan.blueprintTypeID);
  if (held.quantity > 0) return { status: "ALREADY_HELD", blueprintTypeID: plan.blueprintTypeID, quantity: held.quantity };
  const granted = held.items.grantItemToOwnerLocation(owner, station, hangarFlag(held.items),
    plan.blueprintTypeID, 1, { singleton: true });
  if (!granted || granted.success !== true) {
    return { status: "BLUEPRINT_GRANT_FAILED", reason: String((granted && (granted.errorMsg || granted.reason)) || "") };
  }
  const receiptID = "seed:" + owner + ":" + station + ":" + plan.blueprintTypeID;
  atomic(path.join(root(), "blueprints", receiptID.replace(/:/g, "_") + ".json"), {
    version: 1, status: "SEEDED", ownerID: owner, stationID: station,
    blueprintTypeID: plan.blueprintTypeID, blueprintName: plan.blueprintName,
    itemID: Number((granted.data && granted.data.itemID) || (granted.data && granted.data.items && granted.data.items[0] && granted.data.items[0].itemID) || 0),
    at: Date.now(),
  });
  note("BLUEPRINT_SEEDED", { systemID, ownerID: owner, stationID: station,
    blueprintTypeID: plan.blueprintTypeID, blueprintName: plan.blueprintName });
  return { status: "SEEDED", blueprintTypeID: plan.blueprintTypeID, blueprintName: plan.blueprintName };
}

// Install: take the real materials once and record the job.
function install({ ownerID, stationID, blueprintTypeID, runs, systemID, buyer = null } = {}) {
  if (!ENABLED()) return { status: "DISABLED" };
  const plan = recipe(blueprintTypeID, runs);
  if (plan.status !== "READY") return plan;
  const owner = pos(ownerID), station = pos(stationID);
  if (!owner || !station) return { status: "INVALID_ARGUMENT" };
  const blueprint = ownedAt(owner, station, plan.blueprintTypeID);
  if (blueprint.quantity <= 0) {
    return { status: "BLUEPRINT_MISSING", blueprintTypeID: plan.blueprintTypeID,
      blueprintName: plan.blueprintName, stationID: station };
  }
  const shortfalls = [];
  const taken = [];
  const items = blueprint.items;
  for (const material of plan.materials) {
    const held = ownedAt(owner, station, material.typeID);
    if (held.quantity < material.quantity) {
      shortfalls.push({ typeID: material.typeID, need: material.quantity, have: held.quantity });
    }
  }
  if (shortfalls.length) {
    return { status: "MATERIALS_MISSING", blueprintTypeID: plan.blueprintTypeID, shortfalls,
      stationID: station };
  }
  const jobID = ["coop-job", owner, station, plan.blueprintTypeID, Date.now()].join(":");
  const job = {
    version: 1, status: "INSTALLED", jobID, ownerID: owner, stationID: station,
    systemID: pos(systemID) || 0, blueprintTypeID: plan.blueprintTypeID,
    // The demand this job exists for: the buyer's system and station, when the corporation
    // builds for a market one gate away instead of the station it builds at. Measured
    // 2026-10-30: every local station bid for nothing while Jita paid 560 000 for the same
    // goods, and the job record did not say which demand it was answering.
    buyerSystemID: pos(buyer && buyer.systemID) || 0,
    buyerStationID: pos(buyer && buyer.stationID) || 0,
    blueprintName: plan.blueprintName, productTypeID: plan.productTypeID,
    productName: plan.productName, runs: plan.runs, quantity: plan.quantity,
    materials: plan.materials, timeSeconds: plan.timeSeconds,
    installedAt: Date.now(),
    // Native jobs run the recipe time PER RUN.
    finishAtMs: Date.now() + Math.max(100, Math.round(plan.timeSeconds * plan.runs * 1000 * timeScale())),
    taken: [],
  };
  atomic(jobPath(jobID), job);
  for (const material of plan.materials) {
    const result = items.takeItemTypeFromOwnerLocation(owner, station, hangarFlag(items),
      material.typeID, material.quantity);
    if (!result || result.success !== true) {
      // Honest partial state: the journal says exactly how much was really taken.
      job.status = "MATERIAL_TAKE_FAILED";
      job.failed = { typeID: material.typeID, quantity: material.quantity, taken };
      atomic(jobPath(jobID), job);
      note("MATERIAL_TAKE_FAILED", { systemID, jobID, typeID: material.typeID,
        quantity: material.quantity, taken });
      return { status: "MATERIAL_TAKE_FAILED", jobID, taken };
    }
    taken.push({ typeID: material.typeID, quantity: material.quantity });
    job.taken = taken;
    atomic(jobPath(jobID), job);
  }
  note("JOB_INSTALLED", { systemID, jobID, stationID: station,
    blueprintTypeID: plan.blueprintTypeID, productTypeID: plan.productTypeID,
    runs: plan.runs, quantity: plan.quantity, timeSeconds: plan.timeSeconds,
    materials: plan.materials.map((m) => m.typeID + "x" + m.quantity) });
  return { status: "INSTALLED", jobID, quantity: plan.quantity,
    productTypeID: plan.productTypeID, productName: plan.productName,
    finishAtMs: job.finishAtMs, timeSeconds: plan.timeSeconds };
}

function jobPath(jobID) {
  return path.join(root(), "jobs", String(jobID).replace(/[^a-z0-9:.-]/gi, "_") + ".json");
}

// Complete every installed job whose time has come. Idempotent: the product is
// granted once and the journal is rewritten COMPLETED before the next scan.
function tick({ now = Date.now() } = {}) {
  if (!ENABLED()) return { status: "DISABLED", completed: [] };
  const items = require("../services/inventory/itemStore");
  const dir = path.join(root(), "jobs");
  let files = [];
  try { files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); }
  catch (error) { if (error.code === "ENOENT") return { status: "IDLE", completed: [] }; throw error; }
  const completed = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let job;
    try { job = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_error) { continue; }
    if (!job || job.status !== "INSTALLED") continue;
    if (now < num(job.finishAtMs)) continue;
    const granted = items.grantItemToOwnerLocation(job.ownerID, job.stationID, hangarFlag(items),
      job.productTypeID, job.quantity, {});
    if (!granted || granted.success !== true) {
      note("PRODUCT_GRANT_FAILED", { systemID: job.systemID, jobID: job.jobID,
        productTypeID: job.productTypeID, quantity: job.quantity });
      continue;
    }
    job.status = "COMPLETED";
    job.completedAt = now;
    atomic(file, job);
    atomic(path.join(root(), "receipts", String(job.jobID).replace(/[^a-z0-9:.-]/gi, "_") + ".json"), {
      version: 1, status: "PRODUCED", jobID: job.jobID, ownerID: job.ownerID,
      stationID: job.stationID, blueprintTypeID: job.blueprintTypeID,
      productTypeID: job.productTypeID, productName: job.productName,
      quantity: job.quantity, runs: job.runs,
      materials: (job.taken || []).map((m) => ({ typeID: m.typeID, quantity: m.quantity })),
      installedAt: job.installedAt, completedAt: now,
    });
    completed.push({ jobID: job.jobID, productTypeID: job.productTypeID,
      productName: job.productName, quantity: job.quantity });
    note("PRODUCED", { systemID: job.systemID, jobID: job.jobID, stationID: job.stationID,
      productTypeID: job.productTypeID, productName: job.productName,
      quantity: job.quantity, runs: job.runs });
  }
  return { status: completed.length ? "COMPLETED" : "IDLE", completed };
}

module.exports = { ENABLED, recipe, install, tick, seedBlueprint, adoptHeldBlueprints,
  timeScale, root, BLUEPRINT_CATEGORY_ID };
