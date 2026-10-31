"use strict";
// One tick for every co-op loop phase the engine calls from its mining think.
//
// The stock file used to carry one hook line per phase (refinery, then the manufacturer),
// and each new phase cost stock characters that are frozen by the extraction gate. This
// module keeps ONE hook line in the stock file and fans out here, so adding a phase costs
// nothing in the engine and a broken phase cannot stop the others.
//
// Nothing is invented: every phase keeps its own env flag and its own durable journals, so
// this is a dispatcher, not a new authority. A throwing phase is reported and skipped.
// A blueprint's recipe is static client data, and a station can quote hundreds of blueprints:
// measured 2026-10-31, re-reading them for every hull beat a 25 s hull budget and the whole
// run reported HULL_TIMEOUT. One lookup per type is the same answer, cached for the process.
const blueprintRecipes = new Map();
function blueprintRecipe(manufacture, typeID) {
  const id = Number(typeID);
  if (blueprintRecipes.has(id)) return blueprintRecipes.get(id);
  let plan = null;
  try { plan = manufacture.recipe(id, 1); } catch (_error) { plan = null; }
  blueprintRecipes.set(id, plan);
  return plan;
}
const PHASES = ["refinery", "manufacture", "distribution", "distributionRun"];
let distributionRunInFlight = false;
let lastDistributionRunStatus = null;
let lastDistributionStatus = null;

function note(failure, phase, error) {
  try {
    // A phase that fails without a report is indistinguishable from a phase that never ran,
    // so the probe is the default observer rather than an optional one.
    const observe = typeof failure.observe === "function" ? failure.observe
      : require("./coopRuntimeProbe").observe;
    const detail = typeof error === "object" && error !== null
      ? {status: String(error.status || ""), reason: String(error.reason || "")}
      : {status: "THREW", reason: String((error && error.message) || error)};
    observe("living-coop-loop-phase-failed", null, null, {phase, ...detail});
  } catch (_error) { /* telemetry only */ }
}

