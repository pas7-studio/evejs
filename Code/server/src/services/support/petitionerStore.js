const fs = require("fs");
const path = require("path");

// Durable petition store. The client's help window used to be answered with
// constant nulls, so a player could not even file a support ticket. The rows
// below are the only source of truth: every mutation goes through this module
// and is written to disk atomically, so a restart never loses or invents a
// ticket.
const DATA_DIR = process.env.EVEJS_DATA_ROOT || process.env.EVEJS_DATA_DIR || "/var/lib/evejs";
const FILE_NAME = "petitions.json";
const FILE_VERSION = 1;
const MAX_MESSAGES = 200;

const CATEGORIES = Object.freeze([
  { categoryID: 1001, categoryName: "Gameplay issue", description: "Something in the world did not behave as expected." },
  { categoryID: 1002, categoryName: "Technical issue", description: "The client or the server refused to do something." },
  { categoryID: 1003, categoryName: "Other", description: "Anything that does not fit the other categories." },
]);

function positive(value) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function text(value, limit = 4000) {
  return String(value === undefined || value === null ? "" : value).slice(0, limit);
}

function nowIso() {
  return new Date().toISOString();
}

// The client formats petition dates with `FmtDate(..., 'ls')`, which expects the
// same 100-ns Windows filetime every other EVE timestamp uses, not an ISO string.
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
function toFileTime(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return 0;
  return (ms + FILETIME_EPOCH_OFFSET_MS) * 10000;
}

function statePath() {
  return path.join(DATA_DIR, FILE_NAME);
}

function emptyState() {
  return {
    version: FILE_VERSION,
    nextPetitionID: 1,
    nextMessageID: 1,
    petitions: {},
  };
}

let cache = null;

function loadState() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.petitions && typeof parsed.petitions === "object") {
      cache = {
        version: FILE_VERSION,
        nextPetitionID: positive(parsed.nextPetitionID) || 1,
        nextMessageID: positive(parsed.nextMessageID) || 1,
        petitions: parsed.petitions,
      };
      return cache;
    }
  } catch (_error) {
    // A missing file is the normal first start; a corrupt one must not be
    // silently replaced, so the caller gets an empty state and the next write
    // keeps a backup of the unreadable bytes.
    if (_error && _error.code !== "ENOENT") {
      try {
        fs.copyFileSync(statePath(), `${statePath()}.corrupt-${Date.now()}`);
      } catch (_copyError) {
        /* nothing else to do */
      }
    }
  }
  cache = emptyState();
  return cache;
}

function saveState(state) {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, target);
  return true;
}

// A petition row is what the client reads directly (attribute access), so the
// field names come from its own petition window, not from our convenience.
function buildRow(petition) {
  const messages = Array.isArray(petition.messages) ? petition.messages : [];
  return {
    petitionID: petition.petitionID,
    petitionerID: petition.petitionerID,
    email: petition.email || "",
    subject: petition.subject,
    petition: petition.body,
    categoryID: petition.categoryID,
    queueID: petition.queueID,
    claimed: petition.claimedBy > 0 ? 1 : 0,
    claimedByID: petition.claimedBy,
    closed: petition.closed ? 1 : 0,
    deleted: petition.deleted ? 1 : 0,
    updated: petition.updated ? 1 : 0,
    rateable: petition.closed && petition.petitionerID > 0 ? 1 : 0,
    ratingDateTime: petition.ratingAt ? toFileTime(petition.ratingAt) : null,
    responseTimeRating: petition.ratings ? petition.ratings.responseTime : 0,
    helpfulnessRating: petition.ratings ? petition.ratings.helpfulness : 0,
    attitudeRating: petition.ratings ? petition.ratings.attitude : 0,
    comment: petition.ratings ? petition.ratings.comment : "",
    escalatesTo: petition.escalatesTo || 0,
    createDate: toFileTime(petition.createDate),
    lastUpdate: toFileTime(petition.lastUpdate),
    messageCount: messages.length,
  };
}

function createPetition(input) {
  const state = loadState();
  const subject = text(input && input.subject, 200).trim();
  const body = text(input && input.body, 10000).trim();
  const petitionerID = positive(input && input.petitionerID);
  if (!subject || !body || !(petitionerID > 0)) {
    return { success: false, reason: "INVALID_PETITION" };
  }
  const petitionID = state.nextPetitionID++;
  const at = nowIso();
  state.petitions[String(petitionID)] = {
    petitionID,
    petitionerID,
    email: text(input && input.email, 200),
    subject,
    body,
    categoryID: positive(input && input.categoryID) || CATEGORIES[0].categoryID,
    queueID: positive(input && input.queueID) || 1,
    claimedBy: 0,
    closed: false,
    deleted: false,
    updated: false,
    createDate: at,
    lastUpdate: at,
    ratingAt: null,
    ratings: null,
    escalatesTo: 0,
    messages: [],
    log: [{ at, kind: "created", characterID: petitionerID }],
  };
  saveState(state);
  return { success: true, petitionID, petition: getPetition(petitionID) };
}

