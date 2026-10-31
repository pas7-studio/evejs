// Extracted from space/coopAdminBridge.js by scripts/coop-split-module.cjs.
// These declarations touch no module state, so they are pure helpers: they can be
// read, tested and changed without loading the runtime. The parent file requires
// them back, so its exports and call sites are unchanged.

"use strict";
// Admin bridge: lets the local MCP server act on a *live or offline* character
// from inside the server process, where the real session and space runtime live.
//
// Why it exists: a tool that shells into the container is a separate Node
// process with its own empty session registry, so it cannot see the player. The
// only honest way to act on a player is from inside the server, so the tool
// drops a request file on the data volume and this module executes it.
//
// Actions are whitelisted and each one uses native primitives:
//   chat_command  - one slash/GM command as the character's live session
//   give_item     - grant an item (a ship hull included) to the station hangar,
//                   works without a session: the data layer is authoritative
//   remove_item   - delete an item the character really owns (never the active hull)
//   board_ship    - make an owned ship the active hull, works without a session
//
// Every action emits a coop-events.jsonl line with an explicit status, so a
// runtime decision is never only in a chat log.
const fs = require("node:fs");

// Source .cjs modules become .js siblings in the deployed EveJS overlay.

const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";


const REQUESTS = process.env.EVEJS_COOP_ADMIN_REQUESTS || "/var/lib/evejs/coop-admin-requests.jsonl";

const RESULTS = process.env.EVEJS_COOP_ADMIN_RESULTS || "/var/lib/evejs/coop-admin-results.jsonl";

const EVENTS = process.env.EVEJS_COOP_EVENTS_FILE || "/var/lib/evejs/coop-events.jsonl";

// Stations are static: read them once per process instead of parsing the whole
// station table for a single name.

const ALLOWED_ACTIONS = new Set(["chat_command", "create_courier_contract", "give_item", "remove_item", "blueprint_auto", "board_ship", "fit_ship", "move_item", "fit_slots", "give_fit", "restore_last_loss", "batch", "deploy_structure", "spawn_native_npc", "war_diagnose", "war_combat_diagnose", "war_funding_diagnose", "war_payout_diagnose", "war_mercenary_settle", "war_mercenary_state", "inspect_npc", "scene_slim_diagnose", "grant_evermarks", "npc_pair_diagnose", "raid_diagnose", "war_state", "mining_fleet_diagnose", "arrival_diagnose", "trip_diagnose", "militia_state", "militia_enlist", "spawn_war_fleet", "release_identity", "assign_identity", "war_fleet_state", "fleet_reconstitute"]);

const MAX_REQUESTS_PER_DRAIN = 8;


function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (_error) {
    return [];
  }
}


function writeJsonLines(file, lines) {
  try {
    fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
  } catch (_error) {
    /* a lost result is reported as a timeout by the caller */
  }
}


function appendJsonLine(file, value) {
  try {
    fs.appendFileSync(file, JSON.stringify(value) + "\n");
  } catch (_error) {
    /* nothing to do: the caller will time out */
  }
}


function emitEvent(event, status, detail) {
  appendJsonLine(EVENTS, Object.assign(
    { at: new Date().toISOString(), event, status },
    detail || {},
  ));
}


function readRow(table, key) {
  try {
    const store = require("../gameStore");
    let row = store.read(table, String(key));
    if (row && typeof row === "object" && !Array.isArray(row) && "success" in row) {
      if (row.success !== true) return null;
      row = row.data;
    }
    if (typeof row === "string") row = JSON.parse(row);
    return row && typeof row === "object" ? row : null;
  } catch (_error) {
    return null;
  }
}


function liveSessionFor(characterID) {
  try {
    const registry = require("../services/chat/sessionRegistry");
    return typeof registry.findSessionByCharacterID === "function"
      ? registry.findSessionByCharacterID(characterID)
      : null;
  } catch (_error) {
    return null;
  }
}


// COOP_INDUSTRY_DEMO: the `/bpauto` chat command without a client attached.
//
// A player docks and types `/bpauto seed frigate`, then quotes, builds and
// delivers from the same command. QA has no client to dock, so this builds the
// exact session fields that command reads (stationid/regionid/_space) and runs the
// SAME `/bpauto` through the ordinary chat dispatch: seeding the blueprint, the
// quote, the real job-install cost from the wallet and the delivery all go through
// the industry runtime. Nothing here invents a job or an item.
function blueprintAuto(request) {
  const characterID = Number(request.characterID) || 0;
  const argumentsText = String(request.arguments || "").trim();
  if (!(characterID > 0)) return { ok: false, error: "characterID is required" };
  if (!argumentsText) return { ok: false, error: "arguments are required, e.g. \"seed frigate\"" };
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  const stationID = Number(request.stationID) || Number(character.stationID) || 0;
  if (!(stationID > 0)) {
    return { ok: false, error: "character " + characterID + " is not docked; pass stationID explicitly" };
  }
  const systemID = Number(character.solarSystemID) || 0;
  const session = {
    characterID,
    userid: Number(character.accountId) || 0,
    stationid: stationID,
    stationID,
    regionid: Number(character.regionID) || 0,
    solarSystemID: systemID,
    _space: { stationID, systemID, initialStateSent: true },
  };
  try {
    const chat = require("../services/chat/chatCommands");
    if (typeof chat.executeChatCommand !== "function") {
      return { ok: false, error: "executeChatCommand is missing" };
    }
    const result = chat.executeChatCommand(session, "/bpauto " + argumentsText, null, {});
    return {
      ok: Boolean(result && result.handled !== false),
      handled: Boolean(result && result.handled),
      message: String(result && result.message || ""),
      characterID,
      stationID,
      arguments: argumentsText,
    };
  } catch (error) {
    return { ok: false, error: "blueprint auto failed: " + String(error && error.message || error) };
  }
}


function executeChatCommand(request) {
  const characterID = Number(request.characterID) || 0;
  const command = String(request.command || "").trim();
  if (!command) return { ok: false, error: "command is required" };
  const session = liveSessionFor(characterID);
  if (!session) return { ok: false, error: "no live session for " + characterID + " (is the client logged in?)" };
  try {
    const chat = require("../services/chat/chatCommands");
    if (typeof chat.executeChatCommand !== "function") return { ok: false, error: "executeChatCommand is missing" };
    const result = chat.executeChatCommand(session, command, null, {});
    return {
      ok: true,
      handled: Boolean(result && result.handled),
      message: String(result && result.message || ""),
      characterID,
      command,
    };
  } catch (error) {
    return { ok: false, error: "command failed: " + String(error && error.message || error) };
  }
}

// Grants an item (ship hull included) to the character's station hangar. This is
// the same primitive /giveitem uses, minus the session requirement, so it works
// while the character is offline.

// Creates a genuine native courier contract through the same contract runtime the client uses, so the
// co-op courier dispatch can be exercised without a second click path. Escrow, plastic wrap, reward
// escrow and wallet movement are all the native ones - this only supplies the request the client would.
function createCourierContract(request) {
  const characterID = Number(request.characterID) || 0;
  const fromStationID = Number(request.fromStationID) || 0;
  const toStationID = Number(request.toStationID) || 0;
  const itemID = Number(request.itemID) || 0;
  const quantity = Math.max(1, Number(request.quantity) || 1);
  if (!(characterID > 0) || !(fromStationID > 0) || !(toStationID > 0) || !(itemID > 0)) {
    return { ok: false, error: "characterID, fromStationID, toStationID and itemID are required" };
  }
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  try {
    const contracts = require("../services/contracts/contractRuntimeState");
    const session = {
      charid: characterID,
      characterID,
      corpid: Number(character.corporationID) || 0,
      corporationID: Number(character.corporationID) || 0,
      allianceid: Number(character.allianceID) || 0,
      userid: Number(character.userID) || Number(character.accountID) || 0,
      stationid: fromStationID,
      solarsystemid2: Number(request.systemID) || 0,
    };
    const result = contracts.createContract({
      contractType: 3,
      isPrivate: false,
      minutesExpire: 1440,
      numDays: Math.max(1, Number(request.numDays) || 3),
      startStationID: fromStationID,
      destinationID: toStationID,
      price: 0,
      reward: Math.max(0, Number(request.reward) || 0),
      collateral: Math.max(0, Number(request.collateral) || 0),
      title: String(request.title || "co-op courier proof"),
      description: String(request.description || ""),
      itemList: [[itemID, quantity]],
      startStationDivision: 4,
      requestItemTypeList: [],
      forCorp: false,
      multiContract: false,
    }, session, {});
    const contractIDs = Array.isArray(result && result.contractIDs) ? result.contractIDs : [];
    return {
      ok: Boolean(result && result.success !== false),
      contractIDs,
      result: JSON.stringify(result || null).slice(0, 400),
    };
  } catch (error) {
    const payload = error && error.machoErrorResponse
      ? JSON.stringify(error.machoErrorResponse).slice(0, 400)
      : null;
    return { ok: false, error: String(error && error.message || error), payload };
  }
}

