"use strict";
// Daily goals (eve_public.dailygoal.*): the client side is fully built - a cards
// list, progress bars, a redeem button and live notices - and the server answered
// an empty list, so the whole page was blank.
//
// This module is the data side. Everything it reports is measured, never invented:
//
//   mine_ore            -> the real character mining ledger
//                          (services/mining/miningLedgerState, written by the native
//                          mining cycle for a player ship)
//   kill_npc            -> the real killmail ledger, weighted by the victim's hull
//                          class; a target you damaged but somebody else finished pays
//                          the share of damage you really did (never a full kill)
//   space_jump          -> real accepted stargate jumps, counted by the one-line hook
//                          in space/runtime.startStargateJump
//   install_manufacturing_job -> real industry jobs this character installed today
//                          (industryRuntimeState, the same rows the industry window reads)
//   complete_daily_goal -> goals this character actually redeemed today
//
// Names and descriptions are real message ids from the pinned client's own
// localization data (res:/localizationFSD/localization_fsd_en-us.pickle): a daily
// goal carries only numeric message ids, so a made-up id would render an empty or
// "missing message" card. `tests/coop-daily-goals.test.mjs` re-reads that pickle
// when it is present and fails if an id no longer means what we claim.
//
// Rewards are skill points, the classic daily-goal reward in EVE, granted through
// the same path the campaign skill crates use (updateCharacterRecord +
// emitSkillSessionState). No ISK is minted: an ISK reward would have to be paid
// from a funded account, and the co-op world has no such sponsor for players.
const path = require("path");

const { createSkillPointGrant } = require("./coopSkillPointGrant");

const TABLE_CHARACTERS = "characters";
const TABLE_KILLMAILS = "killmails";
const STATE_KEY = "dailyGoals";
const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
const MAX_TARGET = 1000000;

// Pinned to the client build we run (V24.01). Every id was read out of the
// client's own en-us localization pickle, not guessed.
const MESSAGES = Object.freeze({
  mineOreName: 656416, // "Mine Ore"
  mineOreDescription: 528203, // "Mine ore to help with the materials shortage."
  killNpcName: 1037684, // "Kill NPCs"
  killNpcDescription: 550642, // "Destroy NPCs"
  jumpName: 532900, // "Jump Through"
  completeGoalsName: 696804, // "Complete other goals"
  manufactureName: 1040182, // "Manufacture"
  manufactureDescription: 61487, // "Manufacturing"
  completeGoalsDescription: 696803, // "Complete Goal"
  noHelp: 36, // an empty message in the client's own data
});

// Combat weight by hull class. A battleship is a day's work, a frigate is not, so the
// kill goal counts points instead of hulls and the reward follows the points. Group
// ids are the SDE ship groups (25 frigate, 420/566 destroyer, 26 cruiser, 419
// battlecruiser, 27 battleship, ...); an unknown hull falls back to its mass, so a new
// NPC ship can never be worth zero and never be worth a battleship by accident.
const HULL_GROUP_WEIGHTS = Object.freeze({
  25: 1, // Frigate
  324: 1, // Shuttle
  830: 1, // Corvette
  420: 2, // Destroyer
  566: 2, // Destroyer (NPC legacy group)
  26: 3, // Cruiser
  358: 3, // Heavy Assault Cruiser
  963: 3, // Strategic Cruiser
  419: 4, // Battlecruiser
  540: 4, // Command Ship
  463: 4, // Mining Barge
  543: 4, // Exhumer
  28: 3, // Industrial
  380: 3, // Deep Space Transport
  27: 6, // Battleship
  898: 6, // Black Ops
  485: 10, // Dreadnought
  547: 9, // Carrier
  883: 8, // Capital Industrial
  1538: 8, // Force Auxiliary
  659: 11, // Supercarrier
  30: 14, // Titan
});
const MASS_FALLBACK_BASE = 1.2e6;
const MIN_HULL_WEIGHT = 1;
const MAX_HULL_WEIGHT = 14;
// A target you damaged but did not finish can never be worth a whole kill.
const PARTIAL_CREDIT_CAP = 0.9;

