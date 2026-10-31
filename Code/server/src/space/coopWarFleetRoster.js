"use strict";
// FW-027 (fleet reconstitution): war fleets do not simply disappear.
//
// Why this exists: a faction war reads as alive only when a beaten fleet comes
// back. When a fleet loses hulls, the survivors disengage to a real friendly
// staging point and merge with hulls that REALLY exist (never conjured, never a
// clone of a destroyed ship) into a new fleet with the doctrine mix the current
// commander rank allows. If no real replacement exists the fleet stays smaller
// and that is reported, not padded.
//
// Rules this module enforces:
//   * only hulls whose entity is really alive survive; a hull that is gone but
//     was never recorded as lost is marked LOST_UNRECORDED and reported;
//   * an adopted replacement must be a real, free, native hull in the staging
//     system, proved by the injected `listFreeHulls` authority (identity
//     registry: no pilot link, alive) - the roster never spawns a ship;
//   * a hull already owned by any fleet in this roster can never be adopted;
//   * the new fleet's size follows the current command cap, so a commander who
//     lost ships and dropped rank really commands fewer ships;
//   * every loss stays on the record with its wreck/casualty evidence and is
//     returned as a real merit event (`force-lost`) for the caller to award.
const TABLE = "corporationRuntime";
const KEY = "coop-faction-war\u001ffleet-roster-v1";
const VERSION = 1;
const MAX_FLEETS = 256;
const MAX_SHIPS = 64;
const MAX_LOSSES = 256;
// FW-120: the roster must know every role a doctrine can field. MEASURED 2026-10-31: the new
// anti-tackle role was missing here, so createFleet answered FLEET_DOCTRINE_REQUIRED and NO
// formation was recorded at all - five real hulls in space, fleetID empty, and only the
// commander ever appeared in the fleet registry.
const ROLES = new Set(["tackle", "anti-tackle", "brawler", "sniper", "logistics", "ewar",
  "heavy"]);
const FACTIONS = /^[0-9]{1,20}$/;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const valid = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function empty() {
  return { version: VERSION, nextSerial: 1, fleets: {}, reserve: {}, history: [] };
}

// FW-039: the durable per-faction hull RESERVE. A faction can only replace what
// it really holds: `equipped` is decremented by a proven loss, `spawnable` is the
// count of real free native hulls a caller proved (never invented), and a
// replacement consumes one spawnable hull. Both counters are integers per role.
function emptyReserve() {
  const roles = {};
  for (const role of ROLES) roles[role] = { spawnable: 0, equipped: 0 };
  return roles;
}
function normalizeReserve(reserve) {
  const out = emptyReserve();
  if (!reserve || typeof reserve !== "object" || Array.isArray(reserve)) return out;
  for (const [role, row] of Object.entries(reserve)) {
    if (!ROLES.has(role)) continue;
    const spawnable = Number(row && row.spawnable);
    const equipped = Number(row && row.equipped);
    out[role] = {
      spawnable: Number.isSafeInteger(spawnable) && spawnable >= 0 ? spawnable : 0,
      equipped: Number.isSafeInteger(equipped) && equipped >= 0 ? equipped : 0,
    };
  }
  return out;
}

function validate(state) {
  if (!state || state.version !== VERSION || !state.fleets || typeof state.fleets !== "object" ||
    Array.isArray(state.fleets) || !Array.isArray(state.history) ||
    !pos(state.nextSerial) || Object.keys(state.fleets).length > MAX_FLEETS ||
    state.history.length > 512 ||
    (state.reserve !== undefined &&
      (typeof state.reserve !== "object" || Array.isArray(state.reserve) ||
        Object.keys(state.reserve).some((key) => !FACTIONS.test(key))))) {
    throw Error("WAR_FLEET_ROSTER_INVALID");
  }
  for (const [fleetID, fleet] of Object.entries(state.fleets)) {
    if (!valid(fleetID) || !fleet || fleet.fleetID !== fleetID || !pos(fleet.factionID) ||
      !pos(fleet.systemID) || !pos(fleet.commandCap) || !Array.isArray(fleet.ships) ||
      fleet.ships.length > MAX_SHIPS || !Array.isArray(fleet.losses) ||
      fleet.losses.length > MAX_LOSSES ||
      !["ACTIVE", "DISENGAGED", "DESTROYED", "RECONSTITUTED"].includes(fleet.state)) {
      throw Error("WAR_FLEET_ROSTER_CORRUPT_FLEET");
    }
    const entities = new Set();
    for (const ship of fleet.ships) {
      if (!pos(ship && ship.entityID) || entities.has(ship.entityID) ||
        !ROLES.has(String(ship.role || "")) || !valid(String(ship.doctrineID || "")) ||
        !["ALIVE", "LOST", "LOST_UNRECORDED", "ADOPTED"].includes(String(ship.state || ""))) {
        throw Error("WAR_FLEET_ROSTER_CORRUPT_SHIP");
      }
      entities.add(ship.entityID);
    }
  }
  return state;
}