function giveItem(request) {  const characterID = Number(request.characterID) || 0;
  const typeID = Number(request.typeID) || 0;
  const quantity = Math.max(1, Number(request.quantity) || 1);
  if (!(typeID > 0)) return { ok: false, error: "typeID is required" };
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  const stationID = Number(request.stationID) || Number(character.stationID) || 0;
  if (!(stationID > 0)) {
    return { ok: false, error: "character " + characterID + " is not docked; pass stationID explicitly" };
  }
  try {
    const characterState = require("../services/character/characterState");
    const itemStore = require("../services/inventory/itemStore");
    const registry = require("../services/inventory/itemTypeRegistry");
    const lookup = typeof registry.resolveItemByTypeID === "function"
      ? registry.resolveItemByTypeID(typeID)
      : null;
    // resolveItemByTypeID returns {success, match} in this codebase; the grant
    // primitive wants the record itself.
    const resolved = lookup && lookup.match ? lookup.match : lookup;
    if (!resolved) return { ok: false, error: "unknown typeID " + typeID };
    if (typeof itemStore.grantItemToCharacterStationHangar !== "function") {
      return { ok: false, error: "itemStore.grantItemToCharacterStationHangar is missing" };
    }
    const granted = itemStore.grantItemToCharacterStationHangar(characterID, stationID, resolved, quantity);
    if (!granted || granted.success === false) {
      return { ok: false, error: String(granted && granted.errorMsg || "grant refused") };
    }
    const items = (granted.data && granted.data.items) || (granted.data && granted.data.changes) || [];
    const first = Array.isArray(items) && items.length
      ? (items[0].item || items[0])
      : null;
    // A live client should see it immediately instead of waiting for a relog.
    const session = liveSessionFor(characterID);
    let notified = false;
    if (session && first) {
      try {
        const changes = (granted.data && granted.data.changes) || [];
        if (typeof characterState.emitItemsChangedBatchForSession === "function" && changes.length) {
          characterState.emitItemsChangedBatchForSession(session, changes, { locationContext: null });
          notified = true;
        }
      } catch (_error) {
        notified = false;
      }
    }
    return {
      ok: true,
      characterID,
      stationID,
      typeID,
      quantity,
      itemID: first ? Number(first.itemID) || 0 : 0,
      name: first ? String(first.itemName || first.shipName || "") : "",
      online: Boolean(session),
      notified,
    };
  } catch (error) {
    return { ok: false, error: "grant failed: " + String(error && error.message || error) };
  }
}

// Deletes an item the character really owns. Refuses the active hull: deleting
// the ship a player is sitting in would break their session.

function removeItem(request) {
  const characterID = Number(request.characterID) || 0;
  const itemID = Number(request.itemID) || 0;
  if (!(itemID > 0)) return { ok: false, error: "itemID is required" };
  const store = require("../gameStore");
  const item = readRow("items", itemID);
  if (!item) return { ok: false, error: "item " + itemID + " does not exist" };
  if (Number(item.ownerID) !== characterID) {
    return { ok: false, error: "item " + itemID + " is not owned by " + characterID };
  }
  const character = readRow("characters", characterID);
  if (character && Number(character.shipID) === itemID) {
    return { ok: false, error: "item " + itemID + " is the active hull; board another ship first" };
  }
  if (typeof store.remove !== "function") return { ok: false, error: "gameStore has no remove()" };
  store.remove("items", String(itemID));
  if (typeof store.flushTableSync === "function") store.flushTableSync("items");
  return {
    ok: true,
    removed: [itemID],
    item: { itemID, typeID: item.typeID, name: item.itemName || item.shipName || null },
  };
}

// Makes an owned, docked ship the active hull. Native and session-free, so it
// also works while the character is offline.

function boardShip(request) {
  const characterID = Number(request.characterID) || 0;
  const itemID = Number(request.itemID) || 0;
  if (!(itemID > 0)) return { ok: false, error: "itemID is required" };
  const item = readRow("items", itemID);
  if (!item) return { ok: false, error: "item " + itemID + " does not exist" };
  if (Number(item.ownerID) !== characterID) {
    return { ok: false, error: "item " + itemID + " is not owned by " + characterID };
  }
  if (Number(item.categoryID) !== 6) {
    return { ok: false, error: "item " + itemID + " is not a ship hull (categoryID " + item.categoryID + ")" };
  }
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  if (!(Number(character.stationID) > 0)) {
    return { ok: false, error: "character " + characterID + " is not docked; docking is required to switch hulls" };
  }
  if (Number(item.locationID) !== Number(character.stationID) || Number(item.flagID) !== 4) {
    return { ok: false, error: "ship " + itemID + " is not in the hangar of station " + character.stationID };
  }
  const session = liveSessionFor(characterID);
  if (session) {
    return {
      ok: false,
      error: "character " + characterID + " is online; switching the hull of a live session is not supported here - relog or use the client",
    };
  }
  try {
    const itemStore = require("../services/inventory/itemStore");
    if (typeof itemStore.setActiveShipForCharacter !== "function") {
      return { ok: false, error: "setActiveShipForCharacter is missing" };
    }
    const result = itemStore.setActiveShipForCharacter(characterID, itemID);
    if (result && result.success === false) {
      return { ok: false, error: String(result.errorMsg || "board refused") };
    }
    return { ok: true, characterID, itemID, name: String(item.itemName || item.shipName || ""), online: false };
  } catch (error) {
    return { ok: false, error: "board failed: " + String(error && error.message || error) };
  }
}

// Moves an owned item to another location: the native primitive behind looting a
// wreck or putting a module back in the hangar.

function moveItem(request) {
  const characterID = Number(request.characterID) || 0;
  const itemID = Number(request.itemID) || 0;
  const toLocationID = Number(request.toLocationID) || 0;
  const toFlagID = Number(request.toFlagID) || 4;
  if (!(itemID > 0) || !(toLocationID > 0)) return { ok: false, error: "itemID and toLocationID are required" };
  const item = readRow("items", itemID);
  if (!item) return { ok: false, error: "item " + itemID + " does not exist" };
  if (Number(item.ownerID) !== characterID) {
    return { ok: false, error: "item " + itemID + " is not owned by " + characterID };
  }
  try {
    const store = require("../services/inventory/itemStore");
    if (typeof store.moveItemToLocation !== "function") return { ok: false, error: "moveItemToLocation is missing" };
    const moved = store.moveItemToLocation(itemID, toLocationID, toFlagID, null);
    if (moved && moved.success === false) return { ok: false, error: String(moved.errorMsg || "move refused") };
    return {
      ok: true,
      itemID,
      name: String(item.itemName || item.shipName || ""),
      from: Number(item.locationID) || 0,
      toLocationID,
      toFlagID,
    };
  } catch (error) {
    return { ok: false, error: "move failed: " + String(error && error.message || error) };
  }
}

// Fits modules onto an owned, docked hull using the same native fitting path as
// the dev ship commands: grant each module to the hangar, then fit it. Works
// without a live session, so a bare hull can be made flyable offline.

function fitShip(request) {
  const characterID = Number(request.characterID) || 0;
  const shipItemID = Number(request.itemID) || 0;
  const modules = Array.isArray(request.modules) ? request.modules : [];
  if (!(shipItemID > 0)) return { ok: false, error: "itemID (the hull) is required" };
  if (!modules.length) return { ok: false, error: "modules[] is required" };
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  const stationID = Number(character.stationID) || 0;
  if (!(stationID > 0)) return { ok: false, error: "character is not docked" };
  const shipItem = readRow("items", shipItemID);
  if (!shipItem) return { ok: false, error: "ship " + shipItemID + " not found" };
  if (Number(shipItem.ownerID) !== characterID) {
    return { ok: false, error: "ship " + shipItemID + " is not owned by " + characterID };
  }
  if (Number(shipItem.categoryID) !== 6) {
    return { ok: false, error: "item " + shipItemID + " is not a ship hull" };
  }
  if (Number(shipItem.locationID) !== stationID || Number(shipItem.flagID) !== 4) {
    return { ok: false, error: "ship " + shipItemID + " is not in the hangar of station " + stationID };
  }

  let registry = null;
  let characterState = null;
  let dev = null;
  try {
    registry = require("../services/inventory/itemTypeRegistry");
    characterState = require("../services/character/characterState");
    dev = require("../services/ship/devCommandShipRuntime");
  } catch (error) {
    return { ok: false, error: "fitting modules unavailable: " + String(error && error.message || error) };
  }
  if (typeof dev.fitGrantedItemTypeToShip !== "function") {
    return { ok: false, error: "fitGrantedItemTypeToShip is missing" };
  }

  // The native fitting planner needs the real session: with a bare identity it
  // answers "no valid slot" for every module, which would be a lie to report.
  const identity = liveSessionFor(characterID);
  if (!identity) {
    return { ok: false, error: "fitting needs a live session: log the character in first" };
  }

  const results = [];
  for (const module of modules) {
    const name = String(module && module.name || "").trim();
    const typeID = Number(module && module.typeID) || 0;
    const count = Math.max(1, Number(module && module.count) || 1);
    let itemType = null;
    try {
      const lookup = typeID > 0
        ? registry.resolveItemByTypeID(typeID)
        : registry.resolveItemByName(name);
      itemType = lookup && lookup.match ? lookup.match : lookup;
    } catch (_error) {
      itemType = null;
    }
    if (!itemType) {
      results.push({ name: name || String(typeID), ok: false, error: "item type not found" });
      continue;
    }
    // grant:false means the modules already sit in the hangar (for example after
    // being recovered from a wreck), so fitting consumes those real items
    // instead of minting new ones.
    if (request.grant !== false) {
      let granted = null;
      try {
        const store = require("../services/inventory/itemStore");
        granted = store.grantItemToCharacterStationHangar(characterID, stationID, itemType, count);
      } catch (error) {
        results.push({ name, ok: false, error: "grant failed: " + String(error && error.message || error) });
        continue;
      }
      if (!granted || granted.success === false) {
        results.push({ name, ok: false, error: String(granted && granted.errorMsg || "grant refused") });
        continue;
      }
    }
    try {
      const fitted = dev.fitGrantedItemTypeToShip(identity, stationID, shipItem, itemType, count, {
        syncToSession: false,
        forceFit: true,
      });
      const fittedCount = Number(fitted && fitted.fittedCount) || 0;
      results.push({
        name: itemType.name || itemType.typeName || name,
        ok: fittedCount > 0,
        fitted: fittedCount,
        forced: Number(fitted && fitted.forcedCount) || 0,
        error: fittedCount > 0 ? "" : "no valid slot for this module",
      });
    } catch (error) {
      results.push({ name, ok: false, error: "fit failed: " + String(error && error.message || error) });
    }
  }

  const fitted = results.filter((row) => row.ok).length;
  return { ok: fitted > 0, fitted, attempted: results.length, results, characterID, itemID: shipItemID };
}