// SP per point / unit. Deliberately generous: the co-op server runs accelerated, and a
// daily goal that pays a few hundred SP is not worth flying for.
const REWARD_RULES = Object.freeze({
  mine_ore: { perUnit: 4, minimum: 12000, maximum: 60000 },
  // 3 000 SP per combat point: finishing the goal (10 points) is 30 000 SP, and a day
  // of battleships (6 points each) pays well above it without becoming a farm.
  kill_npc: { perPoint: 3000, minimum: 20000, maximum: 90000 },
  space_jump: { perUnit: 1500, minimum: 12000, maximum: 40000 },
  install_manufacturing_job: { perUnit: 12000, minimum: 20000, maximum: 40000 },
  complete_daily_goal: { flat: 40000 },
});

// category: 1 = CATEGORY_DAILY, 2 = CATEGORY_DAILY_BONUS
// career:   0 = CAREER_UNSPECIFIED, 1 = EXPLORATION, 2 = INDUSTRIALIST,
//           3 = ENFORCER, 4 = SOLDIER_OF_FORTUNE (eve_public.career.Path)
const DEFINITIONS = Object.freeze([
  Object.freeze({
    goalID: "1e0d0001-0000-4000-8000-000000000001",
    kind: "mine_ore",
    nameID: MESSAGES.mineOreName,
    descriptionID: MESSAGES.mineOreDescription,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 2,
    target: 5000,
    rewardSkillPoints: 20000,
  }),
  Object.freeze({
    goalID: "1e0d0002-0000-4000-8000-000000000002",
    kind: "kill_npc",
    nameID: MESSAGES.killNpcName,
    descriptionID: MESSAGES.killNpcDescription,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 3,
    // Points, not hulls: a frigate is 1, a battleship 6, and a target you only damaged
    // pays your share of it (see killCreditPoints).
    target: 10,
    rewardSkillPoints: 25000,
  }),
  Object.freeze({
    goalID: "1e0d0003-0000-4000-8000-000000000003",
    kind: "space_jump",
    nameID: MESSAGES.jumpName,
    descriptionID: MESSAGES.noHelp,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 1,
    target: 10,
    rewardSkillPoints: 15000,
  }),
  Object.freeze({
    goalID: "1e0d0005-0000-4000-8000-000000000005",
    kind: "install_manufacturing_job",
    nameID: MESSAGES.manufactureName,
    descriptionID: MESSAGES.manufactureDescription,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 2,
    target: 2,
    // 12 000 SP per job, 20 000 minimum so one job already pays for the flight.
    rewardSkillPoints: 24000,
  }),
  Object.freeze({
    goalID: "1e0d0004-0000-4000-8000-000000000004",
    kind: "complete_daily_goal",
    nameID: MESSAGES.completeGoalsName,
    descriptionID: MESSAGES.completeGoalsDescription,
    helpTextID: MESSAGES.noHelp,
    category: 2,
    career: 0,
    target: 2,
    rewardSkillPoints: 40000,
  }),
]);

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function filetimeToMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric / 10000) - FILETIME_EPOCH_OFFSET_MS;
}

function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayBounds(nowMs) {
  const start = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { start, end: start + DAY_MS };
}

function emptyState(nowMs) {
  return { version: VERSION, day: dayKey(nowMs), jumps: 0, claims: {}, manual: {} };
}

// A character's daily state is one small object inside its own character record:
// the record already has a real owner (characterState) and a persistence path, so
// a goal counter never competes with it for the row.
function normalizeState(raw, nowMs) {
  const day = dayKey(nowMs);
  if (!raw || typeof raw !== "object" || raw.version !== VERSION || raw.day !== day) {
    return emptyState(nowMs);
  }
  const claims = {};
  for (const [goalID, claimedAt] of Object.entries(raw.claims || {})) {
    const numeric = int(claimedAt);
    if (goalID && numeric > 0) claims[goalID] = numeric;
  }
  const manual = {};
  for (const [goalID, amount] of Object.entries(raw.manual || {})) {
    const numeric = int(amount);
    if (goalID && numeric !== 0) manual[goalID] = numeric;
  }
  return {
    version: VERSION,
    day,
    jumps: Math.max(0, int(raw.jumps)),
    claims,
    manual,
  };
}

