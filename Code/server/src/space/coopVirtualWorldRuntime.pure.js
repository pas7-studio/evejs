// Extracted from space/coopVirtualWorldRuntime.js by scripts/coop-split-module.cjs.
// These declarations touch no module state, so they are pure helpers: they can be
// read, tested and changed without loading the runtime. The parent file requires
// them back, so its exports and call sites are unchanged.

﻿"use strict";
const observedNpcIDs=new Set();

const visitedSystems=new Set();
// FW-013B: last published raid-diagnose shape per system (never every tick).

const raidDiagnose=new Map();

const initializedNativeMiningScenes=new WeakSet();

const destroyedNativeShips=new Set();
// The split tool moved the functions but not their module state. Without these
// declarations nativeWarFleetRegistry() threw "warFleetRegistry is not defined"
// inside the garrison phase, so the war silently stopped refilling.
let warFleetRegistry=null,bridge=null,identityRegistry=null,
 economy=null,nativeGateTransfer=null,recognitionAnnouncer=null,nativeAmmoWitness=null;
// Declared here because the extraction left them behind: every phase that
// touched one threw ReferenceError, which froze that part of the world.
let lossBridge=null,factionDirector=null,raidDirector=null,tacticsDirector=null,pveSiteDefenseDirector=null,pveWaveReinforcementsDirector=null,pveObjectiveDoctrineDirector=null,pveNativeBossDirector=null,warpPointDirector=null,nativeGunRange=null,warGateHandoff=null,warRecoverySocket=null,nativeOrderBridge=null,lootCommerce=null,nativeAmmoSupply=null,warTreasuryInstance=null;
function bindWarRuntime(state){
 if(!state||typeof state!=="object")return false;
 if(state.bridge!==undefined)bridge=state.bridge||null;
 if(state.identityRegistry!==undefined)identityRegistry=state.identityRegistry||null;
 if(state.economy!==undefined)economy=state.economy||null;
 if(state.nativeGateTransfer!==undefined)nativeGateTransfer=state.nativeGateTransfer||null;
 if(state.recognitionAnnouncer!==undefined)recognitionAnnouncer=state.recognitionAnnouncer||null;
 if(state.nativeAmmoWitness!==undefined)nativeAmmoWitness=state.nativeAmmoWitness||null;
 if(state.lossBridge)lossBridge=state.lossBridge;
 if(state.factionDirector)factionDirector=state.factionDirector;
 if(state.raidDirector)raidDirector=state.raidDirector;
 if(state.tacticsDirector)tacticsDirector=state.tacticsDirector;
 if(state.pveSiteDefenseDirector)pveSiteDefenseDirector=state.pveSiteDefenseDirector;
 if(state.pveWaveReinforcementsDirector)pveWaveReinforcementsDirector=state.pveWaveReinforcementsDirector;
 if(state.pveObjectiveDoctrineDirector)pveObjectiveDoctrineDirector=state.pveObjectiveDoctrineDirector;
 if(state.pveNativeBossDirector)pveNativeBossDirector=state.pveNativeBossDirector;
 if(state.warpPointDirector)warpPointDirector=state.warpPointDirector;
 if(state.nativeGunRange)nativeGunRange=state.nativeGunRange;
 if(state.warGateHandoff)warGateHandoff=state.warGateHandoff;
 if(state.warRecoverySocket)warRecoverySocket=state.warRecoverySocket;
 if(state.nativeOrderBridge)nativeOrderBridge=state.nativeOrderBridge;
 if(state.lootCommerce)lootCommerce=state.lootCommerce;
 if(state.nativeAmmoSupply)nativeAmmoSupply=state.nativeAmmoSupply;
 if(state.warTreasuryInstance)warTreasuryInstance=state.warTreasuryInstance;
 return true;
}

const wreckCustodyNotes=new Map();

const worldBootAtMs=Date.now();

function courierPilotIDs(){
try{
const result=require("../gameStore").read("characters","/");
const rows=result&&result.success&&result.data?result.data:{};
const ids=[];
for(const key of Object.keys(rows)){
const record=rows[key];
const name=String(record&&(record.characterName||record.name)||"");
const id=Number(record&&record.characterID)||Number(key);
if(/^Haul /.test(name)&&id>0)ids.push(id);
}
if(ids.length)return ids.sort((left,right)=>left-right);
}catch(_error){/* fall back to the known seed below */}
return [140000100,140000101,140000102,140000103,140000104,140000105,140000106];
}