// Fits modules into explicit slot flags: [typeID, flag, count]. This is the
// data-level truth of a fit (items sitting in their slots) and is used when the
// auto-slot planner cannot place a hull it has never seen fitted.

function fitSlots(request) {
  const characterID = Number(request.characterID) || 0;
  const shipItemID = Number(request.itemID) || 0;
  const slots = Array.isArray(request.modules) ? request.modules : [];
  if (!(shipItemID > 0) || !slots.length) return { ok: false, error: "itemID and modules[] are required" };
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  const stationID = Number(character.stationID) || 0;
  const shipItem = readRow("items", shipItemID);
  if (!shipItem) return { ok: false, error: "ship " + shipItemID + " not found" };
  if (Number(shipItem.ownerID) !== characterID) return { ok: false, error: "ship is not owned by " + characterID };

  const store = require("../services/inventory/itemStore");
  const registry = require("../services/inventory/itemTypeRegistry");

  // Every hangar item of a type, oldest first, so recovered items are reused.
  const hangarItemsOfType = (typeID) => {
    const rows = [];
    let table = require("../gameStore").read("items");
    if (table && table.success !== false && table.data !== undefined) table = table.data;
    if (typeof table === "string") table = JSON.parse(table);
    const walk = (value, depth) => {
      if (!value || depth > 4 || rows.length > 4000) return;
      if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
      if (typeof value !== "object") return;
      if (value.itemID !== undefined && value.typeID !== undefined) {
        if (Number(value.ownerID) === characterID &&
            Number(value.typeID) === typeID &&
            Number(value.locationID) === stationID &&
            Number(value.flagID) === 4) {
          rows.push(value);
        }
        return;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    };
    walk(table, 0);
    return rows.sort((left, right) => Number(left.itemID) - Number(right.itemID));
  };

  // A slot holds one module, so count there means "fill N slots". A cargo hold or
  // a drone bay holds one stack, so count there is a quantity: moving it unit by
  // unit turned a 1000-unit ore stack into 1000 separate grants inside a single
  // bridge action, which is both slow and a partial-write risk.
  const isSlotFlag = (flag) =>
    (flag >= 11 && flag <= 34)
    || (flag >= 92 && flag <= 99)
    || (flag >= 125 && flag <= 132)
    || (flag >= 164 && flag <= 171);

  const results = [];
  for (const slot of slots) {
    const typeID = Number(slot && slot.typeID) || 0;
    const flagID = Number(slot && slot.flag) || 0;
    const count = Math.max(1, Number(slot && slot.count) || 1);
    if (!(typeID > 0) || !(flagID > 0)) {
      results.push({ typeID, flag: flagID, ok: false, error: "typeID and flag are required" });
      continue;
    }
    const iterations = isSlotFlag(flagID) ? count : 1;
    const perItem = isSlotFlag(flagID) ? 1 : count;
    for (let index = 0; index < iterations; index += 1) {
      let candidates = hangarItemsOfType(typeID);
      if (!candidates.length) {
        const lookup = registry.resolveItemByTypeID(typeID);
        const itemType = lookup && lookup.match ? lookup.match : lookup;
        if (!itemType) { results.push({ typeID, flag: flagID, ok: false, error: "unknown typeID" }); break; }
        const granted = store.grantItemToCharacterStationHangar(characterID, stationID, itemType, perItem);
        if (!granted || granted.success === false) {
          results.push({ typeID, flag: flagID, ok: false, error: String(granted && granted.errorMsg || "grant refused") });
          break;
        }
        candidates = hangarItemsOfType(typeID);
      }
      const item = candidates[0];
      if (!item) { results.push({ typeID, flag: flagID, ok: false, error: "no item available" }); break; }
      const moved = store.moveItemToLocation(item.itemID, shipItemID, flagID, null);
      if (moved && moved.success === false) {
        results.push({ typeID, flag: flagID, ok: false, error: String(moved.errorMsg || "move refused") });
        break;
      }
      results.push({ typeID, flag: flagID, itemID: item.itemID, ok: true });
    }
  }
  const fitted = results.filter((row) => row.ok).length;
  return { ok: fitted > 0, fitted, attempted: results.length, results, characterID, itemID: shipItemID };
}

// One flat walk over the item table. A whole-fit restore needs the hangar, the
// hull's occupied slots and the existing hulls at once; reading the table once
// per request is what keeps a batched admin call inside a single world step.
function readItemRows() {
  const rows = [];
  try {
    let table = require("../gameStore").read("items");
    if (table && table.success !== false && table.data !== undefined) table = table.data;
    if (typeof table === "string") table = JSON.parse(table);
    const walk = (value, depth) => {
      if (!value || depth > 4 || rows.length > 200000) return;
      if (Array.isArray(value)) {
        for (const child of value) walk(child, depth + 1);
        return;
      }
      if (typeof value !== "object") return;
      if (value.itemID !== undefined && value.typeID !== undefined) {
        rows.push(value);
        return;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    };
    walk(table, 0);
  } catch (_error) {
    /* an unreadable store means every caller below reports its own refusal */
  }
  return rows;
}

function resolveAdminItemType(registry, typeID, name) {
  try {
    const lookup = typeID > 0
      ? registry.resolveItemByTypeID(typeID)
      : registry.resolveItemByName(String(name || ""));
    if (lookup && lookup.match) return lookup.match;
    if (lookup && lookup.typeID) return lookup;
    // An ambiguous name is normal here: the SDE carries unpublished ♦ variants of
    // the same hull, so "Venture" matches three types. Prefer the published entry
    // whose label is exactly the requested name, then any published one.
    if (lookup && Array.isArray(lookup.suggestions) && lookup.suggestions.length) {
      const wanted = String(name || "").trim().toLowerCase();
      const parsed = lookup.suggestions.map((text) => {
        const match = /^(.*?)\s*\((\d+)/.exec(String(text));
        if (!match) return null;
        return {
          label: String(match[1]).replace(/[♦\s]+/g, " ").trim(),
          typeID: Number(match[2]),
          unpublished: /unpublished/i.test(String(text)),
        };
      }).filter((row) => row && row.typeID > 0);
      const chosen = parsed.find((row) => !row.unpublished && row.label.toLowerCase() === wanted)
        || parsed.find((row) => !row.unpublished)
        || parsed[0];
      if (chosen) {
        const resolved = registry.resolveItemByTypeID(chosen.typeID);
        return resolved && resolved.match ? resolved.match : (resolved || null);
      }
    }
    return null;
  } catch (_error) {
    return null;
  }
}

const FIT_FAMILIES = ["high", "med", "low", "rig", "subsystem", "service"];
const DRONE_CATEGORY_ID = 18;
const SHIP_CATEGORY = 6;

// Places requested modules into real slots and fits them, granting anything that
// is missing. This is the "one call gives a whole fitting" path: hull by typeID
// or an existing hull itemID, then every module into its own slot family, drones
// into the drone bay, everything else into the hold.
//
// It never uses the native fitting planner (that one needs a live client
// session); placement comes from space/coopAdminFitPlan, which only needs slot
// counts and per-type slot families, so this works for an offline character.
function giveFit(request) {
  const characterID = Number(request.characterID) || 0;
  const character = readRow("characters", characterID);
  if (!character) return { ok: false, error: "character " + characterID + " not found" };
  const stationID = Number(request.stationID) || Number(character.stationID) || 0;
  if (!(stationID > 0)) {
    return { ok: false, error: "character " + characterID + " is not docked; pass stationID explicitly" };
  }
  let registry = null;
  let fitting = null;
  try {
    registry = require("../services/inventory/itemTypeRegistry");
    fitting = require("../services/fitting/liveFittingState");
  } catch (error) {
    return { ok: false, error: "fitting modules unavailable: " + String(error && error.message || error) };
  }
  const itemStore = require("../services/inventory/itemStore");
  const plan = require("./coopAdminFitPlan" + siblingSuffix);
  const itemRows = readItemRows();

  // 1. The hull: an explicit itemID wins, otherwise reuse the oldest docked hull
  //    of that type (a restore must not mint a second Venture every time), and
  //    only then grant a new one.
  let hull = null;
  let hullGranted = false;
  const explicitHullID = Number(request.itemID) || 0;
  if (explicitHullID > 0) {
    hull = itemRows.find((row) => Number(row.itemID) === explicitHullID) || readRow("items", explicitHullID);
    if (!hull) return { ok: false, error: "ship " + explicitHullID + " not found" };
    if (Number(hull.ownerID) !== characterID) {
      return { ok: false, error: "ship " + explicitHullID + " is not owned by " + characterID };
    }
    if (Number(hull.locationID) !== stationID) {
      return { ok: false, error: "ship " + explicitHullID + " is not at station " + stationID };
    }
  } else {
    let hullTypeID = Number(request.hullTypeID) || 0;
    if (!(hullTypeID > 0) && String(request.hullName || "").trim()) {
      const byName = resolveAdminItemType(registry, 0, String(request.hullName).trim());
      hullTypeID = Number(byName && byName.typeID) || 0;
    }
    if (!(hullTypeID > 0)) {
      return { ok: false, error: "itemID (existing hull), hullTypeID or hullName (hull to grant) is required" };
    }
    hull = itemRows
      .filter((row) => Number(row.ownerID) === characterID
        && Number(row.typeID) === hullTypeID
        && Number(row.locationID) === stationID
        && Number(row.flagID) === 4
        && Number(row.categoryID) === SHIP_CATEGORY)
      .sort((left, right) => Number(left.itemID) - Number(right.itemID))[0] || null;
    if (!hull) {
      const hullType = resolveAdminItemType(registry, hullTypeID, "");
      if (!hullType) return { ok: false, error: "unknown hull typeID " + hullTypeID };
      const granted = itemStore.grantItemToCharacterStationHangar(characterID, stationID, hullType, 1);
      if (!granted || granted.success === false) {
        return { ok: false, error: String(granted && granted.errorMsg || "hull grant refused") };
      }
      hullGranted = true;
      const grantedItems = (granted.data && granted.data.items) || [];
      const first = grantedItems.length ? (grantedItems[0].item || grantedItems[0]) : null;
      hull = first
        ? (readRow("items", Number(first.itemID) || 0) || first)
        : readItemRows().filter((row) => Number(row.ownerID) === characterID
          && Number(row.typeID) === hullTypeID
          && Number(row.locationID) === stationID
          && Number(row.flagID) === 4).sort((left, right) => Number(right.itemID) - Number(left.itemID))[0] || null;
      if (!hull) return { ok: false, error: "hull " + hullTypeID + " was granted but cannot be read back" };
    }
  }
  const hullItemID = Number(hull.itemID) || 0;
  const hullTypeID = Number(hull.typeID) || 0;

  // 2. Real slot capacity of this hull and the flags already in use on it.
  const slotFlags = {};
  for (const family of FIT_FAMILIES) {
    if (typeof fitting.getSlotFlagsForFamily === "function") {
      slotFlags[family] = fitting.getSlotFlagsForFamily(family, hullTypeID);
    }
  }
  const occupiedFlags = itemRows
    .filter((row) => Number(row.locationID) === hullItemID)
    .map((row) => Number(row.flagID) || 0);

  // 3. Classify each requested module: slot family, drone bay or cargo hold.
  //    Anything already on the hull counts towards the request, so calling this
  //    twice with the same fitting is idempotent instead of stacking duplicates.
  const onHull = new Map();
  for (const row of itemRows) {
    if (Number(row.locationID) !== hullItemID) continue;
    const key = String(Number(row.typeID) || 0);
    onHull.set(key, (onHull.get(key) || 0) + Math.max(1, Number(row.quantity) || 1));
  }
  const requested = Array.isArray(request.modules) ? request.modules : [];
  const classified = [];
  const already = [];
  const skipped = [];
  for (const module of requested) {
    const name = String(module && module.name || "").trim();
    const typeID = Number(module && module.typeID) || 0;
    const count = Math.max(1, Number(module && module.count) || 1);
    const itemType = resolveAdminItemType(registry, typeID, name);
    if (!itemType) {
      skipped.push({ name: name || String(typeID), count, error: "item type not found" });
      continue;
    }
    const resolvedTypeID = Number(itemType.typeID) || typeID;
    const explicitKind = String(module && module.kind || "").trim().toLowerCase();
    let family = typeof fitting.getRequiredSlotFamily === "function"
      ? fitting.getRequiredSlotFamily(resolvedTypeID) : null;
    let kind = "module";
    if (explicitKind === "drone" || explicitKind === "cargo") {
      kind = explicitKind;
      family = null;
    } else if (!family) {
      kind = Number(itemType.categoryID) === DRONE_CATEGORY_ID ? "drone" : "cargo";
    }
    const displayName = String(itemType.name || itemType.typeName || name);
    const present = Number(onHull.get(String(resolvedTypeID))) || 0;
    const missing = Math.max(0, count - present);
    if (missing === 0) {
      already.push({ typeID: resolvedTypeID, name: displayName, count: present, family: kind === "drone" ? "drone bay" : (family || "cargo hold") });
      continue;
    }
    classified.push({
      typeID: resolvedTypeID,
      count: missing,
      family,
      kind,
      flag: Number(module && module.flag) || 0,
      name: displayName,
    });
  }

  const placement = plan.planFit({ modules: classified, slotFlags, occupiedFlags });
  const slots = plan.toFitSlots(placement.rows);
  let fit = { ok: false, fitted: 0, attempted: 0, results: [] };
  if (slots.length) {
    fit = fitSlots({ characterID, itemID: hullItemID, modules: slots });
  }
  const nameOf = new Map(classified.map((row) => [String(row.typeID), row.name]));
  const rows = placement.rows.map((row) => ({
    typeID: row.typeID,
    name: nameOf.get(String(row.typeID)) || String(row.typeID),
    count: Number(row.count) || 1,
    flag: row.flag,
    family: row.family || (row.kind === "drone" ? "drone bay" : "cargo hold"),
    ok: row.ok === true,
    error: row.error || "",
  }));

  // 4. Optional board. Only when the character is offline: a live session cannot
  //    have its hull switched under it, and the refusal is reported verbatim.
  let boarded = null;
  if (request.board === true) {
    const board = boardShip({ characterID, itemID: hullItemID });
    boarded = { ok: board.ok === true, error: String(board.error || "") };
  }

  const fitted = Number(fit.fitted) || 0;
  const failedRows = rows.filter((row) => !row.ok);
  // "Satisfied" means the requested fitting is on the hull now, whether this
  // call fitted it or found it already there.
  return {
    ok: failedRows.length === 0 && skipped.length === 0,
    characterID,
    stationID,
    itemID: hullItemID,
    hullTypeID,
    hullName: String(hull.itemName || hull.shipName || ""),
    hullGranted,
    fitted,
    attempted: slots.length,
    rows,
    already,
    skipped,
    boarded,
  };
}

// "He died — recreate exactly the same ship": reads the character's newest
// killmail from the native killmail state, then re-grants and re-fits the lost
// hull with the lost modules, drones and cargo.
//
// A killmail records flag 4 for everything, so flag cannot separate fitted
// modules from cargo. `singleton` can: fitted modules are singletons, stacks in
// the hold are not. Drones are recognised by their category.
function restoreLastLoss(request) {
  const characterID = Number(request.characterID) || 0;
  if (!(characterID > 0)) return { ok: false, error: "characterID is required" };
  let killmailState = null;
  try {
    killmailState = require("../services/killmail/killmailState");
  } catch (error) {
    return { ok: false, error: "killmail state unavailable: " + String(error && error.message || error) };
  }
  const wantedKillID = Number(request.killID) || 0;
  let records = [];
  try {
    records = typeof killmailState.listKillmailsForCharacter === "function"
      ? killmailState.listKillmailsForCharacter(characterID) : [];
  } catch (_error) {
    records = [];
  }
  records = (Array.isArray(records) ? records : [])
    .filter((row) => row && Number(row.victimCharacterID) === characterID);
  let record = null;
  if (wantedKillID > 0) {
    record = records.find((row) => Number(row.killID) === wantedKillID) || null;
    if (!record) record = killmailState.getKillmailRecord(wantedKillID) || null;
  } else {
    record = records.sort((left, right) => Number(right.killID) - Number(left.killID))[0] || null;
  }
  if (!record) {
    return {
      ok: false,
      error: wantedKillID > 0
        ? "killmail " + wantedKillID + " was not found for character " + characterID
        : "character " + characterID + " has no killmail to restore",
    };
  }
  const hullTypeID = Number(record.victimShipTypeID) || 0;
  if (!(hullTypeID > 0)) return { ok: false, error: "killmail " + record.killID + " has no victim ship" };

  // Aggregate by type: a stack split across the drone bay and the hold must come
  // back as one stack, and dropped + destroyed are both real losses.
  const totals = new Map();
  for (const item of Array.isArray(record.items) ? record.items : []) {
    const typeID = Number(item && item.typeID) || 0;
    if (!(typeID > 0)) continue;
    const qty = (Number(item.qtyDropped) || 0) + (Number(item.qtyDestroyed) || 0);
    if (!(qty > 0)) continue;
    const entry = totals.get(typeID) || { typeID, count: 0, singleton: false };
    entry.count += qty;
    if (Number(item.singleton) === 1) entry.singleton = true;
    totals.set(typeID, entry);
  }

  let registry = null;
  let fitting = null;
  try {
    registry = require("../services/inventory/itemTypeRegistry");
    fitting = require("../services/fitting/liveFittingState");
  } catch (_error) {
    registry = null;
    fitting = null;
  }
  const includeCargo = request.includeCargo !== false;
  const modules = [];
  const skipped = [];
  for (const entry of totals.values()) {
    const itemType = registry ? resolveAdminItemType(registry, entry.typeID, "") : null;
    if (!itemType) {
      skipped.push({ typeID: entry.typeID, count: entry.count, error: "item type not found" });
      continue;
    }
    const isDrone = Number(itemType.categoryID) === DRONE_CATEGORY_ID;
    const family = fitting && typeof fitting.getRequiredSlotFamily === "function"
      ? fitting.getRequiredSlotFamily(entry.typeID) : null;
    const kind = isDrone ? "drone" : (entry.singleton && family ? "module" : "cargo");
    if (kind === "cargo" && !includeCargo) {
      skipped.push({ typeID: entry.typeID, count: entry.count, name: String(itemType.name || ""), error: "cargo skipped by includeCargo:false" });
      continue;
    }
    modules.push({ typeID: entry.typeID, count: entry.count, kind, family, name: String(itemType.name || "") });
  }

  const fit = giveFit({
    characterID,
    stationID: Number(request.stationID) || 0,
    hullTypeID,
    modules,
    board: request.board,
  });
  const hullType = registry ? resolveAdminItemType(registry, hullTypeID, "") : null;
  return {
    ok: fit.ok === true,
    characterID,
    killID: Number(record.killID) || 0,
    killTime: String(record.killTime || ""),
    solarSystemID: Number(record.solarSystemID) || 0,
    hullTypeID,
    hullName: String(hullType && (hullType.name || hullType.typeName) || ""),
    restored: modules,
    skipped,
    fit,
  };
}

// Deploys one real structure for a faction through coopStructureFactory, which
// writes via the native structureState writer. The co-op layer needs this because
// the stock deployment surface is client RPC only. The result always carries the
// factory's own refusal reason, and a deploy is only "ok" when the row is read
// back from the native system reader afterwards.

function deployStructure(request) {
  let factory = null;
  try {
    factory = require("./coopStructureFactory" + siblingSuffix);
  } catch (error) {
    return { ok: false, error: "structure factory unavailable: " + String(error && error.message || error) };
  }
  const input = {
    systemID: Number(request.systemID) || 0,
    typeID: Number(request.typeID) || 0,
    // Passed verbatim: the factory's own strict faction validation must be what
    // the caller sees, so a JSON string never becomes a faction here.
    factionID: request.factionID,
    ownerCorpID: Number(request.ownerCorpID) || 0,
    position: request.position,
    name: String(request.name || ""),
  };
  if (typeof request.description === "string" && request.description.trim()) {
    input.description = request.description;
  }
  let deployed = null;
  try {
    deployed = factory.deploy(input);
  } catch (error) {
    return { ok: false, error: "deploy threw: " + String(error && error.message || error) };
  }
  if (!deployed || deployed.status !== "DEPLOYED") {
    return {
      ok: false,
      status: String((deployed && deployed.status) || "UNKNOWN"),
      error: String((deployed && (deployed.reason || deployed.errorMsg)) || "deploy refused"),
    };
  }
  let verified = { status: "UNKNOWN", reason: "NOT_VERIFIED" };
  try {
    verified = factory.verify({ systemID: deployed.systemID, structureID: deployed.structureID });
  } catch (_error) {
    verified = { status: "UNKNOWN", reason: "VERIFY_FAILED" };
  }
  return {
    ok: verified.status === "PRESENT",
    status: deployed.status,
    structureID: deployed.structureID,
    systemID: deployed.systemID,
    typeID: deployed.typeID,
    factionID: deployed.factionID,
    verified: verified.status,
    verifyReason: String(verified.reason || ""),
    name: String((deployed.record && (deployed.record.name || deployed.record.itemName)) || ""),
  };
}

// FW-003C: the real loadout row a coop war patrol must be spawned with.
// Stock pirate subcapital profiles point at the retail empty loadout, so a
// native spawn would fit no modules and the muster gate could never pass. The
// row is the profile's own authored `*_loadout` row (real turret + compatible
// charge), named through the L1 loadout override; when none validates the
// caller must not get an unarmed hull labelled "patrol".

function resolveWarPatrolLoadout(profileQuery, loadoutID, options) {
  const requireAmmoDepth = Boolean(options && options.requireAmmoDepth === true);
  let data = null;
  let loadout = null;
  let rows = null;
  try {
    data = require("./npc/npcData");
    const registry = require("../services/inventory/itemTypeRegistry");
    const dogma = require("./combat/weaponDogma");
    const capability = require("./npc/npcCapabilityResolver");
    rows = require("./coopWarPatrolLoadoutRow" + siblingSuffix);
    loadout = require("./coopWarPatrolLoadout" + siblingSuffix).createWarPatrolLoadout({
      getProfile: (profileID) => data.getNpcProfile(profileID),
      // The static table first, then the authored row (which only validates when
      // every module and charge typeID really exists in that same static row).
      getLoadout: (id) => data.getNpcLoadout(id) || rows.resolveRow(id),
      resolveItemByTypeID: registry.resolveItemByTypeID,
      resolveWeaponFamily: (item) => dogma.resolveWeaponFamily(item),
      isCompatibleCharge: (module, chargeTypeID) =>
        capability.isNpcChargeCompatibleWithModule(module, chargeTypeID),
      getAuthoredRow: (baseLoadoutID, depth) => rows.authoredIDFor(baseLoadoutID, depth),
      ammoDepth: Number(process.env.EVEJS_COOP_WAR_PATROL_AMMO_DEPTH) || 60,
    });
  } catch (error) {
    return { status: "REFUSED", reason: "LOADOUT_AUTHORITIES_UNAVAILABLE:" + String(error && error.message || error), override: false };
  }
  const resolution = data.resolveNpcProfile(String(profileQuery || ""), "");
  if (!resolution.success || !resolution.data) {
    return { status: "REFUSED", reason: "PROFILE_NOT_RESOLVED", override: false };
  }
  return loadout.resolve({
    profileID: resolution.data.profileID,
    loadoutID: String(loadoutID || ""),
    requireAmmoDepth,
  });
}

// Spawns real native NPC hulls in a system from a real SDE profile, so the world
// can be set up honestly (e.g. a second faction's patrol in a tied system). It
// uses the same native spawnBatchInSystem + scene anchor the materializer uses,
// reports the resulting entity/corporation/faction, and never fabricates a ship.

function spawnNativeNpc(request) {
  const systemID = Number(request.systemID) || 0;
  const profileQuery = String(request.profileQuery || "").trim();
  const amount = Math.max(1, Math.min(4, Number(request.amount) || 1));
  if (!(systemID > 0)) return { ok: false, error: "systemID is required" };
  if (!profileQuery) return { ok: false, error: "profileQuery is required" };
  let runtime = null;
  let npc = null;
  let topology = null;
  let npcStore = null;
  let factions = null;
  try {
    runtime = require("./runtime");
    npc = require("./npc/npcRuntime");
    topology = require("./coopNpcTopology" + siblingSuffix);
    npcStore = require("./npc/nativeNpcStore");
    factions = require("../services/faction/factionState");
  } catch (error) {
    return { ok: false, error: "native spawn dependencies unavailable: " + String(error && error.message || error) };
  }
  // FW-073: never spawn a hull for a pilot that is already flying one.
  //
  // Measured 10:3x-10:4xZ: repeated seeding asked for pilots whose link already existed,
  // the spawn created a SECOND physical hull and the link (correctly) refused, leaving an
  // armed orphan no war can mobilize whose pilot the mobiliser then reports as
  // PILOT_IN_USE forever. The caller gets the existing binding back so it can reuse the
  // hull that is really there instead of inventing another one.
  const requestedPilotID = String(request.pilotID || "").trim();
  if (requestedPilotID) {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      const links = typeof runtimeWorld.identityLinks === "function" ? runtimeWorld.identityLinks() : [];
      const bound = (Array.isArray(links) ? links : []).find((row) =>
        row && String(row.pilotID || "") === requestedPilotID);
      if (bound) {
        let liveEntityID = 0;
        let liveSystemID = 0;
        try {
          const native = npcStore.getNativeEntity(Number(bound.entityID));
          liveEntityID = Number(native && native.entityID) || 0;
          liveSystemID = Number(native && native.systemID) || 0;
        } catch (_error) { liveEntityID = 0; }
        if (liveEntityID > 0)
          return { ok: false, error: "PILOT_ALREADY_LINKED", pilotID: requestedPilotID,
            entityID: liveEntityID, systemID: liveSystemID,
            evidence: "PILOT_HAS_A_LIVE_HULL_NO_SECOND_SHIP_SPAWNED" };
      }
    } catch (_error) { /* an unreadable registry never blocks an explicit operator spawn */ }
  }
  let scene = null;
  try {
    scene = runtime.ensureScene(systemID, { refreshStargates: false });
  } catch (error) {
    return { ok: false, error: "scene unavailable: " + String(error && error.message || error) };
  }
  const anchor = topology.anchorOptions(scene);
  if (!anchor) return { ok: false, error: "NO_NATIVE_SYSTEM_ANCHOR" };
  // A war patrol is armed at spawn time or it is not spawned: see
  // resolveWarPatrolLoadout above. `allowUnarmed: true` is the explicit opt-out
  // for a hull that is intentionally not a fighting patrol.
  const warPatrol = request.warPatrol === true || String(request.role || "") === "patrol";
  let loadout = null;
  let loadoutID = String(request.loadoutID || "").trim();
  if (warPatrol || loadoutID) {
    // A patrol that can fire exactly one volley is not a war patrol: the native
    // ammo bank debits one charge per cycle, so a single-charge row is refused.
    loadout = resolveWarPatrolLoadout(profileQuery, loadoutID, { requireAmmoDepth: warPatrol });
    if (loadout.status === "RESOLVED") loadoutID = loadout.loadoutID;
    else if (loadout.status === "ALREADY_ARMED") loadoutID = loadout.override === true ? loadout.loadoutID : "";
    else if (warPatrol && request.allowUnarmed !== true) {
      return {
        ok: false,
        error: "WAR_PATROL_LOADOUT_UNAVAILABLE:" + String(loadout.reason || "UNKNOWN"),
        loadout,
      };
    }
    // The authored row is not in the static table; the native resolver only sees
    // it behind this explicit flag. Without it the spawn would fail with a
    // missing loadout instead of silently fitting the retail empty row.
    if (loadoutID && loadoutID.startsWith("coop_war_patrol_ammo") &&
      process.env.EVEJS_COOP_WAR_PATROL_LOADOUT_ROW !== "1") {
      return {
        ok: false,
        error: "WAR_PATROL_LOADOUT_UNAVAILABLE:AUTHORED_ROW_FLAG_OFF",
        loadout,
      };
    }
  }
  let result = null;
  try {
    result = npc.spawnBatchInSystem(systemID, {
      ...anchor,
      amount,
      entityType: "npc",
      // A war patrol is a persistent world presence: a transient hull (and its
      // transient modules/charges) can never pass the native muster gate, which
      // requires durable fitted hardware. `durable: true` is explicit.
      transient: request.durable === true ? false : true,
      broadcast: true,
      profileQuery,
      ...(loadoutID ? { loadoutID } : {}),
    });
  } catch (error) {
    return { ok: false, error: "spawn threw: " + String(error && error.message || error) };
  }
  const spawned = (result && result.data && Array.isArray(result.data.spawned)) ? result.data.spawned : [];
  if (!result || result.success !== true || !spawned.length) {
    return { ok: false, error: String((result && result.errorMsg) || "spawn refused"), spawned: spawned.length };
  }
  const ships = spawned.map((entry) => {
    const entityID = Number((entry.entity && entry.entity.itemID) || entry.entityID || 0);
    let corporationID = 0;
    let factionID = 0;
    try {
      const native = npcStore.getNativeEntity(entityID);
      corporationID = Number(native && native.corporationID) || 0;
      factionID = Number(factions.getFactionIDForCorporation(corporationID)) || 0;
    } catch (_error) {
      corporationID = 0;
    }
    return { entityID, corporationID, factionID };
  });
  // FW-077: a war patrol that was spawned unarmed is not a war patrol, and it is
  // not harmless - it occupies a pilot, a system slot and a registry row while the
  // mobiliser refuses it with WAR_NO_NATIVE_LOADED_WEAPON. Measured 14:3xZ: a hull from
  // this very action reported ZERO native modules and zero cargo, so the loadout was
  // never fitted and the campaign could not muster. The answer now says so at spawn time,
  // with the entity named, instead of failing a war an hour later.
  if (warPatrol && ships.length) {
    const bare = ships.filter((ship) => {
      try {
        const modules = npcStore.listNativeModulesForEntity(ship.entityID) || [];
        return modules.length === 0;
      } catch (_error) { return false; }
    });
    if (bare.length)
      return { ok: false, error: "WAR_PATROL_UNARMED",
        entityIDs: bare.map((ship) => ship.entityID),
        loadoutID: String(loadoutID || ""),
        evidence: "SPAWNED_HULL_HAS_NO_NATIVE_MODULES_SO_THE_WAR_CANNOT_FIRE" };
  }
  // Optional: make the ship a real world presence by linking it to an unlinked
  // roster pilot. Without a link the war presence legitimately ignores the hull.
  let link = null;
  const pilotID = String(request.pilotID || "").trim();
  if (pilotID && ships.length) {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      link = runtimeWorld.linkSpawnedIdentity({
        pilotID,
        systemID,
        entityID: ships[0].entityID,
        role: String(request.role || ""),
      });
    } catch (error) {
      link = { status: "LINK_UNAVAILABLE", reason: String(error && error.message || error) };
    }
  }
  return {
    ok: true,
    systemID,
    profileQuery,
    spawned: ships.length,
    ships,
    link,
    durable: request.durable === true,
    loadout: loadout ? {
      status: loadout.status,
      reason: String(loadout.reason || ""),
      loadoutID: String(loadout.loadoutID || ""),
      moduleTypeID: Number(loadout.moduleTypeID) || 0,
      chargeTypeID: Number(loadout.chargeTypeID) || 0,
      moduleFamily: String(loadout.moduleFamily || ""),
      chargeDepth: Number(loadout.chargeDepth) || 0,
    } : null,
    selectionID: String((result.data && (result.data.selectionID || result.data.selectionName)) || ""),
  };
}

// FW-024: read-only militia view for one real character. It resolves the
// character's own faction from the character record, the militia corporation
// from the faction record, the enemy from the declared war (or the game's own
// warzone pairing) and the live enlistment/merit rows. Nothing is written.

function militiaEnlist(request) {
  const characterID = Number(request.characterID) || 0;
  const agentID = Number(request.agentID) || 0;
  if (!(characterID > 0) || !(agentID > 0))
    return { ok: false, error: "characterID and agentID are required" };
  try {
    const characters = require("../services/character/characterState");
    const agents = require("../services/agent/agentAuthority");
    const registry = require("../services/chat/sessionRegistry");
    const record = characters.getCharacterRecord(characterID);
    const agent = agents.getAgentByID(agentID);
    if (!record || !agent) return { ok: false, error: "unknown character or agent" };
    if (Number(record.stationID) !== Number(agent.stationID))
      return { ok: false, error: "character is not docked at that agent's station",
        characterStationID: Number(record.stationID) || 0, agentStationID: Number(agent.stationID) || 0 };
    if (registry.findSessionByCharacterID(characterID))
      return { ok: false, error: "a live session already exists for this character" };
    const session = { characterID, stationid: Number(agent.stationID),
      socket: { destroyed: false }, coopProofSession: true };
    registry.register(session);
    try {
      const reply = require("./coopFactionWarAgent" + siblingSuffix)
        .doAction({ session, agentID, actionID: 3 });
      const warStore = require("./coopFactionWarStore" + siblingSuffix);
      const { readRow } = require("./coopNativeRowPath" + siblingSuffix);
      let enlistment = null;
      try {
        const state = readRow(require("../gameStore"), warStore.TABLE, warStore.KEY);
        enlistment = state && state.enlistments ? state.enlistments[String(characterID)] || null : null;
      } catch (_error) { enlistment = null; }
      return {
        ok: true, characterID, agentID,
        agentSays: reply && reply.data && reply.data.agentSays ? reply.data.agentSays[0] : null,
        enlistment,
        sessionProof: "SERVER_SIDE_IN_PROCESS_SESSION_NOT_A_CLIENT_LOGIN",
      };
    } finally {
      registry.unregister(session);
    }
  } catch (error) {
    return { ok: false, error: "militia enlist failed: " + String(error && error.message || error) };
  }
}

// FW-026/027: real doctrine fleets. One call composes a role-complete formation
// for the commander's real rank, spawns every hull with its authored doctrine
// row, links the commander (the only identity that may be free), and records the
// fleet in the durable roster. Nothing is spawned unless the doctrine row really
// validated and the native spawn really returned a hull.

function warFleetAuthorities() {
  const data = require("./npc/npcData");
  const registry = require("../services/inventory/itemTypeRegistry");
  const dogma = require("./combat/weaponDogma");
  const capability = require("./npc/npcCapabilityResolver");
  const fitting = require("../services/fitting/liveFittingState");
  const database = require("../gameStore");
  const profiles = () => {
    const rows = database.read("npcProfiles", "/");
    return rows && rows.success && rows.data && Array.isArray(rows.data.profiles)
      ? rows.data.profiles : [];
  };
  const chargeTypes = () => {
    const rows = database.read("itemTypes", "/");
    const list = rows && rows.success && rows.data && Array.isArray(rows.data.types)
      ? rows.data.types : [];
    return list.filter((row) => Number(row.categoryID) === 8)
      .map((row) => ({ typeID: Number(row.typeID), name: String(row.name || "") }));
  };
  const doctrine = require("./coopWarDoctrine" + siblingSuffix).createWarDoctrine({
    getProfile: (profileID) => profiles().find((row) => String(row && row.profileID || "") === String(profileID)) || null,
    resolveItemByTypeID: registry.resolveItemByTypeID,
    resolveWeaponFamily: (item) => dogma.resolveWeaponFamily(item),
    isCompatibleCharge: (module, chargeTypeID) =>
      capability.isNpcChargeCompatibleWithModule(module, chargeTypeID),
    listCharges: () => chargeTypes(),
    slotFamilyFor: (typeID) => fitting.getRequiredSlotFamily(typeID),
    hullSlotsFor: (typeID) => fitting.getShipSlotCounts(typeID),
    dogmaAttributeCountFor: (typeID) => Object.keys(fitting.getTypeDogmaAttributes(typeID) || {}).length,
  });
  const composition = require("./coopWarFleetComposition" + siblingSuffix)
    .createWarFleetComposition({
      resolveDoctrine: ({ factionID, role }) => doctrine.resolve({ factionID, role }),
    });
  return { doctrine, composition, data };
}


function freeHullLinks() {
  const file = process.env.EVEJS_COOP_NPC_LINKS || "/var/lib/evejs/coop-npc-links.json";
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(Object.values((raw && raw.links) || {}).map((link) => Number(link && link.entityID)));
  } catch (_error) {
    return new Set();
  }
}

