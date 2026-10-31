"use strict";
// Payroll: the corporation pays its own pilots out of the REAL corporation wallet.
//
// Why this is not optional: the native market settles a purchase against the PILOT's earned
// balance (`INSUFFICIENT_EARNED_ISK`), and the treasury sweep moves every pilot's balance into
// the corporation wallet after each sale. Measured 2026-10-31 on the agents world: every pilot
// in `ledger.json` stood at 0 ISK while the corporation walled 1.45 BILLION - so no NPC could
// ever buy a blueprint or a single unit of input material. The economy could sell but never
// purchase, which is not an economy.
//
// Rules it never breaks:
//  - ISK is only ever MOVED: the native corporation wallet is debited in the same journaled
//    step that credits the pilot's earned balance, so nothing is created;
//  - the wallet row is verified before it is debited (the same native predicate the faction war
//    chest uses), and a wallet that cannot be read pays nobody;
//  - one eventID pays once: a crash between the debit and the credit leaves a PREPARED record
//    that `recover()` finishes or reports, never a second salary.
const fs = require("node:fs");
const path = require("node:path");

const TABLE = "corporations";
const CORP_PREFIX = "corp:";
const DEFAULT_DIVISION = "1000";
const MAX_ENTRIES = 4000;

const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null);
const cents = (x) => {
  const value = Number(x);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};
const isk = (value) => Math.round(Number(value)) / 100;
const key = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);

function emptyJournal() {
  return {version: 1, entries: {}, nextJournalID: 1};
}

