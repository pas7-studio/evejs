// COOP_COMPONENT_MARKET_V1
//
// The client's SKIN-component market asks the gateway for listings
// (`eve_public.cosmetic.market.component.listing.api.GetAll`) and nobody answered
// it, so the window was empty no matter what the world held. The 924 real component
// item types were already in the item-type table (SDE group 4726), so the missing
// piece was only the market itself.
//
// This store holds listings of REAL component item types. A listing is priced in
// whole ISK (CCP's own base price for that type, rounded up to at least 1) and sells
// a bundle of `bundleSize` units. A purchase debits the buyer's real wallet, takes
// the real component items out of the world's stock and grants them to the buyer's
// station hangar. No stock is conjured by a purchase: the listing carries what it
// sells, and a sold-out listing stops selling.
//
// The price rule and the stock rule are pure, so they are testable without a store.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE_FILE = "coop-component-listings.json";
const HANGAR_FLAG = 4;
const DEFAULT_SALE_DAYS = 30;
const MAX_LISTINGS = 2000;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function emptyState() {
  return { version: 1, seededAtMs: 0, listings: {} };
}

function normalizeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const listings = {};
  const source = state.listings && typeof state.listings === "object" ? state.listings : {};
  for (const key of Object.keys(source)) {
    const row = source[key];
    if (!row || typeof row !== "object") continue;
    const typeID = toInt(row.typeID, 0);
    const priceISK = toInt(row.priceISK, 0);
    const bundleSize = toInt(row.bundleSize, 0);
    const remaining = toInt(row.remaining, 0);
    const saleEndMs = toInt(row.saleEndMs, 0);
    if (!(typeID > 0) || !(priceISK > 0) || !(bundleSize > 0)) continue;
    listings[String(key)] = { uuid: String(key), typeID, priceISK, bundleSize,
      remaining: Math.max(0, remaining), saleEndMs: Math.max(0, saleEndMs),
      createdMs: Math.max(0, toInt(row.createdMs, 0)) };
  }
  return { version: 1, seededAtMs: Math.max(0, toInt(state.seededAtMs, 0)), listings };
}

// A listing is buyable when it still has stock and has not expired.
function isActiveListing(listing, nowMs) {
  if (!listing) return false;
  return toInt(listing.remaining, 0) > 0 &&
    (toInt(listing.saleEndMs, 0) === 0 || toInt(listing.saleEndMs, 0) > toInt(nowMs, 0));
}

// Whole ISK from CCP's base price: never zero (a free item is not a market), and
// rounded up so the seller is not short-changed by a fraction.
function priceForBasePrice(basePrice) {
  const numeric = Number(basePrice);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.max(1, Math.ceil(numeric));
}

// Bundles requested by the client, never more than the listing holds.
function resolveBundleCount(quantity, bundleSize, remaining) {
  const perBundle = Math.max(1, toInt(bundleSize, 1));
  const requested = Math.max(1, toInt(quantity, 1));
  const unitsWanted = requested * perBundle;
  const unitsAvailable = Math.max(0, toInt(remaining, 0));
  if (unitsAvailable <= 0) return 0;
  if (unitsWanted <= unitsAvailable) return requested;
  return Math.floor(unitsAvailable / perBundle);
}

function totalISK({ priceISK, bundles }) {
  return Math.max(0, toInt(priceISK, 0)) * Math.max(0, toInt(bundles, 0));
}