function observeLoop(event, detail) {
  try { require("./coopRuntimeProbe").observe(event, null, null, detail); }
  catch (_error) { /* telemetry only */ }
}
// Everything a freight run needs, built from the world itself: a real hull marker, the real
// hangars, the real seeded book (read-only), real stations and a real reciprocal gate.
function distributionRunAuthorities(options = {}) {
  const env = options.env || process.env;
  try {
    const store = require("./npc/nativeNpcStore");
    const items = require("../services/inventory/itemStore");
    const inventory = require("../services/inventory/itemTypeRegistry");
    const worldData = require("./worldData");
    const runtime = require("./runtime");
    const npc = require("./npc/npcRuntime");
    const sceneFor = options.sceneForSystem ||
      ((id) => runtime.ensureScene(id, {refreshStargates: false}));
    let db = null;
    const openDb = () => {
      if (db !== null) return db || null;
      try {
        const Better = require("better-sqlite3");
        db = new Better(env.EVEJS_MARKET_DB || "/var/lib/evejs/market/market.sqlite",
          {readonly: true, fileMustExist: true});
      } catch (error) {
        db = false;
        observeLoop("living-distribution-book-unavailable",
          {reason: String((error && error.message) || error).slice(0, 90)});
      }
      return db || null;
    };
    // What the corporation's OWN blueprints still need at a station is not freight. Measured
    // 2026-10-31: the merchant shipped every unit of Pyerite and Mexallon the factory needed,
    // so the hangar held 3.8 M Tritanium and the manufacturer answered
    // MATERIALS_MISSING 34:1324/3892702 35:481/0 36:119/0.
    //
    // Only a blueprint whose product somebody really bids for reserves material: reserving for
    // every style the corporation owns would lock 12 562 Pyerite for ammunition no station in
    // the region buys. The answer is cached for two minutes per station - the same reply must
    // not cost a recipe lookup and a SQL query on every beat.
    const supplyCache = new Map();
    const factorySupply = (stationID) => {
      const station = Number(stationID);
      if (!station) return null;
      const cached = supplyCache.get(station);
      if (cached && Date.now() - cached.at < 120000) return cached.value;
      const keep = (value) => { supplyCache.set(station, {at: Date.now(), value}); return value; };
      try {
        const owner = Number(env.EVEJS_COOP_FACTORY_CORP_ID || 1000129);
        const root = env.EVEJS_COOP_NPC_INDUSTRY_ROOT || "/var/lib/evejs/coop-native-industry";
        const nodeFs = require("node:fs");
        const nodePath = require("node:path");
        let names = [];
        try { names = nodeFs.readdirSync(nodePath.join(root, "blueprints")); }
        catch (_error) { return keep(null); }
        const blueprints = [];
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          let row = null;
          try { row = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "blueprints", name), "utf8")); }
          catch (_error) { continue; }
          if (!row || String(row.status) !== "SEEDED") continue;
          if (Number(row.ownerID) !== owner || Number(row.stationID) !== station) continue;
          blueprints.push({blueprintTypeID: Number(row.blueprintTypeID), stationID: station});
        }
        if (!blueprints.length) return keep(null);
        const supply = require("./coopNpcInputSupply");
        const manufacture = require("./coopNpcManufacture");
        const db = openDb();
        const wanted = [];
        for (const row of blueprints) {
          let plan = null;
          try { plan = manufacture.recipe(row.blueprintTypeID, 1); } catch (_error) { plan = null; }
          if (!plan || plan.status !== "READY") continue;
          let bid = null;
          try {
            bid = db ? db.prepare("select sum(quantity) as volume from seed_buy_orders " +
              "where type_id=? and quantity>0 and solar_system_id in (30000142,30000144,30000145)")
              .get(Number(plan.productTypeID)) : null;
          } catch (_error) { bid = null; }
          if (!bid || Number(bid.volume) <= 0) continue;
          wanted.push({...row, productTypeID: Number(plan.productTypeID)});
        }
        if (!wanted.length) return keep(null);
        const held = supply.heldAt({items, ownerID: owner, stationID: station});
        const plan = supply.planSupply({blueprints: wanted, held, runs: Number(env.EVEJS_COOP_INPUT_RUNS) || 2,
          maxTypes: 6, stationID: station,
          recipe: (blueprintTypeID, runs) => manufacture.recipe(blueprintTypeID, runs)});
        return keep({...plan, stationID: station, held});
      } catch (_error) { return keep(null); }
    };
    // Where the corporation's own factory really is: the explicit setting, or the station its
    // blueprint receipts name most often. Measured 2026-10-31: the Miner I copy lives at
    // 60000682, and every imported input has to come home to exactly that hangar.
    const factoryStation = () => {
      const configured = Number(env.EVEJS_COOP_INDUSTRY_STATION || 0) || 0;
      if (configured) return configured;
      try {
        const owner = Number(env.EVEJS_COOP_FACTORY_CORP_ID || 1000129);
        const root = env.EVEJS_COOP_NPC_INDUSTRY_ROOT || "/var/lib/evejs/coop-native-industry";
        const nodeFs = require("node:fs");
        const nodePath = require("node:path");
        const counts = new Map();
        for (const name of nodeFs.readdirSync(nodePath.join(root, "blueprints"))) {
          if (!name.endsWith(".json")) continue;
          let row = null;
          try { row = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "blueprints", name), "utf8")); }
          catch (_error) { continue; }
          if (!row || String(row.status) !== "SEEDED" || Number(row.ownerID) !== owner) continue;
          const station = Number(row.stationID) || 0;
          if (station) counts.set(station, (counts.get(station) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
      } catch (_error) { return 0; }
    };
    // A delivery makes the cached shortfall wrong the moment it lands: the hangar grew while
    // the answer was still cached, so without this the next plan would buy the same shortfall
    // a second time. Measured 2026-10-31: the cache lives 120 s and a whole unload/replan cycle
    // fits inside it.
    const refreshFactorySupply = () => { supplyCache.clear(); return true; };
    // The one input worth BUYING. The refinery here only ever turns Veldspar into Tritanium
    // (measured `refined 17471 -> 1 mineral`), so a Tritanium shortfall is mining's job -
    // importing it would pay the Jita ask to undo the corporation's own ore. Pyerite, Mexallon
    // and every higher mineral have no local source at all and must be shopped for.
    const nextMissingInput = (plan) => {
      const needs = plan && Array.isArray(plan.needs) ? plan.needs : [];
      return needs.find((row) => row && Number(row.typeID) > 0 && Number(row.typeID) !== 34 &&
        Number(row.short) > 0) || null;
    };
    // Keep the FULL requirement home, not only today's shortfall: once the hangar holds what the
    // factory needs, a shortfall-only reserve would let it all leave again on the next trip.
    const industryReserve = (stationID) => {
      const plan = factorySupply(stationID);
      if (!plan) return null;
      const map = {};
      for (const need of plan.totals || []) if (need.need > 0) map[need.typeID] = need.need;
      return Object.keys(map).length ? map : null;
    };
    // The hull needs an identity the registry will accept: the one already bound to it, or
    // the lowest free name (the crossing itself links it from the durable record).
    const pilotFor = (haulerID) => {
      try {
        const links = JSON.parse(require("fs").readFileSync(
          env.EVEJS_COOP_IDENTITY_FILE || "/var/lib/evejs/coop-npc-links.json", "utf8")).links || {};
        const bound = Object.values(links).find((row) =>
          Number(row && row.entityID) === Number(haulerID));
        if (bound) return String(bound.pilotID);
        for (let n = 1; n <= 9999; n += 1) {
          const candidate = "coop-pilot-" + String(n).padStart(3, "0");
          if (!links[candidate]) return candidate;
        }
      } catch (_error) { /* no identity file is no identity */ }
      return null;
    };
    const hulls = () => (store.listNativeEntities() || [])
      .filter((row) => /^coop-distribution-[0-9]+-hauler$/.test(String(row.operatorKind || "")))
      .map((row) => Number(row.entityID)).filter(Boolean);
    const distanceTo = (stationID, systemID, haulerID) => {
      try {
        const scene = sceneFor(systemID);
        const ship = scene && scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
        // The physical station in the scene, not only the static-data row: the native
        // market refuses a sale 10 km from the PHYSICAL one (measured 2026-10-30).
        const physical = (scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
          .find((row) => Number(row && row.itemID) === Number(stationID) &&
            String(row && row.kind) === "station") || null;
        const station = physical || worldData.getStationByID(stationID);
        if (!ship || !ship.position || !station || !station.position) return null;
        const dx = ship.position.x - station.position.x;
        const dy = ship.position.y - station.position.y;
        const dz = ship.position.z - station.position.z;
        return Math.max(0, Math.hypot(dx, dy, dz) - (Number(ship.radius) || 0) -
          (Number(station.radius) || 0));
      } catch (_error) { return null; }
    };
    // A durable hull without an identity link is pruned out of its scene, and then it can
    // never reach a station: measured 2026-10-30 the distribution hull was rebuilt every beat
    // because nothing named it. Keeping the link alive is the same bookkeeping the sale needs.
    // The hold that is really free: capacity minus what the hull already carries.
    const capacityM3 = (haulerID) => {
      try {
        const native = store.getNativeEntity(haulerID);
        const type = inventory.resolveItemByTypeID(Number(native && (native.shipTypeID || native.typeID)));
        const total = Number(type && type.capacity) || 0;
        let used = 0;
        for (const row of store.listNativeCargoForEntity(haulerID) || []) {
          const meta = inventory.resolveItemByTypeID(Number(row.typeID)) || {};
          used += Number(row.quantity) * Number(meta.volume || 0);
        }
        return Math.max(0, total - used);
      } catch (_error) { return 0; }
    };
    const ensureNamed = (haulerID) => {
      try {
        const native = store.getNativeEntity(haulerID);
        const systemID = Number(native && native.systemID) || 0;
        if (!systemID) return false;
        const registry = require("./coopIdentityRegistry").createRegistry({
          file: env.EVEJS_COOP_IDENTITY_FILE || "/var/lib/evejs/coop-npc-links.json",
          exists: (system, id) => {
            try {
              const scene = sceneFor(system);
              const ship = scene && scene.getEntityByID ? scene.getEntityByID(id) : null;
              return Boolean(ship && ship.kind === "ship");
            } catch (_error) { return false; }
          },
        });
        const links = (registry.snapshot() || {}).links || {};
        const bound = Object.entries(links)
          .find(([, row]) => Number(row && row.entityID) === Number(haulerID));
        const role = bound ? String(bound[1].role || "") : "";
        const rightSystem = bound ? Number(bound[1].systemID) === systemID : false;
        if (bound && rightSystem && ["hauler", "miner", "trader"].includes(role)) return true;
        const pilotID = bound ? bound[0] : pilotFor(haulerID);
        if (!pilotID) return false;
        if (bound) registry.release(pilotID, {expectedEntityID: Number(haulerID)});
        registry.link({id: pilotID, name: bound ? bound[1].name : pilotID,
          faction: "independent", role: "hauler", durable: false}, systemID, haulerID);
        return true;
      } catch (_error) { return false; }
    };
    // The same durable ship, brought back into its scene from its own record.
    const ensureLive = (haulerID) => {
      try {
        const native = store.getNativeEntity(haulerID);
        if (!native) return false;
        // Named first: an unlinked hull is pruned from its scene, so materializing it first
        // would only give the pruner something to remove.
        ensureNamed(haulerID);
        const scene = sceneFor(Number(native.systemID) || 0);
        if (!scene) return false;
        const ship = typeof scene.getEntityByID === "function" ? scene.getEntityByID(haulerID) : null;
        if (ship) return true;
        const answer = require("./npc/nativeNpcService")
          .materializeStoredNativeController(scene, haulerID);
        return Boolean(answer && answer.success === true);
      } catch (_error) { return false; }
    };
    const goTo = (stationID, haulerID) => {
      // Distance decides the mode, exactly as the gate approach does: a warp for a long leg,
      // a follow for the last kilometres. Subwarp across a solar system never arrives.
      try {
        const native = store.getNativeEntity(haulerID);
        const systemID = Number(native && native.systemID) || 0;
        const scene = sceneFor(systemID);
        const ship = scene && scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
        const station = worldData.getStationByID(stationID);
        if (ship && ship.position && station && station.position) {
          const gap = Math.hypot(ship.position.x - station.position.x,
            ship.position.y - station.position.y, ship.position.z - station.position.z);
          if (gap > 500000 && typeof require("./npc/npcRuntime").warpToPoint === "function") {
            const warp = require("./npc/npcRuntime").warpToPoint(haulerID, station.position,
              {forceImmediateStart: true});
            if (warp && warp.success === true) return true;
          }
        }
      } catch (_error) { /* fall through to the orders below */ }
      // The manual order needs a live controller; a restored hull may have its ship back
      // without one, so the scene follow - the same call the station arrival uses - is the
      // fallback. Measured 2026-10-30: the order answered NOT_FOUND while the ship was
      // already sitting at its station.
      try {
        const answer = require("./npc/npcService").issueManualOrder(haulerID, {
          type: "follow", targetID: stationID, followRangeMeters: 2000, allowWeapons: false,
        });
        if (answer && answer.success === true) return true;
      } catch (_error) { /* fall through to the scene order */ }
      try {
        const native = store.getNativeEntity(haulerID);
        const scene = sceneFor(Number(native && native.systemID) || 0);
        const ship = scene && scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
        if (!ship || typeof scene.followShipEntity !== "function") return false;
        return scene.followShipEntity(ship, stationID, 2000, {allowWeapons: false}) !== false;
      } catch (_error) { return false; }
    };
    return {
      env, hulls, distanceTo, goTo, ensureLive, capacityM3,
      planTrip: ({haulerID}) => {
        const native = store.getNativeEntity(haulerID);
        const systemID = Number(native && native.systemID) || 0;
        return require("./coopDistributionPlan").planTrip({
          haulerID, store, items, inventory, db: openDb(), worldData, scene: sceneFor(systemID),
          reserve: industryReserve,
          connectedGates: ({sourceSystemID, targetSystemID}) => {
            const pair = require("./coopNpcGateTravel").connectedGates({
              sourceSystemID, targetSystemID, sourceScene: sceneFor(sourceSystemID),
              getGate: (id) => worldData.getStargateByID(id),
            });
            return pair && pair[0] ? pair[0] : null;
          },
        });
      },
      // A shopping trip: nothing worth CARRYING does not mean nothing worth doing. When the
      // factory is short of an input this system cannot make, an EMPTY hull flies to the
      // station that really sells it, buys, and carries it home. Measured 2026-10-31: the
      // refinery here only ever saw Veldspar, so Pyerite and Mexallon never appear locally
      // while Jita sells both one gate away.
      importPlan: ({haulerID}) => {
        try {
          if (String(env.EVEJS_COOP_INPUT_IMPORT_TRIP || "0") !== "1")
            return {status: "IMPORT_DISABLED"};
          const home = factoryStation();
          if (!home) return {status: "NO_FACTORY_STATION"};
          const need = nextMissingInput(factorySupply(home));
          if (!need) return {status: "NOTHING_TO_BUY"};
          // One shopping trip per input at a time. Measured 2026-10-31: three hulls planned
          // the same Mexallon shortfall and bought 420 units for a 119-unit need, because the
          // material sits in a HOLD until the trip comes home and the hangar is recomputed.
          try {
            const runs = require("./coopDistributionRun").list(env) || [];
            const busy = runs.find((row) => row && String(row.mode) === "import" &&
              Number(row.haulerID) !== Number(haulerID) &&
              (Array.isArray(row.importTypes) ? row.importTypes : []).map(Number)
                .includes(Number(need.typeID)) &&
              !["RETURN", "DONE", "PLAN"].includes(String(row.phase)));
            if (busy) return {status: "IMPORT_IN_PROGRESS",
              haulerID: Number(busy.haulerID), typeID: Number(need.typeID)};
          } catch (_error) { /* no journal directory is no lock */ }
          const native = store.getNativeEntity(haulerID);
          const here = Number(native && native.systemID) || 0;
          if (!here) return {status: "HULL_UNKNOWN"};
          // A shopping trip needs ROOM, not an empty hold: measured 2026-10-31 three hulls were
          // carrying ore no station in the region bids for, which is exactly why nothing was
          // being manufactured. The trader sells a few units per trade, so a few cubic metres
          // of free space is enough, and the cargo stays aboard for its own trip later.
          const carried = store.listNativeCargoForEntity(haulerID) || [];
          let usedM3 = 0;
          for (const row of carried) {
            const volume = Number(inventory.resolveItemByTypeID(Number(row.typeID))?.volume) || 0;
            usedM3 += Math.max(0, Number(row.quantity) || 0) * volume;
          }
          const holdM3 = typeof capacityM3 === "function" ? Number(capacityM3(haulerID)) || 0 : 0;
          if (holdM3 > 0 && holdM3 - usedM3 < 5) return {status: "HOLD_FULL"};
          const db = openDb();
          if (!db) return {status: "BOOK_UNAVAILABLE"};
          // The hull's own system first, then the one gate away: a shopping trip is not a
          // tour of the region.
          const systems = [here];
          try {
            const scene = sceneFor(here);
            for (const entity of (scene && Array.isArray(scene.staticEntities)
              ? scene.staticEntities : [])) {
              if (String(entity.kind) !== "stargate") continue;
              const gate = worldData.getStargateByID(entity.itemID);
              const destination = Number(gate && gate.destinationSolarSystemID) || 0;
              if (destination && destination !== here && !systems.includes(destination))
                systems.push(destination);
            }
          } catch (_error) { /* the hull's own system is still a candidate */ }
          let best = null;
          for (const systemID of systems) {
            let row = null;
            try {
              row = db.prepare("select station_id, price, quantity from seed_stock " +
                "where solar_system_id=? and type_id=? and quantity>0 " +
                "order by price asc limit 1").get(Number(systemID), Number(need.typeID));
            } catch (_error) { row = null; }
            if (!row || !(Number(row.price) > 0)) continue;
            const price = Number(row.price);
            if (!best || price < best.price)
              best = {price, stationID: Number(row.station_id), systemID};
          }
          if (!best) return {status: "NO_SELLER", typeID: Number(need.typeID)};
          const homeStation = worldData.getStationByID(home);
          const homeSystemID = Number(homeStation && homeStation.solarSystemID) || 0;
          let gate = null;
          if (best.systemID !== here) {
            const pair = require("./coopNpcGateTravel").connectedGates({
              sourceSystemID: here, targetSystemID: best.systemID,
              sourceScene: sceneFor(here), getGate: (id) => worldData.getStargateByID(id)});
            if (!pair || !pair[0]) return {status: "NO_RECIPROCAL_GATE",
              typeID: Number(need.typeID), toSystemID: best.systemID};
            gate = {sourceGateID: pair[0].sourceGateID,
              destinationGateID: pair[0].destinationGateID,
              sourceSystemID: here, destinationSystemID: best.systemID};
          }
          return {status: "OK", trip: {mode: "import", typeID: Number(need.typeID),
            quantity: 0, expectedIsk: 0, price: best.price,
            fromStationID: best.stationID, fromSystemID: best.systemID,
            toStationID: best.stationID, toSystemID: best.systemID,
            homeStationID: Number(home), homeSystemID, gate,
            items: [{stationID: best.stationID, typeID: Number(need.typeID), quantity: 0}]}};
        } catch (error) {
          return {status: "IMPORT_PLAN_THREW",
            reason: String((error && error.message) || error).slice(0, 80)};
        }
      },
      // Import what this system cannot produce. The refinery here only sees Veldspar
      // (`refined 17471 -> 1 mineral`), so Pyerite and Mexallon exist only at a station that
      // really sells them; a hull standing there with an empty hold is the ship that carries
      // them home, where they stow into the factory hangar.
      buyInputs: async ({haulerID, stationID, systemID}) => {
        try {
          const home = factoryStation();
          if (!home) return {status: "NO_FACTORY_STATION"};
          if (Number(home) === Number(stationID)) return {status: "NOTHING_TO_BUY"};
          const plan = factorySupply(home);
          const need = nextMissingInput(plan);
          if (!need) return {status: "NOTHING_TO_BUY"};
          const answer = await require("./coopVirtualWorldRuntime").buyFromStationStock({
            systemID: Number(systemID), stationID: Number(stationID), typeID: Number(need.typeID),
            haulerID: Number(haulerID), intent: "input"});
          const status = String(answer && answer.status || "NO_ANSWER");
          if (status === "TRADE_SETTLED") {
            try { require("./coopRuntimeProbe").observe("living-npc-input-bought", null,
              {spaceState: {systemID: Number(systemID), stationID: Number(stationID)}},
              {haulerID: Number(haulerID), typeID: Number(need.typeID), stationID: Number(home),
               quantity: Number(answer.quantity || 0), price: Number(answer.price || 0),
               status: "BOUGHT"}); } catch (_error) { /* telemetry only */ }
            return {status: "BOUGHT", typeID: Number(need.typeID),
              quantity: Number(answer.quantity || 0), price: Number(answer.price || 0),
              stillShort: Math.max(0, Number(need.short || 0) - Number(answer.quantity || 0))};
          }
          return {status, typeID: Number(need.typeID)};
        } catch (error) {
          return {status: "BUY_THREW", reason: String(error && error.message || error).slice(0, 80)};
        }
      },
      // Called by the run after a delivery really reached the hangar.
      refreshFactorySupply,
      stow: ({haulerID, stationID, categoryID, types}) => {
        try {
          return require("./coopNpcCargoStow").createCargoStow({
            store, items, sceneFor, getStation: (id) => worldData.getStationByID(id),
            resolveType: (id) => inventory.resolveItemByTypeID(id),
            ownerID: Number(env.EVEJS_COOP_FACTORY_CORP_ID || 1000129),
            root: env.EVEJS_COOP_NPC_INDUSTRY_ROOT || "/var/lib/evejs/coop-native-industry",
            probe: require("./coopRuntimeProbe"),
          }).stow({haulerID, stationID, categoryID, types});
        } catch (error) {
          return {status: "STOW_THREW", reason: String(error && error.message || error).slice(0, 90)};
        }
      },
      lift: async ({haulerID, stationID, systemID, demand}) => {
        const lift = require("./coopNpcMineralLift").createMineralLift({
          store, items, getStation: (id) => worldData.getStationByID(id),
          resolveType: (id) => inventory.resolveItemByTypeID(id),
          corpID: Number(env.EVEJS_COOP_FACTORY_CORP_ID || 1000129),
          call: (method, params) => require("../services/market/marketDaemonClient")
            .marketDaemonClient.call(method, params),
          root: env.EVEJS_COOP_NPC_MARKET_ROOT || "/var/lib/evejs/coop-native-market",
          probe: require("./coopRuntimeProbe"),
        });
        return lift.lift({systemID, stationID, haulerID, cap: 1e6, demand,
          reserve: industryReserve(stationID),
          capM3: Number(capacityM3) || 0,
          volumeOf: (id) => Number(inventory.resolveItemByTypeID(id)?.volume) || 0});
      },
      planCrossing: ({haulerID, gate}) => {
        const native = store.getNativeEntity(haulerID);
        return require("./coopNpcGateCrossing").plan({
          entityID: haulerID, pilotID: pilotFor(haulerID),
          operatorKind: String(native && native.operatorKind || ""), gate, now: Date.now(),
        });
      },
      // The way home: a real reciprocal gate between where the hull is and where it belongs.
      planCrossingTo: ({haulerID, targetSystemID}) => {
        const native = store.getNativeEntity(haulerID);
        const fromSystemID = Number(native && native.systemID) || 0;
        if (!fromSystemID || !targetSystemID || fromSystemID === Number(targetSystemID))
          return {status: "NO_GATE"};
        const pair = require("./coopNpcGateTravel").connectedGates({
          sourceSystemID: fromSystemID, targetSystemID: Number(targetSystemID),
          sourceScene: sceneFor(fromSystemID),
          getGate: (id) => worldData.getStargateByID(id),
        });
        const gate = pair && pair[0] ? pair[0] : null;
        if (!gate) return {status: "NO_RECIPROCAL_GATE"};
        return require("./coopNpcGateCrossing").plan({
          entityID: haulerID, pilotID: pilotFor(haulerID),
          operatorKind: String(native && native.operatorKind || ""),
          gate: {sourceGateID: gate.sourceGateID, destinationGateID: gate.destinationGateID,
            sourceSystemID: fromSystemID, destinationSystemID: Number(targetSystemID)},
          now: Date.now(),
        });
      },
      hullSystemOf: (haulerID) => {
        try { return Number(store.getNativeEntity(haulerID)?.systemID || 0); }
        catch (_error) { return 0; }
      },
      // A station in this hull's own system that bids for what it is carrying, so leftovers
      // are sold instead of parked.
      // The same question one gate away: a neighbour whose book takes what this hull carries.
      buyerForCargo: ({haulerID}) => {
        try {
          const native = store.getNativeEntity(haulerID);
          const fromSystemID = Number(native && native.systemID) || 0;
          const carried = (store.listNativeCargoForEntity(haulerID) || [])
            .map((row) => Number(row.typeID)).filter(Boolean);
          const db = openDb();
          if (!fromSystemID || !db || !carried.length) return null;
          const planModule = require("./coopDistributionPlan");
          const row = (planModule.stockSystems({items, worldData}) || []).find((entry) =>
            entry.systemID && entry.systemID !== fromSystemID);
          const neighbours = new Set();
          const scene = sceneFor(fromSystemID);
          for (const entity of (scene && Array.isArray(scene.staticEntities)
            ? scene.staticEntities : [])) {
            if (String(entity.kind) !== "stargate") continue;
            const gate = worldData.getStargateByID(entity.itemID);
            const destination = Number(gate && gate.destinationSolarSystemID) || 0;
            if (destination && destination !== fromSystemID) neighbours.add(destination);
          }
          const systems = [...neighbours];
          if (row && neighbours.has(row.systemID)) systems.unshift(row.systemID);
          for (const systemID of systems) {
            const answer = planModule.stationForTypes({db, systemID, typeIDs: carried});
            if (answer && Number(answer.stationID) > 0)
              return {systemID, stationID: Number(answer.stationID)};
          }
        } catch (_error) { return null; }
        return null;
      },
      stationForCargo: ({haulerID}) => {
        try {
          const native = store.getNativeEntity(haulerID);
          const systemID = Number(native && native.systemID) || 0;
          const carried = (store.listNativeCargoForEntity(haulerID) || [])
            .map((row) => Number(row.typeID)).filter(Boolean);
          const answer = require("./coopDistributionPlan").stationForTypes({
            db: openDb(), systemID, typeIDs: carried});
          return Number(answer && answer.stationID) || 0;
        } catch (_error) { return 0; }
      },
      // Where the corporation really keeps its freight, so a hull parked in the buyer system
      // can go and get some instead of idling there.
      homeSystemFor: ({haulerID}) => {
        try {
          const systems = require("./coopDistributionPlan").stockSystems({items, worldData});
          const native = store.getNativeEntity(haulerID);
          const here = Number(native && native.systemID) || 0;
          for (const row of systems) {
            if (!row.systemID || row.systemID === here) continue;
            const pair = require("./coopNpcGateTravel").connectedGates({
              sourceSystemID: here, targetSystemID: row.systemID,
              sourceScene: sceneFor(here), getGate: (id) => worldData.getStargateByID(id),
            });
            if (pair && pair[0]) return row.systemID;
          }
        } catch (_error) { /* no reachable stock is no reposition */ }
        return 0;
      },
      // A hull that waits in the buyer system with an empty hold is dead freight.
      recycle: String(env.EVEJS_COOP_DISTRIBUTION_CYCLE || "") === "1",
      crossingPhase: (haulerID) => {
        const row = (require("./coopNpcGateCrossing").read() || [])
          .find((entry) => Number(entry.entityID) === Number(haulerID));
        return row ? String(row.phase) : null;
      },
      // Buying a blueprint is the only way the corporation can grow new products: it owned
      // four, the seeded world sells 2 772, and the native trader already matches seeded asks.
      buyBlueprint: async ({haulerID, stationID, systemID}) => {
        try {
          const inventory = require("../services/inventory/itemTypeRegistry");
          const items = require("../services/inventory/itemStore");
          const manufacture = require("./coopNpcManufacture");
          const worldData = require("./worldData");
          const Better = require("better-sqlite3");
          const db = new Better(process.env.EVEJS_MARKET_DB || "/var/lib/evejs/market/market.sqlite",
            {readonly: true, fileMustExist: true});
          const ownedRows = items.listOwnedItems(Number(process.env.EVEJS_COOP_FACTORY_CORP_ID || 1000129),
            {locationID: undefined});
          const rows = Array.isArray(ownedRows) ? ownedRows : (ownedRows && ownedRows.data) || [];
          const owned = [...new Set(rows.filter((row) => Number(row.quantity) === -1)
            .map((row) => Number(row.typeID)).filter(Boolean))];
          const stock = db.prepare("select type_id, station_id, price, quantity from seed_stock " +
            "where station_id=? and quantity>0").all(Number(stationID));
          const asks = [];
          const productOf = {};
          // Only what the budget could ever buy: a recipe lookup for every seeded blueprint
          // at a trade hub is what turned one beat into a HULL_TIMEOUT.
          const priceCap = Number(process.env.EVEJS_COOP_BLUEPRINT_PRICE_CAP || 500000);
          for (const row of stock) {
            const typeID = Number(row.type_id);
            if (!(Number(row.price) > 0) || Number(row.price) > priceCap) continue;
            const meta = inventory.resolveItemByTypeID(typeID) || {};
            if (Number(meta.categoryID) !== 9) continue;
            const plan = blueprintRecipe(manufacture, typeID);
            if (plan && plan.status === "READY") productOf[typeID] = Number(plan.productTypeID);
            asks.push({typeID, name: String(meta.name || typeID), stationID: Number(row.station_id),
              price: Number(row.price) || 0, quantity: Number(row.quantity) || 0});
          }
          // Can it be BUILT here? A blueprint is useless at a station that holds none of its
          // materials (measured: 2.8 M Tritanium at 60000682, chipset blueprint at 60014935).
          const runsAtStation = {};
          // The factory is where the materials sit, not the station the hull happens to shop
          // at: a blueprint bought in Jita is worthless there and profitable at home.
          const buildStation = factoryStation() || Number(stationID);
          for (const typeID of Object.keys(productOf)) {
            const plan = blueprintRecipe(manufacture, Number(typeID));
            if (!plan || plan.status !== "READY") continue;
            let runs = Infinity;
            for (const material of plan.materials || []) {
              const held = rows.filter((row) => Number(row.typeID) === Number(material.typeID) &&
                Number(row.locationID) === Number(buildStation))
                .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
              runs = Math.min(runs, Math.floor(held / Math.max(1, Number(material.quantity))));
            }
            if (Number.isFinite(runs)) runsAtStation[Number(typeID)] = Math.max(0, runs);
          }
          // Demand is where the PRODUCT can be sold, not where the blueprint is bought: measured
          // 2026-10-31 the chooser found nothing because it asked New Caldari (83 LP bids) while
          // the goods sell in Jita one gate away.
          const demandSystems = [Number(systemID)];
          try {
            const scene = sceneFor(Number(systemID));
            for (const entity of (scene && Array.isArray(scene.staticEntities)
              ? scene.staticEntities : [])) {
              if (String(entity.kind) !== "stargate") continue;
              const gate = worldData.getStargateByID(entity.itemID);
              const destination = Number(gate && gate.destinationSolarSystemID) || 0;
              if (destination && !demandSystems.includes(destination)) demandSystems.push(destination);
            }
          } catch (_error) { /* the hull system alone is still a real answer */ }
          const demand = {};
          const placeholders = demandSystems.map(() => "?").join(",");
          for (const row of db.prepare("select type_id, sum(quantity) as volume, max(price) as price " +
            "from seed_buy_orders where solar_system_id in (" + placeholders + ") and quantity>0 " +
            "group by type_id").all(...demandSystems)) {
            const typeID = Number(row.type_id);
            const current = demand[typeID] || {volume: 0, price: 0};
            demand[typeID] = {volume: current.volume + (Number(row.volume) || 0),
              price: Math.max(current.price, Number(row.price) || 0)};
          }
          db.close();
          // What each recipe eats, at the prices this region really pays for those materials:
          // a material nobody bids for here costs nothing to consume, which is exactly why the
          // corporation's own Tritanium is free to turn into something that does have a buyer.
          const unitCostOf = {};
          for (const typeID of Object.keys(productOf)) {
            const plan = blueprintRecipe(manufacture, Number(typeID));
            if (!plan || plan.status !== "READY") continue;
            let cost = 0;
            for (const material of plan.materials || []) {
              const quote = demand[Number(material.typeID)] || demand[String(material.typeID)];
              cost += Number(material.quantity) * Number((quote && quote.price) || 0);
            }
            unitCostOf[Number(typeID)] =
              cost / Math.max(1, Number(plan.productPerRun) || 1);
          }
          const chosen = require("./coopBlueprintPurchase").choose({asks, owned, demand, productOf,
            runsAtStation, unitCostOf,
            budget: Number(process.env.EVEJS_COOP_BLUEPRINT_BUDGET || 5000000),
            priceCap: Number(process.env.EVEJS_COOP_BLUEPRINT_PRICE_CAP || 500000)});
          if (chosen.status !== "BUY") return chosen;
          // The market pays for a purchase from the PILOT's earned balance, not from the
          // corporation's treasury: measured 2026-10-31 the trader refused
          // INSUFFICIENT_EARNED_ISK for a 42 500 ISK blueprint on a fresh identity. Give the
          // hull a pilot that has actually earned the money, using the same link mechanism the
          // sale uses.
          try {
            const ledgerFile = require("path").join(process.env.EVEJS_COOP_NPC_MARKET_ROOT ||
              "/var/lib/evejs/coop-native-market", "ledger.json");
            const pilots = (JSON.parse(require("fs").readFileSync(ledgerFile, "utf8")) || {}).pilots || {};
            const registry = require("./coopIdentityRegistry").createRegistry({
              file: env.EVEJS_COOP_IDENTITY_FILE || "/var/lib/evejs/coop-npc-links.json",
              exists: (system, id) => {
                try {
                  const scene = sceneFor(system);
                  const ship = scene && scene.getEntityByID ? scene.getEntityByID(id) : null;
                  return Boolean(ship && ship.kind === "ship");
                } catch (_error) { return false; }
              },
            });
            const links = (registry.snapshot() || {}).links || {};
            const bound = Object.entries(links)
              .find(([, row]) => Number(row && row.entityID) === Number(haulerID));
            const boundBalance = bound ? Number((pilots[bound[0]] || {}).balance || 0) : 0;
            const price = Number(chosen.blueprint.price) || 0;
            if (boundBalance < price) {
              const richer = Object.entries(pilots)
                .filter(([id, row]) => Number(row && row.balance) >= price && !links[id])
                .sort((a, b) => Number(b[1].balance) - Number(a[1].balance))[0];
              if (richer) {
                if (bound) registry.release(bound[0], {expectedEntityID: Number(haulerID)});
                registry.link({id: richer[0], name: richer[0], faction: "independent",
                  role: "hauler", durable: false}, systemID, haulerID);
              }
            }
          } catch (_error) { /* the purchase reports its own refusal */ }
          const owner = require("./coopVirtualWorldRuntime");
          const bought = typeof owner.buyFromStationStock === "function"
            ? await owner.buyFromStationStock({systemID, stationID, typeID: chosen.blueprint.typeID,
              haulerID, scene: sceneFor(systemID)}) : {status: "NO_BUYER"};
          return {chosen: chosen.blueprint, bought};
        } catch (error) {
          return {status: "BUY_THREW", reason: String((error && error.message) || error).slice(0, 90),
            stack: String((error && error.stack) || "").split("\n").slice(1, 4).join(" | ").slice(0, 200)};
        }
      },
      sell: ({haulerID, stationID, systemID}) => {
        // The arrival sale only trades through a hull that is NAMED as a hauler. Measured
        // 2026-10-30: the hull was linked here with an empty role and every sale answered
        // HAULER_NOT_NAMED while the cargo sat in its real hold.
        try {
          const identityFile = env.EVEJS_COOP_IDENTITY_FILE ||
            "/var/lib/evejs/coop-npc-links.json";
          const registry = require("./coopIdentityRegistry").createRegistry({
            file: identityFile,
            exists: (system, id) => {
              try {
                const scene = sceneFor(system);
                const ship = scene && scene.getEntityByID ? scene.getEntityByID(id) : null;
                return Boolean(ship && ship.kind === "ship");
              } catch (_error) { return false; }
            },
          });
          let links = (registry.snapshot() || {}).links || {};
          let bound = Object.entries(links)
            .find(([, row]) => Number(row && row.entityID) === Number(haulerID));
          // A pending trade journal blocks a PILOT, not a ship: the world refuses every sale of
          // that identity until an operator settles it. Measured 2026-10-31 a hull sat blocked
          // UNRESOLVED_MARKET_JOURNAL with real cargo aboard while the journal could not be
          // proven (the market's order row says NOT_FILLED). The goods move under a clean
          // identity; the old journal stays pending for the operator, untouched.
          try {
            const txDir = require("path").join(process.env.EVEJS_COOP_NPC_MARKET_ROOT ||
              "/var/lib/evejs/coop-native-market", "tx");
            if (bound && require("fs").existsSync(require("path").join(txDir, bound[0] + ".json"))) {
              registry.release(bound[0], {expectedEntityID: Number(haulerID)});
              links = (registry.snapshot() || {}).links || {};
              let free = null;
              for (let n = 1; n <= 9999; n += 1) {
                const candidate = "coop-pilot-" + String(n).padStart(3, "0");
                if (!links[candidate]) { free = candidate; break; }
              }
              if (free) {
                registry.link({id: free, name: free, faction: "independent", role: "hauler",
                  durable: false}, systemID, haulerID);
                bound = [free, {pilotID: free, role: "hauler", entityID: haulerID, systemID}];
              }
            }
          } catch (_error) { /* the sale reports its own refusal below */ }
          const role = bound ? String(bound[1].role || "") : "";
          if (!bound || !role || !["hauler", "miner", "trader"].includes(role)) {
            const pilotID = bound ? bound[0] : "coop-pilot-027";
            if (bound) registry.release(pilotID, {expectedEntityID: Number(haulerID)});
            registry.link({id: pilotID, name: bound ? bound[1].name : pilotID,
              faction: "independent", role: "hauler", durable: false}, systemID, haulerID);
          }
        } catch (_identityError) { /* the sale reports its own refusal below */ }
        // A crashed partial fill leaves a journal behind and every later sale is refused
        // UNRESOLVED_MARKET_JOURNAL until somebody reconciles it. The world can read the
        // market's own row and settle it: that is the proof, not a re-send.
        try { require("./coopVirtualWorldRuntime").reconcileMarketJournalsAtBoot(true); }
        catch (_error) { /* reported by the sale itself */ }
        try {
          return require("./coopVirtualWorldRuntime").sellOnArrival({systemID, stationID,
            haulerID, types: [], scene: sceneFor(systemID)});
        } catch (error) {
          return {status: "SALE_THREW", reason: String((error && error.message) || error)};
        }
      },
      // The settled sale result lives for about five seconds, so the run must be able to
      // read it directly instead of waiting for the next beat to find it gone.
      saleSettlement: (haulerID, stationID) => {
        try {
          const map = require("./coopVirtualWorldRuntime.pure").arrivalSales;
          const job = map && typeof map.get === "function"
            ? map.get(String(Number(stationID)) + ":" + String(Number(haulerID))) : null;
          return job && job.settled ? job.settled : null;
        } catch (_error) { return null; }
      },
      cargoUnits: (haulerID) => {
        try {
          return (store.listNativeCargoForEntity(haulerID) || [])
            .reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 0), 0);
        } catch (_error) { return null; }
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || 1))),
      // The station in this hull's system that holds the most corporation stock: that is where
      // a blueprint is worth buying and where its materials already are.
      stockStationFor: ({haulerID}) => {
        try {
          const native = store.getNativeEntity(haulerID);
          const systemID = Number(native && native.systemID) || 0;
          const scene = sceneFor(systemID);
          const stations = new Set((scene && Array.isArray(scene.staticEntities)
            ? scene.staticEntities : []).filter((row) => String(row.kind) === "station")
            .map((row) => Number(row.itemID)).filter(Boolean));
          const items = require("../services/inventory/itemStore");
          const owned = items.listOwnedItems(Number(process.env.EVEJS_COOP_FACTORY_CORP_ID || 1000129),
            {locationID: undefined});
          const rows = Array.isArray(owned) ? owned : (owned && owned.data) || [];
          const totals = new Map();
          for (const row of rows) {
            const stationID = Number(row.locationID) || 0;
            if (!stationID || !stations.has(stationID)) continue;
            if (Number(row.flagID) !== 4) continue;
            totals.set(stationID, (totals.get(stationID) || 0) + Math.max(0, Number(row.quantity) || 0));
          }
          let best = {stationID: 0, units: 0};
          for (const [stationID, units] of totals) if (units > best.units) best = {stationID, units};
          return best.stationID;
        } catch (_error) { return 0; }
      },
      observe: require("./coopRuntimeProbe").observe,
      minIsk: Number(env.EVEJS_COOP_DISTRIBUTION_MIN_ISK || 200000),
    };
  } catch (error) {
    return {hulls: () => [], planTrip: () => ({status: "AUTHORITY_UNAVAILABLE",
      reason: String((error && error.message) || error).slice(0, 90)})};
  }
}
// The crossing needs real scenes, real gates, the live identity registry and the verified
// native transfer - never a stub. Eager requirements are lazy so a world without them still
// boots; a missing authority is reported, not guessed.
function distributionAuthorities(options = {}) {
  try {
    const runtime = require("./runtime");
    const worldData = require("./worldData");
    const controllers = require("./npc/npcRegistry");
    const npc = require("./npc/npcRuntime");
    const sceneForSystem = options.sceneForSystem ||
      ((id) => runtime.ensureScene(id, {refreshStargates: false}));
    const getGate = options.getGate || ((id) => worldData.getStargateByID(id));
    let transfer = options.transfer || null;
    let sharedIdentity = null;
    if (!transfer) {
      // NOT the shared war adapter: measured 2026-10-30, it carries the identity registry
      // built at boot, so a hull linked afterwards is invisible to its preflight and every
      // attempt is refused SOURCE_IDENTITY_MISMATCH. The co-op builds its own transfer from a
      // FRESH read of the durable identity file - the same file, one record owner per
      // journey, and no second long-lived writer.
      const registry = require("./coopIdentityRegistry").createRegistry({
        file: (options.env || process.env).EVEJS_COOP_IDENTITY_FILE ||
          "/var/lib/evejs/coop-npc-links.json",
        exists: (system, id) => {
          try {
            const scene = runtime.ensureScene(system, {refreshStargates: false});
            const ship = scene && scene.getEntityByID ? scene.getEntityByID(id) : null;
            return Boolean(ship && ship.kind === "ship");
          } catch (_error) { return false; }
        },
      });
      const prepared = require("./coopNativeGateTransfer").createNativeGateTransfer({
        sceneForSystem, getGate,
        store: require("./npc/nativeNpcStore"),
        service: require("./npc/nativeNpcService"),
        getController: (id) => controllers.getControllerByEntityID(id),
        registry,
        isScrambled: (ship) =>
          require("./modules/hostileModuleRuntime").isEntityWarpScrambled(ship),
      });
      // A co-op adapter owns its own interrupted crossings first, exactly as the war
      // instance does at boot; an unreadable journal must stop it, not be ignored.
      const recovered = typeof prepared.recoverPending === "function"
        ? prepared.recoverPending() : {status: "NONE"};
      if (recovered && recovered.status === "NEEDS_OPERATOR_REPAIR")
        return {status: "CROSSING_REPAIR_REQUIRED"};
      transfer = prepared.transfer.bind(prepared);
      // The same durable record answers both questions: who the hull is, and where it is.
      sharedIdentity = registry;
    }
    return {
      status: "OK",
      sceneForSystem,
      getGate,
      getController: options.getController || ((id) => controllers.getControllerByEntityID(id)),
      // The answer is returned whole, so a refusal can report its own reason.
      warpToGate: options.warpToGate || ((id, gateID) => npc.warpToEntity(id, gateID, {})),
      // The durable final approach the gate travel module proves: a manual follow order,
      // because a warp refuses a target that is already a few kilometres away.
      followGate: options.followGate || ((id, gateID) => {
        try {
          const answer = require("./npc/npcService").issueManualOrder(id, {
            type: "follow", targetID: gateID, followRangeMeters: 1000, allowWeapons: false,
          });
          return answer && answer.success === true;
        } catch (_error) { return false; }
      }),
      transfer,
      // A crossing may re-establish a pruned identity link from the durable record.
      identity: options.identity || sharedIdentity,
      hullSystemOf: options.hullSystemOf || ((id) => {
        try { return Number(require("./npc/nativeNpcStore").getNativeEntity(id)?.systemID || 0); }
        catch (_error) { return 0; }
      }),
      // The adapter refuses a scrambled hull, so the diagnostic asks the same question.
      isScrambled: options.isScrambled || ((ship) => {
        try { return require("./modules/hostileModuleRuntime").isEntityWarpScrambled(ship) === true; }
        catch (_error) { return false; }
      }),
      // A hull that keeps re-locking is stood down with the native order type the behaviour
      // loop itself honours, never by writing currentTargetID.
      standDown: options.standDown || ((id) => {
        try {
          const answer = require("./npc/npcService").issueManualOrder(id, { type: "stop" });
          return answer && answer.success === true;
        } catch (_error) { return false; }
      }),
      // A durable ship whose scene was rebuilt is re-materialized from its own record.
      materialize: options.materialize ||
        ((scene, id) => require("./npc/nativeNpcService").materializeStoredNativeController(scene, id)),
    };
  } catch (error) {
    return {status: "AUTHORITY_UNAVAILABLE", reason: String((error && error.message) || error).slice(0, 90)};
  }
}
/**
 * Run every enabled phase once. Returns {statuses, failures} - never throws.
 */
