"use strict";
// FW-005A: physically funded NPC-corporation war escrow. Moves existing ISK
// out of a native corporation wallet under GameStore FULL SQLite transaction.
// NEVER mints ISK, purchases inventory, or grants campaign supply permission.
const TABLE="corporationRuntime",KEY="coop-faction-war\u001ftreasury-v1",
 CORP_PREFIX="corporations\u001f",WAR_KEY="coop-faction-war\u001fstate-v1",
 JOURNAL_BASE=8000000000000000,MAX_EVENTS=2000,MAX_RESERVATIONS=500,
 // FW-056 (review): the event ledger has a hard cap, and at it EVERY money command
 // stopped (WAR_TREASURY_EVENT_CAP) - a world that has fought for long enough could
 // never fund or pay another war. Old entries are compacted into an archive of
 // eventID -> signature hash: a replay is still detected (DUPLICATE, no receipt, so
 // nothing can move twice) and a DIFFERENT command under the same eventID is still
 // refused, while memory stays bounded.
 MAX_ARCHIVE=20000;
const crypto=require("node:crypto");
const signatureHash=(value)=>crypto.createHash("sha256")
 .update(String(value)).digest("hex").slice(0,32);
const pos=x=>Number.isSafeInteger(x)&&x>0;
const nonneg=x=>Number.isSafeInteger(x)&&x>=0;
const key=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x)&&
 !["__proto__","constructor","prototype"].includes(x);
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
// FW-055 (review, the reason no bounty ever paid): a payout names a CO-OP PILOT,
// which is a string ("coop-pilot-027"); the treasury demanded a positive INTEGER,
// so `coopWarBounty.pay` -> PAYOUT was refused with INVALID_TREASURY_PAYOUT before
// any money could move, and the row validator would have rejected the same string
// afterwards. Both a real pilot id and a positive integer are accepted; anything
// else is still refused, and a payout row keeps the identifier it was paid to.
const pilotRef=(x)=>pos(x)||(typeof x==="string"&&/^coop-(pilot|player)-[0-9]{3,}$/.test(x));
function cents(x){
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const v=x*100,n=Math.round(v);
 return nonneg(n)&&Math.abs(v-n)<=0.000001?n:null;
}
const isk=x=>x/100;
const empty=()=>({version:1,reservations:{},processed:{},nextJournalID:JOURNAL_BASE});
function validate(s){
 if(!s||s.version!==1||!s.reservations||!s.processed||
  typeof s.reservations!=="object"||Array.isArray(s.reservations)||
  typeof s.processed!=="object"||Array.isArray(s.processed)||
  !nonneg(s.nextJournalID)||s.nextJournalID<JOURNAL_BASE||
  Object.keys(s.reservations).length>MAX_RESERVATIONS||
  Object.keys(s.processed).length>MAX_EVENTS||
  (s.archive!==undefined&&(typeof s.archive!=="object"||Array.isArray(s.archive)||
   Object.keys(s.archive).length>MAX_ARCHIVE)))
  throw Error("WAR_TREASURY_INVALID");
 for(const [id,r] of Object.entries(s.reservations)){
  if(!key(id)||r?.reservationID!==id||!pos(r.corporationID)||
   !pos(r.factionID)||!key(r.warID)||!key(r.campaignID)||
   !pos(r.cents)||!["HELD","REFUNDED","PAID"].includes(r.status))
   throw Error("WAR_TREASURY_CORRUPT_RESERVATION");
   // A PAID row is the proof that escrowed value left the chest for a named
   // pilot; without the whole proof the row is not a settlement.
   if(r.status==="PAID"&&(!pos(r.paidAt)||!pilotRef(r.paidToPilotID)||!key(r.payoutProofID)))
    throw Error("WAR_TREASURY_CORRUPT_PAYOUT");
 }
 return s;
}
function createWarTreasury({gameStore,verifyCorporation,authorizeRefund,
 authorizePayout=()=>false,clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  [verifyCorporation,authorizeRefund,authorizePayout,clock].some(x=>typeof x!=="function"))
  throw Error("WAR_TREASURY_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_WAR_TREASURY==="1"&&env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 let busy=false;
 // Set by the RESERVE path when it had to make room: reported, never invented.
 const validators={pruned:0,liveHeld:0};
 function snapshot(){
  if(!enabled())return {status:"DISABLED"};
  return gameStore.coopAtomicNativeRows.transact([TABLE],
   tx=>structuredClone(validate(tx.get(TABLE,KEY)||empty())));
 }
 function execute(command){
  if(!enabled())return {status:"DISABLED"};
  if(busy)return {status:"BLOCKED",reason:"WAR_TREASURY_REENTRANT"};
  if(!command||!key(command.eventID)||
   !["RESERVE","REFUND","PAYOUT","TAX_INCOME","CAPITAL_GRANT"].includes(command.type))
   return {status:"BLOCKED",reason:"INVALID_TREASURY_COMMAND"};
  busy=true;
  try{
   return gameStore.coopAtomicNativeRows.transact([TABLE],tx=>{
    const state=validate(tx.get(TABLE,KEY)||empty()),
     signature=JSON.stringify(command),recorded=own(state.processed,command.eventID)?
      state.processed[command.eventID]:null;
    if(recorded)return recorded.signature===signature?
     {status:"DUPLICATE",receipt:recorded.receipt}:
     {status:"BLOCKED",reason:"WAR_TREASURY_EVENT_CONFLICT"};
    // FW-056: a command that was compacted into the archive is still decided here -
    // same signature means it already happened (DUPLICATE, and deliberately no
    // receipt, so a replay can never be mistaken for a fresh settlement), a
    // different signature under the same eventID stays a conflict.
    if(own(state.archive||{},command.eventID)){
     return state.archive[command.eventID]===signatureHash(signature)?
      {status:"DUPLICATE",receipt:null,archived:true}:
      {status:"BLOCKED",reason:"WAR_TREASURY_EVENT_CONFLICT"};
    }
    if(Object.keys(state.processed).length>=MAX_EVENTS){
     // Make room by compacting the oldest receipts. The signature hash keeps every
     // replay decision exact while dropping the bulky receipts themselves.
     if(!state.archive||typeof state.archive!=="object")state.archive={};
     const ordered=Object.entries(state.processed)
      .sort((a,b)=>(Number(a[1]?.receipt?.at)||0)-(Number(b[1]?.receipt?.at)||0));
     const room=Math.max(1,Math.ceil(ordered.length/2));
     for(const [eventID,row] of ordered.slice(0,room)){
      if(Object.keys(state.archive).length>=MAX_ARCHIVE)break;
      state.archive[eventID]=signatureHash(row&&row.signature);
      delete state.processed[eventID];
     }
     if(Object.keys(state.processed).length>=MAX_EVENTS)
      return {status:"BLOCKED",reason:"WAR_TREASURY_EVENT_CAP"};
    }
    // FW-123: an INCOME command has no reservation to name. It is identified by its own
    // proof, which is already required to be a valid key, so the identity check stays the
    // same for every movement instead of demanding an escrow id that income cannot have.
    const income=command.type==="TAX_INCOME"||command.type==="CAPITAL_GRANT";
    const id=income?String(command.reservationID||command.proofID):command.reservationID,
     r=own(state.reservations,String(id))?state.reservations[id]:null;
    if(!key(id)||!pos(command.corporationID))
     return {status:"BLOCKED",reason:"INVALID_TREASURY_IDENTITY"};
    // A RESERVE naming a reservation that is already HELD is decided further
    // down: it is a DUPLICATE when the campaign exists, and a REUSE when the
    // campaign record is gone (an orphaned escrow must unblock its campaign).
    if(command.type==="RESERVE"&&((r&&r.status!=="HELD")||
      !key(command.warID)||!key(command.campaignID)||
      !pos(command.factionID)||!pos(command.amountCents)||
      command.amountCents>100000000000||
      !nonneg(command.minRemainingCents)))
     return {status:"BLOCKED",reason:"INVALID_TREASURY_RESERVE"};
    if(command.type==="REFUND"&&(!r||r.status!=="HELD"||
      r.corporationID!==command.corporationID||!key(command.proofID)))
     return {status:"BLOCKED",reason:"INVALID_TREASURY_REFUND"};
    // PAYOUT releases a HELD escrow to one named pilot. The funds already left
    // the native wallet at RESERVE time, so a payout can never create ISK: it
    // only proves where the escrowed value went.
    if(command.type==="PAYOUT"&&(!r||r.status!=="HELD"||
      r.corporationID!==command.corporationID||!key(command.proofID)||
      !pilotRef(command.pilotID)))
     return {status:"BLOCKED",reason:"INVALID_TREASURY_PAYOUT"};
    // FW-122: TAX INCOME. A faction that holds a system takes a share of the tax its
    // market already charges. This is NOT minting: the caller passes the exact amount
    // that was debited from a real seller, with the sale as its proof, and the same
    // journal entry is written into the corporation wallet as every other movement.
    if(command.type==="TAX_INCOME"&&(!pos(command.corporationID)||!pos(command.factionID)||
      !key(command.proofID)||!(Number(command.amountCents)>0)||
      Number(command.amountCents)>100000000000))
     return {status:"BLOCKED",reason:"INVALID_TREASURY_TAX_INCOME"};
    // FW-123 (owner decision 2026-10-31): a one-time STARTING CAPITAL grant, so a war can
    // actually be fought and paid before its own economy has produced a single sale. It is
    // an explicit, labelled, journaled grant - never a silent mint - capped per command and
    // idempotent by eventID, so replaying it can never create a second fortune.
    if(command.type==="CAPITAL_GRANT"&&(!pos(command.corporationID)||!pos(command.factionID)||
      !key(command.proofID)||!(Number(command.amountCents)>0)||
      Number(command.amountCents)>500000000000))
     return {status:"BLOCKED",reason:"INVALID_TREASURY_CAPITAL_GRANT"};
    const at=clock();
    if(!pos(at))throw Error("WAR_TREASURY_CLOCK_UNSAFE");
    const warState=tx.get(TABLE,WAR_KEY);
    if(warState?.version!==1||!warState.wars||!warState.campaigns)
     return {status:"BLOCKED",reason:"WAR_NATIVE_STATE_UNAVAILABLE"};
    const purpose=command.type==="RESERVE"?command:r;
    // FW-123c: an INCOME command is not a war operation - a tax or a capital grant belongs
    // to a faction, not to one campaign - so it has no war to belong to.
    const war=income?null:(own(warState.wars,purpose&&purpose.warID)?
     warState.wars[purpose.warID]:null);
    // Either real party to the war funds its own chest: the attacker pays for an
    // operation and the defender pays its own defensive bounty. A faction that
    // is not in this war can never touch its escrow.
    if(!income&&(!war||(war.attackerFactionID!==purpose.factionID&&
      war.defenderFactionID!==purpose.factionID)))
     return {status:"BLOCKED",reason:"WAR_TREASURY_FACTION_MISMATCH"};
    if(command.type==="RESERVE"){
     // FW-054 (review): terminal rows were never pruned, so after 500 campaign
     // sides the cap refused every new war forever even though only a handful of
     // escrows were live. Settled rows (REFUNDED/PAID) are history, not money:
     // the oldest are dropped only when room is needed, and a HELD row is never
     // touched. The count of dropped rows is reported, never silent.
     let pruned=0;
     const live=Object.values(state.reservations).filter(row=>row.status==="HELD").length;
     if(Object.keys(state.reservations).length>=MAX_RESERVATIONS){
      const terminal=Object.values(state.reservations)
       .filter(row=>row.status!=="HELD")
       .sort((a,b)=>(Number(b.paidAt||b.refundedAt||b.reservedAt)||0)-(Number(a.paidAt||a.refundedAt||a.reservedAt)||0));
      for(const row of terminal){
       if(Object.keys(state.reservations).length<MAX_RESERVATIONS)break;
       delete state.reservations[row.reservationID];
       pruned+=1;
      }
      validators.pruned=pruned;
      validators.liveHeld=live;
     }
     // FW-109: a BOUNTY reserve is not an opening reserve. An opening puts the supply
     // money aside BEFORE the campaign exists; a bounty is earned by a kill that can only
     // happen INSIDE a live campaign, so it has to be allowed to reserve against the
     // campaign that is already there. MEASURED on the play stack 2026-10-30: every real
     // front kill answered WAR_TREASURY_PURPOSE_UNAVAILABLE (surfaced only as the opaque
     // BLOCKED), so the wallet-backed bounty never paid once even with money in the
     // faction's own wallet - the reserve path was structurally unreachable for a bounty.
     const bountyReserve=command.type==="RESERVE"&&command.purpose==="BOUNTY";
     const reserveCampaign=own(warState.campaigns,command.campaignID)?
      warState.campaigns[command.campaignID]:null;
     const purposeOK=bountyReserve?
      Boolean(reserveCampaign&&reserveCampaign.warID===command.warID&&
       ["PREPARING","ASSAULT"].includes(String(reserveCampaign.state))):
      !reserveCampaign;
     if(war.state!=="ACTIVE"||!purposeOK||
      Object.keys(state.reservations).length>=MAX_RESERVATIONS)
      return {status:"BLOCKED",reason:"WAR_TREASURY_PURPOSE_UNAVAILABLE",
       prunedReservations:pruned,liveEscrows:live};
     // An ORPHANED escrow must unblock its own campaign. Measured on the work
     // stack 2026-10-28: the campaign record was lost to a container recreate
     // while its reservation stayed HELD, so every later opening refused with
     // WAR_TREASURY_PURPOSE_UNAVAILABLE and 25 000 ISK stayed locked with no war
     // to spend it on. When the campaign does not exist, a HELD reservation for
     // the same purpose is REUSED (nothing is debited twice) instead of blocking.
     const held=Object.values(state.reservations).find(v=>v.warID===command.warID&&
      v.campaignID===command.campaignID&&v.factionID===command.factionID&&
      v.status==="HELD");
     // FW-109: an orphaned OPENING escrow is reused, but a bountied KILL owns its own
     // escrow: two kills must never collapse into one reservation, or the second one
     // pays nothing and the first is released twice.
     if(held&&!bountyReserve)return {status:"DUPLICATE",reused:true,receipt:{
      type:"RESERVE",reservationID:held.reservationID,corporationID:held.corporationID,
      factionID:held.factionID,warID:held.warID,campaignID:held.campaignID,
      amountCents:held.cents,walletBeforeCents:null,walletAfterCents:null,
      journalID:held.sourceJournalID||0,at:held.reservedAt||0,reused:true}};
    }else if(command.type==="TAX_INCOME"||command.type==="CAPITAL_GRANT"){
     // No escrow, no campaign: a tax is income from a sale that really happened.
    }else if(command.type==="PAYOUT"){
     // The escrow belongs to one campaign of one war. A payout must name the
     // campaign that really exists for this reservation.
     const campaign=warState.campaigns[r.campaignID];
     if(!campaign||campaign.warID!==r.warID)
      return {status:"BLOCKED",reason:"WAR_TREASURY_PURPOSE_UNAVAILABLE"};
     let valid=false;
     try{valid=authorizePayout({...r,proofID:command.proofID,
       pilotID:command.pilotID,war,campaign},tx)===true}catch{}
     if(!valid)return {status:"BLOCKED",reason:"WAR_TREASURY_PAYOUT_NOT_AUTHORIZED"};
    }else{
     const campaign=warState.campaigns[r.campaignID];
     // FW-053 (review): an EXPIRED campaign is just as terminal as a cancelled one.
     // Measured today: `war:500011-500020:campaign:30045343` expired after its
     // PREPARING stall and its 2 500 000-cent reservation stayed HELD with no
     // campaign that could ever pay it - real ISK locked forever, because only
     // CANCELLED and ENDED were accepted here and the live runtime never provides
     // an authorizeRefund at all.
     // FW-066 (validation): a WON campaign is finished too. Once CAPTURE_TERRITORY moves
     // the campaign to OCCUPIED no further kill of THIS campaign can happen, so its
     // bounty escrow can never be spent - measured after the capture of 30003837, where
     // two HELD rows (25 000 ISK each) sat behind a campaign that was already over.
     // FW-085: a reservation whose campaign was NEVER created (an opening aborted
     // before START_CAMPAIGN) can never be spent by anybody. Measured: with the
     // both-sides rule a funded side's 25 000 ISK stayed HELD while the border was
     // refused, and the retry uses a new campaign id, so the orphan was invisible to the
     // reuse path and the money was simply gone. The escape hatch is explicit: it needs
     // an `unfunded:` proof, so no normal refund can use it.
     const abortedOpening=!campaign&&/^unfunded:/.test(String(command.proofID||""));
     if(!abortedOpening&&!(war.state==="ENDED"||
      ["CANCELLED","EXPIRED","OCCUPIED"].includes(String(campaign?.state||""))))
      return {status:"BLOCKED",reason:"WAR_TREASURY_STILL_IN_USE"};
     let valid=false;
     try{valid=authorizeRefund({...r,proofID:command.proofID,war,campaign},tx)===true}catch{}
     if(!valid)return {status:"BLOCKED",reason:"WAR_TREASURY_REFUND_NOT_AUTHORIZED"};
    }
    // A payout never touches the native wallet: RESERVE already removed the
    // value, so releasing it can only move an existing escrow to a named pilot.
    if(command.type==="PAYOUT"){
     const paid={...r,status:"PAID",paidAt:at,
      paidToPilotID:command.pilotID,payoutProofID:command.proofID};
     const receipt={type:"PAYOUT",reservationID:id,
      corporationID:r.corporationID,factionID:r.factionID,warID:r.warID,
      campaignID:r.campaignID,pilotID:command.pilotID,amountCents:r.cents,
      escrowJournalID:r.sourceJournalID||0,payoutProofID:command.proofID,at};
     state.reservations[id]=paid;
     state.processed[command.eventID]={signature,receipt};
     validate(state);
     tx.put(TABLE,KEY,state);
     return {status:"APPLIED",receipt};
    }
    const corpKey=CORP_PREFIX+command.corporationID,corp=tx.get(TABLE,corpKey),
     division=corp?.wallet?.divisions?.["1000"],
     balance=cents(division?.balance);
    let corporationOK=false;
    try{corporationOK=verifyCorporation({corporationID:command.corporationID,
      factionID:purpose.factionID,warID:purpose.warID},corp,tx)===true}catch{}
    if(!corporationOK||!corp||
     (corp.corporationID!==undefined&&corp.corporationID!==command.corporationID)||
     balance===null||!Array.isArray(division.journal)||
     !Array.isArray(division.transactions))
     return {status:"BLOCKED",reason:"NATIVE_CORPORATION_WALLET_UNVERIFIED"};
    const amount=command.type==="RESERVE"?command.amountCents:
     (command.type==="TAX_INCOME"||command.type==="CAPITAL_GRANT")?
      Number(command.amountCents):r.cents;
    const next=balance+(command.type==="RESERVE"?-amount:amount);
    // A tax income is the only direction that grows a faction wallet, and it can only
    // grow by the exact amount a real sale already charged.
    if(!nonneg(next)||!nonneg(amount)||!nonneg(state.nextJournalID)||
     state.nextJournalID>=Number.MAX_SAFE_INTEGER-1||
     (command.type==="RESERVE"&&next<command.minRemainingCents))
     return {status:"BLOCKED",reason:"WAR_TREASURY_FUNDS_UNAVAILABLE"};
    // The counter lives in this row, and in this world a row can be lost while the
    // wallet it describes survives. A counter that restarts then collides with real
    // journal entries (measured: WAR_TREASURY_JOURNAL_COLLISION blocked a funded
    // reservation). The next ID is therefore derived from what the wallet really
    // holds, and the stored counter only ever moves forward.
    const highest=(list)=>Array.isArray(list)?list.reduce((max,row)=>{
     const id=Number(row&&row.transactionID);
     return Number.isSafeInteger(id)&&id>max?id:max;
    },0):0;
    const journalID=Math.max(state.nextJournalID,
     highest(division.journal)+1,highest(division.transactions)+1);
    if(division.journal.some(v=>v?.transactionID===journalID)||
     division.transactions.some(v=>v?.transactionID===journalID))
     return {status:"BLOCKED",reason:"WAR_TREASURY_JOURNAL_COLLISION"};
    const transfer={
     transactionID:journalID,
     transactionDate:String(BigInt(at)*10000n+116444736000000000n),
     referenceID:journalID,entryTypeID:0,accountKey:1000,currency:1,
     sortValue:1,ownerID1:command.corporationID,
     ownerID2:command.corporationID,
     description:(command.type==="RESERVE"?
      "Coop faction-war internal escrow reserve ":
      command.type==="TAX_INCOME"?"Coop faction system tax income ":
      command.type==="CAPITAL_GRANT"?"Coop faction starting capital grant ":
      "Coop faction-war escrow refund ")+
      ((command.type==="TAX_INCOME"||command.type==="CAPITAL_GRANT")?
       String(command.proofID):id),
     amount:isk(command.type==="RESERVE"?-amount:amount),
     balance:isk(next)
    };
    const nextCorp={...corp,wallet:{...corp.wallet,divisions:{
     ...corp.wallet.divisions,
     "1000":{...division,balance:isk(next),
      journal:[...division.journal,transfer].slice(-100),
      transactions:[...division.transactions,transfer].slice(-2000)}}}};
    const receipt={type:command.type,reservationID:id,
     corporationID:command.corporationID,amountCents:amount,
     walletBeforeCents:balance,walletAfterCents:next,
     journalID,at,
     // FW-054: room made for this reserve by dropping settled history, so a
     // full ledger can never look like a world that simply cannot fund a war.
     prunedReservations:Number(validators.pruned)||0};
    if(command.type==="TAX_INCOME"||command.type==="CAPITAL_GRANT"){
     // Income is not a reservation: it is recorded on the receipt only.
    }else if(command.type==="RESERVE"){
     state.reservations[id]={reservationID:id,corporationID:command.corporationID,
      factionID:command.factionID,warID:command.warID,
      campaignID:command.campaignID,cents:amount,status:"HELD",
      reservedAt:at,sourceJournalID:journalID};
    }else state.reservations[id]={...r,status:"REFUNDED",
     refundedAt:at,refundJournalID:journalID,refundProofID:command.proofID};
    state.nextJournalID++;
    state.processed[command.eventID]={signature,receipt};
    validate(state);
    tx.put(TABLE,corpKey,nextCorp);
    tx.put(TABLE,KEY,state);
    return {status:"APPLIED",receipt};
   });
  }finally{busy=false}
 }
 return Object.freeze({execute,snapshot});
}
module.exports={TABLE,KEY,CORP_PREFIX,empty,validate,cents,createWarTreasury};
