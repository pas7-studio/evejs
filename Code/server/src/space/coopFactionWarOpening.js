"use strict";
// Opening wars from the real world.
//
// Owner model (2026-10-27): a war is global and multi-front. A front is the place
// where two factions' sectors actually touch, so one faction pair can fight on
// several borders at once. Nothing here invents a faction pair, a border or a
// fleet: the inputs are the real identity links (which native ship sits where),
// the real corporation -> faction table, the real reciprocal gate graph and the
// paper treasury. Every record is written by coopFactionWarCore.transition, so a
// war cannot exist without its native proofs.
//
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const { territoriesFromPresence, buildFronts } = require("./coopFactionWarFronts" + siblingSuffix);
const { planOpeningCampaign } = require("./coopFactionWarBootstrap" + siblingSuffix);
const core = require("./coopFactionWarCore" + siblingSuffix);
const paper = require("./coopFactionWarTreasury" + siblingSuffix);

const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const MAX_LINKS = 5000;
const LIVE_CAMPAIGN_STATES = new Set(["PREPARING", "ASSAULT"]);

const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});

// A campaign waiting for its assault deployment proof holds its target system in
// CONTESTED. If that proof never comes - a defender with no navy, a fleet that is
// never deployed - nothing can open that border again: `liveCampaignFor` keeps
// answering for the stalled campaign and every other front is refused with
// TARGET_ALREADY_CONTESTED. MEASURED 2026-10-28: one PREPARING campaign on 30045344
// starved the whole frontier for hours and the client's war map showed no front at
// all. Expiry invents nothing: it drops a claim that never produced evidence and
// releases the territory only when no other live campaign holds it.
const STALL_ENV = "EVEJS_COOP_WAR_OPENING_STALL_MS";
const DEFAULT_STALL_MS = 45 * 60 * 1000;
function stallMs() {
  const configured = num(process.env[STALL_ENV]);
  return configured > 0 ? configured : DEFAULT_STALL_MS;
}

// Targets whose stale claim was just released, so a reopen attempt is not repeated on
// every tick: MEASURED on the live world, an opened campaign that did not survive to the
// next tick was re-planned every 30 seconds and the world published "war opened" forever.
// In memory on purpose - it is a pacing guard, not world state.
const recentlyExpired = new Map();

// FW-064 (validation): a border that keeps opening and expiring without ever mustering
// is not a war, it is a loop. Measured overnight on the work stack: `30045343` reopened
// and expired four times (`:r2`, `:r3`, `:r4`), each cycle reserving real escrow and
// refunding it 45 minutes later, because the defender simply never fielded a hull there.
// The cooldown therefore grows with the number of campaigns that target already expired:
// one failure = base window, two = double, four caps at 8x. A target that finally
// produces an assault proof resets it, because `campaigns` counts only EXPIRED records.
// A war only opens when both sides can really pay their own bounty, if the stack is
// configured that way. Off by default: the shape of the old behaviour is preserved.
function bothSidesRequired(env = process.env) {
  return String(env.EVEJS_COOP_WAR_BOUNTY_BOTH_SIDES ?? "") === "1";
}
// FW-099: a cooldown may not outlive the reason it was created for.
//
// WAR_ESCROW_MISSING is not a fact about the border - it is the name of a treasury
// defect. MEASURED on the play stack 2026-10-30: ten campaigns of 30003837 and five
// of 30045344 expired with exactly that reason while FW-050 was live, and the growing
// cooldown they left behind (8 x 45 min) kept the ONLY armed border of a fully funded
// war (decision BOTH_SIDES_CAN_FIELD_NAVY) shut for hours after the treasury itself
// was fixed - the world reported "no front" all day. A release that says nothing about
// this border must not count towards the backoff; only an expiry that does (an opened
// campaign that never produced an assault proof) keeps growing it.
const STALE_EXPIRY_REASONS = new Set(["WAR_ESCROW_MISSING"]);
function countsAsFailure(campaign) {
  return !STALE_EXPIRY_REASONS.has(String((campaign && campaign.expiredReason) || ""));
}
function targetCooldownMs({ state, targetSystemID, baseMs = stallMs(),
  nowMs = Date.now() } = {}) {
  const target = num(targetSystemID);
  const base = Math.max(1, num(baseMs) || 1);
  if (!pos(target) || !state || !state.campaigns) return base;
  // FW-127 (measured 2026-10-31T13:59:14Z): every expiry a border had EVER produced
  // counted towards its backoff, so after two days of fighting the multiplier reached
  // 8 x 45 min = 6 h and the live war answered NO_OPENABLE_FRONT with 5 of its 8
  // borders still cooling down - the war could not restart itself. Only expiries inside
  // the backoff horizon count now, and the multiplier stops at 4: a border that keeps
  // failing now still backs off, but its history can never shut it for a day.
  const horizonMs = base * 8;
  const expired = Object.values(state.campaigns)
    .filter((campaign) => campaign && num(campaign.targetSystemID) === target &&
      String(campaign.state) === "EXPIRED" && countsAsFailure(campaign) &&
      (!num(campaign.expiredAt) || num(campaign.expiredAt) >= num(nowMs) - horizonMs))
    .length;
  if (!expired) return base;
  return base * Math.min(4, Math.pow(2, Math.min(2, expired - 1)));
}

// FW-100: the in-memory pacing map has to obey the same rule as the durable record.
// MEASURED on the play stack 2026-10-30 21:08Z: campaign r17 of 30003837 opened and was
// released one minute later with WAR_ESCROW_MISSING, and because the map kept only a
// timestamp the target was paced for the full 90-minute window even though that reason is
// explicitly not a failure any more (FW-099). The map now carries the reason with the
// time, so a lost-escrow release paces the border for the base window and no longer.
function coolingDown(targetSystemID, nowMs, ttlMs = stallMs(), state = null) {
  const target = num(targetSystemID);
  const window = targetCooldownMs({ state, targetSystemID: target, baseMs: ttlMs,
    nowMs });
  const entry = recentlyExpired.get(target);
  const at = num(entry && entry.at !== undefined ? entry.at : entry);
  if (at) {
    const reason = String((entry && entry.reason) || "");
    const paced = STALE_EXPIRY_REASONS.has(reason) ? Math.max(1, num(ttlMs) || 1) : window;
    if (num(nowMs) - at < paced) return true;
    recentlyExpired.delete(target);
  }
  // The map above dies with the process, so the durable record is consulted too: a
  // target whose only campaign is EXPIRED moments ago must not be re-planned on the
  // very next tick, or the world reopens (and announces) the same front forever.
  for (const campaign of Object.values((state && state.campaigns) || {})) {
    if (!campaign || num(campaign.targetSystemID) !== target) continue;
    if (campaign.state !== "EXPIRED") continue;
    if (!countsAsFailure(campaign)) continue;
    const expiredAt = num(campaign.expiredAt);
    if (expiredAt && num(nowMs) - expiredAt < window) return true;
  }
  return false;
}