// Real free hulls in a system: alive native entities the identity registry does
// not own, no live fleet owns, whose real corporation resolves to this faction
// and whose hull really is one of its doctrine hulls.

function listFreeHullsFor({ factionID, systemID }) {
  const runtime = require("./runtime");
  const npcStore = require("./npc/nativeNpcStore");
  const factions = require("../services/faction/factionState");
  const roster = require("./coopWarFleetRoster" + siblingSuffix).sharedRoster();
  const { doctrine } = warFleetAuthorities();
  const catalog = doctrine.catalog({ factionID: Number(factionID) });
  const roleByHull = new Map();
  for (const entry of catalog.doctrines || []) {
    if (entry.status === "REFUSED" || !entry.hull) continue;
    if (!roleByHull.has(Number(entry.hull.typeID))) {
      roleByHull.set(Number(entry.hull.typeID), { role: entry.role, doctrineID: entry.loadoutID });
    }
  }
  const scene = runtime.ensureScene(Number(systemID), { refreshStargates: false });
  if (!scene || !scene.dynamicEntities) return { status: "NO_SCENE", hulls: [] };
  const linked = freeHullLinks();
  const owned = new Set();
  try {
    const snapshot = roster.snapshot();
    for (const fleet of Object.values((snapshot && snapshot.state && snapshot.state.fleets) || {})) {
      if (fleet.state === "RECONSTITUTED" || fleet.state === "DESTROYED") continue;
      for (const ship of fleet.ships) {
        if (ship.state !== "LOST" && ship.state !== "LOST_UNRECORDED") owned.add(Number(ship.entityID));
      }
    }
  } catch (_error) { /* an unreadable roster means nothing is adoptable */ }
  const hulls = [];
  for (const entity of scene.dynamicEntities.values()) {
    const entityID = Number(entity && (entity.itemID || entity.entityID)) || 0;
    if (!(entityID > 0) || linked.has(entityID) || owned.has(entityID)) continue;
    let native = null;
    try { native = npcStore.getNativeEntity(entityID); } catch (_error) { native = null; }
    if (!native || native.transient === true) continue;
    if (Number(native.systemID) !== Number(systemID)) continue;
    let faction = 0;
    try { faction = Number(factions.getFactionIDForCorporation(native.corporationID)) || 0; } catch (_error) { faction = 0; }
    if (faction !== Number(factionID)) continue;
    const match = roleByHull.get(Number(entity.typeID || native.typeID));
    if (!match) continue;
    hulls.push({
      entityID, role: match.role, doctrineID: match.doctrineID,
      hullTypeID: Number(entity.typeID || native.typeID) || 0,
    });
  }
  return { status: "OK", systemID: Number(systemID), factionID: Number(factionID), hulls };
}


