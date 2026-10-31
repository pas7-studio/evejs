const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  buildKeyVal,
  buildList,
  normalizeNumber,
  normalizeText,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const store = require(path.join(__dirname, "./petitionerStore"));

// The help window used to receive constants: MayPetition answered "disabled",
// CreatePetition answered false and every list was empty, so a player could not
// file a ticket at all. The handlers below read and write the durable store in
// `petitionerStore`; nothing is invented and a refused change keeps the ticket
// untouched.
const HELP_CENTER_URL = "https://support.eveonline.com/hc/en-us";
const SUBMIT_REQUEST_URL = `${HELP_CENTER_URL}/requests/new`;
const MAY_PETITION_ALLOWED = 0;

function toPositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(normalizeNumber(unwrapMarshalValue(value), fallback));
  return numeric > 0 ? numeric : fallback;
}

function toText(value, fallback = "") {
  return normalizeText(unwrapMarshalValue(value), fallback);
}

function getSessionCharacterID(session) {
  return toPositiveInteger(
    session && (session.characterID || session.charid || session.clientID),
    0,
  );
}

function kwargsToObject(kwargs) {
  const unwrapped = unwrapMarshalValue(kwargs);
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? unwrapped
    : {};
}

function rowToKeyVal(row) {
  return buildKeyVal(Object.entries(row || {}).map(([key, value]) => [
    key,
    value === undefined ? null : value,
  ]));
}

function rowsToList(rows) {
  return buildList((Array.isArray(rows) ? rows : []).map(rowToKeyVal));
}

function categoryToList() {
  return buildList(store.CATEGORIES.map((category) => buildKeyVal([
    ["categoryID", category.categoryID],
    ["categoryName", category.categoryName],
    ["description", category.description],
    ["primaryCategory", category.categoryName],
    ["categoryHierarchy", [category.categoryID]],
  ])));
}

class PetitionerService extends BaseService {
  constructor() {
    super("petitioner");
  }

  Handle_IsSerenity() {
    return false;
  }

  Handle_IsZendeskEnabled() {
    return true;
  }

  Handle_IsZendeskSwapEnabled() {
    return true;
  }

  Handle_HasOpenTickets(args, session) {
    const characterID = getSessionCharacterID(session);
    const open = store.listForPetitioner(characterID).filter((row) => !row.closed && !row.deleted);
    return open.length > 0;
  }

  Handle_GetZendeskJwtLink(args, session, kwargs) {
    const ticketID = toPositiveInteger(kwargsToObject(kwargs).ticketID, 0);
    return ticketID ? `${HELP_CENTER_URL}/requests/${ticketID}` : SUBMIT_REQUEST_URL;
  }

  Handle_GetUnreadMessages(args, session) {
    return rowsToList(store.listUnread(getSessionCharacterID(session)));
  }

  Handle_MarkAsRead(args, session) {
    const result = store.markMessageRead(getSessionCharacterID(session), toPositiveInteger(args && args[0], 0));
    if (!result.success) log.debug(`[Petitioner] MarkAsRead refused ${result.reason}`);
    return null;
  }

  Handle_GetMyPetitionsEx(args, session) {
    return rowsToList(store.listForPetitioner(getSessionCharacterID(session)));
  }

  Handle_GetClaimedPetitions(args, session) {
    return rowsToList(store.listClaimedBy(getSessionCharacterID(session)));
  }

  Handle_GetPetitionQueue(args) {
    return rowsToList(store.listQueue(toPositiveInteger(args && args[0], 1)));
  }

  Handle_GetQueues() {
    return buildList([buildKeyVal([["queueID", 1], ["queueName", "General"]])]);
  }

  Handle_GetCategories() {
    return categoryToList();
  }

  Handle_GetCategoryHierarchicalInfo() {
    return [buildDict([]), buildDict([]), buildDict([]), buildDict([])];
  }

  Handle_GetCategoryProperties() {
    // No category needs extra structured properties: subject and text are enough.
    return buildList([]);
  }

  Handle_PropertyPopulationInfo() {
    return buildList([]);
  }

  Handle_GetClientPickerInfo() {
    return buildList([]);
  }

  Handle_GetUserCatalogCountry() {
    return "US";
  }

  Handle_MayPetition(args, session) {
    const characterID = getSessionCharacterID(session);
    if (!(characterID > 0)) return -1;
    return MAY_PETITION_ALLOWED;
  }