// FW-062 (validation): a live campaign with no escrow on ANY side can never pay
// anybody. Under REQUIRE_FUNDING=1 a campaign only opens when both sides really
// reserved, so "no HELD and no PAID row" means the money was lost (measured today:
// the FW-050 store defect reverted the treasury row and two ASSAULT campaigns kept
// running with nothing behind them). Leaving them live squats the target forever and
// hides the loss; expiring them releases the claim so a funded campaign can open.
// A campaign with a PAID row is never expired: that escrow did exist and was spent.
// FW-101: this guard only means anything where a campaign is NOT allowed to open
// without escrow, and its own comment says so. MEASURED on the play stack 2026-10-30:
// that stack runs EVEJS_COOP_WAR_REQUIRE_FUNDING=0 (its factions' funding plan is
// REFUSED:NO_REAL_FACTION_INCOME, so demanding escrow would mean no war at all), yet the
// expirer still killed every campaign about a minute after it opened (r17 and the sixteen
// before it), each time with WAR_ESCROW_MISSING - the whole frontier was an open/expire
// loop that looked exactly like "the war never starts". Where funding is not required a
// campaign without escrow is the configured shape, not a loss, so nothing is expired.
function expireUnfundedCampaigns(state, { nowMs = Date.now(), isFunded = null,
  requireFunding = fundingRequired() } = {}) {
  const campaignIDs = [];
  if (!state || !state.campaigns || typeof isFunded !== "function") return { campaignIDs };
  if (requireFunding !== true) return { campaignIDs, skipped: "FUNDING_NOT_REQUIRED" };
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  for (const campaign of Object.values(state.campaigns)) {
    if (!campaign) continue;
    if (!["PREPARING", "ASSAULT"].includes(String(campaign.state))) continue;
    let funded = true;
    try { funded = isFunded(campaign) === true; } catch (_error) { funded = true; }
    if (funded) continue;
    campaign.state = "EXPIRED";
    campaign.revision = num(campaign.revision) + 1;
    campaign.expiredAt = at;
    campaign.expiredReason = "WAR_ESCROW_MISSING";
    campaignIDs.push(campaign.campaignID);
    recentlyExpired.set(num(campaign.targetSystemID),
      { at, reason: String(campaign.expiredReason || "") });
    const target = state.territories && state.territories[String(campaign.targetSystemID)];
    const stillContested = liveCampaignFor(state, campaign.targetSystemID);
    if (target && target.state === "CONTESTED" && !stillContested) {
      state.territories[String(campaign.targetSystemID)] = { ...target,
        state: "SECURE", revision: num(target.revision) + 1, changedAt: at };
    }
  }
  return { campaignIDs };
}
function expireStalledCampaigns(state, { nowMs = Date.now(), ttlMs = stallMs() } = {}) {
  const campaignIDs = [];
  if (!state || !state.campaigns || !(num(ttlMs) > 0)) return { campaignIDs };
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  for (const campaign of Object.values(state.campaigns)) {
    if (!campaign || campaign.state !== "PREPARING") continue;
    // An assault already proved itself; a campaign with evidence is never expired.
    if (Array.isArray(campaign.objectiveEvidence) && campaign.objectiveEvidence.length) continue;
    const startedAt = num(campaign.startedAt);
    if (!pos(startedAt) || at - startedAt < num(ttlMs)) continue;
    campaign.state = "EXPIRED";
    campaign.revision = num(campaign.revision) + 1;
    campaign.expiredAt = at;
    campaign.expiredReason = "NO_ASSAULT_DEPLOYMENT_PROOF";
    campaignIDs.push(campaign.campaignID);
    recentlyExpired.set(num(campaign.targetSystemID),
      { at, reason: String(campaign.expiredReason || "") });
    const target = state.territories && state.territories[String(campaign.targetSystemID)];
    // Only release the claim when this was the last live campaign on it.
    const stillContested = liveCampaignFor(state, campaign.targetSystemID);
    if (target && target.state === "CONTESTED" && !stillContested) {
      state.territories[String(campaign.targetSystemID)] = {
        ...target,
        state: "SECURE",
        revision: num(target.revision) + 1,
        changedAt: at,
      };
    }
  }
  return { campaignIDs };
}


// A gate is a proof only when it is reciprocal: one-way and unresolved gates are
// not a route a fleet can cross.
function gateBetween(fromSystemID, toSystemID, getStargatesForSystem, getGate) {
  if (!pos(fromSystemID) || !pos(toSystemID) || fromSystemID === toSystemID) return null;
  if (typeof getStargatesForSystem !== "function") return null;
  for (const gate of getStargatesForSystem(fromSystemID) || []) {
    const gateID = num(gate && gate.itemID);
    const destinationGateID = num(gate && gate.destinationID);
    if (!pos(gateID) || !pos(destinationGateID)) continue;
    if (num(gate && gate.destinationSolarSystemID) !== toSystemID) continue;
    const back = typeof getGate === "function" ? getGate(destinationGateID) : null;
    if (typeof getGate === "function" &&
      (!back || num(back.destinationID) !== gateID || num(back.solarSystemID) !== toSystemID)) continue;
    return {
      fromGateID: gateID,
      toGateID: destinationGateID,
      fromSystemID,
      toSystemID,
      reciprocal: Boolean(back),
    };
  }
  return null;
}