function spawnWarFleet(request) {
  const factionID = Number(request.factionID) || 0;
  const systemID = Number(request.systemID) || 0;
  if (!(factionID > 0) || !(systemID > 0)) return { ok: false, error: "factionID and systemID are required" };
  const merit = Math.max(0, Number(request.merit) || 0);
  const rank = String(request.rank || "");
  let plan = null;
  try {
    plan = warFleetAuthorities().composition.compose({ factionID, merit, rank });
  } catch (error) {
    return { ok: false, error: "fleet composition unavailable: " + String(error && error.message || error) };
  }
  if (!plan || plan.status !== "COMPOSED") {
    return {
      ok: false,
      error: "FLEET_COMPOSITION_REFUSED:" + String((plan && plan.reason) || "UNKNOWN"),
      plan,
    };
  }
  const commanderPilotID = String(request.commanderPilotID || "").trim();
  const spawned = [];
  for (const ship of plan.ships) {
    const result = spawnNativeNpc({
      systemID,
      profileQuery: ship.profileID,
      warPatrol: true,
      durable: true,
      loadoutID: ship.loadoutID,
      role: "patrol",
      ...(spawned.length === 0 && commanderPilotID ? { pilotID: commanderPilotID } : {}),
    });
    const entityID = result && result.ok && Array.isArray(result.ships) && result.ships.length
      ? Number(result.ships[0].entityID) || 0 : 0;
    spawned.push({
      role: ship.role,
      doctrineID: ship.doctrineID,
      loadoutID: ship.loadoutID,
      profileID: ship.profileID,
      hullName: ship.hullName,
      entityID,
      ok: Boolean(result && result.ok && entityID > 0),
      error: result && result.ok ? "" : String((result && result.error) || "SPAWN_REFUSED"),
      loadout: result && result.loadout ? {
        status: result.loadout.status, reason: result.loadout.reason,
        loadoutID: result.loadout.loadoutID, chargeTypeID: result.loadout.chargeTypeID,
        chargeDepth: result.loadout.chargeDepth, moduleFamily: result.loadout.moduleFamily,
      } : null,
    });
  }
  const ships = spawned.filter((entry) => entry.ok && entry.entityID > 0)
    .map((entry) => ({
      entityID: entry.entityID, role: entry.role, doctrineID: entry.doctrineID,
      loadoutID: entry.loadoutID, profileID: entry.profileID, hullName: entry.hullName,
    }));
  if (!ships.length) {
    emitEvent("living-war-fleet-spawned", "NO_SHIP_SPAWNED", { factionID, systemID, spawned });
    return { ok: false, error: "NO_SHIP_SPAWNED", plan, spawned };
  }
  let fleet = null;
  try {
    fleet = require("./coopWarFleetRoster" + siblingSuffix).sharedRoster().createFleet({
      factionID,
      systemID,
      stagingSystemID: Number(request.stagingSystemID) || systemID,
      rank, merit,
      commandCap: plan.commandCap,
      ships,
    });
  } catch (error) {
    fleet = { status: "BLOCKED", reason: "ROSTER_UNAVAILABLE:" + String(error && error.message || error) };
  }
  emitEvent("living-war-fleet-spawned", fleet && fleet.status === "CREATED" ? "FLEET_SPAWNED" : "FLEET_NOT_RECORDED", {
    factionID, systemID, size: ships.length, commandCap: plan.commandCap,
    counts: plan.counts, fleetID: String((fleet && fleet.fleetID) || ""),
    roles: ships.map((ship) => ship.role),
  });
  return {
    ok: Boolean(fleet && fleet.status === "CREATED"),
    factionID, systemID,
    commandCap: plan.commandCap,
    size: ships.length,
    counts: plan.counts,
    fleetID: String((fleet && fleet.fleetID) || ""),
    fleetStatus: String((fleet && fleet.status) || ""),
    fleetReason: String((fleet && fleet.reason) || ""),
    ships, spawned,
  };
}


