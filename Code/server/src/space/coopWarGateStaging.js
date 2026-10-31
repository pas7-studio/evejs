"use strict";
// FW-007A: stage already-funded physical warships at REAL reciprocal gates.
// Reuses the existing NPC gate director and shared WAR arbiter. There is NO
// native cross-system transfer: custody is never inferred from gate arrival.
const {createGateTravel}=require("./coopNpcGateTravel"+
 (__filename.endsWith(".js")?"":".cjs"));
const warCore=require("./coopFactionWarCore"+
 (__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
const REQUIRED_FLAGS=["EVEJS_COOP_FACTION_WAR","EVEJS_COOP_FACTION_WAR_FLEETS",
 "EVEJS_COOP_WAR_TREASURY","EVEJS_COOP_FACTION_WAR_GATE_APPROACH",
 "EVEJS_COOP_NATIVE_ATOMIC_ROWS"];
// A phase that refuses without a reason cannot be diagnosed from outside, so the
// exact missing flag is part of the contract, not a comment.
function gateReason(env){
 const missing=REQUIRED_FLAGS.filter(k=>env?.[k]!=="1");
 if(env?.EVEJS_COOP_ALIFE!=="1"&&env?.EVEJS_COOP_NPC_ORDER_ARBITER!=="1")
  missing.push("EVEJS_COOP_ALIFE|EVEJS_COOP_NPC_ORDER_ARBITER");
 return missing.length?`WAR_GATE_FLAGS_INCOMPLETE:${missing.join(",")}`:null;
}
const gate=env=>gateReason(env)===null;
function createWarGateStaging({readWar,readFleet,readTreasury,
 sceneForSystem,getGate,warpToEntity,getController,bridge,transfer=null,
 isTactical=()=>false,isAmmoRetreat=()=>false,
 clock=()=>Date.now(),env=process.env,maxOrders=1,orderFollow=null}={}){
 if([readWar,readFleet,readTreasury,sceneForSystem,getGate,
  warpToEntity,getController,isTactical,isAmmoRetreat,clock]
  .some(x=>typeof x!=="function")||typeof bridge?.issue!=="function"||
  (transfer!==null&&typeof transfer!=="function")||
  !Number.isSafeInteger(maxOrders)||maxOrders<1||maxOrders>3)
  throw Error("WAR_NATIVE_GATE_AUTHORITIES_REQUIRED");
 const travel=createGateTravel({getGate,clock,maxShipsPerTick:maxOrders,
  orderFollow,
  warp:(id,gateID,options)=>{
   let controller;
   try{controller=getController(id)}catch{
    return {success:false,errorMsg:"WAR_GATE_CONTROLLER_UNAVAILABLE"}}
   const systemID=controller?.systemID;
   if(!pos(systemID)||isTactical(id)||isAmmoRetreat(systemID,id))
    return {success:false,errorMsg:"WAR_GATE_SHIP_UNAVAILABLE"};
   return bridge.issue({entityID:id,systemID,owner:"WAR",
    action:"warp-to-gate",execute:()=>warpToEntity(id,gateID,options)});
  },
  // FW-007B: physical transition only through the explicitly enabled
  // proof-backed SQL + JSON military handoff. No direct stock transfer.
  transfer:transfer?args=>bridge.issue({
   owner:"WAR",entityID:args.entityID,systemID:args.gate?.sourceSystemID,
   action:"native-gate-transfer",
   execute:()=>transfer(args)
  }):null});
 function tick({systemIDs=[]}={}){
  if(!gate(env))return {status:"DISABLED",reason:gateReason(env),orders:[],
   observations:[],skips:[]};
  if(!Array.isArray(systemIDs)||systemIDs.length>512||
   systemIDs.some(x=>!pos(x)))return {status:"INVALID_SYSTEMS",orders:[],
   observations:[],skips:[]};
  let war,fleet,treasury;
  try{war=readWar();fleet=readFleet();treasury=readTreasury()}
  catch{return {status:"NATIVE_STATE_UNAVAILABLE",orders:[],
   observations:[],skips:[]}}
  if(war?.version!==1||fleet?.version!==1||treasury?.version!==1||
   !war.campaigns||!war.wars||!fleet.ships||!treasury.reservations)
   return {status:"WAR_NATIVE_STATE_INVALID",orders:[],observations:[],
    skips:[]};
  const accepted=new Set(systemIDs),orders=[],observations=[],skips=[];
  // Funding alone is not supply. A campaign must ALREADY have passed the
  // independent native supply/route verification in FW-001 START_CAMPAIGN.
  // An ASSAULT campaign is exactly the leg where the attacker still has to fly
  // the gate, so it is staged too - but only the hulls still in the source
  // system (one already inside the target system needs no crossing).
  const live=Object.values(war.campaigns).filter(c=>
   ["PREPARING","ASSAULT"].includes(String(c?.state))&&
   pos(c.sourceSystemID)&&pos(c.targetSystemID))
   .sort((a,b)=>String(a.campaignID).localeCompare(String(b.campaignID)))
   .slice(0,12);
  if(!live.length)skips.push({campaignID:null,reason:"NO_PREPARING_CAMPAIGN"});
  for(const campaign of live){
   if(!accepted.has(campaign.sourceSystemID)){
    skips.push({campaignID:campaign.campaignID,
     reason:"SOURCE_SYSTEM_NOT_VISITED:"+campaign.sourceSystemID});
    continue;
   }
   if(orders.length>=maxOrders){
    skips.push({campaignID:campaign.campaignID,reason:"ORDER_BUDGET_SPENT"});
    continue;
   }
   const w=war.wars[campaign.warID],reserve=treasury.reservations[campaign.supplyReservationID];
   if(w?.state!=="ACTIVE"||!pos(w.attackerFactionID)){
    skips.push({campaignID:campaign.campaignID,
     reason:`WAR_NOT_ACTIVE:${String(w?.state)}`});
    continue;
   }
   // EVEJS_COOP_WAR_REQUIRE_FUNDING=0 is an explicit operator decision: the
   // opening records the campaign's own `paper-supply:<campaignID>` id and
   // reserves nothing, so no escrow can exist and no bounty can ever be paid.
   // Such a campaign may still fly a real hull at a real gate; it is labelled
   // PAPER_UNFUNDED_EXPLICIT and never treated as funded. Any OTHER id keeps the
   // full strict escrow proof.
   const paperSupply=warCore.paperSupply(campaign);
   if(!paperSupply&&(reserve?.status!=="HELD"||reserve.warID!==campaign.warID||
    reserve.campaignID!==campaign.campaignID||
    reserve.factionID!==w.attackerFactionID||!pos(reserve.cents))){
    // Name the FIRST precondition that actually failed instead of a blanket
    // "no supply": the operator has to know which one to repair.
    const why=!reserve?`SUPPLY_RESERVATION_MISSING:${String(campaign.supplyReservationID)}`:
     reserve.status!=="HELD"?`SUPPLY_NOT_HELD:${String(reserve.status)}`:
     reserve.warID!==campaign.warID?`SUPPLY_WAR_MISMATCH:${String(reserve.warID)}`:
     reserve.campaignID!==campaign.campaignID?
      `SUPPLY_CAMPAIGN_MISMATCH:${String(reserve.campaignID)}`:
     reserve.factionID!==w.attackerFactionID?
      `SUPPLY_FACTION_MISMATCH:${String(reserve.factionID)}`:
      "SUPPLY_AMOUNT_INVALID";
    skips.push({campaignID:campaign.campaignID,reason:why});
    continue;
   }
   let scene;
   try{scene=sceneForSystem(campaign.sourceSystemID)}catch{
    skips.push({campaignID:campaign.campaignID,
     reason:"SOURCE_SCENE_UNAVAILABLE:"+campaign.sourceSystemID});
    continue;
   }
   if(!scene){
    skips.push({campaignID:campaign.campaignID,
     reason:"SOURCE_SCENE_MISSING:"+campaign.sourceSystemID});
    continue;
   }
   if(scene?.systemID!==campaign.sourceSystemID){
    skips.push({campaignID:campaign.campaignID,
     reason:"SOURCE_SCENE_NOT_READY:"+campaign.sourceSystemID});
    continue;
   }
   const registered=Object.values(fleet.ships).filter(s=>
    s?.campaignID===campaign.campaignID&&s.warID===campaign.warID&&
    s.factionID===w.attackerFactionID);
   const assignments=registered.filter(s=>
    s.systemID===campaign.sourceSystemID&&pos(s.entityID)&&
    typeof s.pilotID==="string"&&/^coop-pilot-[0-9]{3,}$/.test(s.pilotID))
    .slice(0,8).map(s=>({...s,role:"patrol"}));
   if(!assignments.length){
    skips.push({campaignID:campaign.campaignID,
     reason:registered.length?
      "NO_ATTACKER_SHIP_IN_SOURCE:"+campaign.sourceSystemID:
      "NO_ATTACKER_SHIP_REGISTERED"});
    continue;
   }
   const blocked=new Set();
   for(const a of assignments)try{
    if(isTactical(a.entityID)||isAmmoRetreat(a.systemID,a.entityID))
     blocked.add(a.entityID)
   }catch{blocked.add(a.entityID)}
   const output=travel.tick({
    systemID:campaign.sourceSystemID,scene,assignments,
    route:[campaign.sourceSystemID,campaign.targetSystemID],
    getController,blockedIDs:blocked
   });
   if(output.status!=="OK"&&!output.orders.length&&!output.observations.length)
    skips.push({campaignID:campaign.campaignID,
     reason:String(output.status||"GATE_TRAVEL_REFUSED")});
   if(output.status==="OK"&&!output.orders.length&&!output.observations.length)
    skips.push({campaignID:campaign.campaignID,
     reason:(Array.isArray(output.rejections)&&output.rejections.length)?
      "ATTACKER_REJECTED:"+output.rejections.slice(0,3)
       .map(r=>`${r.entityID}/${r.reason}`).join(","):
      blocked.size?"ATTACKER_BLOCKED:"+[...blocked].sort((a,b)=>a-b).join(","):
      "NO_STAGEABLE_ATTACKER_SHIP"});
   // A gate-warp result does not change native ship location, fleet
   // registry, cargo, SDE faction, war objective or player's wallet.
   for(const o of output.orders){
    if(orders.length>=maxOrders)break;
    if(o.action==="NATIVE_WARP_TO_REAL_GATE"||
       o.action==="NATIVE_SUBWARP_TO_REAL_GATE"||
       o.action==="VERIFIED_NATIVE_GATE_TRANSFER")
     orders.push({...o,campaignID:campaign.campaignID,
      campaignState:String(campaign.state),
      supply:paperSupply?"PAPER_UNFUNDED_EXPLICIT":"REAL_HELD_ESCROW",
      phase:o.action==="VERIFIED_NATIVE_GATE_TRANSFER"?
       "NATIVE_TRANSFER_WITH_DURABLE_HANDOFF":
       o.action==="NATIVE_SUBWARP_TO_REAL_GATE"?
       "STAGING_SUBWARP_APPROACH_ONLY_NOT_TRANSFER":
       "STAGING_ONLY_NOT_TRANSFER"});
   }
   for(const o of output.observations.slice(0,8))
    observations.push({...o,campaignID:campaign.campaignID,
     phase:o.status==="TRANSFER_REFUSED"?"NATIVE_TRANSFER_REFUSED":
      o.status==="WARP_REFUSED"?"NATIVE_WARP_REFUSED":
      "AWAITING_NATIVE_WAR_FLEET_TRANSFER"});
  }
  return {status:"OBSERVED",orders,observations:observations.slice(0,16),
   skips:skips.slice(0,16)};
 }
 return Object.freeze({tick,activeIDs:travel.activeIDs});
}
module.exports={createWarGateStaging,gate,gateReason,REQUIRED_FLAGS};