// Which faction really sits in which system, from the identity links plus the
// real corporation -> faction table. A link whose native record disagrees about
// the system is in flight and owns nothing yet.
function collectPresence({ links, systemIDs, getNativeEntity, getFactionForCorporation, maxLinks = MAX_LINKS } = {}) {
  if (!Array.isArray(links) || links.length > maxLinks) return { status: "INVALID_LINKS", pilots: [], skipped: 0 };
  if (typeof getNativeEntity !== "function" || typeof getFactionForCorporation !== "function")
    return { status: "NATIVE_AUTHORITIES_REQUIRED", pilots: [], skipped: 0 };
  const allowed = Array.isArray(systemIDs) && systemIDs.length
    ? new Set(systemIDs.map(Number).filter(pos))
    : null;
  const pilots = [];
  let skipped = 0;
  let drifted = 0;
  for (const link of links) {
    const linkSystemID = num(link && link.systemID);
    const entityID = num(link && link.entityID);
    if (!pos(entityID)) { skipped++; continue; }
    let native = null, faction = 0;
    try {
      native = getNativeEntity(entityID);
      faction = num(getFactionForCorporation(native && native.corporationID));
    } catch (_error) { skipped++; continue; }
    if (!pos(faction)) { skipped++; continue; }
    // FW-051: the opening planner used to DROP a hull whose link had drifted,
    // because the link's systemID follows the VIRTUAL pilot while the hull stays
    // put (see FW-049). That made the planner and the territory bootstrap disagree
    // about the very same fleet: `warPresencePilots` counted the ship where it
    // really was while this collector silently skipped it, so a border could be
    // "owned" by a faction the opener could not see. The native record decides the
    // system; a hull with no readable native position keeps the link's value.
    const nativeSystemID = num(native && native.systemID);
    const systemID = pos(nativeSystemID) ? nativeSystemID : linkSystemID;
    if (!pos(systemID) || (allowed && !allowed.has(systemID))) { skipped++; continue; }
    if (pos(linkSystemID) && linkSystemID !== systemID) drifted += 1;
    pilots.push({
      pilotID: link.pilotID,
      entityID,
      systemID,
      factionID: String(faction),
      corporationID: num(native && native.corporationID),
      role: String(link.role || ""),
      linkSystemID,
      positionDrifted: pos(linkSystemID) && linkSystemID !== systemID,
    });
  }
  return { status: "PRESENCE", pilots, skipped, drifted };
}

// Registered military control is authoritative; live presence only fills the
// systems that no campaign has decided yet. A capture must not be undone by
// counting the ships that happen to be passing through.
function territoriesForFronts({ state, presence, minShips = 1 } = {}) {
  const observed = territoriesFromPresence({ pilots: presence && presence.pilots, minShips });
  const territories = Object.assign({}, observed);
  let registeredCount = 0;
  const registered = state && state.territories;
  if (registered && typeof registered === "object") {
    for (const [key, record] of Object.entries(registered)) {
      const systemID = num(key);
      const owner = num(record && record.militaryControllerFactionID);
      if (!pos(systemID) || !pos(owner)) continue;
      territories[String(systemID)] = String(owner);
      registeredCount++;
    }
  }
  return { territories, observedCount: Object.keys(observed).length, registeredCount };
}

// A faction pays for an operation from what it really holds. This is a PAPER
// budget by owner decision: no market order, no cargo, and the paper nature is
// part of the result so it can never be mistaken for a native settlement.
function paperFunding({ heldSystemIDs = [], balanceISK = 0, rates = {} } = {}) {
  const funding = paper.fundOperation({ balanceISK, heldSystemIDs, rates });
  return Object.assign({ heldSystemIDs: heldSystemIDs.length }, funding);
}

// Owner decision 2026-10-27: the bounty escrow is an economic layer, not a
// precondition for a real battle. EVEJS_COOP_WAR_REQUIRE_FUNDING=0 allows an
// opening with an explicitly labelled PAPER_UNFUNDED_EXPLICIT supply: no ISK is
// reserved, no bounty can ever be paid, and every opening event carries the
// label. Default is 1 (strict).
function fundingRequired(env = process.env) {
  return String(env.EVEJS_COOP_WAR_REQUIRE_FUNDING ?? "1") !== "0";
}

function supplyFor({ funding, env = process.env } = {}) {
  const base = funding && typeof funding === "object" ? funding : { status: "REFUSED_UNFUNDED" };
  if (!fundingRequired(env) && base.status !== "FUNDED")
    return Object.assign({}, base, {
      status: "PAPER_UNFUNDED_EXPLICIT", paper: true,
      reason: "WAR_FUNDING_NOT_REQUIRED_BY_OPERATOR",
    });
  return base;
}