function warFleetState(request) {
  const roster = require("./coopWarFleetRoster" + siblingSuffix).sharedRoster();
  const fleetID = String(request.fleetID || "").trim();
  const snapshot = roster.snapshot();
  if (!snapshot || snapshot.status !== "OK") return { ok: false, error: "FLEET_ROSTER_" + String(snapshot && snapshot.status || "UNAVAILABLE") };
  if (!fleetID) {
    return {
      ok: true,
      fleets: snapshot.fleets,
      state: snapshot.state.fleets,
      presence: roster.presence({ systemIDs: [] }),
    };
  }
  const fleet = roster.fleet(fleetID);
  if (!fleet) return { ok: false, error: "FLEET_NOT_FOUND", fleetID };
  let store = null;
  try { store = require("./npc/nativeNpcStore"); } catch (_error) { store = null; }
  const ships = fleet.ships.map((ship) => {
    let modules = [], cargo = [], native = null;
    try {
      native = store ? store.getNativeEntity(ship.entityID) : null;
      modules = store ? (store.listNativeModulesForEntity(ship.entityID) || []) : [];
      cargo = store ? (store.listNativeCargoForEntity(ship.entityID) || []) : [];
    } catch (_error) { /* reported as zeroes below */ }
    return {
      entityID: ship.entityID,
      role: ship.role,
      doctrineID: ship.doctrineID,
      hullTypeID: ship.hullTypeID,
      hullName: ship.hullName,
      state: ship.state,
      alive: Boolean(native),
      systemID: Number(native && native.systemID) || 0,
      moduleCount: modules.length,
      moduleTypeIDs: modules.map((m) => Number(m.typeID) || 0),
      chargeStacks: cargo.map((c) => ({ typeID: Number(c.typeID) || 0, quantity: Number(c.quantity) || 0 })),
      chargeTotal: cargo.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0),
    };
  });
  return { ok: true, fleetID, fleet: { ...fleet, ships }, ships };
}