function createComponentListings({
  root = process.env.EVEJS_DATA_ROOT || "/var/lib/evejs",
  clock = () => Date.now(),
  fsApi = fs,
  wallet = null,
  items = null,
  characterState = null,
  events = null,
  env = process.env,
  stateFile = null,
} = {}) {
  const file = stateFile || path.join(root, STATE_FILE);
  const enabled = () => env.EVEJS_COOP_COMPONENT_MARKET === "1";
  const walletApi = () => wallet || require(path.join(__dirname, "../services/account/walletState"));
  const itemApi = () => items || require(path.join(__dirname, "../services/inventory/itemStore"));

  function readState() {
    try {
      return normalizeState(JSON.parse(fsApi.readFileSync(file, "utf8")));
    } catch (error) {
      if (error && error.code === "ENOENT") return emptyState();
      // A corrupt market file must not become "no stock at all" silently: keep the
      // error visible and let the caller decide.
      throw error;
    }
  }

  function writeState(state) {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp-" + process.pid;
    fsApi.writeFileSync(temp, JSON.stringify(state));
    fsApi.renameSync(temp, file);
  }

  function note(kind, detail) {
    try {
      if (events && typeof events.observe === "function") {
        events.observe(kind, null, null, detail);
      } else {
        require("./coopRuntimeProbe").observe(kind, null, null, detail);
      }
    } catch (_error) { /* telemetry never authorizes a sale */ }
  }

  // Seeded once from real component types the caller verified (SDE group 4726).
  // Every listing names a real type, a real price and its own stock.
  function seed(catalog, options = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const entries = Array.isArray(catalog) ? catalog : [];
    const state = readState();
    if (Object.keys(state.listings).length > 0 && options.force !== true) {
      return { status: "ALREADY_SEEDED", listings: Object.keys(state.listings).length };
    }
    const saleDays = Math.max(1, toInt(options.saleDays, DEFAULT_SALE_DAYS));
    const nowMs = clock();
    let written = 0;
    for (const entry of entries) {
      if (Object.keys(state.listings).length >= MAX_LISTINGS) break;
      const typeID = toInt(entry && entry.typeID, 0);
      if (!(typeID > 0)) continue;
      if (state.listings["comp:" + typeID] && options.force !== true) continue;
      const priceISK = priceForBasePrice(entry.basePrice);
      const bundleSize = Math.max(1, toInt(entry.bundleSize, 1));
      const remaining = Math.max(0, toInt(entry.stock, 50));
      state.listings["comp:" + typeID] = {
        uuid: "comp:" + typeID, typeID, priceISK, bundleSize, remaining,
        saleEndMs: nowMs + saleDays * 24 * 60 * 60 * 1000, createdMs: nowMs,
      };
      written += 1;
    }
    if (written > 0) {
      state.seededAtMs = nowMs;
      writeState(state);
    }
    note("coop-component-market-seeded",
      { status: written > 0 ? "SEEDED" : "UNCHANGED", written });
    return { status: written > 0 ? "SEEDED" : "UNCHANGED", listings: Object.keys(state.listings).length };
  }

  function list(nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED", listings: [] };
    const state = readState();
    const listings = Object.values(state.listings)
      .filter((row) => isActiveListing(row, nowMs))
      .sort((left, right) => left.typeID - right.typeID);
    return { status: "OK", listings };
  }

  // Buys real component items with real ISK. Order matters: the stock is reserved
  // first (so two buyers cannot oversell one bundle), then the wallet is debited,
  // then the items are granted. Any later failure puts the stock back.
  function purchase({ uuid, characterID, quantity = 1 } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = toInt(characterID, 0);
    if (!(id > 0)) return { status: "NO_CHARACTER" };
    const key = String(uuid || "");
    if (!key) return { status: "UUID_REQUIRED" };
    const state = readState();
    const listing = state.listings[key];
    if (!listing) return { status: "NOT_FOUND" };
    if (!isActiveListing(listing, clock())) return { status: "NOT_ACTIVE" };
    const bundles = resolveBundleCount(quantity, listing.bundleSize, listing.remaining);
    if (bundles <= 0) return { status: "OUT_OF_STOCK" };
    const costISK = totalISK({ priceISK: listing.priceISK, bundles });
    const units = bundles * listing.bundleSize;

    const currentWallet = walletApi().getCharacterWallet(id);
    if (!currentWallet) return { status: "NO_CHARACTER" };
    if (Number(currentWallet.balance || 0) < costISK) {
      return { status: "PAYMENT_FAILED", reason: "NOT_ENOUGH_ISK", costISK };
    }

    // 1. reserve the stock
    listing.remaining -= units;
    writeState(state);

    // 2. take the money
    const debited = walletApi().adjustCharacterBalance(id, -costISK, {
      description: `Skin component purchase (type ${listing.typeID})`,
      eventID: `component-buy:${key}:${id}:${clock()}`,
    });
    if (!debited || debited.success === false) {
      listing.remaining += units;
      writeState(state);
      note("coop-component-market-purchase",
        { status: "PAYMENT_FAILED", typeID: listing.typeID, characterID: id, costISK });
      return { status: "PAYMENT_FAILED", reason: String(debited && debited.errorMsg || "WALLET_REFUSED") };
    }

    // 3. hand over the items, where the buyer really is docked
    const characters = characterState || require(path.join(
      __dirname,
      "../services/character/characterState",
    ));
    const record = characters.getCharacterRecord(id);
    const stationID = toInt(record && record.stationID, 0);
    const granted = stationID > 0
      ? itemApi().grantItemsToCharacterLocation(id, stationID, HANGAR_FLAG,
        [{ itemType: listing.typeID, quantity: units }])
      : { success: false, errorMsg: "NOT_DOCKED" };
    if (!granted || granted.success === false) {
      // The money is real but the goods are not: give the money back and restore
      // the stock rather than keeping a paid, empty-handed buyer.
      walletApi().adjustCharacterBalance(id, costISK, {
        description: `Skin component purchase refund (type ${listing.typeID})`,
        eventID: `component-refund:${key}:${id}:${clock()}`,
      });
      listing.remaining += units;
      writeState(state);
      note("coop-component-market-purchase",
        { status: "DELIVERY_FAILED", typeID: listing.typeID, characterID: id, costISK,
          reason: String(granted && granted.errorMsg || "GRANT_REFUSED") });
      return { status: "DELIVERY_FAILED", reason: String(granted && granted.errorMsg || "GRANT_REFUSED") };
    }

    note("coop-component-market-purchase",
      { status: "SOLD", typeID: listing.typeID, characterID: id, units, costISK,
        stationID, remaining: listing.remaining });
    return {
      status: "SOLD",
      // A real UUID, not a description. The client decodes this with
      // `uuid.UUID(bytes=response.transaction.uuid)`, which raises unless it is exactly 16
      // bytes, and then keeps it as the purchase's transaction id.
      transactionUUID: crypto.randomUUID(),
      transactionID: `${key}:${id}:${units}:${costISK}`,
      typeID: listing.typeID,
      units,
      costISK,
      balanceAfter: Number(currentWallet.balance || 0) - costISK,
      stationID,
      // Activation needs a component licence mapping this world does not have, so a
      // purchase is always "buy the item", never a pretend licence.
      immediatelyActivate: false,
    };
  }

  return Object.freeze({ enabled, seed, list, purchase, stateFile: file });
}

let singleton = null;
function shared() {
  if (!singleton) singleton = createComponentListings();
  return singleton;
}

module.exports = { STATE_FILE, createComponentListings, shared, isActiveListing,
  priceForBasePrice, resolveBundleCount, totalISK, normalizeState, emptyState };
