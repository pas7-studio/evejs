"use strict";
// FW-009A: immutable native wreck-based faction-war casualties, NOT kill
// credit, damage, sovereign control, campaign defeat or automatic rewards.
// Uses the existing GameStore SQLite corporationRuntime atomic keyspace.
const {TABLE,KEY:WAR_KEY}=require("./coopFactionWarStore"+
 (__filename.endsWith(".js")?"":".cjs"));
const {KEY:FLEET_KEY,validate:validateFleet}=require("./coopWarFleetRegistry"+
 (__filename.endsWith(".js")?"":".cjs"));
const {validateState:validateWar}=require("./coopFactionWarCore"+
 (__filename.endsWith(".js")?"":".cjs"));
const KEY="coop-faction-war\u001fcasualties-v1",MAX=4096,MAX_PER_CAMPAIGN=256;
const pos=x=>Number.isSafeInteger(x)&&x>0;
const safe=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const pilot=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const empty=()=>({version:1,byWreck:{},count:0});
function validate(s){
 if(!s||s.version!==1||!s.byWreck||typeof s.byWreck!=="object"||
   Array.isArray(s.byWreck)||!Number.isSafeInteger(s.count)||
   s.count<0||s.count!==Object.keys(s.byWreck).length||s.count>MAX)
  throw Error("WAR_NATIVE_CASUALTY_LEDGER_INVALID");
 for(const [id,e] of Object.entries(s.byWreck)){
  if(!pos(Number(id))||String(Number(id))!==id||e?.wreckID!==Number(id)||
   !pos(e.systemID)||!pos(e.entityID)||!pilot(e.pilotID)||
   !pos(e.victimFactionID)||!pos(e.corporationID)||
   !safe(e.warID)||!safe(e.campaignID)||!pos(e.observedAt)||
   e.attribution!=="NATIVE_VICTIM_WRECK_ONLY_NO_KILLER"||
   e.kind!=="WARSHIP_DESTROYED")
   throw Error("WAR_NATIVE_CASUALTY_RECORD_CORRUPT");
 }
 return s;
}
// FW-136 (measured 2026-10-31T16:52Z): the flat casualty row can be ABSENT from
// SQLite while a validated copy of the very same document still sits in the legacy
// "coop-faction-war" row group the in-memory cache was built from. Every atomic
// reader (capture-by-force, this ledger itself) then saw an empty ledger: the
// defender wrecks were invisible, capture-by-force answered NO_DEFENDER_WRECK for
// five live fronts, and a replayed wreck would have been recorded twice because the
// "victim already recorded" guard had nothing to compare against.
//
// The cache copy is a persisted document, not an invention, so a missing durable row
// is healed from it inside the caller's own transaction. A row that is present is
// always authoritative and is never replaced.
function readLedgerRow({tx=null,gameStore=null}={}){
 const durable=tx&&typeof tx.get==="function"?tx.get(TABLE,KEY):null;
 if(durable)return validate(durable);
 if(!gameStore)return empty();
 let cached=null;
 try{
  const {readRow}=require("./coopNativeRowPath"+
   (__filename.endsWith(".js")?"":".cjs"));
  cached=readRow(gameStore,TABLE,KEY,validate);
 }catch(_error){cached=null}
 if(!cached)return empty();
 if(tx&&typeof tx.put==="function")tx.put(TABLE,KEY,cached);
 return validate(cached);
}
function createWarCasualtyLedger({gameStore,verifyNativeWreck,
 getFactionForCorporation,clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  [verifyNativeWreck,getFactionForCorporation,clock].some(x=>typeof x!=="function"))
  throw Error("WAR_NATIVE_CASUALTY_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
  env.EVEJS_COOP_FACTION_WAR_NATIVE_CASUALTIES==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const transact=fn=>gameStore.coopAtomicNativeRows.transact([TABLE],fn);
 let busy=false;
 function record({systemID,entityID,wreckID,pilotID}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!pos(systemID)||!pos(entityID)||!pos(wreckID)||!pilot(pilotID))
   return {status:"BLOCKED",reason:"INVALID_NATIVE_WRECK_IDENTITY"};
  if(busy)return {status:"BLOCKED",reason:"CASUALTY_RECORD_REENTRANT"};
  busy=true;
  try{
   return transact(tx=>{
    const state=readLedgerRow({tx,gameStore}),
     known=own(state.byWreck,String(wreckID))?state.byWreck[String(wreckID)]:null;
    // A wreck is a globally unique native physical entity. A replay for
    // the exact same victim is safe even after the wreck was salvaged.
    if(known)return known.entityID===entityID&&known.systemID===systemID&&
      known.pilotID===pilotID?
      {status:"DUPLICATE",receipt:{...known}}:
      {status:"BLOCKED",reason:"NATIVE_WRECK_REPLAY_CONFLICT"};
    if(state.count>=MAX)
     return {status:"BLOCKED",reason:"WAR_CASUALTY_LEDGER_AT_CAPACITY"};
    const warState=tx.get(TABLE,WAR_KEY),fleetState=tx.get(TABLE,FLEET_KEY);
    if(!warState||!fleetState)
     return {status:"BLOCKED",reason:"NATIVE_WAR_FLEET_STATE_UNAVAILABLE"};
    validateWar(warState);validateFleet(fleetState);
    const victim=fleetState.ships[String(entityID)];
    if(!victim||victim.entityID!==entityID||victim.systemID!==systemID||
     victim.pilotID!==pilotID||!pos(victim.corporationID)||
     !pos(victim.factionID)||!safe(victim.warID)||
     !safe(victim.campaignID)||fleetState.transfers?.[String(entityID)])
     return {status:"BLOCKED",reason:"WAR_CASUALTY_SHIP_NOT_STABLE"};
    const war=warState.wars[victim.warID],
     campaign=warState.campaigns[victim.campaignID];
    if(war?.state!=="ACTIVE"||campaign?.state!=="ASSAULT"||
     campaign.warID!==victim.warID||campaign.targetSystemID!==systemID||
     !pos(war.attackerFactionID)||!pos(war.defenderFactionID)||
     ![war.attackerFactionID,war.defenderFactionID].includes(victim.factionID))
     return {status:"BLOCKED",reason:"WAR_CASUALTY_NO_NATIVE_ASSAULT"};
    // Even if a native engine accidentally assigns a second wreck ID
    // to the same physical entity, the victim cannot die twice in this
    // same war/campaign. A later independent campaign remains separate.
    if(Object.values(state.byWreck).some(e=>
      e.campaignID===victim.campaignID&&e.warID===victim.warID&&
      e.entityID===entityID))
     return {status:"BLOCKED",reason:"WAR_CASUALTY_VICTIM_ALREADY_RECORDED"};
    if(Object.values(state.byWreck).filter(e=>
      e.campaignID===victim.campaignID).length>=MAX_PER_CAMPAIGN)
     return {status:"BLOCKED",reason:"WAR_CASUALTY_CAMPAIGN_CAP"};
    let faction,proof;
    try{
     faction=getFactionForCorporation(victim.corporationID);
     proof=verifyNativeWreck({systemID,entityID,wreckID,pilotID,
      corporationID:victim.corporationID,factionID:victim.factionID,
      campaignID:victim.campaignID,warID:victim.warID});
    }catch{return {status:"BLOCKED",reason:"NATIVE_WRECK_WITNESS_UNAVAILABLE"}}
    if(faction!==victim.factionID||
     proof?.status!=="PHYSICAL_NATIVE_WRECK_VERIFIED"||
     proof.systemID!==systemID||proof.victimEntityID!==entityID||
     proof.victimPilotID!==pilotID||proof.wreckID!==wreckID||
     !Number.isSafeInteger(proof.storedItemCount)||proof.storedItemCount<0)
     return {status:"BLOCKED",reason:"NATIVE_WRECK_OR_SDE_FACTION_UNVERIFIED"};
    const observedAt=clock();
    if(!pos(observedAt))throw Error("WAR_CASUALTY_CLOCK_INVALID");
    const entry={kind:"WARSHIP_DESTROYED",warID:victim.warID,
     campaignID:victim.campaignID,systemID,entityID,wreckID,
     pilotID,corporationID:victim.corporationID,
     victimFactionID:victim.factionID,observedAt,
     nativeStoredItemCount:proof.storedItemCount,
     attribution:"NATIVE_VICTIM_WRECK_ONLY_NO_KILLER"};
    state.byWreck[String(wreckID)]=entry;state.count++;
    validate(state);tx.put(TABLE,KEY,state);
    return {status:"RECORDED",receipt:{...entry}};
   });
  }finally{busy=false}
 }
 function assess({campaignID}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!safe(campaignID))return {status:"INVALID_CAMPAIGN_ID"};
  return transact(tx=>{
   const s=validate(tx.get(TABLE,KEY)||empty()),
    w=tx.get(TABLE,WAR_KEY);
   if(!w)return {status:"WAR_STATE_UNAVAILABLE"};
   validateWar(w);
   const campaign=w.campaigns[campaignID],war=campaign&&w.wars[campaign.warID];
   if(!campaign||!war)return {status:"CAMPAIGN_NOT_FOUND"};
   const casualties=Object.values(s.byWreck).filter(e=>
    e.campaignID===campaignID&&e.warID===campaign.warID);
   const attackerLosses=casualties.filter(e=>
    e.victimFactionID===war.attackerFactionID).length;
   const defenderLosses=casualties.filter(e=>
    e.victimFactionID===war.defenderFactionID).length;
   return {status:"NATIVE_WAR_CASUALTIES_OBSERVED",
    campaignID,warID:campaign.warID,phase:campaign.state,
    attackerFactionID:war.attackerFactionID,
    defenderFactionID:war.defenderFactionID,
    attackerConfirmedLosses:attackerLosses,
    defenderConfirmedLosses:defenderLosses,
    totalConfirmedLosses:casualties.length,
    // Never a native command to capture, pay a bounty or announce a kill.
    captureAuthorized:false,defeatAdjudicated:false,
    victoryAdjudicated:false,killCreditAssigned:false,
    objectiveProofRequired:true};
  });
 }
 return Object.freeze({record,assess});
}
module.exports={TABLE,KEY,empty,validate,readLedgerRow,createWarCasualtyLedger};