function fleetReconstitute(request) {
  const fleetID = String(request.fleetID || "").trim();
  if (!fleetID) return { ok: false, error: "fleetID is required" };
  const roster = require("./coopWarFleetRoster" + siblingSuffix).sharedRoster();
  const recorded = [];
  for (const loss of Array.isArray(request.losses) ? request.losses : []) {
    const entityID = Number(loss && loss.entityID) || 0;
    const wreckID = Number(loss && loss.wreckID) || 0;
    if (!(entityID > 0)) { recorded.push({ status: "BLOCKED", reason: "LOSS_ENTITY_REQUIRED" }); continue; }
    // A loss is only recorded with a real native wreck: never a guessed death.
    if (!(wreckID > 0)) {
      recorded.push({ status: "BLOCKED", reason: "LOSS_WRECK_REQUIRED", entityID });
      continue;
    }
    recorded.push(roster.recordLoss({
      fleetID, entityID, wreckID,
      casualtyID: String(loss.casualtyID || ""),
    }));
  }
  const stagingSystemID = Number(request.stagingSystemID) || 0;
  const merit = Math.max(0, Number(request.merit) || 0);
  const rank = String(request.rank || "");
  const { composition } = warFleetAuthorities();
  const plan = roster.planReconstitution({
    fleetID,
    stagingSystemID,
    merit,
    rank,
    compose: ({ factionID, merit: m, rank: r }) => composition.compose({ factionID, merit: m, rank: r }),
  });
  let committed = null;
  if (request.commit === true && (plan.status === "RECONSTITUTED" || plan.status === "REDUCED")) {
    committed = roster.commitReconstitution({ plan, rank });
  }
  // FW-039: a real loss and a real replacement are announced on the front once
  // each (warFrontChat is once-per-eventKey), never once per tick.
  try {
    const runtime = require("./coopVirtualWorldRuntime" + siblingSuffix);
    for (const row of recorded) {
      if (row && row.status === "RECORDED" && row.frontChat)
        runtime.warFrontChat(row.frontChat.kind, row.frontChat,
          [row.frontChat.systemID]);
    }
    if (committed && committed.frontChat)
      runtime.warFrontChat(committed.frontChat.kind, committed.frontChat,
        [committed.frontChat.systemID]);
  } catch (_error) { /* the front chat must never fail a reconstitution */ }
  emitEvent("living-war-fleet-reconstitution",
    plan.status === "BLOCKED" ? "BLOCKED" : String(committed ? committed.status : plan.status), {
      fleetID,
      status: plan.status,
      reason: String(plan.reason || ""),
      survivors: Array.isArray(plan.survivors) ? plan.survivors.length : 0,
      adopted: Array.isArray(plan.adopted) ? plan.adopted.length : 0,
      missing: Array.isArray(plan.missing) ? plan.missing.length : 0,
      size: Number(plan.size) || 0,
      commandCap: Number(plan.commandCap) || 0,
      newFleetID: String((committed && committed.fleetID) || ""),
    });
  return { ok: plan.status !== "BLOCKED", recorded, plan, committed };
}