function createWarFleetRoster(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  const gameStore = base.gameStore;
  const env = base.env || process.env;
  const clock = typeof base.clock === "function" ? base.clock : () => Date.now();
  // A hull is alive only when the native scene says so; without the authority a
  // caller must not be able to declare survivors.
  const isEntityAlive = base.isEntityAlive;
  // Real, free, native hulls in the staging system (identity registry proof).
  const listFreeHulls = base.listFreeHulls;
  if (typeof gameStore?.coopAtomicNativeRows?.transact !== "function") {
    throw Error("WAR_FLEET_ROSTER_NATIVE_AUTHORITIES_REQUIRED");
  }
  const { readRow } = require("./coopNativeRowPath" +
    (__filename.endsWith(".js") ? "" : ".cjs"));
  const enabled = () => env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_FACTION_WAR_FLEETS === "1";
  const transact = (fn) => gameStore.coopAtomicNativeRows.transact([TABLE], fn);

  function read() {
    const row = readRow(gameStore, TABLE, KEY);
    return row ? validate(clone(row)) : empty();
  }

  function snapshot() {
    if (!enabled()) return { status: "DISABLED" };
    const state = read();
    return {
      status: "OK",
      fleets: Object.keys(state.fleets).length,
      reserve: state.reserve || {},
      state: clone(state),
    };
  }

  // Read-only: what one faction really holds right now, per role.
  function reserveOf({ factionID } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const faction = String(Number(factionID) || 0);
    if (!FACTIONS.test(faction) || faction === "0") {
      return { status: "BLOCKED", reason: "FACTION_REQUIRED" };
    }
    const state = read();
    const roles = normalizeReserve((state.reserve || {})[faction]);
    const totals = Object.values(roles).reduce((acc, row) => ({
      spawnable: acc.spawnable + row.spawnable,
      equipped: acc.equipped + row.equipped,
    }), { spawnable: 0, equipped: 0 });
    return { status: "OK", factionID: Number(faction), roles, totals };
  }

  // Durable write of what a caller PROVED: free real hulls in a staging system.
  // It is a declaration with a reason, never a guess.
  function declareReserve({ factionID, role, spawnable = 0, equipped = 0,
    source = "", at = 0 } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const faction = String(Number(factionID) || 0);
    if (!FACTIONS.test(faction) || faction === "0") {
      return { status: "BLOCKED", reason: "FACTION_REQUIRED" };
    }
    if (!ROLES.has(String(role || ""))) {
      return { status: "BLOCKED", reason: "UNKNOWN_ROLE" };
    }
    if (!Number.isSafeInteger(Number(spawnable)) || Number(spawnable) < 0 ||
      !Number.isSafeInteger(Number(equipped)) || Number(equipped) < 0) {
      return { status: "BLOCKED", reason: "COUNT_NOT_AN_INTEGER" };
    }
    const when = pos(at) ? Number(at) : clock();
    return transact((tx) => {
      const state = validate(tx.get(TABLE, KEY) || empty());
      if (!state.reserve) state.reserve = {};
      const roles = normalizeReserve(state.reserve[faction]);
      roles[String(role)] = { spawnable: Number(spawnable), equipped: Number(equipped) };
      state.reserve[faction] = roles;
      state.history.push({ at: when, event: "FLEET_RESERVE_DECLARED", factionID: Number(faction),
        role: String(role), spawnable: Number(spawnable), equipped: Number(equipped),
        source: String(source || "").slice(0, 64) });
      if (state.history.length > 512) state.history.splice(0, state.history.length - 512);
      validate(state);
      tx.put(TABLE, KEY, state);
      return { status: "DECLARED", factionID: Number(faction), role: String(role),
        spawnable: Number(spawnable), equipped: Number(equipped) };
    });
  }

  function fleet(fleetID) {
    const state = read();
    const found = state.fleets[String(fleetID || "")];
    return found ? clone(found) : null;
  }

  function createFleet({ factionID, systemID, stagingSystemID = 0, rank = "", merit = 0,
    commandCap = 0, ships = [], parentFleetID = "" } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const f = Number(factionID), system = Number(systemID);
    if (!pos(f) || !pos(system)) return { status: "BLOCKED", reason: "FLEET_IDENTITY_REQUIRED" };
    if (!Array.isArray(ships) || !ships.length || ships.length > MAX_SHIPS) {
      return { status: "BLOCKED", reason: "FLEET_SHIPS_REQUIRED" };
    }
    const seen = new Set();
    const normalized = [];
    for (const ship of ships) {
      const entityID = Number(ship && ship.entityID);
      if (!pos(entityID) || seen.has(entityID)) {
        return { status: "BLOCKED", reason: "FLEET_SHIP_IDENTITY_CONFLICT" };
      }
      seen.add(entityID);
      if (!ROLES.has(String(ship.role || "")) || !valid(String(ship.doctrineID || ""))) {
        return { status: "BLOCKED", reason: "FLEET_DOCTRINE_REQUIRED", entityID };
      }
      normalized.push({
        entityID,
        slot: normalized.length,
        role: String(ship.role),
        doctrineID: String(ship.doctrineID),
        loadoutID: String(ship.loadoutID || ship.doctrineID),
        profileID: String(ship.profileID || ""),
        hullTypeID: Number(ship.hullTypeID) || 0,
        hullName: String(ship.hullName || ""),
        pilotID: String(ship.pilotID || ""),
        state: ship.state === "ADOPTED" ? "ADOPTED" : "ALIVE",
      });
    }
    const at = clock();
    return transact((tx) => {
      const state = validate(tx.get(TABLE, KEY) || empty());
      if (Object.keys(state.fleets).length >= MAX_FLEETS) {
        return { status: "BLOCKED", reason: "FLEET_ROSTER_CAP" };
      }
      // One owner per native hull: a ship already in a live fleet cannot be
      // created twice. The parent fleet of a reconstitution is the one allowed
      // source, because its hulls really transfer into the new formation.
      for (const fleet of Object.values(state.fleets)) {
        if (fleet.fleetID === String(parentFleetID || "")) continue;
        if (fleet.state === "RECONSTITUTED" || fleet.state === "DESTROYED") continue;
        for (const ship of fleet.ships) {
          if (seen.has(ship.entityID)) {
            return { status: "BLOCKED", reason: "FLEET_SHIP_ALREADY_OWNED", entityID: ship.entityID };
          }
        }
      }
      const serial = state.nextSerial;
      const fleetID = "coop-fleet-" + f + "-" + String(serial).padStart(4, "0");
      const record = {
        fleetID,
        factionID: f,
        systemID: system,
        stagingSystemID: pos(stagingSystemID) ? Number(stagingSystemID) : system,
        rank: String(rank || ""),
        merit: Number(merit) || 0,
        commandCap: pos(commandCap) ? Number(commandCap) : normalized.length,
        state: "ACTIVE",
        parentFleetID: String(parentFleetID || ""),
        createdAt: at,
        updatedAt: at,
        ships: normalized,
        losses: [],
      };
      state.fleets[fleetID] = record;
      state.nextSerial = serial + 1;
      state.history.push({ at, event: "FLEET_CREATED", fleetID, size: normalized.length });
      if (state.history.length > 512) state.history.splice(0, state.history.length - 512);
      validate(state);
      tx.put(TABLE, KEY, state);
      return {
        status: "CREATED",
        fleetID,
        size: normalized.length,
        commandCap: record.commandCap,
        composition: normalized.map((ship) => ship.role),
      };
    });
  }

  // A real loss, with its evidence. The caller proves the wreck/casualty; the
  // roster only records that this hull left the fleet.
  function recordLoss({ fleetID, entityID, wreckID = 0, casualtyID = "", at = 0 } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = String(fleetID || "");
    const entity = Number(entityID);
    if (!valid(id) || !pos(entity)) return { status: "BLOCKED", reason: "LOSS_IDENTITY_REQUIRED" };
    return transact((tx) => {
      const state = validate(tx.get(TABLE, KEY) || empty());
      const record = state.fleets[id];
      if (!record) return { status: "BLOCKED", reason: "FLEET_NOT_FOUND" };
      const ship = record.ships.find((entry) => entry.entityID === entity);
      if (!ship) return { status: "BLOCKED", reason: "SHIP_NOT_IN_FLEET" };
      if (ship.state === "LOST" || ship.state === "LOST_UNRECORDED") {
        return { status: "DUPLICATE", fleetID: id, entityID: entity };
      }
      const when = pos(at) ? Number(at) : clock();
      ship.state = "LOST";
      ship.lostAt = when;
      ship.wreckID = Number(wreckID) || 0;
      record.losses.push({
        entityID: entity,
        role: ship.role,
        doctrineID: ship.doctrineID,
        wreckID: Number(wreckID) || 0,
        casualtyID: String(casualtyID || ""),
        at: when,
      });
      if (record.losses.length > MAX_LOSSES) {
        return { status: "BLOCKED", reason: "FLEET_LOSS_CAP" };
      }
      const survivors = record.ships.filter((entry) => entry.state === "ALIVE" || entry.state === "ADOPTED");
      record.state = survivors.length ? "DISENGAGED" : "DESTROYED";
      record.updatedAt = when;
      // A proven loss really removes one equipped hull from its faction's reserve.
      if (!state.reserve) state.reserve = {};
      const faction = String(record.factionID);
      const roles = normalizeReserve(state.reserve[faction]);
      const role = ROLES.has(String(ship.role || "")) ? String(ship.role) : "brawler";
      roles[role].equipped = Math.max(0, roles[role].equipped - 1);
      state.reserve[faction] = roles;
      state.history.push({ at: when, event: "FLEET_LOSS", fleetID: id, entityID: entity, survivors: survivors.length });
      if (state.history.length > 512) state.history.splice(0, state.history.length - 512);
      validate(state);
      tx.put(TABLE, KEY, state);
      return {
        status: "RECORDED",
        fleetID: id,
        entityID: entity,
        survivors: survivors.length,
        lost: record.losses.length,
        fleetState: record.state,
        factionID: record.factionID,
        role,
        reserve: roles[role],
        frontChat: { kind: "fleet-loss", eventKey: "loss:" + id + ":" + entity,
          factionID: record.factionID, role, systemID: record.systemID,
          remaining: survivors.length, lost: record.losses.length },
        meritEvent: { kind: "force-lost", count: 1, fleetID: id, pilotID: ship.pilotID },
      };
    });
  }

  // Pure plan: who survives, what can really be adopted, and what the current
  // command cap allows. Nothing is written and no ship is created.
  function planReconstitution({ fleetID, stagingSystemID = 0, rank = "", merit = 0,
    compose = null, at = 0 } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const record = fleet(fleetID);
    if (!record) return { status: "BLOCKED", reason: "FLEET_NOT_FOUND" };
    const staging = pos(stagingSystemID) ? Number(stagingSystemID) : record.stagingSystemID;
    const survivors = [];
    const unrecorded = [];
    for (const ship of record.ships) {
      if (ship.state !== "ALIVE" && ship.state !== "ADOPTED") continue;
      let alive = true;
      if (typeof isEntityAlive === "function") {
        try {
          alive = isEntityAlive(ship.entityID) === true;
        } catch (_error) {
          alive = false;
        }
      }
      if (alive) survivors.push(ship);
      else unrecorded.push(ship.entityID);
    }
    if (!survivors.length) {
      return {
        status: "BLOCKED", reason: "NO_SURVIVOR",
        fleetID: record.fleetID, unrecorded, stagingSystemID: staging,
      };
    }
    if (typeof compose !== "function") return { status: "BLOCKED", reason: "COMPOSITION_AUTHORITY_REQUIRED" };
    const effectiveMerit = Number(merit) || record.merit;
    const plan = compose({ factionID: record.factionID, merit: effectiveMerit, rank });
    if (!plan || plan.status !== "COMPOSED") {
      return {
        status: "BLOCKED", reason: "COMPOSITION_REFUSED",
        fleetID: record.fleetID,
        compositionReason: String((plan && plan.reason) || "UNKNOWN"),
      };
    }
    let free = [];
    if (typeof listFreeHulls === "function") {
      try {
        free = listFreeHulls({ factionID: record.factionID, systemID: staging }) || [];
      } catch (_error) {
        free = [];
      }
    }
    const owned = new Set();
    for (const other of Object.values(read().fleets)) {
      for (const ship of other.ships) {
        if (other.fleetID === record.fleetID) continue;
        if (ship.state !== "LOST" && ship.state !== "LOST_UNRECORDED") owned.add(ship.entityID);
      }
    }
    const available = free.filter((hull) => pos(hull && hull.entityID) &&
      !owned.has(Number(hull.entityID)) && ROLES.has(String(hull.role || "")))
      .map((hull) => ({
        entityID: Number(hull.entityID),
        role: String(hull.role),
        doctrineID: String(hull.doctrineID || ""),
        hullTypeID: Number(hull.hullTypeID) || 0,
      }));
    const usedSurvivors = new Set();
    const adopted = [];
    const ships = [];
    const missing = [];
    for (const slot of plan.ships) {
      const role = String(slot.role);
      let ship = survivors.find((entry) => !usedSurvivors.has(entry.entityID) && entry.role === role);
      if (ship) {
        usedSurvivors.add(ship.entityID);
        ships.push({ ...ship, slot: ships.length, state: ship.state === "ADOPTED" ? "ADOPTED" : "ALIVE" });
        continue;
      }
      const replacement = available.find((hull) => !adopted.some((entry) => entry.entityID === hull.entityID) &&
        hull.role === role);
      if (replacement) {
        adopted.push(replacement);
        ships.push({
          entityID: replacement.entityID, slot: ships.length, role,
          doctrineID: replacement.doctrineID || String(slot.doctrineID || ""),
          loadoutID: replacement.doctrineID || String(slot.loadoutID || ""),
          profileID: String(slot.profileID || ""),
          hullTypeID: replacement.hullTypeID || Number(slot.hullTypeID) || 0,
          hullName: String(slot.hullName || ""),
          pilotID: "", state: "ADOPTED",
        });
        continue;
      }
      missing.push({ role, doctrineID: String(slot.doctrineID || "") });
    }
    // Survivors whose role the new mix does not need still stay with the fleet:
    // they are real hulls and abandoning them would be a fabricated loss.
    const leftOver = survivors.filter((entry) => !usedSurvivors.has(entry.entityID));
    for (const ship of leftOver) {
      ships.push({ ...ship, slot: ships.length, state: ship.state === "ADOPTED" ? "ADOPTED" : "ALIVE" });
    }
    const status = missing.length === 0 ? "RECONSTITUTED" : "REDUCED";
    return {
      status,
      reason: missing.length === 0 ? "REAL_SURVIVORS_PLUS_FREE_HULLS" : "NO_REAL_REPLACEMENT_AVAILABLE",
      fleetID: record.fleetID,
      factionID: record.factionID,
      stagingSystemID: staging,
      commandCap: plan.commandCap,
      previousSize: record.ships.filter((ship) => ship.state === "ALIVE" || ship.state === "ADOPTED").length,
      survivors: survivors.map((ship) => ({ entityID: ship.entityID, role: ship.role })),
      adopted: adopted.map((hull) => ({ entityID: hull.entityID, role: hull.role })),
      missing,
      unrecorded,
      ships,
      size: ships.length,
      at: pos(at) ? Number(at) : clock(),
    };
  }

  // Writes the new fleet and retires the old one. Never spawns: every entityID
  // in the new fleet is a hull that already exists.
  function commitReconstitution({ plan, rank = "" } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    if (!plan || !["RECONSTITUTED", "REDUCED"].includes(plan.status)) {
      return { status: "BLOCKED", reason: "PLAN_NOT_RECONSTITUTABLE" };
    }
    const created = createFleet({
      factionID: plan.factionID,
      systemID: plan.stagingSystemID,
      stagingSystemID: plan.stagingSystemID,
      rank,
      merit: 0,
      commandCap: plan.commandCap,
      ships: plan.ships,
      parentFleetID: plan.fleetID,
    });
    if (created.status !== "CREATED") return created;
    const at = clock();
    let reserveAfter = null, faction = String(plan.factionID);
    transact((tx) => {
      const state = validate(tx.get(TABLE, KEY) || empty());
      const parent = state.fleets[plan.fleetID];
      if (!parent) return;
      parent.state = "RECONSTITUTED";
      parent.updatedAt = at;
      parent.reconstitutedAs = created.fleetID;
      const child = state.fleets[created.fleetID];
      if (child) child.planStatus = plan.status;
      // Every adopted real hull consumes one spawnable reserve slot and becomes
      // equipped; a faction can never replace more than it really holds.
      if (!state.reserve) state.reserve = {};
      const factionKey = String(plan.factionID);
      const roles = normalizeReserve(state.reserve[factionKey]);
      for (const ship of plan.adopted || []) {
        const role = ROLES.has(String(ship && ship.role || "")) ? String(ship.role) : "brawler";
        if (roles[role].spawnable > 0) roles[role].spawnable -= 1;
        roles[role].equipped += 1;
      }
      state.reserve[factionKey] = roles;
      reserveAfter = roles;
      state.history.push({
        at, event: "FLEET_RECONSTITUTED", fleetID: plan.fleetID, newFleetID: created.fleetID,
        status: plan.status, survivors: plan.survivors.length, adopted: plan.adopted.length,
        size: plan.size, commandCap: plan.commandCap, missing: plan.missing.length,
      });
      if (state.history.length > 512) state.history.splice(0, state.history.length - 512);
      validate(state);
      tx.put(TABLE, KEY, state);
    });
    return {
      status: plan.status,
      previousFleetID: plan.fleetID,
      fleetID: created.fleetID,
      size: created.size,
      commandCap: created.commandCap,
      survivors: plan.survivors.length,
      adopted: plan.adopted.length,
      missing: plan.missing,
      unrecorded: plan.unrecorded,
      reason: plan.reason,
      factionID: plan.factionID,
      reserve: reserveAfter ? { factionID: Number(faction), roles: reserveAfter } : null,
      frontChat: plan.adopted.length
        ? { kind: "fleet-replacement", eventKey: "replacement:" + created.fleetID,
          factionID: plan.factionID, systemID: plan.stagingSystemID,
          adopted: plan.adopted.length, size: created.size,
          status: plan.status }
        : null,
    };
  }

  // FW-027: real ships are real presence. Every hull of a live fleet that the
  // native entity store still places in the system counts, with the faction its
  // real corporation resolves to. A hull whose native record disagrees about the
  // system (in flight) counts nowhere.
  function presence({ systemIDs = [] } = {}) {
    const getNativeEntity = base.getNativeEntity;
    const getFactionForCorporation = base.getFactionForCorporation;
    if (typeof getNativeEntity !== "function" || typeof getFactionForCorporation !== "function") return [];
    const allowed = Array.isArray(systemIDs) && systemIDs.length
      ? new Set(systemIDs.map(Number).filter(pos)) : null;
    const state = read();
    const ships = [];
    for (const fleet of Object.values(state.fleets)) {
      if (fleet.state === "RECONSTITUTED" || fleet.state === "DESTROYED") continue;
      for (const ship of fleet.ships) {
        if (ship.state !== "ALIVE" && ship.state !== "ADOPTED") continue;
        let native = null;
        try {
          native = getNativeEntity(ship.entityID);
        } catch (_error) {
          native = null;
        }
        if (!native) continue;
        const systemID = Number(native.systemID) || 0;
        if (!pos(systemID) || (allowed && !allowed.has(systemID))) continue;
        let factionID = 0;
        try {
          factionID = Number(getFactionForCorporation(native.corporationID)) || 0;
        } catch (_error) {
          factionID = 0;
        }
        if (!pos(factionID)) continue;
        ships.push({
          entityID: ship.entityID,
          systemID,
          factionID,
          corporationID: Number(native.corporationID) || 0,
          pilotID: "coop-fleet-ship-" + ship.entityID,
          role: "patrol",
          fleetID: fleet.fleetID,
          doctrineID: ship.doctrineID,
          source: "FLEET_ROSTER",
        });
      }
    }
    return ships;
  }

  return Object.freeze({ snapshot, fleet, createFleet, recordLoss, planReconstitution,
    commitReconstitution, presence, reserveOf, declareReserve });
}

let shared = null;

// One process-wide roster for the runtime (presence) and the admin bridge
// (spawn/loss/reconstitution): both read and write the same durable row.
function sharedRoster() {
  if (shared) return shared;
  const gameStore = require("../gameStore");
  const npcStore = require("./npc/nativeNpcStore");
  const factions = require("../services/faction/factionState");
  shared = createWarFleetRoster({
    gameStore,
    getNativeEntity: (id) => npcStore.getNativeEntity(id),
    getFactionForCorporation: (id) => factions.getFactionIDForCorporation(id),
  });
  return shared;
}

module.exports = {
  TABLE, KEY, VERSION, empty, validate, createWarFleetRoster,
  sharedRoster, ROLES,
};