function getPetitionRecord(petitionID) {
  const state = loadState();
  const record = state.petitions[String(positive(petitionID))];
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function getPetition(petitionID) {
  const record = getPetitionRecord(petitionID);
  return record ? buildRow(record) : null;
}

function listPetitions(predicate) {
  const state = loadState();
  const rows = [];
  for (const record of Object.values(state.petitions)) {
    if (typeof predicate === "function" && !predicate(record)) continue;
    rows.push(buildRow(record));
  }
  rows.sort((left, right) => right.petitionID - left.petitionID);
  return rows;
}

function listForPetitioner(characterID) {
  const id = positive(characterID);
  if (!(id > 0)) return [];
  return listPetitions((record) => record.petitionerID === id && record.deleted !== true);
}

function listClaimedBy(characterID) {
  const id = positive(characterID);
  if (!(id > 0)) return [];
  return listPetitions((record) => record.claimedBy === id && record.deleted !== true);
}

function listQueue(queueID) {
  const queue = positive(queueID) || 1;
  return listPetitions((record) => (
    record.deleted !== true &&
    record.closed !== true &&
    !(record.claimedBy > 0) &&
    (positive(record.queueID) || 1) === queue
  ));
}

function updatePetition(petitionID, mutate) {
  const state = loadState();
  const key = String(positive(petitionID));
  const record = state.petitions[key];
  if (!record) return { success: false, reason: "PETITION_NOT_FOUND" };
  const result = mutate(record) || {};
  if (result.refused) return { success: false, reason: String(result.refused) };
  record.lastUpdate = nowIso();
  if (!Array.isArray(record.log)) record.log = [];
  record.log.push({ at: record.lastUpdate, kind: String(result.log || "updated") });
  if (record.log.length > MAX_MESSAGES) record.log.splice(0, record.log.length - MAX_MESSAGES);
  saveState(state);
  return { success: true, petition: buildRow(record), detail: result.detail || null };
}

function addMessage(petitionID, senderID, body, isComment) {
  const message = text(body, 4000).trim();
  if (!message) return { success: false, reason: "EMPTY_MESSAGE" };
  const state = loadState();
  const record = state.petitions[String(positive(petitionID))];
  if (!record) return { success: false, reason: "PETITION_NOT_FOUND" };
  if (record.closed) return { success: false, reason: "PetitionClosed" };
  const messageID = state.nextMessageID++;
  const at = nowIso();
  if (!Array.isArray(record.messages)) record.messages = [];
  record.messages.push({
    messageID,
    petitionID: record.petitionID,
    senderID: positive(senderID),
    text: message,
    comment: isComment === true,
    createDate: at,
    readBy: [],
  });
  if (record.messages.length > MAX_MESSAGES) {
    record.messages.splice(0, record.messages.length - MAX_MESSAGES);
  }
  record.lastUpdate = at;
  record.updated = true;
  saveState(state);
  return { success: true, messageID };
}

function listMessages(petitionID, readerID) {
  const record = getPetitionRecord(petitionID);
  if (!record) return [];
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return messages.map((message) => ({
    messageID: message.messageID,
    petitionID: message.petitionID,
    senderID: message.senderID,
    message: message.text,
    text: message.text,
    comment: message.comment === true ? 1 : 0,
    createDate: toFileTime(message.createDate),
    unread: !(Array.isArray(message.readBy) && message.readBy.includes(positive(readerID))),
  }));
}

function listUnread(characterID) {
  const id = positive(characterID);
  if (!(id > 0)) return [];
  const state = loadState();
  const unread = [];
  for (const record of Object.values(state.petitions)) {
    if (record.deleted === true) continue;
    if (record.petitionerID !== id) continue;
    for (const message of Array.isArray(record.messages) ? record.messages : []) {
      if (message.senderID === id) continue;
      if (Array.isArray(message.readBy) && message.readBy.includes(id)) continue;
      unread.push({
        messageID: message.messageID,
        petitionID: record.petitionID,
        text: message.text,
        createDate: toFileTime(message.createDate),
      });
    }
  }
  unread.sort((left, right) => left.messageID - right.messageID);
  return unread;
}

function markMessageRead(characterID, messageID) {
  const id = positive(characterID);
  const target = positive(messageID);
  if (!(id > 0) || !(target > 0)) return { success: false, reason: "INVALID_MESSAGE" };
  const state = loadState();
  for (const record of Object.values(state.petitions)) {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const message = messages.find((entry) => entry.messageID === target);
    if (!message) continue;
    if (!Array.isArray(message.readBy)) message.readBy = [];
    if (!message.readBy.includes(id)) message.readBy.push(id);
    saveState(state);
    return { success: true };
  }
  return { success: false, reason: "MESSAGE_NOT_FOUND" };
}

function ratePetition(petitionID, characterID, ratings) {
  return updatePetition(petitionID, (record) => {
    if (record.petitionerID !== positive(characterID)) return { refused: "NOT_PETITIONER" };
    if (!record.closed) return { refused: "PETITION_NOT_CLOSED" };
    record.ratings = {
      responseTime: Math.max(0, Math.min(5, Math.trunc(Number(ratings.responseTime) || 0))),
      helpfulness: Math.max(0, Math.min(5, Math.trunc(Number(ratings.helpfulness) || 0))),
      attitude: Math.max(0, Math.min(5, Math.trunc(Number(ratings.attitude) || 0))),
      comment: text(ratings.comment, 1000),
    };
    record.ratingAt = nowIso();
    return { log: "rated" };
  });
}

module.exports = {
  CATEGORIES,
  createPetition,
  getPetition,
  getPetitionRecord,
  listForPetitioner,
  listClaimedBy,
  listQueue,
  listMessages,
  listUnread,
  markMessageRead,
  updatePetition,
  addMessage,
  ratePetition,
  // tests
  _resetForTests() {
    cache = null;
  },
  _statePath: statePath,
};
