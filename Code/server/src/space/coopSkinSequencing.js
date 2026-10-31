"use strict";
// SKIN sequencing jobs (eve_public...sequencing.job.api.*).
//
// A job is the only thing that turns a design into a third-party skin licence. It costs real
// things, and it pays for them before the job exists:
//
//   - every component in the design must be covered by a licence the character holds: an
//     infinite licence is free, a finite one is spent down by the amount asked for;
//   - `licenses` is the number of copies being sequenced, which is the quantity the job will
//     mint when it completes.
//
// If anything is missing the request is refused and NOTHING is spent - the checks run over the
// whole design before the first component is taken. A job that is due completes on read (Get or
// GetAllActive), mints the copies into the licence store and is never charged twice; CompleteEarly
// completes a pending job now. No skin hex is invented before a job actually completes.
const path = require("path");
const crypto = require("crypto");

const STATE_KEY = "skinSequencingJobs";
const VERSION = 1;
const MAX_QUANTITY = 100;
const DEFAULT_DURATION_MS = 30000;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

// A skin hex is derived from the job id, so it cannot be guessed before the job completes and
// it can never collide with another job.
function skinHexFor(uuid) {
  return crypto.createHash("sha256").update(`skins:${uuid}`).digest("hex").slice(0, 16);
}

// The job id arrives as raw bytes; the store keys rows by its hex form.
function uuidKey(value) {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value == null ? "" : value).trim().toLowerCase();
}

function emptyState() {
  return { version: VERSION, jobs: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== VERSION ||
    !raw.jobs || typeof raw.jobs !== "object" || Array.isArray(raw.jobs)) {
    return emptyState();
  }
  const jobs = {};
  for (const [key, row] of Object.entries(raw.jobs)) {
    if (!row || typeof row !== "object") continue;
    jobs[key] = {
      uuid: String(row.uuid || key),
      name: String(row.name || ""),
      lineName: String(row.lineName || ""),
      layout: String(row.layout || ""),
      quantity: Math.max(0, int(row.quantity)),
      kinds: Array.isArray(row.kinds) ? row.kinds.map((kind) => ({
        component: Math.max(0, int(kind && kind.component)),
        infinite: kind && kind.infinite === true,
        finite: Math.max(0, int(kind && kind.finite)),
      })) : [],
      pending: row.pending !== false,
      startedMs: Math.max(0, int(row.startedMs)),
      plannedMs: Math.max(0, int(row.plannedMs)),
      completedMs: Math.max(0, int(row.completedMs)),
      skinHex: String(row.skinHex || ""),
      failed: String(row.failed || ""),
    };
  }
  return { version: VERSION, jobs };
}

