"use strict";
// FW-008: terminal-campaign cleanup, never victory/capture fabrication.
// Keeps original physical NPC ships, native cargo and wallet unchanged.
// An already-registered idle hull can join a different verified campaign
// through the EXISTING FW-003C mobilizer in the following phase/tick.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const pilot=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const valid=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(x);
const enabled=env=>env.EVEJS_COOP_FACTION_WAR==="1"&&
 env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
 env.EVEJS_COOP_FACTION_WAR_DEMOBILIZE==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
 (env.EVEJS_COOP_ALIFE==="1"||env.EVEJS_COOP_NPC_ORDER_ARBITER==="1");
function createWarDemobilizer({registry,readWarState,readLinks,
 getOrderLeases,clock=()=>Date.now(),env=process.env,
 maxPerTick=2}={}){
 if(typeof registry?.snapshot!=="function"||
  typeof registry.execute!=="function"||
  [readWarState,readLinks,getOrderLeases,clock].some(x=>typeof x!=="function")||
  !Number.isSafeInteger(maxPerTick)||maxPerTick<1||maxPerTick>4)
  throw Error("WAR_DEMOB_NATIVE_AUTHORITIES_REQUIRED");
 let busy=false;
 function tick({systemIDs=[]}={}){
  if(!enabled(env))return {status:"DISABLED",demobilized:[]};
  if(busy)return {status:"BUSY",demobilized:[]};
  if(!Array.isArray(systemIDs)||systemIDs.length>512||
   systemIDs.some(x=>!pos(x)))
   return {status:"INVALID_SYSTEMS",demobilized:[]};
  busy=true;
  try{
   const now=clock();
   if(!pos(now))return {status:"CLOCK_UNSAFE",demobilized:[]};
   let warState,fleetState,links,leases;
   try{
    warState=readWarState();
    fleetState=registry.snapshot();
    links=readLinks();
    leases=getOrderLeases();
   }catch{return {status:"NATIVE_AUTHORITIES_UNAVAILABLE",demobilized:[]}}
   if(warState?.version!==1||!warState.campaigns||!warState.wars||
    fleetState?.version!==1||!fleetState.ships||
    !Array.isArray(links)||links.length>10000||
    !Array.isArray(leases)||leases.length>10000)
    return {status:"INVALID_NATIVE_STATE",demobilized:[]};
   const activeSystems=new Set(systemIDs),pilotCounts=new Map(),
    shipCounts=new Map();
   for(const l of links){
    if(pilot(l?.pilotID))
     pilotCounts.set(l.pilotID,(pilotCounts.get(l.pilotID)||0)+1);
    if(pos(l?.entityID))
     shipCounts.set(l.entityID,(shipCounts.get(l.entityID)||0)+1);
   }
   const linksByShip=new Map(links.filter(l=>pos(l?.entityID))
    .map(l=>[l.entityID,l]));
   const demobilized=[];
   const assigned=Object.values(fleetState.ships)
    .filter(x=>x&&pos(x.entityID)&&activeSystems.has(x.systemID))
    .sort((a,b)=>a.entityID-b.entityID).slice(0,512);
   for(const hull of assigned){
    if(demobilized.length>=maxPerTick)break;
    const c=warState.campaigns[hull.campaignID],
     war=warState.wars[hull.warID],link=linksByShip.get(hull.entityID);
    if(!c||!war||c.warID!==hull.warID||
     !["OCCUPIED","CANCELLED"].includes(c.state)||
     !["ACTIVE","ENDED"].includes(war.state)||
     (c.state==="CANCELLED"&&war.state!=="ENDED")||
     !pos(c.revision)||!valid(c.campaignID)||
     !valid(hull.warID)||!valid(hull.fleetID)||
     !pilot(hull.pilotID)||!pos(hull.systemID)||
     ![war.attackerFactionID,war.defenderFactionID].includes(hull.factionID)||
     !link||link.pilotID!==hull.pilotID||
     link.systemID!==hull.systemID||
     pilotCounts.get(hull.pilotID)!==1||
     shipCounts.get(hull.entityID)!==1)
     continue;
    // Do not release the same NPC while a physical gate transition is
    // unresolved or even terminal-but-not-retired. Native SQL does the
    // same check AGAIN inside the actual demobilization transaction.
    if(fleetState.transfers?.[String(hull.entityID)])continue;
    if(leases.some(l=>l?.entityID===hull.entityID&&
     (l.phase==="OUTCOME_UNKNOWN"||l.phase==="ISSUING"||
      l.phase==="ACTIVE"&&
       (l.expiresAt===null||!Number.isFinite(l.expiresAt)||
        l.expiresAt>now))))continue;
    const command={type:"DEMOBILIZE",
     eventID:"wd:"+c.campaignID+":"+hull.entityID+":"+c.revision,
     entityID:hull.entityID,pilotID:hull.pilotID,
     systemID:hull.systemID,fleetID:hull.fleetID,
     warID:hull.warID,campaignID:c.campaignID,
     campaignRevision:c.revision,
     proofID:"native-demob:"+c.campaignID+":"+hull.entityID};
    if(!valid(command.eventID)||!valid(command.proofID))continue;
    let result;
    try{result=registry.execute(command)}
    catch{return {status:"NATIVE_COMMIT_UNCERTAIN",demobilized}};
    if(result?.status==="APPLIED")
     demobilized.push({
      entityID:hull.entityID,pilotID:hull.pilotID,
      systemID:hull.systemID,warID:hull.warID,
      campaignID:c.campaignID,terminalState:c.state,
      physicalShipPreserved:true
     });
    // A DUPLICATE means native SQL already demobilized it in an earlier
    // commit. Never report a second demobilization for that event.
   }
   return {status:"OBSERVED",demobilized};
  }finally{busy=false}
 }
 return Object.freeze({tick});
}
module.exports={createWarDemobilizer,enabled};