function hullWeight(typeID, resolveType = null) {
  const type = int(typeID);
  if (type <= 0) {
    return MIN_HULL_WEIGHT + 1;
  }
  let record = null;
  try {
    record = resolveType
      ? resolveType(type)
      : require(path.join(__dirname, "../services/inventory/itemTypeRegistry"))
        .resolveItemByTypeID(type);
  } catch (_error) {
    record = null;
  }
  const groupWeight = HULL_GROUP_WEIGHTS[int(record && record.groupID)];
  if (Number.isFinite(groupWeight)) {
    return groupWeight;
  }
  const mass = Number(record && record.mass) || 0;
  if (mass > 0) {
    // Unknown hull: cube-root of its mass relative to a frigate, so a new NPC ship is
    // never worth zero and never worth a capital by accident.
    return clamp(Math.round((mass / MASS_FALLBACK_BASE) ** (1 / 3)),
      MIN_HULL_WEIGHT, MAX_HULL_WEIGHT);
  }
  return MIN_HULL_WEIGHT + 1;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Points for one killed hull, weighted by its class and, for a target somebody else
// finished, by the share of the damage this character really did.
function killCreditPoints(record, characterID, resolveType = null) {
  const victimTypeID = int(record && record.victimShipTypeID);
  const weight = hullWeight(victimTypeID, resolveType);
  const isFinalBlow = int(record && record.finalCharacterID) === characterID;
  if (isFinalBlow) {
    return weight;
  }
  const damageTaken = Math.max(0, Number(record && record.victimDamageTaken) || 0);
  let myDamage = 0;
  for (const attacker of Array.isArray(record && record.attackers) ? record.attackers : []) {
    if (int(attacker && attacker.characterID) === characterID) {
      myDamage += Math.max(0, Number(attacker.damageDone) || 0);
    }
  }
  if (myDamage <= 0) {
    return 0;
  }
  const share = clamp(myDamage / Math.max(damageTaken, myDamage), 0, PARTIAL_CREDIT_CAP);
  return weight * share;
}

function rewardSkillPoints(definition, progress) {
  const rule = REWARD_RULES[definition.kind];
  if (!rule) {
    return definition.rewardSkillPoints;
  }
  if (Number.isFinite(rule.flat)) {
    return rule.flat;
  }
  const perUnit = Number.isFinite(rule.perPoint) ? rule.perPoint : rule.perUnit;
  // Before the target is reached the card must already promise the completion value,
  // and above the target the reward keeps following what was really earned.
  const counted = Math.max(Number(progress) || 0, Number(definition.target) || 0);
  const earned = Math.round(counted * perUnit);
  return clamp(earned, rule.minimum, rule.maximum);
}

function createDailyGoals({
  gameStore,
  characterState,
  miningLogsFor = null,
  industryJobsFor = null,
  hullWeightFor = null,
  clock = () => Date.now(),
  env = process.env,
} = {}) {
  if (typeof gameStore?.read !== "function" || typeof clock !== "function") {
    throw Error("DAILY_GOALS_STORE_REQUIRED");
  }
  const enabled = () => env.EVEJS_COOP_DAILY_GOALS === "1";

  function readRow(table, pth) {
    try {
      const read = gameStore.read(table, pth);
      return read && read.success ? read.data : null;
    } catch (_error) {
      return null;
    }
  }

  function owner() {
    return characterState || require(path.join(
      __dirname,
      "../services/character/characterState",
    ));
  }

  function characterRecord(characterID) {
    // Read through the same owner that writes: the character record has exactly one
    // owner (characterState), and a second reader would answer stale rows.
    try {
      const viaOwner = owner().getCharacterRecord(characterID);
      if (viaOwner) return viaOwner;
    } catch (_error) { /* fall back to the store below */ }
    const records = readRow(TABLE_CHARACTERS, "/") || {};
    return records[String(characterID)] || null;
  }

  function stateOf(characterID, nowMs) {
    const record = characterRecord(characterID);
    return normalizeState(record && record[STATE_KEY], nowMs);
  }

  function saveState(characterID, state) {
    const result = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      [STATE_KEY]: state,
    }));
    if (!result || result.success !== true) {
      throw Error("DAILY_GOALS_STATE_WRITE_FAILED");
    }
    return state;
  }

  function miningLogs(characterID) {
    if (typeof miningLogsFor === "function") {
      return miningLogsFor(characterID) || [];
    }
    // Lazy: the ledger module owns the gameStore, and a goal read must not drag it
    // in before the store is ready.
    return require(path.join(
      __dirname,
      "../services/mining/miningLedgerState",
    )).getCharacterMiningLogs(characterID);
  }

  function industryJobs(characterID) {
    if (typeof industryJobsFor === "function") {
      return industryJobsFor(characterID) || [];
    }
    return require(path.join(
      __dirname,
      "../services/industry/industryRuntimeState",
    )).listJobsByOwner(characterID, true) || [];
  }

  function manufacturingJobsToday(characterID, nowMs) {
    const { start, end } = dayBounds(nowMs);
    let total = 0;
    for (const job of industryJobs(characterID)) {
      const at = filetimeToMs(job && job.startDate);
      if (at >= start && at < end) total += 1;
    }
    return total;
  }

  function minedUnitsToday(characterID, nowMs) {
    const { start, end } = dayBounds(nowMs);
    let total = 0;
    for (const entry of miningLogs(characterID) || []) {
      const at = filetimeToMs(entry && entry.eventDate);
      if (at >= start && at < end) {
        total += Math.max(0, int(entry.quantity));
      }
    }
    return total;
  }

  // Combat score for today: a kill is worth its hull class, and a target you damaged
  // but somebody else finished is worth your share of the damage actually done.
  function npcKillScoreToday(characterID, nowMs) {
    const { start, end } = dayBounds(nowMs);
    const table = readRow(TABLE_KILLMAILS, "/") || {};
    const records = table.records || {};
    let points = 0;
    let kills = 0;
    let assists = 0;
    for (const record of Object.values(records)) {
      if (!record) continue;
      // An NPC victim has no character id; a player ship is never "kill NPCs".
      if (int(record.victimCharacterID) > 0) continue;
      const at = filetimeToMs(record.killTime);
      if (at < start || at >= end) continue;
      const credit = killCreditPoints(record, characterID, hullWeightFor);
      if (credit <= 0) continue;
      points += credit;
      if (int(record.finalCharacterID) === characterID) kills += 1;
      else assists += 1;
    }
    return { points, kills, assists };
  }

  function claimsToday(state, nowMs, excludeGoalID) {
    const { start, end } = dayBounds(nowMs);
    let total = 0;
    for (const [goalID, claimedAt] of Object.entries(state.claims)) {
      if (excludeGoalID && goalID === excludeGoalID) continue;
      if (claimedAt >= start && claimedAt < end) total += 1;
    }
    return total;
  }

  function measuredProgress(definition, characterID, state, nowMs) {
    if (definition.kind === "mine_ore") return minedUnitsToday(characterID, nowMs);
    if (definition.kind === "kill_npc") {
      return npcKillScoreToday(characterID, nowMs).points;
    }
    if (definition.kind === "space_jump") return state.jumps;
    if (definition.kind === "install_manufacturing_job") {
      return manufacturingJobsToday(characterID, nowMs);
    }
    if (definition.kind === "complete_daily_goal") {
      return claimsToday(state, nowMs, definition.goalID);
    }
    return 0;
  }

  function rawProgressFor(definition, characterID, state, nowMs) {
    const measured = measuredProgress(definition, characterID, state, nowMs);
    const manual = int(state.manual[definition.goalID]);
    return Math.max(0, Math.min(MAX_TARGET, measured + manual));
  }

  function progressFor(definition, characterID, state, nowMs) {
    // Clamped to THIS goal's target, never to a shared ceiling. Measured 2026-10-31 in the
    // pinned client (dailygoals/client/goal.pyj): "completed" is
    // `current_progress == target` - exact equality. A goal that overshot (mining 6000 of
    // 5000) therefore never showed its claim button although the server would have paid.
    // A full bar is also what the card draws. The reward still follows the raw progress, so
    // a richer day is still worth more SP.
    return Math.min(definition.target, rawProgressFor(definition, characterID, state, nowMs));
  }

  function snapshotFor(characterID, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED", goals: [] };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER", goals: [] };
    const state = stateOf(id, nowMs);
    return {
      status: "OBSERVED",
      goals: DEFINITIONS.map((definition) => {
        // The wire carries an integer, and the client's own "completed" test is exact
        // equality with the target, so progress is clamped; the reward follows the raw
        // measurement so a bigger haul is still worth more SP.
        const rawProgress = Math.round(rawProgressFor(definition, id, state, nowMs));
        const progress = Math.min(definition.target, rawProgress);
        const claimedAt = int(state.claims[definition.goalID]);
        return {
          definition,
          progress,
          target: definition.target,
          rewardSkillPoints: rewardSkillPoints(definition, rawProgress),
          completed: progress >= definition.target,
          claimedAt,
          claimable: progress >= definition.target && claimedAt === 0,
        };
      }),
    };
  }

  // A real accepted stargate jump, from the runtime hook. Never called by a test
  // double: an unmeasured jump is better than an invented one.
  function recordJump(characterID, nowMs = clock()) {
    if (!enabled()) return "DISABLED";
    const id = int(characterID);
    if (id <= 0) return "NO_CHARACTER";
    const state = stateOf(id, nowMs);
    state.jumps = Math.min(MAX_TARGET, state.jumps + 1);
    try {
      saveState(id, state);
    } catch (_error) {
      return "WRITE_FAILED";
    }
    return "RECORDED";
  }

  // The QA path the client itself calls (dailygoal.api.admin.Progress): it adds to
  // the goal's progress for a character. Stored as an explicit manual delta so a
  // QA adjustment is never confused with a measured event.
  function recordManualProgress(goalID, characterID, amount, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    const definition = DEFINITIONS.find((entry) => entry.goalID === goalID);
    if (!definition) return { status: "UNKNOWN_GOAL" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id, nowMs);
    state.manual[goalID] = int(state.manual[goalID]) + int(amount);
    try {
      saveState(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "RECORDED", progress: progressFor(definition, id, state, nowMs) };
  }

  const grantSkillPoints = createSkillPointGrant({ characterState });

  function redeem(characterID, goalID, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const definition = DEFINITIONS.find((entry) => entry.goalID === goalID);
    if (!definition) return { status: "UNKNOWN_GOAL" };
    const state = stateOf(id, nowMs);
    if (int(state.claims[goalID]) > 0) return { status: "ALREADY_CLAIMED" };
    const progress = Math.round(progressFor(definition, id, state, nowMs));
    if (progress < definition.target) {
      return { status: "NOT_COMPLETED", progress, target: definition.target };
    }
    // The card promised the reward computed from the raw measurement, so redeem pays that.
    const skillPoints = rewardSkillPoints(
      definition,
      Math.round(rawProgressFor(definition, id, state, nowMs)),
    );
    // Claim first, pay second: a paid goal that was not recorded could be paid
    // twice, a recorded goal that was not paid is recoverable.
    state.claims[goalID] = nowMs;
    try {
      saveState(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    try {
      grantSkillPoints(id, skillPoints);
    } catch (error) {
      delete state.claims[goalID];
      try {
        saveState(id, state);
      } catch (_rollbackError) {
        return { status: "REWARD_FAILED_CLAIM_STUCK" };
      }
      return { status: "REWARD_FAILED", reason: error && error.message };
    }
    return { status: "REDEEMED", skillPoints };
  }

  return Object.freeze({
    enabled,
    snapshotFor,
    progressFor,
    recordJump,
    recordManualProgress,
    redeem,
    grantSkillPoints,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createDailyGoals({ gameStore: require("../gameStore") });
  }
  return singleton;
}

module.exports = {
  DEFINITIONS,
  HULL_GROUP_WEIGHTS,
  MESSAGES,
  REWARD_RULES,
  hullWeight,
  killCreditPoints,
  rewardSkillPoints,
  dayBounds,
  dayKey,
  emptyState,
  filetimeToMs,
  normalizeState,
  createDailyGoals,
  shared,
};