function createPilotPayroll({
  gameStore, adjustEarned, journalFile = "/var/lib/evejs/coop-payroll-journal.json",
  verifyCorporation = null, corpWallet = null, clock = () => Date.now(),
  env = process.env, fsApi = fs,
} = {}) {
  // A payroll that owns the real corporation wallet needs no raw gameStore transaction:
  // the wallet owner does its own verified write.
  if ((!corpWallet && typeof gameStore?.coopAtomicNativeRows?.transact !== "function") ||
      typeof adjustEarned !== "function" || !key(journalFile))
    throw Error("PAYROLL_AUTHORITIES_REQUIRED");
  const enabled = () => String(env.EVEJS_COOP_NPC_PAYROLL || "") === "1";

  function readJournal() {
    try {
      const parsed = JSON.parse(fsApi.readFileSync(journalFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object")
        throw Error("PAYROLL_JOURNAL_INVALID");
      return {version: 1, entries: parsed.entries, nextJournalID: pos(parsed.nextJournalID) || 1};
    } catch (error) {
      if (error.code === "ENOENT") return emptyJournal();
      throw error;
    }
  }
  function writeJournal(state) {
    fsApi.mkdirSync(path.dirname(journalFile), {recursive: true});
    const temp = journalFile + ".tmp-" + process.pid;
    fsApi.writeFileSync(temp, JSON.stringify(state));
    fsApi.renameSync(temp, journalFile);
  }
  function compact(state) {
    const keys = Object.keys(state.entries);
    if (keys.length <= MAX_ENTRIES) return state;
    const terminal = keys.map((id) => state.entries[id])
      .filter((row) => row && row.phase !== "PREPARED")
      .sort((a, b) => Number(a.at) - Number(b.at));
    for (const row of terminal) {
      if (Object.keys(state.entries).length <= MAX_ENTRIES) break;
      delete state.entries[row.journalID];
    }
    return state;
  }

  // The real native corporation wallet row, read-only. A payroll that cannot see the money
  // it is about to pay must not pay it.
  function walletRead(corporationID) {
    // The corporation wallet is owned by corporationRuntimeState, NOT by the `corporations`
    // table: measured 2026-10-31 every payroll was blocked WALLET_UNVERIFIED because the
    // atomic bridge refuses that table outright (ATOMIC_TABLE_ALLOWLIST_VIOLATION). The real
    // owner reads its own table and verifies a write by reading the balance back.
    if (corpWallet && typeof corpWallet.readWallet === "function") {
      let answer = null;
      try { answer = corpWallet.readWallet({gameStore, corporationID}); }
      catch (error) { return {status: "WALLET_UNVERIFIED",
        reason: String((error && error.message) || error).slice(0, 70)}; }
      if (!answer || answer.status !== "OK")
        return {status: "WALLET_UNVERIFIED", reason: String((answer && answer.status) || "NOTHING")};
      const entry = answer.divisions && answer.divisions[String(DEFAULT_DIVISION)];
      const balance = cents(entry && entry.balance);
      if (balance === null) return {status: "WALLET_UNVERIFIED", reason: "NO_BALANCE"};
      return {status: "OK", balance, source: "corp-wallet"};
    }
    return gameStore.coopAtomicNativeRows.transact([TABLE], (tx) => {
      const corp = tx.get(TABLE, CORP_PREFIX + corporationID);
      const division = corp?.wallet?.divisions?.[DEFAULT_DIVISION];
      const balance = cents(division?.balance);
      if (!corp || !division || balance === null ||
          !Array.isArray(division.journal) || !Array.isArray(division.transactions))
        return {status: "WALLET_UNVERIFIED"};
      if (corp.corporationID !== undefined && corp.corporationID !== corporationID)
        return {status: "WALLET_UNVERIFIED"};
      let corporationOK = true;
      if (typeof verifyCorporation === "function") {
        try { corporationOK = verifyCorporation({corporationID}, corp, tx) === true; }
        catch (_error) { corporationOK = false; }
      }
      if (!corporationOK) return {status: "WALLET_UNVERIFIED"};
      return {status: "OK", balance, corpKey: CORP_PREFIX + corporationID};
    });
  }

  function walletDebit(entry) {
    if (corpWallet && typeof corpWallet.applyDelta === "function") {
      let answer = null;
      try {
        answer = corpWallet.applyDelta({gameStore, corporationID: entry.corporationID,
          division: DEFAULT_DIVISION, delta: -entry.cents / 100});
      } catch (error) { return {status: "DEBIT_THREW",
        reason: String((error && error.message) || error).slice(0, 70)}; }
      if (!answer || answer.status !== "OK")
        return {status: String((answer && answer.status) || "DEBIT_FAILED"),
          reason: String((answer && answer.reason) || "").slice(0, 70)};
      const after = Math.round(Number(answer.balance) * 100);
      return {status: "DEBITED", before: after + entry.cents, after};
    }
    return gameStore.coopAtomicNativeRows.transact([TABLE], (tx) => {
      const corpKey = CORP_PREFIX + entry.corporationID;
      const corp = tx.get(TABLE, corpKey);
      const division = corp?.wallet?.divisions?.[DEFAULT_DIVISION];
      const balance = cents(division?.balance);
      if (!corp || !division || balance === null ||
          !Array.isArray(division.journal) || !Array.isArray(division.transactions))
        return {status: "WALLET_UNVERIFIED"};
      if (division.journal.some((row) => row?.transactionID === entry.transactionID) ||
          division.transactions.some((row) => row?.transactionID === entry.transactionID))
        return {status: "ALREADY_DEBITED", balance};
      if (balance < entry.cents) return {status: "WALLET_INSUFFICIENT", balance};
      const after = balance - entry.cents;
      const at = Number(entry.at);
      const row = {
        transactionID: entry.transactionID,
        transactionDate: String(BigInt(at) * 10000n + 116444736000000000n),
        referenceID: entry.transactionID, entryTypeID: 0, accountKey: 1000,
        currency: 1, sortValue: 1, ownerID1: entry.corporationID,
        ownerID2: entry.corporationID,
        description: "Coop pilot salary " + entry.pilotID + " " + String(entry.reason || "").slice(0, 40),
        amount: isk(-entry.cents), balance: isk(after),
      };
      tx.put(TABLE, corpKey, {...corp, wallet: {...corp.wallet, divisions: {
        ...corp.wallet.divisions,
        [DEFAULT_DIVISION]: {...division, balance: isk(after),
          journal: [...division.journal, row].slice(-100),
          transactions: [...division.transactions, row].slice(-2000)}}}});
      return {status: "DEBITED", before: balance, after};
    });
  }

  /**
   * Pay one pilot out of the corporation wallet. `cents` is a positive whole number of
   * hundredths of an ISK; the ledger credit is exactly the wallet debit.
   */
  function pay({corporationID = 1000129, pilotID, cents: amount, reason = "", eventID} = {}) {
    if (!enabled()) return {status: "DISABLED"};
    const corp = pos(corporationID);
    const pilot = key(pilotID);
    const value = pos(amount);
    const id = key(eventID);
    if (!corp || !pilot || !value || !id) return {status: "INVALID_PAYROLL"};
    let state;
    try { state = readJournal(); }
    catch (error) { return {status: "JOURNAL_UNREADABLE",
      reason: String((error && error.message) || error).slice(0, 70)}; }
    const prior = state.entries[id];
    if (prior && prior.phase === "COMMITTED") return {status: "DUPLICATE", entry: prior};
    if (prior && prior.pilotID !== pilot) return {status: "PAYROLL_ID_CONFLICT"};
    const session = prior || {journalID: id, phase: "PREPARED", corporationID: corp,
      pilotID: pilot, cents: value, reason: String(reason).slice(0, 80),
      transactionID: state.nextJournalID, at: clock()};
    if (!prior) {
      state.entries[id] = session;
      state.nextJournalID += 1;
      writeJournal(compact(state));
    }
    // A debit already attempted with an unknown outcome is never attempted again: the money
    // may have moved, and a second salary looks exactly like a real one.
    if (prior && prior.debit === "PENDING")
      return {status: "NEEDS_OPERATOR_REPAIR", reason: "DEBIT_OUTCOME_UNKNOWN", entry: prior};
    let debit = prior && prior.debit === "DONE"
      ? {status: "ALREADY_DEBITED", before: prior.walletBefore, after: prior.walletAfter}
      : null;
    if (!debit) {
      // Never debit a wallet that cannot be read, and never pay a pilot who is already paid:
      // the earned ledger is idempotent per eventID, so a replay is a DUPLICATE, not a salary.
      const wallet = walletRead(corp);
      if (wallet.status !== "OK")
        return {status: "BLOCKED", reason: wallet.status, entry: session};
      if (wallet.balance < session.cents)
        return {status: "BLOCKED", reason: "WALLET_INSUFFICIENT",
          balance: wallet.balance, need: session.cents, entry: session};
      // The intent to debit is written down BEFORE the debit: a crash in between leaves a
      // row that recover() refuses to finish, instead of a salary that could be paid twice.
      session.debit = "PENDING";
      state.entries[id] = session;
      writeJournal(compact(state));
      debit = walletDebit(session);
      if (debit.status !== "DEBITED" && debit.status !== "ALREADY_DEBITED") {
        session.debit = "FAILED";
        session.debitStatus = String(debit.status || "");
        state.entries[id] = session;
        writeJournal(compact(state));
        return {status: "BLOCKED", reason: String(debit.status || "DEBIT_FAILED"), entry: session};
      }
      session.debit = "DONE";
      session.walletBefore = debit.before;
      session.walletAfter = debit.after;
      state.entries[id] = session;
      writeJournal(compact(state));
    }
    const credit = (() => {
      try {
        return adjustEarned({pilotID: pilot, cents: session.cents,
          eventID: "payroll:" + id, reason: "salary " + session.reason});
      } catch (error) {
        return {status: "CREDIT_THREW",
          reason: String((error && error.message) || error).slice(0, 70)};
      }
    })();
    if (credit.status !== "APPLIED" && credit.status !== "DUPLICATE") {
      // The wallet was debited and the pilot was not credited. Keep the record OPEN (not
      // terminal): the earned ledger is idempotent per eventID, so `recover()` may safely
      // finish the same salary, and the operator can see which half happened.
      session.phase = "PREPARED";
      session.creditStatus = String(credit.status || "");
      state.entries[id] = session;
      writeJournal(state);
      return {status: "NEEDS_OPERATOR_REPAIR", reason: String(credit.status || ""),
        entry: session};
    }
    session.phase = "COMMITTED";
    session.walletBefore = debit.before;
    session.walletAfter = debit.after;
    session.settledAt = clock();
    state.entries[id] = session;
    writeJournal(compact(state));
    return {status: "PAID", pilotID: pilot, isk: session.cents / 100,
      walletBefore: debit.before, walletAfter: debit.after,
      receipt: credit.receipt || null, entry: session};
  }

  // A PREPARED row may have debited the wallet and not credited the pilot. Finish it from the
  // recorded numbers; never re-plan it.
  function recover() {
    const state = readJournal();
    const open = Object.values(state.entries).filter((row) => row && row.phase === "PREPARED");
    const finished = [];
    for (const row of open) {
      if (row.debit !== "DONE") {
        // A salary whose debit never completed (or whose outcome is unknown) must not be
        // credited: the pilot would receive money the corporation never paid.
        row.phase = "NEEDS_OPERATOR_REPAIR";
        row.repairReason = "DEBIT_" + String(row.debit || "MISSING");
        state.entries[row.journalID] = row;
        finished.push({journalID: row.journalID, status: "NEEDS_OPERATOR_REPAIR"});
        continue;
      }
      const credit = (() => {
        try {
          return adjustEarned({pilotID: row.pilotID, cents: row.cents,
            eventID: "payroll:" + row.journalID, reason: "salary " + String(row.reason || "")});
        } catch (error) {
          return {status: "CREDIT_THREW", reason: String(error && error.message)};
        }
      })();
      if (credit.status === "APPLIED" || credit.status === "DUPLICATE") {
        row.phase = "COMMITTED";
        row.settledAt = clock();
        finished.push({journalID: row.journalID, status: "COMMITTED"});
      } else {
        row.phase = "NEEDS_OPERATOR_REPAIR";
        finished.push({journalID: row.journalID, status: "NEEDS_OPERATOR_REPAIR"});
      }
      state.entries[row.journalID] = row;
    }
    if (finished.length) writeJournal(state);
    return {status: finished.length ? "RECOVERED" : "NOTHING_OPEN", finished};
  }

  return {pay, recover, walletRead, readJournal};
}

module.exports = {createPilotPayroll, TABLE, CORP_PREFIX, DEFAULT_DIVISION};