  Handle_CreatePetition(args, session, kwargs) {
    const characterID = getSessionCharacterID(session);
    const extra = kwargsToObject(kwargs);
    const created = store.createPetition({
      petitionerID: characterID,
      subject: toText(args && args[0], ""),
      body: toText(args && args[1], ""),
      categoryID: toPositiveInteger(args && args[2], 0),
      email: toText(extra.email, ""),
    });
    if (!created.success) {
      log.debug(`[Petitioner] CreatePetition refused ${created.reason} char=${characterID}`);
      return false;
    }
    log.info(`[Petitioner] petition ${created.petitionID} created by ${characterID}`);
    return true;
  }

  Handle_GetLog(args) {
    // The client renders the log from a fixed DBRowDescriptor of petition events;
    // the durable event list is not modelled that way, so the panel stays empty
    // instead of showing rows the client cannot read.
    return buildList([]);
  }

  Handle_GetPetitionMessages(args, session) {
    return rowsToList(
      store.listMessages(toPositiveInteger(args && args[0], 0), getSessionCharacterID(session)),
    );
  }

  Handle_PetitionerChat(args, session) {
    return this._appendMessage(args, session, false);
  }

  Handle_PetitioneeChat(args, session) {
    return this._appendMessage(args, session, true);
  }

  _appendMessage(args, session, isComment) {
    const characterID = getSessionCharacterID(session);
    const petitionID = toPositiveInteger(args && args[0], 0);
    const result = store.addMessage(petitionID, characterID, toText(args && args[1], ""), isComment);
    if (!result.success) {
      log.debug(`[Petitioner] message refused ${result.reason} petition=${petitionID}`);
      const error = new Error(String(result.reason || "PetitionError"));
      error.msg = String(result.reason || "PetitionError");
      throw error;
    }
    return null;
  }

  Handle_DeletePetition(args) {
    return this._update(args, (record) => {
      if (record.deleted === true) return { refused: "ALREADY_DELETED" };
      record.deleted = true;
      return { log: "deleted" };
    });
  }

  Handle_CancelPetition(args) {
    return this._update(args, (record) => {
      if (record.closed === true) return { refused: "ALREADY_CLOSED" };
      record.closed = true;
      record.deleted = true;
      return { log: "cancelled" };
    });
  }

  Handle_ClosePetition(args) {
    return this._update(args, (record) => {
      if (record.closed === true) return { refused: "ALREADY_CLOSED" };
      record.closed = true;
      return { log: "closed" };
    });
  }

  Handle_UnClaimPetition(args, session) {
    const characterID = getSessionCharacterID(session);
    return this._update(args, (record) => {
      if (record.claimedBy !== characterID) return { refused: "NOT_CLAIMER" };
      record.claimedBy = 0;
      return { log: "unclaimed" };
    });
  }

  Handle_EscalatePetition(args) {
    const escalatesTo = toPositiveInteger(args && args[1], 0);
    if (!(escalatesTo > 0)) return null;
    return this._update(args, (record) => {
      record.escalatesTo = escalatesTo;
      return { log: "escalated" };
    });
  }

  Handle_ClaimPetition(args, session) {
    const characterID = getSessionCharacterID(session);
    if (!(characterID > 0)) return 0;
    const result = this._update(args, (record) => {
      if (record.closed === true) return { refused: "PETITION_CLOSED" };
      if (record.claimedBy > 0 && record.claimedBy !== characterID) return { refused: "ALREADY_CLAIMED" };
      record.claimedBy = characterID;
      return { log: "claimed" };
    });
    return result.success ? characterID : 0;
  }

  Handle_AddPetitionRating(args, session) {
    return this._rate(args, session);
  }

  Handle_UpdatePetitionRating(args, session) {
    return this._rate(args, session);
  }

  _rate(args, session) {
    const petitionID = toPositiveInteger(args && args[0], 0);
    const characterID = getSessionCharacterID(session);
    const result = store.ratePetition(petitionID, characterID, {
      responseTime: toPositiveInteger(args && args[1], 0),
      helpfulness: toPositiveInteger(args && args[2], 0),
      attitude: toPositiveInteger(args && args[3], 0),
      comment: toText(args && args[4], ""),
    });
    if (!result.success) log.debug(`[Petitioner] rating refused ${result.reason} petition=${petitionID}`);
    return null;
  }

  _update(args, mutate) {
    const petitionID = toPositiveInteger(args && args[0], 0);
    const result = store.updatePetition(petitionID, mutate);
    if (!result.success) log.debug(`[Petitioner] update refused ${result.reason} petition=${petitionID}`);
    return result;
  }
}

module.exports = PetitionerService;
module.exports._testing = {
  HELP_CENTER_URL,
  SUBMIT_REQUEST_URL,
  MAY_PETITION_ALLOWED,
};