function createSkinSequencing({
  characterState = null,
  componentLicences = null,
  skins = null,
  clock = () => Date.now(),
  randomUuid = () => crypto.randomBytes(16),
  env = process.env,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const licences = () => componentLicences || require(path.join(
    __dirname,
    "./coopComponentLicences",
  )).shared();
  const licenceStore = () => skins || require(path.join(
    __dirname,
    "./coopThirdPartySkins",
  )).shared();
  const enabled = () => env.EVEJS_COOP_THIRD_PARTY_SKINS === "1";

  function durationMs() {
    const configured = int(env.EVEJS_COOP_SKIN_SEQUENCING_MS);
    return configured > 0 ? configured : DEFAULT_DURATION_MS;
  }

  function stateOf(characterID) {
    try {
      const record = owner().getCharacterRecord(characterID);
      return normalizeState(record && record[STATE_KEY]);
    } catch (_error) {
      return emptyState();
    }
  }

  function save(characterID, state) {
    const result = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      [STATE_KEY]: state,
    }));
    if (!result || result.success !== true) {
      throw Error("SKIN_SEQUENCING_STATE_WRITE_FAILED");
    }
    return state;
  }

  function persist(characterID, state) {
    try {
      save(characterID, state);
      return { status: "OK" };
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
  }

  // A job completes on read, so the completion waits here until the caller that caused the read
  // drains it. A job's completedMs is set once, so nothing is queued or announced twice.
  const completions = new Map();
  function queueCompletion(characterID, event) {
    if (!(characterID > 0) || !event) return 0;
    const rows = completions.get(characterID) || [];
    rows.push(event);
    completions.set(characterID, rows.slice(-64));
    return rows.length;
  }
  function takeCompletions(characterID) {
    const id = int(characterID);
    if (id <= 0) return [];
    const rows = completions.get(id) || [];
    completions.delete(id);
    return rows;
  }

  function completeJob(characterID, state, job, nowMs) {
    const hex = job.skinHex || skinHexFor(job.uuid);
    const minted = licenceStore().grant(characterID, {
      skin: hex,
      unactivated: job.quantity,
      name: job.name,
      lineName: job.lineName,
      layout: job.layout,
      creatorID: characterID,
    });
    if (minted.status !== "GRANTED") {
      // The design was paid for; a store that cannot take the copies is a failure, not a retry.
      job.pending = false;
      job.failed = String(minted.status || "MINT_FAILED");
      return job;
    }
    job.pending = false;
    job.skinHex = hex;
    job.completedMs = nowMs;
    // A job completes on read, so the completion is queued for whoever caused the read and drained
    // by the gateway that announces it. A failure is not queued: its notice carries an enum reason
    // this store cannot name, and a made-up reason is worse than no notice.
    queueCompletion(int(characterID), {
      uuid: job.uuid,
      quantity: Math.max(1, int(job.quantity) || 1),
      skinHex: hex,
      completedMs: nowMs,
    });
    return job;
  }

  // Due jobs complete on read, which is what makes a job survive a restart: the store keeps the
  // planned time, not a timer.
  function refresh(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return emptyState();
    const state = stateOf(id);
    const nowMs = int(clock()) || Date.now();
    let changed = false;
    for (const job of Object.values(state.jobs)) {
      if (!job.pending || job.failed || job.completedMs) continue;
      if (job.plannedMs <= nowMs) {
        completeJob(id, state, job, nowMs);
        changed = true;
      }
    }
    if (changed) persist(id, state);
    return state;
  }

  function list(characterID) {
    const state = refresh(characterID);
    return Object.values(state.jobs)
      .filter((job) => job.pending)
      .sort((left, right) => (left.plannedMs - right.plannedMs) || left.uuid.localeCompare(right.uuid));
  }

  function get(characterID, uuid) {
    const id = int(characterID);
    const key = uuidKey(uuid);
    if (!enabled() || id <= 0 || !/^[0-9a-f]{2,128}$/.test(key)) return null;
    const state = refresh(id);
    return state.jobs[key] || null;
  }

  function initiate(characterID, {
    name, lineName, layout, kinds = [], quantity = 1,
  } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const copies = int(quantity);
    if (copies <= 0 || copies > MAX_QUANTITY) return { status: "QUANTITY_INVALID" };
    if (!String(layout || "").trim()) return { status: "LAYOUT_REQUIRED" };
    const wanted = (Array.isArray(kinds) ? kinds : []).map((kind) => ({
      component: int(kind && kind.component),
      infinite: kind && kind.infinite === true,
      finite: Math.max(0, int(kind && kind.finite)),
    }));
    if (wanted.some((kind) => kind.component <= 0)) return { status: "COMPONENT_REQUIRED" };

    // Every component is checked before anything is spent: a design either costs its whole
    // price or nothing at all.
    for (const kind of wanted) {
      if (kind.infinite) {
        if (!licences().infinite(id, kind.component)) {
          return { status: "LICENCE_NOT_FOUND", component: kind.component };
        }
        continue;
      }
      const row = licences().finite(id, kind.component);
      if (!row) return { status: "LICENCE_NOT_FOUND", component: kind.component };
      const amount = kind.finite > 0 ? kind.finite : 1;
      if (row.capacity < amount) {
        return { status: "NOT_ENOUGH_CAPACITY", component: kind.component, remaining: row.capacity };
      }
    }

    for (const kind of wanted) {
      if (kind.infinite) continue;
      const spent = licences().takeFinite(id, kind.component, kind.finite > 0 ? kind.finite : 1);
      if (spent.status !== "SPENT" && spent.status !== "FREE") {
        return { status: "SPEND_FAILED", component: kind.component, reason: spent.status };
      }
    }

    const state = stateOf(id);
    const nowMs = int(clock()) || Date.now();
    let uuid = "";
    for (let attempt = 0; attempt < 8 && !uuid; attempt += 1) {
      const candidate = randomUuid();
      const key = Buffer.isBuffer(candidate) ? candidate.toString("hex") : String(candidate || "");
      if (key && !state.jobs[key]) uuid = key;
    }
    if (!uuid) return { status: "UUID_FAILED" };

    state.jobs[uuid] = {
      uuid,
      name: String(name || ""),
      lineName: String(lineName || ""),
      layout: String(layout || ""),
      quantity: copies,
      kinds: wanted,
      pending: true,
      startedMs: nowMs,
      plannedMs: nowMs + durationMs(),
      completedMs: 0,
      skinHex: "",
      failed: "",
    };
    const written = persist(id, state);
    return written.status === "OK"
      ? { status: "STARTED", job: state.jobs[uuid] }
      : written;
  }

  function completeEarly(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = uuidKey(uuid);
    if (!/^[0-9a-f]{2,128}$/.test(key)) return { status: "UUID_REQUIRED" };
    const state = refresh(id);
    const job = state.jobs[key];
    if (!job) return { status: "NOT_FOUND" };
    if (!job.pending) return { status: "NOT_PENDING" };
    completeJob(id, state, job, int(clock()) || Date.now());
    const written = persist(id, state);
    return written.status === "OK" ? { status: "COMPLETED", job } : written;
  }

  return Object.freeze({
    enabled,
    durationMs,
    list,
    get,
    initiate,
    completeEarly,
    takeCompletions,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createSkinSequencing();
  }
  return singleton;
}

module.exports = {
  DEFAULT_DURATION_MS,
  MAX_QUANTITY,
  STATE_KEY,
  createSkinSequencing,
  emptyState,
  normalizeState,
  shared,
  skinHexFor,
};