// Per-system faction counts, including the systems that are contested. A tie is
// the real reason a front cannot exist, so it has to be visible instead of
// looking like a broken feature.
function presenceSummary({ pilots = [], minShips = 1 } = {}) {
  const counts = new Map();
  for (const pilot of Array.isArray(pilots) ? pilots : []) {
    const systemID = num(pilot && pilot.systemID);
    const factionID = String((pilot && pilot.factionID) || "");
    if (!pos(systemID) || !factionID) continue;
    if (!counts.has(systemID)) counts.set(systemID, new Map());
    const per = counts.get(systemID);
    per.set(factionID, (per.get(factionID) || 0) + 1);
  }
  const threshold = Math.max(1, Math.trunc(num(minShips) || 1));
  const systems = {}, contested = [];
  for (const [systemID, per] of counts) {
    const ranked = [...per.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [topFaction, topShips] = ranked[0];
    const runnerUp = ranked[1] ? ranked[1][1] : 0;
    const entry = { factions: ranked.map(([factionID, ships]) => ({ factionID, ships })), owner: null, reason: "" };
    if (topShips < threshold) entry.reason = "BELOW_MIN_SHIPS";
    else if (topShips === runnerUp) entry.reason = "TIE_CONTESTED";
    else entry.owner = topFaction;
    systems[systemID] = entry;
    if (!entry.owner) contested.push(systemID);
  }
  return { systems, contested };
}

// One war per faction pair. Several campaigns may run under the same war on
// different borders - that is what "multi-front" means here.
function activeWarFor(state, leftFactionID, rightFactionID) {
  const low = Math.min(num(leftFactionID), num(rightFactionID));
  const high = Math.max(num(leftFactionID), num(rightFactionID));
  for (const war of Object.values((state && state.wars) || {})) {
    if (!war || war.state !== "ACTIVE") continue;
    const pair = [num(war.attackerFactionID), num(war.defenderFactionID)].sort((a, b) => a - b);
    if (pair[0] === low && pair[1] === high) return war;
  }
  return null;
}

function liveCampaignFor(state, targetSystemID) {
  return Object.values((state && state.campaigns) || {})
    .find((campaign) => campaign && num(campaign.targetSystemID) === num(targetSystemID) &&
      LIVE_CAMPAIGN_STATES.has(campaign.state)) || null;
}

function buildProofs({ plan, presence, territories, getStargatesForSystem, getGate, minShips,
 funding, ownerOfSystem = null }) {
  const pilots = (presence && presence.pilots) || [];
  const countIn = (systemID, factionID) => pilots
    .filter((pilot) => pilot.systemID === Number(systemID) && pilot.factionID === String(factionID)).length;
  const sourceSystemID = plan.campaign.sourceSystemID;
  const targetSystemID = plan.campaign.targetSystemID;
  // FW-112: who owns a system no campaign has decided yet. The SDE is a real authority,
  // not a guess, and it is used ONLY where the territory map is silent.
  const sdeOwner = (systemID) => {
    if (typeof ownerOfSystem !== "function") return null;
    try {
      const raw = Number(ownerOfSystem(Number(systemID)));
      return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
    } catch (_error) { return null; }
  };
  return {
    // Both sides must really be present on their own side of the border - or, for an
    // EXPANSION border, the defender must really own the target system in the SDE. A
    // defender that owns the ground but has no hull there yet is exactly the war the
    // garrison then has to defend.
    // FW-114: the attacker must either have hulls on its own side of the border OR really
    // control that side. MEASURED 2026-10-31: 500020 holds 30000144 with one hull in the whole
    // world while 23 ships of another faction sit there, so every expansion border of that
    // faction answered NATIVE_WAR_AUTHORITY_MISSING for ever and the frontier stayed at one
    // live campaign. START_CAMPAIGN already requires the source to be the attacker's own
    // controlled territory, and the garrison is the mechanism that puts hulls there, so
    // control is the honest authority - the navy gate still decides whether it can shoot.
    declaration: ({ attackerFactionID, defenderFactionID }) =>
      (countIn(sourceSystemID, attackerFactionID) >= minShips ||
       territories[String(sourceSystemID)] === String(attackerFactionID)) &&
      (countIn(targetSystemID, defenderFactionID) >= minShips ||
       sdeOwner(targetSystemID) === String(defenderFactionID)),
    // The system is owned by this faction in the map the front was derived from, or by
    // the SDE when no campaign has ever decided it.
    territory: ({ systemID, ownerFactionID }) =>
      territories[String(systemID)] === String(ownerFactionID) ||
      (!territories[String(systemID)] && sdeOwner(systemID) === String(ownerFactionID)),
    // A real reciprocal stargate connects the two systems.
    adjacency: ({ sourceSystemID: from, targetSystemID: to }) =>
      gateBetween(from, to, getStargatesForSystem, getGate) !== null,
    // Paper treasury can pay for the opening operation. An explicitly
    // operator-approved unfunded paper supply is labelled as such.
    supply: () => funding.paper === true &&
      (funding.status === "FUNDED" || funding.status === "PAPER_UNFUNDED_EXPLICIT"),
  };
}

// Turns the real inputs into one opening per open border, or refuses with the
// first missing fact. A border that already has a live campaign is not reopened.
// FW-092 (measured 2026-10-29): a kill only becomes a faction's income if the hull
// that made it can SELL what it recovered. Measured on the work stack, a war hull
// really claimed a real wreck and really carried four recovered cargo units, and
// then sat in a target system that has no station at all (`stationCount: 0`), so
// `loot-market-settled` never fired and every faction chest answered
// NO_REAL_FACTION_INCOME - the war could not fund its own bounty anywhere.
//
// The planner therefore needs to know whether a border leads somewhere the kill
// can be turned into money. It is a PREFERENCE, never a gate: a border without
// market access is still planned when nothing better exists, it is just tried
// last, so a limited opening budget cannot be spent on a front that can never pay.
const MARKET_RANK = Object.freeze({ YES: 2, UNKNOWN: 1, NO: 0 });
function edgeMarketRank(edge, marketAccess) {
  if (typeof marketAccess !== "function") return MARKET_RANK.UNKNOWN;
  const target = num(edge && edge.toSystemID);
  if (!pos(target)) return MARKET_RANK.UNKNOWN;
  let access = null;
  try { access = marketAccess(target); } catch (_error) { access = null; }
  return access === true ? MARKET_RANK.YES
    : access === false ? MARKET_RANK.NO : MARKET_RANK.UNKNOWN;
}

function planWars({
  state, presence, getStargatesForSystem, getGate,
  nowMs, minShips = 1, balanceISK = 0, maxOpenings = 4, ownerOfSystem = null,
  navyCapability = null, marketAccess = null,
} = {}) {
  if (!state || typeof state !== "object") return refuse("NO_WAR_STATE");
  const { territories, observedCount, registeredCount } =
    territoriesForFronts({ state, presence, minShips });
  const summary = presenceSummary({ pilots: presence && presence.pilots, minShips });
  if (!Object.keys(territories).length)
    return refuse("NO_TERRITORY_FROM_PRESENCE", { territories, observedCount, registeredCount, summary });
  if (typeof getStargatesForSystem !== "function") return refuse("NO_GATE_AUTHORITY", { territories });
  // FW-113: expansion borders are ADDITIONAL candidates, not a last resort.
  //
  // MEASURED on the play stack 2026-10-31: while the single registered border was being
  // fought, the planner saw exactly ONE front and answered NO_OPENABLE_FRONT because that
  // target was already contested, while five SDE-owned neighbours waited to be contested.
  // The frontier therefore had a hard ceiling of one live campaign - a war the owner asked to
  // scale up looked frozen. Registered borders are still planned FIRST; expansion borders only
  // fill the remaining opening budget, and the navy gate still decides whether both sides can
  // really shoot, so nothing here invents a fightable war.
  const registered = buildFronts({ territories, getStargatesForSystem, getGate });
  const built = typeof ownerOfSystem === "function"
    ? buildFronts({ territories, getStargatesForSystem, getGate, fallbackOwner: ownerOfSystem })
    : registered;
  const expansion = built.some((front) => (front.edges || []).some((edge) => edge.expanded === true));
  if (!built.length)
    return refuse("NO_FRONT", { territories, observedCount, registeredCount, summary,
      expansionAttempted: typeof ownerOfSystem === "function" });
  const fronts = built;
  // FW-092: rank by EDGE, not by front. A single faction pair really holds several
  // borders at once, so ranking the whole front would keep the historical
  // first-edge order inside it and the limited opening budget would still be spent
  // on a border with no market. The flat candidate list is the original
  // front-by-front, edge-by-edge order unless a market authority reorders it.
  const candidates = [];
  for (const front of fronts) for (const edge of front.edges || []) candidates.push({ front, edge });
  // A registered border is a decided fact; an expansion border is a proposal. The opening
  // budget is spent on the decided ones first, then on expansion, in a stable order.
  candidates.sort((a, b) => (a.edge && a.edge.expanded ? 1 : 0) -
    (b.edge && b.edge.expanded ? 1 : 0));
  const ordered = typeof marketAccess === "function"
    ? candidates.map((row, index) => ({ ...row, index,
      rank: edgeMarketRank(row.edge, marketAccess) }))
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
    : candidates;
  const marketAccessible = typeof marketAccess === "function"
    ? ordered.filter((row) => row.rank === MARKET_RANK.YES).length : null;
  const limit = Math.max(1, Math.min(8, Math.trunc(num(maxOpenings) || 1)));
  const openings = [], skipped = [];
  // FW-027: orientation of each war planned in THIS tick, so two borders of the
  // same faction pair never disagree with the single war record.
  const plannedWarOrientation = new Map();
  for (const { front, edge } of ordered) {
    {
      if (openings.length >= limit) break;
      let attackerFactionID = num(edge && edge.fromOwner);
      let defenderFactionID = num(edge && edge.toOwner);
      let sourceSystemID = num(edge && edge.fromSystemID);
      let targetSystemID = num(edge && edge.toSystemID);
      if (!pos(attackerFactionID) || !pos(defenderFactionID) || attackerFactionID === defenderFactionID) {
        skipped.push({ edge, reason: "NOT_TWO_REAL_FACTIONS" });
        continue;
      }
      if (!pos(sourceSystemID) || !pos(targetSystemID)) {
        skipped.push({ edge, reason: "INVALID_EDGE" });
        continue;
      }
      // FW-036 (dynamic decision): a campaign needs two sides that can really
      // shoot, because capture-by-force needs a defending wreck and a defender
      // with no navy can never produce one. Opening such a border squats the
      // target forever and starves every other front (measured: an ORE party
      // blocked the whole frontier). An unknown capability is never a yes.
      if (typeof navyCapability === "function") {
        let navy = null;
        try {
          navy = navyCapability({ attackerFactionID, defenderFactionID });
        } catch (_error) { navy = null; }
        if (!navy || navy.open !== true) {
          skipped.push({ edge, reason: String((navy && navy.reason) || "NO_NAVY_CAPABILITY:UNKNOWN") });
          continue;
        }
      }
      // A front is one gate pair, not one direction. The derived edge keeps the
      // orientation of whichever system the territory map listed first, so when
      // that side's target already carries a live campaign the pair looked
      // permanently blocked even though the other side was free. Attack across
      // the same real gate from the other end instead of freezing the front.
      //
      // The mirror is only for a DIFFERENT war squatting on that system. When
      // the live campaign belongs to this very faction pair, the border is
      // already being fought and must not be reopened from the far side - that
      // would let one war ping-pong its own front every tick.
      let workingEdge = edge;
      const blocking = liveCampaignFor(state, targetSystemID);
      if (blocking) {
        const blockingWar = (state && state.wars && state.wars[blocking.warID]) || null;
        const samePair = Boolean(blockingWar) &&
          [num(blockingWar.attackerFactionID), num(blockingWar.defenderFactionID)]
            .sort((a, b) => a - b).join("|") ===
          [attackerFactionID, defenderFactionID].sort((a, b) => a - b).join("|");
        if (samePair || liveCampaignFor(state, sourceSystemID)) {
          // FW-052 (review): the reason now names the campaign that blocks this
          // border and whether it belongs to this faction pair. Measured today, an
          // ASSAULT campaign opened at 19:14 on 30045344 kept this same string on
          // every tick for over an hour, and nothing in the event said WHICH record
          // was holding the frontier - so a legitimate "already fighting here"
          // looked exactly like a stuck world.
          skipped.push({ edge, reason: "TARGET_ALREADY_CONTESTED",
            blockingCampaignID: String(blocking.campaignID || ""),
            blockingWarID: String(blocking.warID || ""),
            sameFactionPair: samePair,
            sourceCampaignID: String((liveCampaignFor(state, sourceSystemID) || {}).campaignID || "") });
          continue;
        }
        workingEdge = {
          fromSystemID: targetSystemID,
          toSystemID: sourceSystemID,
          fromOwner: defenderFactionID,
          toOwner: attackerFactionID,
          gateID: edge.reciprocalGateID,
          reciprocalGateID: edge.gateID,
        };
        attackerFactionID = defenderFactionID;
        defenderFactionID = num(edge.fromOwner);
        sourceSystemID = workingEdge.fromSystemID;
        targetSystemID = workingEdge.toSystemID;
      }
      const war = activeWarFor(state, attackerFactionID, defenderFactionID);
      const warID = war ? war.warID
        : "war:" + Math.min(attackerFactionID, defenderFactionID) + "-" +
          Math.max(attackerFactionID, defenderFactionID);
      // FW-027: there is exactly ONE war per faction pair, so every campaign of
      // that pair must use the SAME orientation the war record carries. A second
      // border of the same pair in one tick is flipped to the war's orientation
      // instead of being denied by the core as CAMPAIGN_PREREQUISITES_NOT_MET.
      const known = war
        ? { attackerFactionID: num(war.attackerFactionID), defenderFactionID: num(war.defenderFactionID) }
        : plannedWarOrientation.get(warID) || null;
      let plannedEdge = workingEdge;
      let plannedTarget = targetSystemID;
      if (known && known.attackerFactionID === defenderFactionID &&
        known.defenderFactionID === attackerFactionID) {
        plannedEdge = {
          ...workingEdge,
          fromSystemID: targetSystemID, toSystemID: sourceSystemID,
          fromOwner: defenderFactionID, toOwner: attackerFactionID,
        };
        plannedTarget = sourceSystemID;
        if (liveCampaignFor(state, plannedTarget)) {
          const squatter = liveCampaignFor(state, plannedTarget);
          skipped.push({ edge, reason: "TARGET_ALREADY_CONTESTED",
            blockingCampaignID: String((squatter || {}).campaignID || ""),
            blockingWarID: String((squatter || {}).warID || ""),
            sameFactionPair: false });
          continue;
        }
      }
      if (!known) {
        plannedWarOrientation.set(warID, { attackerFactionID, defenderFactionID });
      }
      // A border released a moment ago is not re-planned on the very next tick.
      if (coolingDown(plannedTarget, nowMs, stallMs(), state)) {
        skipped.push({ edge, reason: "TARGET_RECENTLY_EXPIRED" });
        continue;
      }
      const plan = planOpeningCampaign({
        fronts: [{ frontID: front.frontID, edgeCount: 1, edges: [plannedEdge] }],
        nowMs,
        warID,
        campaignID: nextCampaignID(state, warID, plannedTarget),
      });
      if (plan.status !== "PLANNED") { skipped.push({ edge, reason: plan.reason }); continue; }
      const held = Object.keys(territories)
        .filter((key) => territories[key] === String(plan.war.attackerFactionID));
      const funding = paperFunding({ heldSystemIDs: held, balanceISK });
      const supply = supplyFor({ funding });
      const requireFunding = fundingRequired();
      if (requireFunding && supply.status !== "FUNDED") {
        skipped.push({ edge, reason: "SUPPLY_UNFUNDED:" + supply.status });
        continue;
      }
      const proofs = buildProofs({
        plan, presence, territories, getStargatesForSystem, getGate, minShips, funding: supply,
        ownerOfSystem,
      });
      // FW-092: the opening carries the measured market access of the system it
      // contests, so a campaign that cannot ever pay for itself is visible in the
      // record instead of looking like an ordinary front.
      let targetMarketAccess = null;
      if (typeof marketAccess === "function") {
        try { targetMarketAccess = marketAccess(plannedTarget) === true; } catch (_error) { targetMarketAccess = null; }
      }
      openings.push({ plan, proofs, funding: supply, edge, existingWar: Boolean(war),
        frontID: front.frontID, marketAccess: targetMarketAccess });
    }
  }
  if (!openings.length)
    return refuse("NO_OPENABLE_FRONT", { territories, fronts, skipped, observedCount, registeredCount, summary,
      marketAccessible });
  return { status: "READY", openings, territories, fronts, skipped, summary, observedCount,
    registeredCount, marketAccessible, expansion };
}

// Applies every planned opening through the authoritative core, reusing an
// already declared war for the same faction pair.
// A front that expired must be able to reopen, and the campaign id is deterministic
// (war + target system), so the second attempt reused the same id and the same
// processed eventID: the core answered DUPLICATE, nothing changed, and the runtime still
// published "war opened" on every tick. Measured live: six "war opened" lines in ten
// minutes for war:500001-500004:campaign:30003837 while the durable record stayed EXPIRED.
// A terminal campaign therefore gives the next attempt its own id (:r2, :r3 ...), which the
// core accepts as a new campaign; the old record stays as history.
function nextCampaignID(state, warID, targetSystemID) {
  const base = warID + ":campaign:" + targetSystemID;
  const existing = Object.values((state && state.campaigns) || {})
    .filter((campaign) => campaign && String(campaign.campaignID || "").startsWith(base));
  if (!existing.some((campaign) => String(campaign.campaignID) === base)) return base;
  let highest = 1;
  for (const campaign of existing) {
    const match = /^:r(\d+)$/.exec(String(campaign.campaignID).slice(base.length));
    if (match) highest = Math.max(highest, Number(match[1]) || 1);
  }
  return base + ":r" + (highest + 1);
}

function applyOpenings({ state, plan, nowMs, reserveBounty, persistState, releaseBounty, env = process.env } = {}) {
  if (!plan || plan.status !== "READY") return refuse("PLAN_NOT_READY");
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  let current = state;
  const applied = [], warIDs = [], campaignIDs = [], fundings = [], skipped = [];
  // FW-081: a refusal from the state machine must say WHICH command and WHICH border it
  // refused. Measured 16:0xZ: the world published NATIVE_WAR_AUTHORITY_MISSING with an
  // empty skip list, so nobody could tell which of four candidate borders failed a proof.
  let currentEdge = null;
  const step = (command, proofs) => {
    const result = core.transition(current, command, { now: at, proofs });
    if (result.status !== "APPLIED" && result.status !== "DUPLICATE")
      throw Object.assign(Error("WAR_OPENING_BLOCKED:" + result.reason),
        { reason: result.reason, command: command.type,
          warID: String(command.warID || (currentEdge && currentEdge.warID) || ""),
          campaignID: String(command.campaignID || (currentEdge && currentEdge.campaignID) || ""),
          edge: currentEdge });
    current = result.state || current;
    applied.push(Object.assign({ type: command.type }, result.receipt || {}));
  };
  try {
    for (const opening of plan.openings) {
      const { war, campaign } = opening.plan;
      const proofs = opening.proofs;
      currentEdge = { warID: war.warID, campaignID: campaign.campaignID,
        sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID,
        attackerFactionID: war.attackerFactionID, defenderFactionID: war.defenderFactionID };
      // FW-082: one border that cannot pass its own proofs must not abort the batch.
      // Measured 16:1xZ: the planner tried `war:500001-500020` across 30045338/30045343,
      // its declaration proof failed (500020 had no hull on its side), and the thrown
      // refusal discarded EVERY other border in the same tick - including the fully
      // mustered 30003829/30003836 front. FW-037 already isolates a starved border this
      // way; the state machine now gets the same treatment. The state is rewound to the
      // last committed snapshot so a half-applied border leaves no debris.
      const beforeEdge = current;
      try {
      // FW-027: two borders of the same pair can name the SAME target system
      // (e.g. a hub that touches both sides). The core refuses a second live
      // campaign on one target, and one bad edge must not discard the borders
      // that did open, so it is skipped here instead of aborting the batch.
      if (Object.values(current.campaigns || {}).some((existing) =>
        Number(existing && existing.targetSystemID) === Number(campaign.targetSystemID) &&
        ["PREPARING", "ASSAULT"].includes(String(existing && existing.state)))) {
        continue;
      }
      if (!current.wars[war.warID]) {
        step({
          type: "DECLARE_WAR", eventID: "open:" + war.warID + ":declare", warID: war.warID,
          attackerFactionID: war.attackerFactionID, defenderFactionID: war.defenderFactionID,
        }, proofs);
      }
      for (const [systemID, ownerFactionID] of [
        [campaign.sourceSystemID, war.attackerFactionID],
        [campaign.targetSystemID, war.defenderFactionID],
      ]) {
        if (current.territories[String(systemID)]) continue;
        step({
          type: "REGISTER_TERRITORY", eventID: "open:" + war.warID + ":territory:" + systemID,
          systemID, ownerFactionID,
        }, proofs);
      }
      let supplyReservationID = "paper-supply:" + campaign.campaignID;
      let stepProofs = proofs, realReservation = null;
      // FW-005B: a campaign is only funded by real escrow, and the reservation is
      // taken BEFORE the campaign exists (the treasury refuses an existing one).
      // FW-024: when the operator explicitly waives funding
      // (EVEJS_COOP_WAR_REQUIRE_FUNDING=0) no escrow is reserved, nothing can be
      // paid from it, and the opening records PAPER_UNFUNDED_EXPLICIT.
      if (typeof reserveBounty === "function" && fundingRequired()) {
        const reserved = reserveBounty({
          war: current.wars[war.warID], campaign, warID: war.warID,
          campaignID: campaign.campaignID, state: current,
          persist: () => { if (typeof persistState === "function") persistState(current); },
        });
        if (reserved.status !== "RESERVED") {
          // FW-037: one border nobody can pay for must not abort the whole batch.
          // Measured on the work stack: the frontier refused every opening with
          // SUPPLY_UNFUNDED and threw the plan away, so a single broke faction
          // pair could stop every other border from opening in the same tick.
          // The refusal is recorded per border instead, exactly like the
          // mobiliser already reports a starved campaign without hiding others.
          skipped.push({
            edge: { sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID },
            campaignID: campaign.campaignID,
            warID: war.warID,
            reason: "SUPPLY_UNFUNDED:" + String(reserved.reason || "UNKNOWN").slice(0, 160),
          });
          continue;
        }
        // FW-068 (validation): a war in which only ONE side can pay is a trap. The
        // other side may fight and win and still collect nothing - measured overnight
        // with 500020/1000135, whose militia corporation holds 0 ISK and no income, so
        // four campaigns opened and expired on 30045343 with half the war unpayable.
        // With EVEJS_COOP_WAR_BOUNTY_BOTH_SIDES=1 a border is now refused unless BOTH
        // sides really reserved, and the refusal names the side that could not.
        if (bothSidesRequired(env) && Array.isArray(reserved.sides) && reserved.sides.length < 2) {
          const fundedSides = new Set((reserved.sides || []).map((side) => Number(side.factionID)));
          // The factions live on the war, not on the campaign record.
          const missing = [war.attackerFactionID, war.defenderFactionID]
            .filter((factionID) => !fundedSides.has(Number(factionID)));
          // FW-085: the funded side already reserved real ISK for a campaign that will
          // never exist. Give it back now, or it stays HELD with nothing to spend it on
          // (the next attempt uses a different campaign id, so the orphan reuse path
          // never sees it).
          const released = [];
          if (typeof releaseBounty === "function") {
            for (const side of reserved.sides || []) {
              let outcome = null;
              try {
                outcome = releaseBounty({ campaignID: campaign.campaignID,
                  reservationID: String(side && side.reservationID || ""),
                  factionID: Number(side && side.factionID) || 0,
                  corporationID: Number(side && side.corporationID) ||
                    Number(reserved.corporationID) || 0 });
              } catch (error) {
                outcome = { status: "BLOCKED", reason: String(error && error.message || error) };
              }
              released.push(String((outcome && outcome.status) || "UNKNOWN"));
            }
          }
          skipped.push({
            edge: { sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID },
            campaignID: campaign.campaignID,
            warID: war.warID,
            reason: "SUPPLY_UNFUNDED_SIDE:" + missing.join("+"),
            released,
          });
          continue;
        }
        supplyReservationID = reserved.reservationID;
        realReservation = reserved;
        fundings.push(Object.assign({ status: "FUNDED", paper: false, escrow: true },
          reserved));
        // The supply proof is now the real HELD escrow this faction funded.
        stepProofs = Object.assign({}, proofs, { supply: () => true });
      }
      step({
        type: "START_CAMPAIGN", eventID: "open:" + campaign.campaignID + ":start",
        campaignID: campaign.campaignID, warID: war.warID,
        sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID,
        supplyReservationID,
      }, stepProofs);
      if (!warIDs.includes(war.warID)) warIDs.push(war.warID);
      campaignIDs.push(campaign.campaignID);
      if (!realReservation) fundings.push(opening.funding);
      } catch (error) {
        current = beforeEdge;
        skipped.push({
          edge: { sourceSystemID: campaign.sourceSystemID, targetSystemID: campaign.targetSystemID,
            attackerFactionID: war.attackerFactionID, defenderFactionID: war.defenderFactionID },
          campaignID: campaign.campaignID, warID: war.warID,
          reason: "BORDER_REFUSED:" + String((error && error.reason) ||
            (error && error.message) || "UNKNOWN"),
        });
      }
    }
    // OPENED must mean "something was really opened". Measured: a batch where
    // every border was skipped for funding still answered OPENED with zero
    // campaigns, so the runtime published a success event with empty lists and the
    // real refusal disappeared for an hour. Nothing opened = a refusal, with the
    // per-border reasons attached.
    if (!campaignIDs.length) {
      // FW-082: with a SINGLE border, the refusal it hit IS the answer - reporting
      // NO_FUNDED_FRONT would hide the real cause (a failed proof, not a failed
      // reservation). With several borders the per-border reasons travel in `skipped`
      // and the batch reason stays the summary.
      const firstSkip = String((skipped[0] && skipped[0].reason) || "");
      // Only a FAILED PROOF is surfaced this way; a supply refusal keeps the summary
      // reason, which the caller already renders with its per-border detail.
      const only = Array.isArray(plan.openings) && plan.openings.length === 1 &&
        firstSkip.startsWith("BORDER_REFUSED:")
        ? firstSkip.replace(/^BORDER_REFUSED:/, "") : "";
      // FW-084: a refusal must still publish WHAT the planner saw. Without the derived
      // territories and fronts, an empty map and a dropped edge look identical from
      // outside - which hid a genuine owned+adjacent pair for a whole tick storm.
      return refuse(only || "NO_FUNDED_FRONT",
        { state: current, applied, fundings, skipped,
          territories: plan.territories || {}, fronts: (plan.fronts || []).length });
    }
    return { status: "OPENED", state: current, warIDs, campaignIDs, applied, fundings, skipped };
  } catch (error) {
    return refuse(error.reason || String((error && error.message) || error),
      { state: current, applied, refusedCommand: error.command || "",
        refusedWarID: error.warID || "", refusedCampaignID: error.campaignID || "",
        refusedEdge: error.edge || null });
  }
}

// Single-opening convenience used by the assault tests and by callers that only
// care about the first front.
function applyOpening({ state, plan, nowMs, reserveBounty, persistState, releaseBounty } = {}) {
  if (!plan || plan.status !== "READY" || !Array.isArray(plan.openings) || plan.openings.length !== 1)
    return refuse("PLAN_NOT_READY");
  const result = applyOpenings({ state, plan, nowMs, reserveBounty, persistState, releaseBounty });
  if (result.status !== "OPENED") return result;
  return Object.assign({}, result, {
    warID: result.warIDs[0],
    campaignID: result.campaignIDs[0],
    funding: result.fundings[0],
  });
}

function createWarOpening({
  readLinks, getNativeEntity, getFactionForCorporation,
  getStargatesForSystem, getGate, readWarState, writeWarState,
  reserveBounty = null,
  // FW-085: the counterpart that gives a funded side its escrow back when the border
  // is refused because the OTHER side cannot fund it.
  releaseBounty = null,
  // FW-027: a real war fleet is presence too. A formation of real armed native
  // hulls that the fleet roster proves in a system holds that system exactly the
  // same way a linked pilot does - the ships really exist, are really there, and
  // their corporation really resolves to a faction. Without the authority the
  // behaviour is unchanged.
  fleetPresence = null,
  // FW-036: which factions can really field a navy. Without this authority the
  // planner behaves exactly as before (no capability gate).
  navyCapability = null,
  // FW-092: whether a contested system can sell what its kills produce.
  marketAccess = null,
  // FW-112: the SDE owner of a system no campaign has decided yet, so a war that has
  // captured its whole border can expand instead of freezing the frontier for ever.
  ownerOfSystem = null,
  minShips = 1, balanceISK = 0, maxOpenings = 4,
  now = () => Date.now(), maxLinks = MAX_LINKS,
} = {}) {
  const required = [readLinks, getNativeEntity, getFactionForCorporation,
    getStargatesForSystem, readWarState, writeWarState];
  if (required.some((fn) => typeof fn !== "function")) throw Error("WAR_OPENING_AUTHORITIES_REQUIRED");
  if (fleetPresence !== null && typeof fleetPresence !== "function") {
    throw Error("WAR_OPENING_AUTHORITIES_REQUIRED");
  }
  let busy = false;
  function tick({ systemIDs = [], isCampaignFunded = null } = {}) {
    if (busy) return { status: "BUSY" };
    if (!Array.isArray(systemIDs) || systemIDs.length > 20) return { status: "INVALID_SYSTEMS" };
    busy = true;
    try {
      let state, links;
      try {
        state = readWarState();
        links = readLinks();
      } catch (_error) { return { status: "NATIVE_AUTHORITIES_UNAVAILABLE" }; }
      if (!state) return { status: "NO_WAR_STATE" };
      try { core.validateState(state); } catch (_error) { return { status: "INVALID_WAR_STATE" }; }
      // Release borders whose campaign never produced an assault proof, before the
      // planner asks which targets are already contested.
      let expiredCampaignIDs = [];
      try {
        // FW-062: a live campaign whose escrow vanished cannot pay anyone, so it is
        // expired (and its claim released) before the planner runs.
        const unfunded = expireUnfundedCampaigns(state, { nowMs: num(now()),
          isFunded: typeof isCampaignFunded === "function" ? isCampaignFunded : null });
        if (unfunded.campaignIDs.length) {
          core.validateState(state);
          writeWarState(state);
          expiredCampaignIDs = unfunded.campaignIDs.slice();
        }
        const expiry = expireStalledCampaigns(state, { nowMs: num(now()) });
        if (expiry.campaignIDs.length) {
          core.validateState(state);
          writeWarState(state);
          expiredCampaignIDs = expiry.campaignIDs;
        }
      } catch (_error) { expiredCampaignIDs = []; }
      const presence = collectPresence({ links, systemIDs, getNativeEntity, getFactionForCorporation, maxLinks });
      if (presence.status !== "PRESENCE") return { status: presence.status };
      let fleetShips = 0;
      if (typeof fleetPresence === "function") {
        let extra = [];
        try {
          extra = fleetPresence({ systemIDs }) || [];
        } catch (_error) {
          extra = [];
        }
        const seen = new Set(presence.pilots.map((pilot) => Number(pilot.entityID)));
        for (const ship of Array.isArray(extra) ? extra : []) {
          const entityID = num(ship && ship.entityID);
          const systemID = num(ship && ship.systemID);
          const factionID = String((ship && ship.factionID) || "");
          if (!pos(entityID) || !pos(systemID) || !factionID || seen.has(entityID)) continue;
          seen.add(entityID);
          presence.pilots.push({
            pilotID: String((ship && ship.pilotID) || ("coop-fleet-ship-" + entityID)),
            entityID,
            systemID,
            factionID,
            corporationID: num(ship && ship.corporationID),
            role: String((ship && ship.role) || "patrol"),
            source: "FLEET_ROSTER",
          });
          fleetShips += 1;
        }
      }
      const plan = planWars({
        state, presence, getStargatesForSystem, getGate,
        nowMs: num(now()), minShips, balanceISK, maxOpenings,
        navyCapability: typeof navyCapability === "function" ? navyCapability : null,
        marketAccess: typeof marketAccess === "function" ? marketAccess : null,
        ownerOfSystem: typeof ownerOfSystem === "function" ? ownerOfSystem : null,
      });
      if (plan.status !== "READY")
        return { status: "NO_OPENING", reason: plan.reason || "PLAN_REFUSED", plan,
          expiredCampaignIDs };
      const opened = applyOpenings({ state, plan, nowMs: num(now()),
        reserveBounty, releaseBounty, persistState: writeWarState });
      if (opened.status !== "OPENED") return opened;
      writeWarState(opened.state);
      return {
        status: "OPENED", warIDs: opened.warIDs, campaignIDs: opened.campaignIDs,
        applied: opened.applied, fundings: opened.fundings,
        presence: { pilots: presence.pilots.length, skipped: presence.skipped,
          drifted: num(presence.drifted), fleetShips },
        expiredCampaignIDs,
        territories: plan.territories, fronts: plan.fronts.length,
        marketAccessible: plan.marketAccessible,
        // A border refused for funding is named here instead of vanishing.
        skipped: plan.skipped.concat(Array.isArray(opened.skipped) ? opened.skipped : []),
      };
    } finally { busy = false; }
  }
  return Object.freeze({ tick });
}

module.exports = {
  nextCampaignID,
  gateBetween, collectPresence, territoriesForFronts, paperFunding, presenceSummary,
  expireUnfundedCampaigns, targetCooldownMs, bothSidesRequired, STALE_EXPIRY_REASONS,
  fundingRequired, supplyFor,
  activeWarFor, liveCampaignFor, buildProofs, planWars, applyOpenings, applyOpening,
  expireStalledCampaigns, stallMs, coolingDown,
  createWarOpening,
};