function nativeWarFleetRegistry(){
 if(process.env.EVEJS_COOP_FACTION_WAR!=="1"||
    process.env.EVEJS_COOP_FACTION_WAR_FLEETS!=="1"||
    process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")return null;
 if(!warFleetRegistry){
  const runtime=require("./runtime"),controllers=require("./npc/npcRegistry"),
   entityStore=require("./npc/nativeNpcStore"),
   factions=require("../services/faction/factionState");
  const proofs=require("./coopWarFleetNativeProofs").createWarFleetNativeProofs({
   sceneForSystem:id=>runtime.scenes instanceof Map?runtime.scenes.get(id):null,
   getController:id=>controllers.getControllerByEntityID(id),
   getNativeEntity:id=>entityStore.getNativeEntity(id),
   assignments:()=>[...(bridge?.snapshot()||[]),
    ...Object.values(identityRegistry?.snapshot()?.links||{})],
   getFactionForCorporation:id=>factions.getFactionIDForCorporation(id),
   // A hull whose physical native wreck this process already confirmed may leave
   // fleet custody. Nothing else counts as destroyed: a missing scene never does.
   confirmDestroyed:d=>destroyedNativeShips.has(Number(d?.entityID))
  });
  warFleetRegistry=require("./coopWarFleetRegistry").createWarFleetRegistry({
   gameStore:require("../gameStore"),...proofs,
   // A terminal campaign is NOT permission to hijack a busy NPC. The
   // native hull and a nonambiguous arbiter idle state are mandatory.
   verifyDemobOrderIdle:d=>{
    const arbiter=nativeOrderBridge;
    if(!arbiter||!d?.entityID||!d?.pilotID)return false;
    let scene,ctrl,leases;
    try{
     scene=runtime.scenes instanceof Map?runtime.scenes.get(d.systemID):null;
     ctrl=controllers.getControllerByEntityID(d.entityID);
     leases=arbiter.snapshot()?.leases;
    }catch{return false}
    const ship=scene?.getEntityByID?.(d.entityID);
    if(!Array.isArray(leases)||!ship||ship.nativeNpc!==true||
     ship.itemID!==d.entityID||ship.session?.characterID||
     ctrl?.entityID!==d.entityID||ctrl.systemID!==d.systemID||
     ctrl.manualOrder||ctrl.currentTargetID||ship.pendingWarp||
     ship.warpState||ship.isWarping||
     !["STOP","IDLE"].includes(String(ship.mode||"").toUpperCase()))
     return false;
    const now=Date.now();
    if(leases.some(l=>l.entityID===d.entityID&&
     (l.phase==="ISSUING"||l.phase==="OUTCOME_UNKNOWN"||
      l.phase==="ACTIVE"&&(!Number.isSafeInteger(l.expiresAt)||
       l.expiresAt>now))))return false;
    try{
     if(tacticsDirector?.activeIDs()?.has(d.entityID)===true||
      nativeAmmoSupply?.activeIDs(d.systemID)?.has(d.entityID)===true)
      return false;
    }catch{return false}
    return true;
   }
  });
 }
 return warFleetRegistry;
}
// FW-008: terminal war campaigns demobilize BEFORE the existing native
// recruiter evaluates new adjacent wars. No second tick or physical ship
// movement. All custody changes are rechecked inside native SQLite.

const warSkipReasons={};

function warSkip(phase,reason){
 if(warSkipReasons[phase]===reason)return;
 warSkipReasons[phase]=reason;
 console.log(`[CoopFactionWar] ${phase} skipped: ${reason}`);
 try{
  require("./coopRuntimeProbe").observe("living-native-war-skip",null,null,
   {phase,reason,status:"SKIPPED",evidence:"EXPLICIT_PRECONDITION_NOT_MET"});
 }catch(_error){/* probe is best effort */}
}
// The war record lives in the SAME SQLite keyspace the authoritative war store
// writes: `coopAtomicNativeRows` with the raw KEY. The JSON-path API is a
// different, cache-only view - a state written there is never the state a later
// tick reads, which is why the bootstrap used to recreate the record forever.

const warFrontChatSent=new Set();
// Source .cjs modules become .js siblings in the deployed EveJS overlay.

const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";

function warFrontChat(kind,details={},systemIDs=[]){
 const key=kind+":"+String(details.eventKey||"");
 if(warFrontChatSent.has(key))return false;
 let text=null;
 try{text=require("./coopWarClientView"+siblingSuffix).frontReport(kind,details)}catch(_error){text=null}
 if(!text)return false;
 warFrontChatSent.add(key);
 if(warFrontChatSent.size>256)warFrontChatSent.clear();
 const systems=[...new Set((Array.isArray(systemIDs)?systemIDs:[]).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
 let sent=0;
 try{
  const native=require("./runtime"),chat=require("../services/chat/chatHub");
  for(const systemID of systems){
   const scene=native.scenes instanceof Map?native.scenes.get(systemID):null;
   for(const session of scene?.sessions?.values?.()||[]){
    if(session?._space?.initialStateSent!==true||!session.characterID)continue;
    try{chat.sendSystemMessage(session,text);sent++;}catch(_error){/* one bad socket never stops the report */}
   }
  }
 }catch(_error){/* a missing chat hub must not break the war phase */}
 try{
  require("./coopRuntimeProbe").observe("living-war-front-report",null,null,{
   kind,text,systems,sessions:sent,evidence:"REAL_TRANSITION_ONCE_PER_EVENT"});
 }catch(_error){/* probe is best effort */}
 return true;
}
// FW-005B/C: the war chest is real money only. A faction's bounty is funded from
// the earned ISK its own pilots really hold, escrowed in its native corporation
// wallet, reserved BEFORE the campaign exists, and paid out of that HELD escrow.

// FW-094 (measured 2026-10-29): the both-sides rule funds a side and then refuses the
// border because the OTHER side cannot pay, so that escrow belongs to a campaign that
// was never created. `coopWarTreasury` already has exactly that escape hatch (it
// accepts a REFUND with an `unfunded:` proof when no campaign exists), but this
// authority only ever authorised TERMINAL campaigns, so it vetoed the hatch and the
// money stayed HELD forever. Measured on the work stack: `war:500011-500020:...:r7`
// reserved 5 000 ISK from 1000138 and released it as
// WAR_TREASURY_REFUND_NOT_AUTHORIZED, on top of two older orphan HELD rows of the
// same corporation - a faction's real income drained by openings that never existed.
function warRefundAuthorization({war,campaign,proofID}={}){
 const proof=String(proofID||"");
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(proof))return false;
 const terminal=(war&&war.state==="ENDED")||
  ["CANCELLED","EXPIRED","OCCUPIED"].includes(String(campaign&&campaign.state||""));
 if(terminal)return true;
 // No campaign record at all: nothing can ever spend this escrow. The proof string
 // must still be the explicit aborted-opening one, so a normal refund cannot use it.
 return !campaign&&/^unfunded:/.test(proof);
}

function warTreasuryStore(){
 if(warTreasuryInstance)return warTreasuryInstance;
 const gameStore=require("../gameStore"),
  factions=require("../services/faction/factionState"),
  corporationState=require("../services/corporation/corporationState");
 warTreasuryInstance=require("./coopWarTreasuryNative").createNativeWarTreasury({
  gameStore,corporationState,factionState:factions,
  // FW-053: a refund may only return escrow that no campaign can ever spend again.
  authorizeRefund:warRefundAuthorization,
  authorizePayout({factionID,pilotID,campaign}){
   // The payer must be a real member of the faction that owns this escrow, and
   // the campaign must be a real campaign of that war. The event proof itself
   // (a strictly proven native kill or casualty) is checked by the caller.
   // FW-125 (measured 2026-10-31): a co-op war pilot is a STRING ("coop-pilot-060"),
   // so Number.isSafeInteger(pilotID) was false for every real native kill and every
   // bounty answered WAR_TREASURY_PAYOUT_NOT_AUTHORIZED while its escrow sat HELD.
   // The shared war-pilot predicate is the same one the merit ledger already uses.
   if(!isWarPilotRef(pilotID)||!campaign)return false;
   const faction=warPilotFaction(pilotID);
   return Number.isSafeInteger(faction)&&faction===Number(factionID);
  }
 });
 return warTreasuryInstance;
}

// FW-125: one predicate for "this is a real war participant", shared with the merit
// ledger, so a named co-op pilot is never mistaken for an invalid id.
function isWarPilotRef(value){
 // A numeric id was accepted before FW-125 and stays accepted: a mercenary settlement
 // names one. A named co-op pilot is the case that was missing.
 if(Number.isSafeInteger(Number(value))&&Number(value)>0)return true;
 try{return require("./coopWarPilotID"+siblingSuffix).isWarPilotID(value)===true}
 catch(_error){return false}
}
function warPilotFaction(pilotID){
 if(!identityRegistry)return 0;
 const npcStore=require("./npc/nativeNpcStore"),
  factions=require("../services/faction/factionState");
 for(const link of Object.values(identityRegistry.snapshot()?.links||{})){
  if(link?.pilotID!==pilotID)continue;
  try{
   const native=npcStore.getNativeEntity(Number(link.entityID));
   const faction=Number(factions.getFactionIDForCorporation(native?.corporationID));
   if(Number.isSafeInteger(faction)&&faction>0)return faction;
  }catch(_error){/* one bad link never decides a faction */}
 }
 // FW-125: the identity link is released with the confirmed wreck, but the war fleet
 // registry row is the SAME proven assignment and keeps the faction it was mobilised
 // for - so a pilot is still a member when its payout is decided after the kill.
 try{
  const rows=nativeWarFleetRegistry()?.snapshot?.()?.ships||{};
  const row=Object.values(rows).find(r=>String(r&&r.pilotID)===String(pilotID));
  const faction=Number(row&&row.factionID);
  if(Number.isSafeInteger(faction)&&faction>0)return faction;
 }catch(_error){/* a missing registry is simply no faction */}
 // FW-137 (measured 16:58:14Z): the registry row is released WITH the wreck, so a fallen
 // pilot had no faction left anywhere and its own death benefit answered
 // WAR_TREASURY_PAYOUT_NOT_AUTHORIZED although the casualty ledger held the very same
 // pilot with its victimFactionID. The persisted casualty record is the last authority
 // that still says which faction this pilot died for.
 try{
  const cas=require("./coopWarCasualtyLedger"),
   row=require("./coopNativeRowPath").readRow(require("../gameStore"),
    cas.TABLE,cas.KEY,cas.validate);
  const hit=Object.values((row&&row.byWreck)||{})
   .find(e=>String(e&&e.pilotID)===String(pilotID));
  const faction=Number(hit&&hit.victimFactionID);
  if(Number.isSafeInteger(faction)&&faction>0)return faction;
 }catch(_error){/* a missing ledger is simply no faction */}
 return 0;
}

// FW-049: a war presence is a PHYSICAL fleet, so it must be read from the hull.
//
// Measured 20:29-20:34Z: the 500011 Angels spawned in 30003836 kept disappearing
// from `war_state.presence` while their native hulls were still alive there,
// because the link's `systemID` follows the VIRTUAL pilot and the virtual world
// keeps advancing that pilot along its route (x5). Ownership, fronts and target
// selection therefore flickered every few minutes and no border stayed open long
// enough to open a campaign. The native entity record knows where the hull really
// is, and a link whose native record is gone is a dead ship, not a presence.
// Links with no native record AND no readable position are skipped, never guessed.
function projectWarPresence(links,{getNativeEntity,getFactionForCorporation}={}){
 const out=[];
 if(typeof getNativeEntity!=="function"||
  typeof getFactionForCorporation!=="function")return out;
 for(const link of Array.isArray(links)?links:Object.values(links||{})){
  try{
   const entityID=Number(link&&link.entityID);
   const native=entityID>0?getNativeEntity(entityID):null;
   if(!native)continue; // the hull is gone: it is not a presence
   const faction=Number(getFactionForCorporation(native.corporationID));
   if(!Number.isSafeInteger(faction)||faction<=0)continue;
   const physical=Number(native.systemID);
   const systemID=Number.isSafeInteger(physical)&&physical>0?physical:
    (Number(link&&link.systemID)||0);
   if(!systemID)continue;
   out.push({pilotID:link.pilotID,systemID,factionID:faction,
    corporationID:Number(native.corporationID)||0,
    role:String(link.role||""),
    linkSystemID:Number(link.systemID)||0,
    positionDrifted:Number(link.systemID)!==systemID});
  }catch(_error){/* one bad link never decides a presence */}
 }
 return out;
}
function warPresencePilots(){
 if(!identityRegistry)return [];
 const npcStore=require("./npc/nativeNpcStore"),
  factions=require("../services/faction/factionState");
 return projectWarPresence(Object.values(identityRegistry.snapshot()?.links||{}),{
  getNativeEntity:id=>npcStore.getNativeEntity(Number(id)),
  getFactionForCorporation:corp=>factions.getFactionIDForCorporation(corp)});
}
// The real NPC corporation a faction fields. A faction with earned income in
// one of its corporations funds its chest from that corporation's wallet.

function warFactionCorporation(factionID,pilots,ledger){
 const balances=(ledger&&ledger.pilots)||{},counts=new Map();
 for(const pilot of pilots||[]){
  if(Number(pilot?.factionID)!==Number(factionID))continue;
  const corp=Number(pilot.corporationID)||0;
  if(!Number.isSafeInteger(corp)||corp<=0)continue;
  const paid=Number(balances[pilot.pilotID]?.balance)>0?1:0;
  const prior=counts.get(corp)||{corp,paid:0,ships:0};
  counts.set(corp,{corp,paid:prior.paid+paid,ships:prior.ships+1});
 }
 const ranked=[...counts.values()].sort((a,b)=>b.paid-a.paid||b.ships-a.ships||a.corp-b.corp);
 if(ranked.length)return ranked[0].corp;
 try{
  return Number(require("../services/faction/factionState")
   .getFactionRecord(factionID)?.militiaCorporationID)||0;
 }catch(_error){return 0}
}

// FW-093: which of a faction's OWN corporations actually pays. Pure decision, so
// the money rule is provable without a world: the richest corporation that really
// holds the bounty is used, the historical corporation is kept when nothing can
// pay (so a refusal still names the same one), and an unreadable balance is never
// treated as money.
function pickFundingCorporation({ordered=[],needCents=0,readBalance=null}={}){
 const needISK=Math.max(0,Number(needCents)||0)/100;
 const list=(Array.isArray(ordered)?ordered:[]).map(n=>Number(n))
  .filter(id=>Number.isSafeInteger(id)&&id>0);
 const balanceOf=(id)=>{
  if(typeof readBalance!=="function")return null;
  try{const value=readBalance(id);return Number.isFinite(value)?Number(value):null}
  catch(_error){return null}
 };
 const payable=[];
 for(const corporationID of list){
  const walletISK=balanceOf(corporationID);
  if(walletISK!==null&&walletISK>=needISK)payable.push({corporationID,walletISK});
 }
 payable.sort((a,b)=>b.walletISK-a.walletISK||a.corporationID-b.corporationID);
 if(payable.length)return {...payable[0],candidates:list.length,
  fallback:payable[0].corporationID!==list[0]};
 return {corporationID:list[0]||0,
  walletISK:list.length?balanceOf(list[0]):null,candidates:list.length,fallback:false};
}

function presenceSummary(){
 try{
  const opening=require("./coopFactionWarOpening");
  const factions=require("../services/faction/factionState");
  const nativeStore=require("./npc/nativeNpcStore");
  const links=Object.values(identityRegistry?.snapshot().links||{});
  const systems=new Map();
  const skipped=[];
  for(const link of links){
   const systemID=Number(link?.systemID)||0;
   const entityID=Number(link?.entityID)||0;
   if(!(systemID>0)||!(entityID>0))continue;
   const native=nativeStore.getNativeEntity(entityID);
   const faction=Number(factions.getFactionIDForCorporation(native?.corporationID))||0;
   const row=systems.get(systemID)||{systemID,linked:0,resolved:0,factions:{},skipped:0};
   row.linked+=1;
   if(!native){row.skipped+=1;skipped.push({entityID,reason:"NO_NATIVE_ENTITY"});}
   else if(Number(native.systemID)!==systemID){
    row.skipped+=1;
    skipped.push({entityID,reason:"LINK_NATIVE_SYSTEM_MISMATCH",
     linkSystemID:systemID,nativeSystemID:Number(native.systemID)||0});
   }else if(!(faction>0)){
    row.skipped+=1;
    skipped.push({entityID,reason:"NO_FACTION_FOR_CORPORATION",
     corporationID:Number(native.corporationID)||0});
   }else{
    row.resolved+=1;
    const key=String(faction);
    row.factions[key]=(row.factions[key]||0)+1;
   }
   systems.set(systemID,row);
  }
  return {systems:Array.from(systems.values()).sort((a,b)=>a.systemID-b.systemID),
   skipped:skipped.slice(0,8),minShips:1,
   note:"TERRITORIES_NEED_AT_LEAST_ONE_RESOLVED_PILOT_PER_SYSTEM"};
 }catch(error){
  return {status:"PRESENCE_UNAVAILABLE",
   reason:String(error&&error.message||error).slice(0,120)};
 }
}

function advanceNativeAmmoBankRecovery(){
 const env=process.env;
 if(env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE!=="1"||
  env.EVEJS_COOP_NPC_BANK_ATOMIC!=="1"||
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")return;
 const api=require("./coopNpcAmmoBankAtomic");
 const root=env.EVEJS_COOP_NPC_AMMO_DEBIT_ROOT||"/var/lib/evejs/coop-npc-ammo-debits";
 const listed=api.listJournals({root});
 if(listed.status!=="OBSERVED"||!listed.entityIDs.length)return;
 const atomicRows=require("../gameStore").coopAtomicNativeRows;
 const rows=require("./coopNativeRowPath");
 const gameStore=require("../gameStore");
 const readFence=id=>rows.readRow(gameStore,"npcCargo","coopAmmoCycles_"+String(id));
 const recovered=[],blocked=[];
 for(const entityID of listed.entityIDs.slice(0,8)){
  if(api.inspectShip({root,entityID}).status==="COMMITTED")continue;
  const result=api.recoverUncommitted({root,entityID,atomicRows,readFence});
  if(result.status==="ABORTED")recovered.push(result);
  else if(result.status!=="NOTHING_TO_RECOVER")
   blocked.push({entityID,status:String(result.status||""),
    reason:String(result.reason||"")}); }
 if(recovered.length||blocked.length)
  require("./coopRuntimeProbe").observe("living-native-ammo-bank-recovered",
   null,null,{status:recovered.length?"RECOVERED":"BLOCKED",recovered,blocked,
    evidence:"NO_COMMITTED_SQLITE_FENCE_PROVES_UNDEBITED_CHARGE"});
}
// FW-007B: recover/audit native military handoff BEFORE the materializer
// may prune old pilot links or rebuild another physical hull.

function ensureWarRecoverySocket(){
 if(process.env.EVEJS_COOP_WAR_RECOVERY_SOCKET!=="1")return;
 if(warRecoverySocket)return;
 if(process.env.EVEJS_COOP_WAR_RECOVERY_ADMIN!=="1")
  throw Error("WAR_RECOVERY_ADMIN_FLAG_REQUIRED");
 const instance=require("./coopWarRecoverySocket").createWarRecoverySocket({
  createConsole:({authorizeOperator})=>
   createWarRecoveryAdmin({authorizeOperator}),
  socketPath:process.env.EVEJS_COOP_WAR_RECOVERY_SOCKET_PATH||
   "/run/evejs/coop-war-recovery.sock",
  secretFile:process.env.EVEJS_COOP_WAR_RECOVERY_SECRET_FILE||
   "/run/secrets/evejs-war-recovery-key"
 });
 const result=instance.start();
 if(result.status!=="LISTENING_INITIATED")
  throw Error("WAR_RECOVERY_SOCKET_NOT_LISTENING:"+result.status);
 warRecoverySocket=instance;
}

function diagnoseNativeRaids({systemID}={}){
 const id=Number(systemID)||0;
 if(!(id>0))return {status:"SYSTEM_ID_REQUIRED"};
 let spaceRuntime=null,controllers=null,mining=null,scene=null;
 try{
  spaceRuntime=require("./runtime");
  controllers=require("./npc/npcRegistry");
  mining=require("../services/mining/miningNpcOperations");
  scene=spaceRuntime.ensureScene(id,{refreshStargates:false});
 }catch(error){return {status:"SCENE_MISSING",systemID:id,
  reason:String(error&&error.message||error).slice(0,80)};}
 if(!scene?.getEntityByID)return {status:"SCENE_MISSING",systemID:id};
 const links=Object.values(identityRegistry?.snapshot().links||{})
  .filter(link=>Number(link.systemID)===id&&scene.getEntityByID(Number(link.entityID)));
 const roleCounts={};
 for(const link of links)roleCounts[String(link.role||"")]=
  (roleCounts[String(link.role||"")]||0)+1;
 const delivering=lootCommerce?.activeIDs(id)||new Set();
 const outOfAmmo=nativeAmmoSupply?.activeIDs(id)||new Set();
 const pirates=links.filter(link=>link.role==="pirate")
  .map(link=>Number(link.entityID));
 let fleetShips=[];
 try{fleetShips=require("./coopNativeRaidEligibility")
  .liveFleetShips(mining.getMiningFleetsForSystem(id),scene)||[]}catch(_error){fleetShips=[]}
 const gap=(a,b)=>(a&&b&&["x","y","z"].every(k=>
  Number.isFinite(Number(a[k]))&&Number.isFinite(Number(b[k]))))?
  Math.hypot(a.x-Number(b.x),a.y-Number(b.y),a.z-Number(b.z)):null;
 let gunRangeModule=nativeGunRange;
 const pirateDetail=pirates.map(pirateID=>{
  const ship=scene.getEntityByID(pirateID);
  const ctrl=controllers.getControllerByEntityID(pirateID);
  let gun=null;
  try{
   if(!gunRangeModule)gunRangeModule=require("./coopNpcGunRange");
   gun=gunRangeModule.shared().rangeOf(ship);
  }catch(error){gun={status:"THREW",reason:String(error&&error.message||error).slice(0,80)}}
  const nearest=fleetShips.map(target=>{
   const targetShip=scene.getEntityByID(Number(target.id));
   return {id:Number(target.id),role:String(target.role||""),
    distanceMeters:gap(ship?.position,targetShip?.position)};
  }).filter(x=>x.distanceMeters!==null)
   .sort((a,b)=>a.distanceMeters-b.distanceMeters).slice(0,3);
  return {entityID:pirateID,mode:String(ship?.mode||""),
   excludedBy:delivering.has(pirateID)?"LOOT_DELIVERY":
    (outOfAmmo.has(pirateID)?"AMMO_SUPPLY":""),
   currentTargetID:Number(ctrl?.currentTargetID)||0,
   manualType:String(ctrl?.manualOrder?.type||""),
   manualTargetID:Number(ctrl?.manualOrder?.targetID)||0,
   returningHome:ctrl?.returningHome===true,
   leashRangeMeters:Number(ctrl?.behaviorProfile?.leashRangeMeters)||0,
   orbitOverrideMeters:Number(ctrl?.behaviorOverrides?.orbitDistanceMeters)||0,
   homeDistanceMeters:gap(ship?.position,ctrl?.homePosition),
   gunRangeMeters:Number(gun&&gun.meters)||0,
   gunRangeStatus:String(gun&&gun.status||""),
   nearest};
 });
 return {status:"OK",systemID:id,linkedShips:links.length,roleCounts,
  pirates:pirates.length,fleetShips:fleetShips.length,
  excluded:{lootDelivery:Array.from(delivering),ammoSupply:Array.from(outOfAmmo)},
  leases:(raidDirector?.snapshot?.()||[]).filter(lease=>
   Number(String(lease.id||"").split(":")[0])===id),
  pirateDetail,evidence:"READ_ONLY_RAID_DIRECTOR_VIEW"};
}

function npcRealPoints(scene){
 const points=require("./coopNpcTopology").waypoints(scene);
 return {gateCount:points.filter(p=>p.kind==="stargate").length,
  beltCount:points.filter(p=>p.kind==="asteroidBelt").length,
  stationCount:points.filter(p=>p.kind==="station").length};
}
// EX-02/03. Exactly one new phase in the EXISTING 30s A-Life tick; never
// enumerate private bookmarks, spawn sites, or derive NPC knowledge from the
// full native signature catalog without a physical on-grid witness.

function syncNativeDeliveries(){
 if(!economy||process.env.EVEJS_COOP_NATIVE_HAUL_CARGO!=="1")return;
 const depot=require("./coopNativeDepot").getNativeDepot();
 const audit=depot.audit();
 if(audit.status==="NEEDS_OPERATOR_REPAIR"){
  require("./coopRuntimeProbe").observe("living-native-depot-repair-needed",null,null,
   {status:audit.status,invalid:audit.invalid,unresolved:audit.unresolved});
  return;
 }
 if(audit.status==="PENDING_CUSTODY_RECONCILIATION")
  require("./coopRuntimeProbe").observe("living-native-depot-pending",null,null,
   {status:audit.status,unresolved:audit.unresolved});
 const result=economy.syncNativeDeliveries(depot.snapshot().totals);
 if(result.quantity>0){
  console.info("[CoopLivingWorld] Real NPC ore delivered to virtual system supply",JSON.stringify(result));
  require("./coopRuntimeProbe").observe("living-real-ore-delivery",null,null,{
    quantity:result.quantity,systemTotals:depot.snapshot().totals
  });
 }
}

function hasPhysicalWreckClaim(){
 try{
  const runtime=require("./runtime"),
   journal=require("./coopNpcWreckClaims").getWreckClaims();
  for(const systemID of visitedSystems){
   const scene=runtime.scenes instanceof Map?runtime.scenes.get(systemID):null;
   if(!scene||typeof scene.getEntityByID!=="function")continue;
   for(const claim of journal.active(systemID)){
    const wreckID=Number(claim.wreckID)||0;
    if(wreckID>0&&scene.getEntityByID(wreckID)?.nativeNpcWreck===true)return true;
   }
  }
 }catch(_error){/* an unreadable journal simply means no claim-driven work */}
 return false;
}
// Rapid bounded bootstrap attempts, then bounded low-frequency rechecks.
// A temporarily absent EveJS static-data store must not permanently disable
// autonomous NPCs until the next server restart.

function nextHeadlessRetryMs(attempts){
 const count=Math.max(1,Number(attempts)||1);
 if(count<6)return 30000;
 if(count<12)return 5*60000;
 if(count<18)return 10*60000;
 return 15*60000;
}

function isHeadlessNativeReady({miningEnabled=true,physicalNpcCount=0,
 beltCount=0,physicalMiningShips=0,waypointCount=0,sdeBeltCount=null,
 startupSlotsReady=true}={}){
 // A beltless solar system is legitimately not mineable. Require mining
 // fleet/physical belts only when the authoritative SDE says the *system*
 // has mining belts. Never invent a Jita belt or treat it as corrupt data.
 const hasSdeEvidence=Number.isSafeInteger(sdeBeltCount)&&sdeBeltCount>=0;
 const miningRequired=miningEnabled&&(!hasSdeEvidence||sdeBeltCount>0);
 return physicalNpcCount>0&&waypointCount>0&&
  (!miningRequired||(beltCount>0&&physicalMiningShips>0&&startupSlotsReady===true));
}
// Initialize real EveJS scenes without waiting for a human to log in.
// This is not a client/gameplay proof: only existing native entities count.

function ensureNativeGateTransfer(runtime){
 if(process.env.EVEJS_COOP_NATIVE_GATE_APPROACH!=="1"||
  process.env.EVEJS_COOP_NATIVE_GATE_TRANSFER!=="1"||
  nativeGateTransfer)return;
 if(!identityRegistry)throw Error("NATIVE_GATE_TRANSFER_IDENTITY_UNAVAILABLE");
 const worldData=require("./worldData"),controllers=require("./npc/npcRegistry");
 const store=require("./npc/nativeNpcStore");
 const service=require("./npc/nativeNpcService");
 const scrambled=require("./modules/hostileModuleRuntime");
 const prepared=require("./coopNativeGateTransfer").createNativeGateTransfer({
  sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  getGate:id=>worldData.getStargateByID(id),
  store,service,getController:id=>controllers.getControllerByEntityID(id),
  registry:identityRegistry,isScrambled:ship=>scrambled.isEntityWarpScrambled(ship)
 });
 // Must run BEFORE bridge.reconcile() invokes registry.prune(); otherwise
 // an interrupted in-transit ship can lose its durable pilot link.
 const recovered=prepared.recoverPending();
 if(recovered.status==="NEEDS_OPERATOR_REPAIR")
  throw Error("NATIVE_GATE_TRANSFER_REPAIR_REQUIRED: "+JSON.stringify(recovered.pending).slice(0,240));
 if(recovered.recovered)
  require("./coopRuntimeProbe").observe("living-native-gate-recovery",null,null,recovered);
 nativeGateTransfer=prepared;
}

function observeNativeAmmoConsumption(){
 if(process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  !identityRegistry||!visitedSystems.size)return;
 const runtime=require("./runtime"),store=require("./npc/nativeNpcStore");
 if(!nativeAmmoWitness)nativeAmmoWitness=
  require("./coopNpcAmmoWitness").createAmmoWitness({store});
 const assignments=Object.values(identityRegistry.snapshot().links||{});
 for(const systemID of visitedSystems){
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  const result=nativeAmmoWitness.sample({scene,assignments});
  if(result.events.length)
   require("./coopRuntimeProbe").observe("living-native-npc-ammo-debit",null,
    {spaceState:{systemID}},{events:result.events,
     status:"NATIVE_CARGO_DELTA_ONLY_NOT_AUTHORED_SHOT"});
 }
}
// Source-verified native kill -> real surviving wreck -> same killer ship.
// Stage J: one opt-in native competing salvage step on the EXISTING 30s
// A-Life tick. Uses existing named NPC hulls, actual native movements and
// one atomic original cargo debit; never spawns a rival or mints a stack.

const wreckRecoveryNotes=new Map();

function lockedTargets(scene,ship){
 try{return (scene?.getTargetsForEntity?.(ship)||[]).map(Number).slice(0,6);}
 catch(error){return "UNAVAILABLE";}
}

function npcModuleSummary(ship){
 try{
  const equipment=require("./npc/npcEquipment");
  const runtime=require("../services/mining/miningRuntime");
  const fitting=require("../services/fitting/liveFittingState");
  const items=equipment.getNpcFittedModuleItems(ship)||[];
  return items.slice(0,10).map(item=>{
   let miningEffects=0;
   try{
    miningEffects=(fitting.getTypeEffectRecords(Number(item?.typeID)||0)||[])
     .filter(effect=>{try{return runtime.isMiningEffectRecord(effect,item);}catch(_error){return false;}}).length;
   }catch(_error){miningEffects=-1;}
   const online=typeof fitting.isModuleOnline==="function"?fitting.isModuleOnline(item):null;
   return {typeID:Number(item?.typeID)||0,miningEffects,
    online,flagID:Number(item?.flagID)||0,
    // Does the native runtime really hold this module in an active cycle?
    active:ship?.activeModuleEffects instanceof Map?
     Boolean(ship.activeModuleEffects.get(Number(item?.itemID)||0)):null,
    activeTarget:ship?.activeModuleEffects instanceof Map?
     Number(ship.activeModuleEffects.get(Number(item?.itemID)||0)?.targetID)||0:0,
    capacitor:Number.isFinite(ship?.capacitorCharge)?Math.round(ship.capacitorCharge):null,
    hasState:Boolean(item?.moduleState&&typeof item.moduleState==="object"),
    hasExplicit:typeof fitting.hasExplicitModuleOnlineState==="function"?
     fitting.hasExplicitModuleOnlineState(item):null};
  });
 }catch(error){return "UNAVAILABLE:"+String(error?.message||error).slice(0,40);}
}

function distanceBetween(left,right){
 if(!left||!right)return null;
 const keys=["x","y","z"];
 if(!keys.every(key=>Number.isFinite(left[key])&&Number.isFinite(right[key])))return null;
 return Math.round(Math.hypot(left.x-right.x,left.y-right.y,left.z-right.z));
}

function nearestBeltMeters(scene,position){
 if(!position)return null;
 let nearest=null;
 for(const entity of scene?.staticEntities||[]){
  if(entity?.kind!=="asteroidBelt"||!entity.position)continue;
  const meters=distanceBetween(position,entity.position);
  if(meters===null)continue;
  if(nearest===null||meters<nearest)nearest=meters;
 }
 return nearest;
}

function mineableSummary(scene,entityID){
 try{
  const state=require("../services/mining/miningRuntimeState").getMineableState(scene,entityID);
  if(!state)return null;
  return {yieldTypeID:Number(state.yieldTypeID)||0,
   remaining:Number(state.remainingQuantity)||0,
   unitVolume:Number(state.unitVolume)||0,
   updatedAtMs:Number(state.updatedAtMs)||0};
 }catch(error){return "UNAVAILABLE:"+String(error?.message||error).slice(0,40);}
}

function mineableBeltSummary(scene){
 try{
  const state=require("../services/mining/miningRuntimeState");
  const entities=(scene?.staticEntities||[]).filter(entity=>{
   try{return state.isMineableStaticEntity(entity);}catch(_error){return false;}
  });
  let withOre=0,totalRemaining=0;
  for(const entity of entities.slice(0,400)){
   const mineable=state.getMineableState(scene,Number(entity.itemID)||0);
   const remaining=Number(mineable?.remainingQuantity)||0;
   if(remaining>0){withOre++;totalRemaining+=remaining;}
  }
  return {entities:entities.length,withOre,totalRemaining};
 }catch(error){return "UNAVAILABLE:"+String(error?.message||error).slice(0,40);}
}

function miningShipDetail(systemID,fleet){
 try{
  const scene=require("./runtime").ensureScene(systemID,{refreshStargates:false});
  const rocks=[];
  const rockForShips=scene?.getEntityByID?.(Number(fleet?.activeAsteroidID));
  const rockPosition=rockForShips?.position||null;
  const ships=[...(fleet?.minerEntityIDs||[]),...(fleet?.haulerEntityIDs||[])].map(id=>{
   const ship=scene?.getEntityByID?.(Number(id));
   if(!ship)return {id:Number(id)||0,missing:true};
   return {id:Number(id)||0,mode:String(ship.mode||""),
     // Measured 2026-10-27: a hauler sat in mode FOLLOW with speedFraction 1 and a
     // FROZEN gap for dozens of attempts. `inDynamic` answers whether the scene
     // movement loop can even see the hull; advancedAgoMs whether it was advanced.
     inDynamic:Boolean(scene?.dynamicEntities?.has?.(Number(id))),
     advancedAgoMs:ship._lastMovementAdvancedAtMs?Math.max(0,Date.now()-Number(ship._lastMovementAdvancedAtMs)):null,
     maxVelocity:Number(ship.maxVelocity)||0,
    target:Number(ship.targetID)||0,stacks:(ship.nativeCargoItems||[]).length,
    quantity:(ship.nativeCargoItems||[]).reduce((sum,item)=>sum+Math.max(0,Number(item.quantity)||0),0),
    toRockMeters:distanceBetween(ship.position,rockPosition),
    toBeltMeters:nearestBeltMeters(scene,ship.position),
    targets:lockedTargets(scene,ship),
    // Mining only starts when the hull really carries online mining modules.
    modules:npcModuleSummary(ship)};
  });
  const rock=scene?.getEntityByID?.(Number(fleet?.activeAsteroidID));
  if(rock)rocks.push({id:Number(rock.itemID)||0,typeID:Number(rock.typeID)||0,
   quantity:Number(rock.quantity ?? rock.remainingQuantity ?? rock.oreQuantity)||0,
   radius:Number(rock.radius)||0,
   mineable:mineableSummary(scene,Number(rock.itemID)||0)});
  const belt=mineableBeltSummary(scene);
  return {ships,rocks,belt};
 }catch(error){return {error:String(error?.message||error).slice(0,80)};}
}

function observeEconomyOre(){
 if(!visitedSystems.size)return;
 const arrival=require("./coopNativeStationArrival");
 for(const systemID of [...visitedSystems].sort((a,b)=>a-b).slice(0,4))
  arrival.observePreferredOre({systemID,reason:"periodic"});
 // Same process, same second: the real native mining records. Without this a
 // stalled haul looks exactly like a fleet that is simply still mining.
 try{
  const mining=require("../services/mining/miningNpcOperations");
  const probe=require("./coopRuntimeProbe");
  for(const systemID of [...visitedSystems].sort((a,b)=>a-b).slice(0,4)){
   const fleets=mining.getMiningFleetsForSystem(systemID)||[];
   if(!fleets.length)continue;
   probe.observe("living-mining-fleet-state",null,{spaceState:{systemID}},{
    systemID,fleets:fleets.slice(0,6).map(fleet=>({
     fleetID:Number(fleet?.fleetID)||0,state:String(fleet?.state||""),
     miners:(fleet?.minerEntityIDs||[]).length,haulers:(fleet?.haulerEntityIDs||[]).length,
     activeAsteroidID:Number(fleet?.activeAsteroidID)||0,
     loadedUntilMs:Number(fleet?.loadedUntilMs)||0,
     lastHauledVolumeM3:Number(fleet?.lastHauledVolumeM3)||0,
     stationID:Number(fleet?.coopStationArrival?.stationID)||0,
     noCargo:fleet?.coopStationNoCargo===true,
     nextThinkAtMs:Number(fleet?.nextThinkAtMs)||0,now:Date.now(),
     // Where mining really stops: an empty miner, a dead rock or a spent module.
     shipDetail:miningShipDetail(systemID,fleet)
    }))
   });
  }
 }catch(error){console.warn("[CoopEconomyDestination] fleet state",error.message);}
}

// The order in the env list IS the priority: one arrival is bounded to 20 settlements,
// so the goods that matter must be asked for first, and the cap is what keeps that bound.
// Measured 2026-10-28: a manufactured product appended as the 44th type was silently
// dropped by the slice, so the arrival sale never asked the market for the one good the
// station really bids for - the chipsets rode along unsold through a full ore haul.
function nativeMarketAllowlist(name){
 return [...new Set(String(process.env[name]||"").split(",").map(Number)
  .filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,20);
}
// How the merchant prices its own stock: the best real bid first, then small
// steps down every few minutes while nothing sells. Pure policy; the guarded
// native trader still owns every mutation (order fill, cargo, ledger).

function nativeWarpPoint(){
 if(!warpPointDirector)warpPointDirector=require("./coopNpcWarpPoint").shared();
 return warpPointDirector;
}
// FW-018d: while the raid holds a lease it is the one owner of that hull's
// movement, and the stock leash is what aborts it. Measured live: a blaster
// cruiser with 300 real charges got an attack order 4.4 km from its prey, the
// prey's own retreat moved the fleet 2.5 AU, and the stock loop then found the
// hull beyond its 90 km leash, cleared the combat state and flew it home on every
// think (mode GOTO, returningHome true, manualType "", currentTargetID 0) - so the
// DPS never happened even though the gun range was finally right. The leash is a
// stock behaviour parameter, not an evidence gate: it is widened to cover exactly
// the approach the raid itself ordered, and it is restored to the profile's own
// value the moment the raid releases the hull. No damage, no distance of ours and
// no gate is invented or relaxed.

const raidLeashNotes=new Map();

function raidLeashWrite(pirateID,leashRangeMeters){
 const controllers=require("./npc/npcRegistry");
 const npcService=require("./npc/npcService");
 const ctrl=controllers.getControllerByEntityID(pirateID);
 if(!ctrl)return {status:"NPC_NOT_FOUND",entityID:pirateID};
 const existing=(ctrl.behaviorOverrides&&typeof ctrl.behaviorOverrides==="object")
  ?{...ctrl.behaviorOverrides}:{};
 const profileLeash=Math.max(0,Number(ctrl.behaviorProfile?.leashRangeMeters)||0);
 const next={...existing};
 if(leashRangeMeters===null)delete next.leashRangeMeters;
 else next.leashRangeMeters=Math.max(0,Math.round(leashRangeMeters));
 npcService.setBehaviorOverrides(pirateID,next);
 const applied=leashRangeMeters===null?null:(Number(next.leashRangeMeters)||0);
 return {status:"APPLIED",entityID:pirateID,leashRangeMeters:applied,
  restored:leashRangeMeters===null,profileLeashRangeMeters:profileLeash};
}

function raidLeashScope(pirateID,distanceMeters){
 const distance=Number(distanceMeters)||0;
 if(!(distance>0))return {status:"NO_DISTANCE",entityID:pirateID};
 // The leash is measured from the hull's OWN home, not from the hull: a raider
 // that already chased its prey 5.7 AU from home needs a leash that covers both
 // legs, otherwise the effective profile still reads "beyond leash" and the loop
 // clears the order it was just given (measured live: leash 149 182 m applied
 // while homeDistanceMeters was 862 066 008 895).
 let homeGap=0;
 try{
  const controllers=require("./npc/npcRegistry");
  const spaceRuntime=require("./runtime");
  const ctrl=controllers.getControllerByEntityID(pirateID);
  const scene=ctrl?spaceRuntime.ensureScene(Number(ctrl.systemID)||0,{refreshStargates:false}):null;
  const ship=scene?.getEntityByID?.(pirateID);
  const home=ctrl?.homePosition,position=ship?.position;
  if(home&&position&&["x","y","z"].every(k=>
   Number.isFinite(Number(home[k]))&&Number.isFinite(Number(position[k]))))
   homeGap=Math.hypot(position.x-Number(home.x),position.y-Number(home.y),
    position.z-Number(home.z));
 }catch(_error){homeGap=0;}
 let outcome;
 try{outcome=raidLeashWrite(pirateID,homeGap+distance+100000);}
 catch(error){return {status:"REFUSED",entityID:pirateID,
  reason:String(error&&error.message||error).slice(0,80)};}
 // Published once per changed value: the leash the hull really flies with.
 const key=pirateID+":"+outcome.leashRangeMeters;
 if(outcome.status==="APPLIED"&&raidLeashNotes.get(pirateID)!==key){
  raidLeashNotes.set(pirateID,key);
  try{
   require("./coopRuntimeProbe").observe("living-native-raid-leash",null,null,
    {...outcome,orderDistanceMeters:distance,
     reason:"RAID_LEASE_OWNS_MOVEMENT"});
  }catch(_error){/* a lost probe never blocks the order */}
 }
 return outcome;
}

function raidLeashRestore(pirateID){
 try{
  const outcome=raidLeashWrite(pirateID,null);
  if(raidLeashNotes.get(pirateID)!==pirateID+":restored"){
   raidLeashNotes.set(pirateID,pirateID+":restored");
   try{
    require("./coopRuntimeProbe").observe("living-native-raid-leash",null,null,
     {...outcome,reason:"LEASE_RELEASED_PROFILE_LEASH"});
   }catch(_error){/* ignore */}
  }
  return outcome;
 }catch(error){return {status:"REFUSED",entityID:pirateID,
  reason:String(error&&error.message||error).slice(0,80)};}
}

function advanceNativePveBossWreck(){
 if(process.env.EVEJS_COOP_PVE_NATIVE_BOSSES!=="1"||
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1"||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),dungeon=require("../services/dungeon/dungeonRuntime"),
  npc=require("./npc/npcRuntime"),ctrl=require("./npc/npcRegistry"),
  store=require("./npc/nativeNpcStore"),damage=require("./combat/damage");
 if(!(runtime.scenes instanceof Map))return;
 if(!pveNativeBossDirector)
  pveNativeBossDirector=require("./coopPveNativeBossDirector").createNativeBossDirector({
   getNativeEntity:id=>store.getNativeEntity(id),
   getController:id=>ctrl.getControllerByEntityID(id),
   resolveVerifiedPlayer:(scene,ship)=>
    require("./coopNativeConsequences").resolveVerifiedPlayerID(scene,ship),
   getHealth:ship=>{
    const max=damage.getEntityMaxHealthLayers(ship),
     hp=damage.getEntityCurrentHealthLayers(ship,max);
    if(!max||!hp||[max.shield,max.armor,max.structure].some(n=>Number(n)<=0))return null;
    return {shield:Number(hp.shield)/Number(max.shield),
     armor:Number(hp.armor)/Number(max.armor),
     structure:Number(hp.structure)/Number(max.structure)};
   },
   issueAttack:(id,targetID,options)=>npc.issueAttackOrder(id,targetID,options),
   listWrecks:()=>store.listNativeWrecks(),
   listWreckItems:id=>store.listNativeWreckItemsForWreck(id)
  });
 const reserved=new Set([...(bridge.snapshot()||[]),
  ...Object.values(identityRegistry?.snapshot()?.links||{})]
  .map(x=>Number(x.entityID)).filter(x=>Number.isSafeInteger(x)&&x>0));
 for(const systemID of [...visitedSystems].slice(0,12)){
  const scene=runtime.scenes.get(systemID);
  if(!scene||Number(scene.systemID)!==Number(systemID))continue;
  const excluded=new Set(reserved);
  for(const id of pveObjectiveDoctrineDirector?.activeIDs()||[])excluded.add(id);
  for(const lease of pveWaveReinforcementsDirector?.snapshot()||[])
   if(Number(lease.systemID)===Number(systemID)&&Number.isSafeInteger(lease.helperID))
    excluded.add(lease.helperID);
  for(const id of tacticsDirector?.activeIDs()||[])excluded.add(id);
  for(const lease of nativeOrderBridge?.snapshot()?.leases||[])
   if(Number(lease.systemID)===Number(systemID)&&
      ["ACTIVE","ISSUING","OUTCOME_UNKNOWN"].includes(lease.phase)&&
      Number.isSafeInteger(lease.entityID)&&lease.entityID>0)
    excluded.add(lease.entityID);
  if(excluded.size>1024)continue;
  const instances=dungeon.listActiveInstancesBySystem(systemID,{full:true});
  const output=pveNativeBossDirector.tick({systemID,scene,instances,
   excludedIDs:[...excluded]});
  for(const event of output.events)
   require("./coopObserve").observe(require("./coopRuntimeProbe"),
    "living-pve-native-boss-wreck",{systemID},{...event,
     evidence:"NATIVE_HP_OR_WRECK_SOURCE_OBSERVATION_NOT_NEW_LOOT_OR_PAYOUT"});
 }
}

function advanceNativePveObjectiveDoctrine(){
 if(process.env.EVEJS_COOP_PVE_OBJECTIVE_DOCTRINE!=="1"||
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1"||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),dungeon=require("../services/dungeon/dungeonRuntime"),
  npc=require("./npc/npcRuntime"),ctrl=require("./npc/npcRegistry"),
  nativeStore=require("./npc/nativeNpcStore"),
  damage=require("./combat/damage"),scramble=require("./modules/hostileModuleRuntime");
 if(!(runtime.scenes instanceof Map))return;
 if(!pveObjectiveDoctrineDirector)
  pveObjectiveDoctrineDirector=require("./coopPveObjectiveDoctrine").createObjectiveDoctrine({
   getNativeEntity:id=>nativeStore.getNativeEntity(id),
   getController:id=>ctrl.getControllerByEntityID(id),
   resolveVerifiedPlayer:(scene,ship)=>
    require("./coopNativeConsequences").resolveVerifiedPlayerID(scene,ship),
   getHealth:ship=>{
    const max=damage.getEntityMaxHealthLayers(ship),
     actual=damage.getEntityCurrentHealthLayers(ship,max);
    if(!max||!actual||Number(max.armor)<=0||Number(max.structure)<=0)return null;
    return {armor:Number(actual.armor)/Number(max.armor),
     structure:Number(actual.structure)/Number(max.structure)};
   },
   isScrambled:ship=>scramble.isEntityWarpScrambled(ship),
   getStructureHP:obj=>{
    const max=damage.getEntityMaxHealthLayers(obj),
     actual=damage.getEntityCurrentHealthLayers(obj,max);
    return Number(actual?.structure);
   },
   attack:(id,targetID,options)=>npc.issueAttackOrder(id,targetID,options),
   warpToPoint:(id,point,options)=>npc.warpToPoint(id,point,options),
   orbit:(id,targetID,distance,options)=>npc.orbit(id,targetID,distance,options)
  });
 const reserved=new Set([...(bridge.snapshot()||[]),
  ...Object.values(identityRegistry?.snapshot()?.links||{})]
  .map(x=>Number(x.entityID)).filter(x=>Number.isSafeInteger(x)&&x>0));
 for(const systemID of [...visitedSystems].slice(0,12)){
  const scene=runtime.scenes.get(systemID);
  if(!scene||Number(scene.systemID)!==Number(systemID))continue;
  const excluded=new Set(reserved);
  for(const lease of pveWaveReinforcementsDirector?.snapshot()||[])
   if(Number(lease.systemID)===Number(systemID)&&Number.isSafeInteger(lease.helperID))
    excluded.add(lease.helperID);
  for(const receipt of pveSiteDefenseDirector?.snapshot()||[]){
   const id=Number(String(receipt.key||"").split(":").pop());
   if(Number.isSafeInteger(id)&&id>0)excluded.add(id);
  }
  for(const id of tacticsDirector?.activeIDs()||[])excluded.add(id);
  for(const id of pveNativeBossDirector?.activeIDs()||[])excluded.add(id);
  // Do not override any native lease owned by the already shared A-Life
  // arbiter. This remains read-only; original owners keep order authority.
  for(const lease of nativeOrderBridge?.snapshot()?.leases||[])
   if(Number(lease.systemID)===Number(systemID)&&
      ["ACTIVE","ISSUING","OUTCOME_UNKNOWN"].includes(lease.phase)&&
      Number.isSafeInteger(lease.entityID)&&lease.entityID>0)
    excluded.add(lease.entityID);
  if(excluded.size>1024)continue;
  const instances=dungeon.listActiveInstancesBySystem(systemID,{full:true});
  const output=pveObjectiveDoctrineDirector.tick({
   systemID,scene,instances,excludedIDs:[...excluded],
   waypoints:require("./coopNpcTopology").waypoints(scene)
  });
  for(const event of output.events)
   require("./coopObserve").observe(require("./coopRuntimeProbe"),
    "living-pve-objective-doctrine",{systemID},{...event,
     evidence:"NATIVE_ATTACK_OR_MOVEMENT_ACK_NOT_DAMAGE_HIT_OR_MISSION_REWARD"});
 }
}

function advanceNativePveWaveReinforcements(){
 if(process.env.EVEJS_COOP_PVE_WAVE_REINFORCEMENTS!=="1"||
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1"||
    !bridge||!visitedSystems.size)return;
 const native=require("./runtime"),dungeon=require("../services/dungeon/dungeonRuntime"),
  npc=require("./npc/npcRuntime"),ctrl=require("./npc/npcRegistry"),
  nativeStore=require("./npc/nativeNpcStore");
 if(!(native.scenes instanceof Map))return;
 if(!pveWaveReinforcementsDirector)
  pveWaveReinforcementsDirector=require("./coopPveWaveReinforcements")
   .createWaveReinforcements({
    getNativeEntity:id=>nativeStore.getNativeEntity(id),
    getController:id=>ctrl.getControllerByEntityID(id),
    resolveVerifiedPlayer:(scene,ship)=>
     require("./coopNativeConsequences").resolveVerifiedPlayerID(scene,ship),
    warpToEntity:(npcID,targetID,options)=>npc.warpToEntity(npcID,targetID,options),
    attack:(npcID,targetID,options)=>npc.issueAttackOrder(npcID,targetID,options)
   });
 const reserved=new Set([...(bridge.snapshot()||[]),
  ...Object.values(identityRegistry?.snapshot()?.links||{})]
  .map(x=>Number(x.entityID)).filter(x=>Number.isSafeInteger(x)&&x>0));
 if(reserved.size>1024)return;
 for(const systemID of [...visitedSystems].slice(0,12)){
  const scene=native.scenes.get(systemID);
  if(!scene||Number(scene.systemID)!==Number(systemID))continue;
  const instances=dungeon.listActiveInstancesBySystem(systemID,{full:true});
  const excluded=new Set(reserved);
  for(const id of pveNativeBossDirector?.activeIDs()||[])excluded.add(id);
  for(const id of pveObjectiveDoctrineDirector?.activeIDs()||[])excluded.add(id);
  if(excluded.size>1024)continue;
  const output=pveWaveReinforcementsDirector.tick({
   systemID,scene,instances,excludedIDs:[...excluded]
  });
  for(const event of output.events)
   require("./coopObserve").observe(require("./coopRuntimeProbe"),
    "living-pve-native-wave-reinforcement",{systemID},{...event,
     evidence:"NATIVE_ORDER_ACK_NOT_SPAWN_DAMAGE_OR_REWARD_PROOF"});
 }
}

function advanceNativePveSiteDefense(){
 if(process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1"||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),dungeon=require("../services/dungeon/dungeonRuntime"),
  npc=require("./npc/npcRuntime"),controllers=require("./npc/npcRegistry"),
  nativeStore=require("./npc/nativeNpcStore");
 if(!(runtime.scenes instanceof Map))return;
 if(!pveSiteDefenseDirector){
  pveSiteDefenseDirector=require("./coopPveNativeSiteDefense").createDirector({
   getController:id=>controllers.getControllerByEntityID(id),
   getNativeEntity:id=>nativeStore.getNativeEntity(id),
   resolveVerifiedPlayer:(scene,ship)=>
    require("./coopNativeConsequences").resolveVerifiedPlayerID(scene,ship),
   issueAttack:(npcID,playerID,options)=>
    npc.issueAttackOrder(npcID,playerID,options)
  });
 }
 const reserved=new Set([...(bridge.snapshot()||[]),
  ...Object.values(identityRegistry?.snapshot()?.links||{})]
  .map(x=>Number(x.entityID)).filter(x=>Number.isSafeInteger(x)&&x>0));
 for(const systemID of [...visitedSystems].slice(0,12)){
  const scene=runtime.scenes.get(systemID);
  if(!scene||Number(scene.systemID)!==Number(systemID))continue;
  const instances=dungeon.listActiveInstancesBySystem(systemID,{full:true});
  // If ownership reservations exceed the bounded audit budget, fail closed.
  // A site warp lease retains custody of its physical hull across ticks.
  // Never let the closer-range site director preempt the warp/attack handoff.
  const waveLeases=pveWaveReinforcementsDirector?.snapshot()||[];
  const excluded=new Set(reserved);
  for(const id of pveNativeBossDirector?.activeIDs()||[])excluded.add(id);
  for(const lease of waveLeases)
   if(Number(lease.systemID)===Number(systemID)&&Number.isSafeInteger(lease.helperID)&&
      lease.helperID>0)excluded.add(lease.helperID);
  for(const id of pveObjectiveDoctrineDirector?.activeIDs()||[])excluded.add(id);
  if(excluded.size>1024)continue;
  const result=pveSiteDefenseDirector.tick({
   systemID,scene,instances,excludedIDs:[...excluded]
  });
  if(result.events.length)for(const event of result.events){
   require("./coopObserve").observe(require("./coopRuntimeProbe"),
    "living-pve-site-defense",{systemID},{...event,
     evidence:"NATIVE_ORDER_ACK_NOT_WEAPON_OR_DAMAGE_PROOF"});
  }
  if(result.status==="ORDER_JOURNAL_CAP_REACHED")
   console.warn("[CoopLivingWorld] PVE native order replay fence full");
 }
}

function advanceNpcRecognition(){
 if(process.env.EVEJS_COOP_NPC_MEMORY!=="1"||!identityRegistry||!visitedSystems.size)return;
 const runtime=require("./runtime");
 if(!recognitionAnnouncer){
  const {createRecognition}=require("./coopNpcRecognition");
  recognitionAnnouncer=createRecognition({
   lookup:query=>require("./coopNpcMemory").getNativeMemory().recall(query),
   send:(session,message)=>require("../services/chat/chatHub").sendSystemMessage(session,message)
  });
 }
 const links=Object.values(identityRegistry.snapshot().links||{});
 for(const systemID of visitedSystems){
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  if(!scene?.sessions?.values)continue;
  for(const session of scene.sessions.values()){
   const result=recognitionAnnouncer.tick({session,scene,links});
   if(result.status==="DELIVERED")require("./coopRuntimeProbe").observe(
    "living-npc-recognizes-player",session,null,result);
  }
 }
}

function confirmedWreck(session,ship,npcID,wreckID){
 if(!economy)return;
 try{
  if(!lossBridge){
   const {createLossBridge}=require("./coopNpcLossBridge");
   lossBridge=createLossBridge({
    file:process.env.EVEJS_COOP_LOSS_LEDGER_FILE||"/var/lib/evejs/coop-loss-ledger.json",
    recordLoss:(system,amount)=>economy.recordLoss(system,amount)
   });
  }
  const systemID=Number(ship?.spaceState?.systemID||session?._space?.systemID||session?.solarsystemid);
  const result=lossBridge.accept({systemID,npcID,wreckID});
  if(result.status==="COMMITTED"&&factionDirector){
    factionDirector.onLoss({
      eventID:"wreck:"+wreckID,
      faction:"independent",systemID
    });
  }
  require("./coopRuntimeProbe").observe("virtual-economy-npc-loss",session,ship,{npcID,wreckID,status:result.status});
 }catch(e){console.warn("[CoopVirtualWorld] loss",e.message);}
}

const arrivalSales=new Map();

const saleNotes=new Map();
// A sale that silently does not happen is indistinguishable from a bug, so every
// skip reason is reported once per hauler and reason per five minutes.

function noteSaleSkip(systemID,stationID,haulerID,reason){
 const key=String(systemID)+":"+String(haulerID)+":"+String(reason);
 const now=Date.now();
 if(now-(saleNotes.get(key)||0)<300000)return;
 saleNotes.set(key,now);
 try{
  require("./coopRuntimeProbe").observe("living-npc-sale-skipped",null,
   {spaceState:{systemID:Number(systemID)||0}},
   {stationID:Number(stationID)||0,haulerID:Number(haulerID)||0,
    reason:String(reason||"").slice(0,80)});
 }catch(_error){/* telemetry must never break a delivery */}
}

function createWarRecoveryAdmin({authorizeOperator}={}){
 if(process.env.EVEJS_COOP_WAR_RECOVERY_ADMIN!=="1")
  throw Error("WAR_RECOVERY_ADMIN_DISABLED");
 if(typeof authorizeOperator!=="function")
  throw Error("WAR_RECOVERY_AUTHORITY_MISSING");
 if(!warGateHandoff)throw Error("WAR_GATE_HANDOFF_NOT_INITIALIZED");
 return warGateHandoff.recovery({authorizeOperator});
}
// Read-only: an original native boss was observed alive and its single
// original wreck + initial item records were verified in this process.

function witnessedNativeBossWreck(wreckID){
 if(process.env.EVEJS_COOP_PVE_NATIVE_BOSSES!=="1"||
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1")return null;
 return pveNativeBossDirector?.witnessedWreck(Number(wreckID))||null;
}

function releaseSpawnedIdentity({pilotID,entityID=0,reason=""}={}){
 if(!identityRegistry)return {status:"IDENTITY_REGISTRY_UNAVAILABLE"};
 const pilotId=String(pilotID||"").trim();
 if(!pilotId)return {status:"PILOT_REQUIRED"};
 let released=null;
 try{
  released=identityRegistry.release(pilotId,
   Number(entityID)>0?{expectedEntityID:Number(entityID)}:{});
 }catch(error){
  return {status:"RELEASE_FAILED",reason:String(error?.message||error)};
 }
 if(released?.status!=="RELEASED")return released||{status:"NOT_RELEASED"};
 try{
  require("./coopNativeActivity"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
 }catch{}
 return {...released,reason:String(reason||"IDENTITY_REASSIGNED")};
}

module.exports = {projectWarPresence, pickFundingCorporation, warRefundAuthorization, bindWarRuntime, observedNpcIDs, visitedSystems, raidDiagnose, initializedNativeMiningScenes, destroyedNativeShips, wreckCustodyNotes, worldBootAtMs, courierPilotIDs, nativeWarFleetRegistry, warSkipReasons, warSkip, warFrontChatSent, siblingSuffix, warFrontChat, warTreasuryStore, warPilotFaction, warPresencePilots, warFactionCorporation, presenceSummary, advanceNativeAmmoBankRecovery, ensureWarRecoverySocket, diagnoseNativeRaids, npcRealPoints, syncNativeDeliveries, hasPhysicalWreckClaim, nextHeadlessRetryMs, isHeadlessNativeReady, ensureNativeGateTransfer, observeNativeAmmoConsumption, wreckRecoveryNotes, lockedTargets, npcModuleSummary, distanceBetween, nearestBeltMeters, mineableSummary, mineableBeltSummary, miningShipDetail, observeEconomyOre, nativeMarketAllowlist, nativeWarpPoint, raidLeashNotes, raidLeashWrite, raidLeashScope, raidLeashRestore, advanceNativePveBossWreck, advanceNativePveObjectiveDoctrine, advanceNativePveWaveReinforcements, advanceNativePveSiteDefense, advanceNpcRecognition, confirmedWreck, arrivalSales, saleNotes, noteSaleSkip, createWarRecoveryAdmin, witnessedNativeBossWreck, releaseSpawnedIdentity};