function tick(options = {}) {
  const env = options.env || process.env;
  const statuses = {};
  const failures = [];
  const run = (phase, enabled, call) => {
    if (!enabled) { statuses[phase] = "DISABLED"; return; }
    try { statuses[phase] = call(); }
    catch (error) {
      statuses[phase] = "THREW";
      failures.push({ phase, reason: String((error && error.message) || error).slice(0, 90) });
      note(options, phase, error);
    }
  };
  run("refinery", String(env.EVEJS_COOP_NPC_REFINERY || "") === "1", () =>
    String(require("./coopNpcRefineryTick").tick({
      systemID: options.systemID, stationID: options.stationID, fleetID: options.fleetID,
      gameStore: options.gameStore, marketRoot: options.marketRoot, now: options.now,
    }).status || "UNKNOWN"));
  run("manufacture", String(env.EVEJS_COOP_NPC_MANUFACTURE || "") === "1", () =>
    String(require("./coopNpcManufactureTick").tick({
      systemID: options.systemID, now: options.now,
      // Demand one gate away is real demand: the manufacturer may build for a buyer the
      // freight run can actually reach.
      // What the corporation cannot make, so a full warehouse of demand does not look like
      // an idle manufacturer.
      demandGap: ({limit}) => {
        try {
          const inventory = require("../services/inventory/itemTypeRegistry");
          const worldData = require("./worldData");
          const runtime = require("./runtime");
          const items = require("../services/inventory/itemStore");
          const manufacture = require("./coopNpcManufacture");
          const Better = require("better-sqlite3");
          const db = new Better(process.env.EVEJS_MARKET_DB || "/var/lib/evejs/market/market.sqlite",
            {readonly: true, fileMustExist: true});
          const owned = items.listOwnedItems(Number(process.env.EVEJS_COOP_FACTORY_CORP_ID || 1000129),
            {locationID: undefined});
          const rows = Array.isArray(owned) ? owned : (owned && owned.data) || [];
          const blueprints = [...new Set(rows.filter((row) => Number(row.quantity) === -1)
            .map((row) => Number(row.typeID)).filter(Boolean))];
          const systemIDs = [];
          for (const row of rows) {
            const station = worldData.getStationByID(Number(row.locationID));
            const systemID = Number(station && station.solarSystemID) || 0;
            if (systemID && !systemIDs.includes(systemID)) systemIDs.push(systemID);
          }
          const scene = sceneFor(options.systemID || systemIDs[0] || 0);
          for (const entity of (scene && Array.isArray(scene.staticEntities)
            ? scene.staticEntities : [])) {
            if (String(entity.kind) !== "stargate") continue;
            const gate = worldData.getStargateByID(entity.itemID);
            const destination = Number(gate && gate.destinationSolarSystemID) || 0;
            if (destination && !systemIDs.includes(destination)) systemIDs.push(destination);
          }
          const answer = require("./coopDemandGap").gap({db, systemIDs, blueprints,
            recipeOf: (id) => manufacture.recipe(id, 1),
            resolveType: (id) => inventory.resolveItemByTypeID(id), limit});
          db.close();
          return answer;
        } catch (_error) { return null; }
      },
      bidElsewhere: (query) => {
        try {
          const inventory = require("../services/inventory/itemTypeRegistry");
          const worldData = require("./worldData");
          const runtime = require("./runtime");
          const Better = require("better-sqlite3");
          const db = new Better(process.env.EVEJS_MARKET_DB || "/var/lib/evejs/market/market.sqlite",
            {readonly: true, fileMustExist: true});
          const station = worldData.getStationByID(Number(query.stationID));
          const fromSystemID = Number(station && station.solarSystemID) || 0;
          if (!fromSystemID) return null;
          const scene = runtime.ensureScene(fromSystemID, {refreshStargates: false});
          const systems = new Set();
          for (const entity of (scene && Array.isArray(scene.staticEntities)
            ? scene.staticEntities : [])) {
            if (String(entity.kind) !== "stargate") continue;
            const gate = worldData.getStargateByID(entity.itemID);
            const destination = Number(gate && gate.destinationSolarSystemID) || 0;
            if (destination && destination !== fromSystemID) systems.add(destination);
          }
          if (!systems.size) return null;
          const placeholders = [...systems].map(() => "?").join(",");
          const row = db.prepare("select station_id, solar_system_id, max(price) as price, " +
            "sum(quantity) as volume from seed_buy_orders where type_id=? and quantity>0 " +
            "and solar_system_id in (" + placeholders + ") group by station_id " +
            "order by price desc limit 1").get(Number(query.productTypeID), ...[...systems]);
          db.close();
          if (!row) return null;
          return {price: Number(row.price) || 0, volume: Number(row.volume) || 0,
            stationID: Number(row.station_id) || 0, systemID: Number(row.solar_system_id) || 0};
        } catch (_error) { return null; }
      },
    }).status || "UNKNOWN"));
  // The distribution crossing only ever advances a run an operator already journaled; it
  // never plans or starts one on its own (cross-system transfer is opt-in, see the docs).
  // It also needs a native transfer adapter, which the caller must supply: without one the
  // phase reports TRANSFER_UNAVAILABLE instead of pretending a hull could cross.
  // One real freight trip: lift at the origin station, cross the gate, sell at the
  // destination. It is DISPATCHED rather than awaited here because the lift and the sale
  // are journaled async work; a second beat while one is in flight would half-do a trip.
  const wantsRun = String(env.EVEJS_COOP_DISTRIBUTION_RUN || "") === "1";
  if (!wantsRun) statuses.distributionRun = "DISABLED";
  else if (distributionRunInFlight) statuses.distributionRun = "IN_FLIGHT";
  else {
    distributionRunInFlight = true;
    Promise.resolve()
      .then(() => require("./coopDistributionRun").tickAll(distributionRunAuthorities(options)))
      .then((rows) => {
        const summary = (rows || []).map((row) => String(row.status || "")).join(",");
        if (summary !== lastDistributionRunStatus) {
          lastDistributionRunStatus = summary;
          observeLoop("living-coop-loop-distribution-run", null, null, { status: summary || "EMPTY" });
        }
      })
      .catch((error) => observeLoop("living-coop-loop-distribution-run-failed", null, null,
        { reason: String((error && error.message) || error).slice(0, 90) }))
      .finally(() => { distributionRunInFlight = false; });
    statuses.distributionRun = "DISPATCHED";
  }
  const wantsDistribution = String(env.EVEJS_COOP_DISTRIBUTION || "") === "1";
  if (!wantsDistribution) statuses.distribution = "DISABLED";
  else {
    run("distribution", true, () => {
      const authorities = distributionAuthorities(options);
      if (authorities.status !== "OK") {
        // A phase that quietly declines to run looks exactly like a phase that works and
        // has nothing to do; the reason is reported once per change.
        if (lastDistributionStatus !== authorities.status) {
          lastDistributionStatus = authorities.status;
          note(options, "distribution",
            {status: authorities.status, reason: authorities.reason || null});
        }
        return authorities.status;
      }
      return String(require("./coopNpcGateCrossing").tick({
        ...authorities, now: options.now,
        observe: options.observe || require("./coopRuntimeProbe").observe,
      }).status || "UNKNOWN");
    });
  }
  return { status: failures.length ? "PARTIAL" : "OK", statuses, failures };
}

// Advance any operator-journaled crossing. Exported so more than one periodic phase can
// drive it: the crossing is durable, so driving it twice in the same minute is harmless.
function advanceDistribution(options = {}) {
  const env = options.env || process.env;
  if (String(env.EVEJS_COOP_DISTRIBUTION || "") !== "1") return {status: "DISABLED"};
  const authorities = distributionAuthorities(options);
  if (authorities.status !== "OK") return authorities;
  return require("./coopNpcGateCrossing").tick({
    ...authorities, now: options.now,
    observe: options.observe || require("./coopRuntimeProbe").observe,
  });
}

module.exports = { PHASES, tick, advanceDistribution, distributionAuthorities, distributionRunAuthorities };