// FW-027: crew a real hull with a real roster identity, or release one. A fleet
// hull spawned by spawn_war_fleet is unlinked by design (the world's pilot roster
// is finite), and the war mobiliser only musters linked patrols, so this pair of
// actions is how a fleet commander really takes the ship. Neither action creates
// a ship or an identity: release only detaches an existing link, assign only uses
// a pilot the identity registry still considers free.

function releaseIdentity(request) {
  const pilotID = String(request.pilotID || "").trim();
  const entityID = Number(request.entityID) || 0;
  if (!pilotID) return { ok: false, error: "pilotID is required" };
  // FW-075: releasing an identity while its hull is still flying leaves an armed ship
  // that can be killed but can never be attributed. Measured 12:36Z and 12:40Z: two war
  // casualties answered NOT_UNIQUE_NAMED_PIRATE because their hulls had no link at all
  // (the pilots had been released minutes earlier to free the pool). A release now
  // refuses while the hull is physical, unless the operator forces it explicitly.
  if (request.force !== true) {
    try {
      const pilotRow = require("./npc/nativeNpcStore");
      const links = require("./coopVirtualWorldRuntime" + siblingSuffix).identityLinks();
      const bound = (Array.isArray(links) ? links : []).find((row) =>
        row && String(row.pilotID || "") === pilotID);
      const liveID = Number(bound && bound.entityID) || entityID;
      const native = liveID > 0 ? pilotRow.getNativeEntity(liveID) : null;
      if (native && Number(native.entityID) === liveID)
        return { ok: false, error: "HULL_STILL_PHYSICAL", pilotID,
          entityID: liveID, systemID: Number(native.systemID) || 0,
          evidence: "A_RELEASED_IDENTITY_LEAVES_AN_UNATTRIBUTABLE_ARMED_HULL" };
    } catch (_error) { /* an unreadable store never blocks an explicit release */ }
  }
  try {
    const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
    const released = runtimeWorld.releaseSpawnedIdentity({
      pilotID, entityID, reason: String(request.reason || "IDENTITY_REASSIGNED"),
    });
    emitEvent("living-identity-released", String(released && released.status || "UNKNOWN"), {
      pilotID, entityID, reason: String(request.reason || ""),
      releasedEntityID: Number(released && released.entityID) || 0,
    });
    return { ok: released && released.status === "RELEASED", pilotID, released };
  } catch (error) {
    return { ok: false, error: "identity release failed: " + String(error && error.message || error) };
  }
}


function assignIdentity(request) {
  const pilotID = String(request.pilotID || "").trim();
  const entityID = Number(request.entityID) || 0;
  const systemID = Number(request.systemID) || 0;
  if (!pilotID || !(entityID > 0) || !(systemID > 0)) {
    return { ok: false, error: "pilotID, entityID and systemID are required" };
  }
  try {
    const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
    const link = runtimeWorld.linkSpawnedIdentity({
      pilotID, systemID, entityID, role: String(request.role || "patrol"),
    });
    emitEvent("living-identity-assigned", String(link && link.status || "UNKNOWN"), {
      pilotID, entityID, systemID, role: String(request.role || "patrol"),
    });
    return { ok: link && link.status === "LINKED", pilotID, entityID, systemID, link };
  } catch (error) {
    return { ok: false, error: "identity assign failed: " + String(error && error.message || error) };
  }
}


module.exports = {fs, siblingSuffix, REQUESTS, RESULTS, EVENTS, ALLOWED_ACTIONS, MAX_REQUESTS_PER_DRAIN, readJsonLines, writeJsonLines, appendJsonLine, emitEvent, readRow, readItemRows, liveSessionFor, executeChatCommand, blueprintAuto, createCourierContract, giveItem, removeItem, boardShip, moveItem, fitShip, fitSlots, giveFit, restoreLastLoss, deployStructure, resolveWarPatrolLoadout, spawnNativeNpc, militiaEnlist, warFleetAuthorities, freeHullLinks, listFreeHullsFor, spawnWarFleet, warFleetState, fleetReconstitute, releaseIdentity, assignIdentity};
