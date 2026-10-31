"use strict";

// Pure helpers live in space\coopVirtualWorldRuntime.pure.js (split by scripts/coop-split-module.cjs).
const { observedNpcIDs, visitedSystems, raidDiagnose, initializedNativeMiningScenes, destroyedNativeShips, wreckCustodyNotes, worldBootAtMs, courierPilotIDs, nativeWarFleetRegistry, warSkipReasons, warSkip, warFrontChatSent, siblingSuffix, warFrontChat, warTreasuryStore, warPilotFaction, warPresencePilots, warFactionCorporation, pickFundingCorporation, presenceSummary, advanceNativeAmmoBankRecovery, ensureWarRecoverySocket, diagnoseNativeRaids, npcRealPoints, syncNativeDeliveries, hasPhysicalWreckClaim, nextHeadlessRetryMs, isHeadlessNativeReady, ensureNativeGateTransfer, observeNativeAmmoConsumption, wreckRecoveryNotes, lockedTargets, npcModuleSummary, distanceBetween, nearestBeltMeters, mineableSummary, mineableBeltSummary, miningShipDetail, observeEconomyOre, nativeMarketAllowlist, nativeWarpPoint, raidLeashNotes, raidLeashWrite, raidLeashScope, raidLeashRestore, advanceNativePveBossWreck, advanceNativePveObjectiveDoctrine, advanceNativePveWaveReinforcements, advanceNativePveSiteDefense, advanceNpcRecognition, confirmedWreck, arrivalSales, saleNotes, noteSaleSkip, createWarRecoveryAdmin, witnessedNativeBossWreck, releaseSpawnedIdentity } = require("./coopVirtualWorldRuntime.pure");
const jsonFileCache = require("./coopJsonFileCache");
// Optional background driver of virtual world; no NPC ships materialized.
let world=null,timer=null,combatTimer=null,bridge=null,gateTravelDirector=null,nativeGateTransfer=null,nativeMarketTrader=null,nativeMarketTickRunning=false,nativeMarketBlocked=false,economy=null,lossBridge=null,factionDirector=null,patrolDirector=null,patrolNavigator=null,civilianOrders=null,life=null,identityRegistry=null,raidDirector=null,huntPolicy=null,tacticsDirector=null,pveSiteDefenseDirector=null,pveWaveReinforcementsDirector=null,pveObjectiveDoctrineDirector=null,pveNativeBossDirector=null,activityDirector=null,combatEvidenceDirector=null,stockCombatEvidenceDirector=null,warpPointDirector=null,nativeGunRange=null;
let warTaxIncome=null,warDoctrineInstance=null,warCaptureByForce=null,warFleetRegistry=null,warBattleDirector=null,warEngagement=null,warPosture=null,warLossReconcile=null,warGarrison=null,warMobilizer=null,warGateStaging=null,warGateHandoff=null,warRecoverySocket=null,warDemobilizer=null,warCasualtyLedger=null,warObjectiveDirector=null,warOpening=null,warRelief=null,gateStagingSkipKey=null,followOrderReason=null;
// Native wreck IDs this process confirmed (and, after a restart, the durable
// casualty ledger): the only proof that a registered warship is really gone.
let casualtySeedDone=false;
let backgroundTicks=0,headlessBootTimer=null,nativeOrderBridge=null,personalGoals=null,squadDirector=null,wreckRecoveryDirector=null,wreckCustody=null,lootCommerce=null,nativeRearm=null,nativeAmmoWitness=null,nativeAmmoSupply=null;
// Real merit per pilot (coop-pilot-XXX -> record). Nothing promotes a pilot yet,
// so it is empty and every commander is a recruit; the career phase fills it.
// FW-009B: the durable merit ledger is the real source; it is read here so a
// promotion earned by a confirmed kill immediately enlarges the command.
let warMeritLedger=null;
// FW-118: the role a hull flies, asked of the doctrine table. One authority for every
// director that needs it, and an unknown hull is an empty role, never a guess.
function warHullRole(entityID){
 try{
  const native=require("./npc/nativeNpcStore").getNativeEntity(Number(entityID));
  const typeID=Number(native&&(native.shipTypeID||native.typeID))||0;
  if(!typeID)return "";
  if(!warDoctrineInstance)warDoctrineInstance=
   require("./coopWarDoctrine").createWarDoctrine();
  return String(warDoctrineInstance.roleForHullType(typeID)||"");
 }catch(_error){return ""}
}
function warMeritRecords(){
 if(!warMeritLedger){
  try{
   warMeritLedger=require("./coopWarMeritLedger").createWarMeritLedger({
    gameStore:require("../gameStore")});
  }catch(error){
   console.warn("[CoopWarMerit]",String(error&&error.message||error));
   return {};
  }
 }
 try{return warMeritLedger.records();}catch{return {}}
}
let intelAnnouncer=null,recognitionAnnouncer=null,alifeEconomyObserver=null,nativeMiningWitness=null,courierDispatch=null;
let wreckClaimReconcile=null,wreckRecoveryTimer=null,wreckRecoveryFastBusy=false,perfTimer=null;
const lootStationNotes=new Map();
// Wall-clock instant this process started running the living world. A wreck
// claim is never closed or re-spawned inside the boot grace window, because a
// scene that has just been created may not have loaded its entities yet.
let alifeStationAuthority=null,alifeEconomyAuthorityBusy=false,alifeBuyerRuntime=null,alifeManufacturingRuntime=null;
let worldPhaseCoordinator=null,npcExpeditionDirector=null,npcProbeEvidence=null,npcProbeFlight=null,npcProbeSweep=null,npcProbeLifecycle=null,npcProbeSceneTransition=null,npcExpeditionOperations=null,npcWormholeTransit=null,npcWormholeApproaches=new Set();
// The courier roster is data, not a constant: every seeded "Haul ..." character
// is a real carrier with its own hull and balance. A hardcoded id list silently
// ignored any courier added later, so a new carrier never accepted a contract.
function safeNpcPhase(phase,run){
 // Opt-in phase timing (EVEJS_COOP_PERF_METRICS=1): a measured phase is the only
 // honest basis for the next optimisation.
 const timed=require("./coopPerfMetrics"+(__filename.endsWith(".js")?"":".cjs")).enabled();
 const started=timed?process.hrtime.bigint():0n;
 try{return run();}
 catch(error){
  console.warn("[CoopLivingWorld] "+phase,error.message);
  try{require("./coopRuntimeProbe").observe("living-world-phase-failed",null,null,
   {phase,reason:String(error.message).slice(0,160)});}catch(_ignored){}
  return null;
 }finally{
  if(timed)require("./coopPerfMetrics"+(__filename.endsWith(".js")?"":".cjs")).metrics()
   .observe(phase,Number(process.hrtime.bigint()-started)/1e6);
 }
}
// Opt-in shared native order arbitration; original native behavior stays OFF.
// ALIFE-1 Phase A: one master switch for order authority. The ALIFE flag
// implies arbitration so a world cannot be "alive" while six directors race
// for the same hull; the legacy arbiter flag keeps working unchanged.
function alifeOrderArbitrationEnabled(env={}){
 return env.EVEJS_COOP_ALIFE==="1"||env.EVEJS_COOP_NPC_ORDER_ARBITER==="1";
}
// FW-003: use the very same native GameStore and physical identity as
// existing living-world orders. A missing/corrupt registry is UNKNOWN and
// cannot silently surrender a warship to a civilian/raid planner.
function advanceNativeWarDemobilization(){
 const {enabled,createWarDemobilizer}=require("./coopWarDemobilizer");
 if(!enabled(process.env)||!visitedSystems.size||!identityRegistry)return;
 const registry=nativeWarFleetRegistry(),guard=npcOrderBridge();
 if(!registry||!guard)return;
 if(!warDemobilizer){
  warDemobilizer=createWarDemobilizer({
   registry,
   readWarState:()=>warStateStore().read(),
   readLinks:()=>Object.values(identityRegistry.snapshot()?.links||{}),
   getOrderLeases:()=>guard.snapshot().leases
  });
 }
 const result=warDemobilizer.tick({
  systemIDs:[...visitedSystems].slice(0,12)
 });
 if(result.demobilized.length)
  require("./coopRuntimeProbe").observe(
   "living-native-war-demobilized",null,null,{
    status:result.status,ships:result.demobilized,
    evidence:"TERMINAL_NATIVE_WAR_FLEET_RELEASE_NO_HULL_OR_CARGO_MUTATION"
   });
}
// FW-003C: real patrol mobilization on the SAME existing A-Life tick. Any
// failed source proof results in zero military assignments, never free ships.
// A war phase that returns silently cannot be diagnosed from the outside: the
// reason is reported once per change instead, with a real event.
// FW-050: the legacy namespace copy of the war state is a separate storage view
// inside a ROW GROUP. Writing one member of a group can rebuild every member from
// the cache on the next flush, which silently reverted the real treasury row
// (escrow rows lost, journal counter rewound, wallet debits left unbacked). The
// file mirror plus the atomic row restore the war without ever touching a sibling
// row, so the dangerous copy is opt-in only.
function legacyWarStateMirrorEnabled(env={}){
 // Only the exact "1" opt-in: a typo or a stray "true" must not re-arm a writer
 // that can revert a sibling atomic row.
 return String(env.EVEJS_COOP_WAR_STATE_LEGACY_MIRROR??"")==="1";
}
function warStateStore(){
 const {TABLE,KEY}=require("./coopFactionWarStore"),core=require("./coopFactionWarCore"),
  gameStore=require("../gameStore");
 const rows=gameStore.coopAtomicNativeRows;
 if(!rows||typeof rows.transact!=="function")throw Error("WAR_STORE_UNAVAILABLE");
 return {
  TABLE,KEY,
  read(){
   const value=rows.transact([TABLE],tx=>tx.get(TABLE,KEY));
   if(value==null)return null;
   core.validateState(value);
   return value;
  },
  write(state){
   core.validateState(state);
   // Every phase writes the WHOLE state after reading it, so a write that is not
   // merged can erase a record another phase just added (core.mergeWarRecords has the
   // measurement and the reasoning).
   let committed=state;
   rows.transact([TABLE],tx=>{
    committed=core.mergeWarRecords(tx.get(TABLE,KEY)||null,state);
    tx.put(TABLE,KEY,committed);
   });
   mirrorWarState(committed);
   // FW-042: keep the SECOND view in sync. Measured in the SQLite file: the legacy
   // namespace blob ("coop-faction-war", 9018 B) held treasury-v1 and merit-v1 but an
   // EMPTY state-v1, and the blob is what survives a container recreate, so the war
   // (wars + campaigns + territories) was erased while real ISK stayed in escrow.
   // Writing the same validated document into the legacy path means whichever view
   // the boot reconciliation prefers, it now contains the real war.
   // FW-050: this second copy is now OFF by default, because it was destroying real
   // money. `corporationRuntime` stores "coop-faction-war" as a row GROUP, so a write
   // to one member marks the whole group dirty and the next flush rebuilds EVERY
   // member from the in-memory cache - including `treasury-v1`, which the atomic
   // write path updates in SQLite without refreshing that cache. Measured at 22:2xZ:
   // the treasury row came back with 3 reservations and `nextJournalID` 3 while the
   // live events had already used escrow journals 8000000000000004..6, and two
   // ASSAULT campaigns lost their HELD escrow while the wallets kept the debits
   // (1000120 journal -25 000 ISK, no reservation behind it).
   // The legacy copy was never read back either: `warStateStore.read` reads the flat
   // atomic row, and boot recovery prefers the live record and otherwise the
   // validated FILE mirror (FW-041), which cannot touch a sibling row.
   if(legacyWarStateMirrorEnabled(process.env)){
    try{gameStore.write(TABLE,"/coop-faction-war/state-v1",committed);}
    catch(_error){/* the atomic row stays authoritative; this is a second copy */}
   }
  }
 };
}
// FW-041: the war record must survive a container recreate.
//
// Measured repeatedly on the work stack: the fleet registry, the casualty ledger,
// the merit ledger and the treasury row all survived, while the war state row came
// back EMPTY - so the campaign disappeared, the escrow kept holding real ISK and
// no bounty could ever pay. A validated mirror on the data volume is a copy of the
// authoritative record, never an invention: it is written after every successful
// write and restored only when the atomic row is missing or unreadable, and it must
// pass the core's own validateState before it is used.
const WAR_MIRROR_FILE=()=>process.env.EVEJS_COOP_WAR_STATE_MIRROR_FILE||
 "/var/lib/evejs/coop-faction-war-mirror.json";
function warMirrorEnabled(){
 return String(process.env.EVEJS_COOP_WAR_STATE_MIRROR??"1")!=="0";
}
function mirrorWarState(state){
 if(!warMirrorEnabled())return;
 try{
  const fs=require("node:fs"),file=WAR_MIRROR_FILE(),tmp=file+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(state));
  fs.renameSync(tmp,file);
 }catch(_error){/* a mirror is best effort, never a reason to fail a war write */}
}
function readWarMirror(){
 if(!warMirrorEnabled())return null;
 try{
  const fs=require("node:fs");
  const parsed=JSON.parse(fs.readFileSync(WAR_MIRROR_FILE(),"utf8"));
  const core=require("./coopFactionWarCore");
  core.validateState(parsed);
  return parsed;
 }catch(_error){return null}
}
// Pure: which record to use on boot. A mirror may only replace an ABSENT or EMPTY
// record - it can never overwrite a live war with an older copy.
function chooseWarRestore({current,mirror}={}){
 const liveSides=(state)=>Object.keys((state&&state.wars)||{}).length+
  Object.keys((state&&state.campaigns)||{}).length+
  Object.keys((state&&state.territories)||{}).length;
 if(!mirror)return {use:current||null,reason:"NO_MIRROR"};
 if(liveSides(mirror)===0)return {use:current||null,reason:"MIRROR_EMPTY_TOO"};
 if(current&&liveSides(current)>0)return {use:current,reason:"LIVE_RECORD_WINS"};
 return {use:mirror,reason:"RESTORED_FROM_MIRROR"};
}
// The war domain needs a valid state record to exist at all. Without it every
// phase answers NO_WAR_STATE, which looks like a broken feature instead of an
// empty world. One documented factory (`core.empty()`) owns the bootstrap, and
// every war phase may call it - it is idempotent and never overwrites a record.
function ensureWarState(){
 const store=warStateStore(),core=require("./coopFactionWarCore");
 const current=store.read();
 if(current)return current;
 // FW-041: restore the validated mirror instead of publishing an empty war.
 const restored=chooseWarRestore({current,mirror:readWarMirror()});
 if(restored.use&&restored.reason==="RESTORED_FROM_MIRROR"){
  store.write(restored.use);
  try{
   require("./coopRuntimeProbe").observe("living-native-war-state",null,null,
    {status:"RESTORED",version:core.VERSION,
     wars:Object.keys(restored.use.wars||{}).length,
     campaigns:Object.keys(restored.use.campaigns||{}).length,
     evidence:"VALIDATED_MIRROR_ON_DATA_VOLUME_NOT_AN_INVENTED_WAR"});
  }catch(_error){/* probe is best effort */}
  return restored.use;
 }
 const state=core.empty();
 store.write(state);
 console.log("[CoopFactionWar] empty war state created (version "+core.VERSION+")");
 try{
  require("./coopRuntimeProbe").observe("living-native-war-state",null,null,
   {status:"CREATED",version:core.VERSION,
    evidence:"DOCUMENTED_EMPTY_STATE_FACTORY_NO_CAMPAIGN_YET"});
 }catch(_error){/* probe is best effort */}
 return state;
}
// FW-010: open the first real war. The mobiliser can only reserve ships for a
// campaign that already exists in the state, so this phase derives the war from
// real presence + real reciprocal gates + real held ground, and writes it through
// the authoritative core. One faction pair = one war; every open border under it
// is its own campaign, so a war is multi-front by construction.
// Front chat reports. Only real transitions call this, the text comes from
// coopWarClientView.frontReport (built from real state), and each event is sent
// once per process so a player is never spammed by a repeating tick.
let warChestInstance=null,warTreasuryInstance=null,warBountyInstance=null;
function warChestStore(){
 if(warChestInstance)return warChestInstance;
 const gameStore=require("../gameStore"),factions=require("../services/faction/factionState"),
  nativeRows=require("./coopNativeRowPath");
 const trader=ensureMarketTrader();
 if(!trader||typeof trader.adjustEarned!=="function")
  throw Error("WAR_CHEST_EARNED_LEDGER_UNAVAILABLE");
 warChestInstance=require("./coopWarChestFunding").createWarChestFunding({
  gameStore,
  journalFile:process.env.EVEJS_COOP_WAR_CHEST_JOURNAL||
   "/var/lib/evejs/coop-war-chest-journal.json",
  readWarState:()=>warStateStore().read(),
  adjustEarned:args=>trader.adjustEarned(args),
  verifyCorporation({corporationID,factionID},stored){
   if(!Number.isSafeInteger(corporationID)||!Number.isSafeInteger(factionID)||!stored||
    (stored.corporationID!==undefined&&stored.corporationID!==corporationID))return false;
   try{
    const corporation=require("../services/corporation/corporationState")
      .getCorporationRecord(corporationID),
     faction=factions.getFactionRecord(factionID);
    return corporation?.corporationID===corporationID&&
     corporation.isNPC===true&&faction?.factionID===factionID&&
     factions.getFactionIDForCorporation(corporationID)===factionID;
   }catch(_error){return false}
  }
 });
 void nativeRows;
 return warChestInstance;
}
function warEarnedLedger(){
 try{
  const trader=ensureMarketTrader();
  return trader?trader.snapshot():{version:1,pilots:{}};
 }catch(_error){return {version:1,pilots:{}}}
}

// FW-036: which factions can really field a navy, read from the same doctrine
// composition the sanctioned spawn path uses. Never invents a hull, a doctrine
// row or a charge; a mining laser is not a weapon family, so ORE is NO_NAVY.
let warNavyCapabilityInstance=null;
function warNavyCapability(){
 if(warNavyCapabilityInstance)return warNavyCapabilityInstance;
 try{
  const npcData=require("./npc/npcData"),
   itemTypes=require("../services/inventory/itemTypeRegistry"),
   dogma=require("./combat/weaponDogma"),
   authorities=require("./coopAdminBridgeActions").warFleetAuthorities();
  warNavyCapabilityInstance=require("./coopWarNavyCapability").createNavyCapability({
   compose:args=>authorities.composition.compose(args),
   getLoadout:id=>npcData.getNpcLoadout(id),
   isWeapon:typeID=>{
    const item=itemTypes.resolveItemByTypeID(Number(typeID));
    return Boolean(item&&dogma.resolveWeaponFamily(item));
   }
  });
 }catch(_error){warNavyCapabilityInstance=null}
 return warNavyCapabilityInstance;
}
// Read-only: the capability of every faction that appears in a live war, plus the
// decision for each war, so "this border cannot be fought" is a measurement.
// FW-040: the live identity registry, for attribution paths that used to read
// only the on-disk file and therefore saw a just-spawned war hull as UNNAMED.
function identityLinks(){
 try{return Object.values(identityRegistry?.snapshot?.()?.links||{})}catch(_error){return []}
}
function diagnoseNavy(){
 const capability=warNavyCapability();
 if(!capability)return {status:"UNAVAILABLE",factions:[],wars:[]};
 let state=null;
 try{state=warStateStore().read()}catch(_error){state=null}
 const factions=new Set();
 for(const war of Object.values(state?.wars||{})){
  if(!war||war.state!=="ACTIVE")continue;
  for(const id of [Number(war.attackerFactionID),Number(war.defenderFactionID)])
   if(Number.isSafeInteger(id)&&id>0)factions.add(id);
 }
 const rows=[...factions].sort((a,b)=>a-b).map(id=>{
  const r=capability.faction(id);
  return {factionID:id,status:r.status,armedHulls:r.armedHulls,
   loadouts:r.hulls.slice(0,3).map(h=>h.loadoutID)};
 });
 const wars=Object.values(state?.wars||{}).filter(w=>w&&w.state==="ACTIVE").map(w=>({
  warID:w.warID,attackerFactionID:Number(w.attackerFactionID),
  defenderFactionID:Number(w.defenderFactionID),
  decision:capability.decide({attackerFactionID:w.attackerFactionID,
   defenderFactionID:w.defenderFactionID}),
 }));
 return {status:"OK",factions:rows,wars};
}
function warBountyStore(){
 if(warBountyInstance)return warBountyInstance;
 const gameStore=require("../gameStore"),
  factions=require("../services/faction/factionState"),
  npcStore=require("./npc/nativeNpcStore"),
  casualtyStore=require("./coopWarCasualtyLedger"),
  nativeRows=require("./coopNativeRowPath");
 warBountyInstance=require("./coopWarBounty").createWarBounty({
  gameStore,
  treasury:warTreasuryStore(),
  chest:warChestStore(),
  readWarState:()=>warStateStore().read(),
  readLinks:()=>Object.values(identityRegistry?.snapshot()?.links||{}),
  getNativeEntity:id=>npcStore.getNativeEntity(id),
  getFactionForCorporation:id=>factions.getFactionIDForCorporation(id),
  readCasualties:()=>nativeRows.readRow(gameStore,casualtyStore.TABLE,
   casualtyStore.KEY,casualtyStore.validate),
  // FW-078: which campaign this exact hull was mobilised for, straight from the war
  // fleet registry - the casualty ledger is not written yet when the kill is decided.
  readCampaignForEntity:(entityID)=>{
   try{
    const ships=nativeWarFleetRegistry()?.snapshot?.()?.ships||{};
    const row=ships[String(Number(entityID))]||ships[Number(entityID)];
    return row&&row.campaignID?{campaignID:String(row.campaignID)}:null;
   }catch(_error){return null}
  },
  // FW-104: the pilot's own registry row is the same proven assignment the mobiliser
  // wrote (native ship + campaign verified at ASSIGN), so a kill stays attributable
  // after its identity link is released with the confirmed wreck.
  readFleet:()=>{
   try{return nativeWarFleetRegistry()?.snapshot?.()||null}catch(_error){return null}
  },
  // FW-105 (owner decision 2026-10-30): a real kill may be backed by the faction's real
  // native corporation wallet instead of only by a levy its pilots never earned. The
  // escrow is taken by coopWarTreasury RESERVE, which verifies the corporation, debits
  // division 1000 with a real journal entry and refuses when the money is not there.
  reserveFromWallet:({campaignID,factionID,needCents,proofID})=>{
   try{
    const state=warStateStore().read();
    const campaign=state?.campaigns?.[campaignID];
    if(!campaign)return {status:"BLOCKED",reason:"CAMPAIGN_NOT_FOUND"};
    const pilots=warPresencePilots(),ledger=warEarnedLedger();
    const corporationID=warFactionCorporation(factionID,pilots,ledger);
    if(!(Number(corporationID)>0))return {status:"BLOCKED",reason:"NO_FACTION_CORPORATION"};
    // FW-109: ONE escrow per KILL, not one per faction per campaign. The old fixed ids
    // meant the second kill of a campaign reused the first reservation, and the treasury
    // correctly answered a conflict - so a faction could never pay two bounties in one war.
    // The proof is hashed because a treasury id may not exceed 96 characters.
    let tag="";
    try{
     tag=require("node:crypto").createHash("sha1")
      .update(String(proofID||"event")).digest("hex").slice(0,10);
    }catch(_error){tag="";}
    if(!tag)return {status:"BLOCKED",reason:"BOUNTY_PROOF_UNHASHABLE"};
    return warTreasuryStore().execute({type:"RESERVE",purpose:"BOUNTY",
     eventID:"fw:wallet-reserve:"+campaignID+":"+factionID+":"+tag,
     reservationID:"bounty:"+campaignID+":"+factionID+":"+tag,
     corporationID,factionID,warID:campaign.warID,campaignID,
     amountCents:needCents,minRemainingCents:0});
   }catch(error){
    return {status:"BLOCKED",reason:String(error&&error.message||error)};
   }
  },
  emit:(event,detail)=>{
   try{require("./coopRuntimeProbe").observe(event,null,null,detail);}
   catch(_error){/* probe is best effort */}
  }
 });
 return warBountyInstance;
}
// FW-067 (validation): why is there no payout, answered once from the live record.
//
// A payout needs five things at the same time: a campaign that is still fightable, a
// HELD escrow for the side that will make the kill, a real hull of that side inside the
// campaign's own systems, a real native kill with an attributed attacker, and a credit
// leg that can reach the pilot. Any one of them missing looks identical from outside -
// nothing arrives - so this reports each of them with its own status and the blockers
// as plain sentences.
function diagnoseWarPayout(){
 const out={status:"UNKNOWN",campaigns:[],blockers:[],checkedAt:Date.now()};
 let state=null,treasury=null;
 try{state=warStateStore().read();}catch(error){
  out.status="WAR_STATE_UNAVAILABLE";
  out.blockers.push("the war record could not be read: "+String(error&&error.message||error).slice(0,120));
  return out;
 }
 try{treasury=warTreasuryStore().snapshot();}catch(error){
  out.status="TREASURY_UNAVAILABLE";
  out.blockers.push("the treasury could not be read: "+String(error&&error.message||error).slice(0,120));
  return out;
 }
 const wars=new Map(Object.entries((state&&state.wars)||{}));
 const campaigns=Object.values((state&&state.campaigns)||{});
 const reservations=Object.values((treasury&&treasury.reservations)||{});
 let presencePilots=[];
 try{presencePilots=warPresencePilots()||[];}catch(_error){presencePilots=[];}
 const lastAttribution=lastWarAttributionStatus();
 for(const campaign of campaigns){
  const war=wars.get(campaign.warID)||null;
  const theatre=[Number(campaign.sourceSystemID),Number(campaign.targetSystemID)].filter(id=>id>0);
  const rows=reservations.filter(row=>row&&row.campaignID===campaign.campaignID);
  const sides=[];
  for(const factionID of [Number(war&&war.attackerFactionID),Number(war&&war.defenderFactionID)]){
   if(!(factionID>0))continue;
   const escrow=rows.find(row=>Number(row.factionID)===factionID)||null;
   const hulls=presencePilots.filter(pilot=>Number(pilot.factionID)===factionID&&
    theatre.includes(Number(pilot.systemID))).length;
   sides.push({factionID,escrowStatus:String(escrow&&escrow.status||"NONE"),
    reservationID:String(escrow&&escrow.reservationID||""),
    hullsInTheatre:hulls,
    canCollectNow:Boolean(escrow&&escrow.status==="HELD"&&hulls>0)});
  }
  const live=["PREPARING","ASSAULT"].includes(String(campaign.state));
  const payable=sides.filter(side=>side.canCollectNow===true);
  const entry={campaignID:campaign.campaignID,state:String(campaign.state),
   targetSystemID:Number(campaign.targetSystemID)||0,
   sourceSystemID:Number(campaign.sourceSystemID)||0,sides,
   payoutReady:live&&payable.length>0,
   blockers:[]};
  if(!live)entry.blockers.push("campaign is "+String(campaign.state)+", no further kill can be paid");
  for(const side of sides){
   if(side.escrowStatus!=="HELD"&&side.escrowStatus!=="PAID")
    entry.blockers.push("faction "+side.factionID+" has no escrow ("+side.escrowStatus+")");
   else if(side.hullsInTheatre<1)
    entry.blockers.push("faction "+side.factionID+" has escrow but no hull in systems "+
     theatre.join("/"));
  }
  if(entry.payoutReady&&lastAttribution&&lastAttribution.status!=="NATIVE_DESTRUCTION_ATTACKER_PROVIDED")
   entry.blockers.push("last destruction attribution answered "+lastAttribution.status);
  out.campaigns.push(entry);
  for(const line of entry.blockers)out.blockers.push(campaign.campaignID+": "+line);
 }
 const ready=out.campaigns.filter(entry=>entry.payoutReady);
 out.payoutPossible=ready.length>0;
 out.status=ready.length?"PAYOUT_POSSIBLE":(out.campaigns.length?"NOTHING_PAYABLE":"NO_CAMPAIGN");
 out.lastAttribution=lastAttribution;
 if(!out.payoutPossible&&!out.blockers.length)out.blockers.push("no campaign needs money right now");
 return out;
}
// The most recent destruction attribution the world recorded, from its own event log.
// Read-only, bounded, and never a reason to fail the diagnostic.
function lastWarAttributionStatus(){
 const file=process.env.EVEJS_COOP_EVENTS_FILE||"/var/lib/evejs/coop-events.jsonl";
 try{
  const fs=require("node:fs");
  const LF=String.fromCharCode(10);
  const raw=fs.readFileSync(file,"utf8").trim().split(LF).slice(-400);
  for(let index=raw.length-1;index>=0;index-=1){
   let row=null;
   try{row=JSON.parse(raw[index]);}catch(_error){continue;}
   if(!row||row.event!=="living-native-destruction-attacker")continue;
   return {at:row.at||"",status:String(row.status||""),
    victimPilotID:String(row.victimPilotID||""),attackerPilotID:String(row.attackerPilotID||"")};
  }
 }catch(_error){/* an unreadable log is simply unknown */}
 return null;
}
// FW-088: the durable casualty ledger as a read-only snapshot, so attribution can name a
// victim whose hull every other cache has already pruned.
function warCasualtySnapshot(){
 try{
  if(!warCasualtyLedger)return null;
  return warCasualtyLedger.snapshot();
 }catch(_error){return null}
}
// FW-053: escrow of an expired campaign must go back to the corporation that paid it.
//
// A campaign that never produced an assault proof is expired by the opener (that is
// how a squatted target is released), but nothing released its money: the treasury
// only refunded a war that ENDED or a campaign that was CANCELLED, and the live
// runtime supplied no authorizeRefund at all, so the default refused every refund.
// Measured 22:5xZ: `war:500011-500020:campaign:30045343` was EXPIRED while its
// 2 500 000-cent reservation stayed HELD. The refund is idempotent per campaign side
// (eventID `fw:refund:<campaignID>:<factionID>`), returns the exact cents the
// reservation holds, and is recorded with a status either way.
//
// FW-053B: a campaign can also expire BEFORE this process starts, and the tick that
// expires it has already passed, so the same refund is reconciled from the state.
function refundExpiredCampaigns(campaignIDs){
 const ids=Array.isArray(campaignIDs)?campaignIDs.filter(x=>typeof x==="string"&&x):[];
 if(!ids.length)return [];
 let treasury=null;
 try{treasury=warTreasuryStore()}catch(_error){return []}
 const out=[];
 for(const campaignID of ids){
  let snapshot=null;
  try{snapshot=treasury.snapshot()}catch(_error){snapshot=null}
  const held=Object.values((snapshot&&snapshot.reservations)||{})
   .filter(row=>row&&row.status==="HELD"&&row.campaignID===campaignID);
  for(const row of held){
   let refunded=null;
   try{
    refunded=treasury.execute({type:"REFUND",
     eventID:"fw:refund:"+campaignID+":"+row.factionID,
     reservationID:row.reservationID,corporationID:row.corporationID,
     proofID:"expire:"+campaignID});
   }catch(error){
    refunded={status:"BLOCKED",reason:String(error&&error.message||error).slice(0,120)};
   }
   const detail={status:String(refunded&&refunded.status||"UNKNOWN"),
    reason:String(refunded&&refunded.reason||""),
    campaignID,factionID:Number(row.factionID)||0,
    corporationID:Number(row.corporationID)||0,
    reservationID:row.reservationID,amountCents:Number(row.cents)||0,
    refundJournalID:Number(refunded&&refunded.receipt&&refunded.receipt.journalID)||0,
    evidence:"REAL_ESCROW_RETURNED_TO_THE_CORPORATION_THAT_PAID_IT"};
   out.push(detail);
   try{require("./coopRuntimeProbe").observe("living-native-war-bounty-refunded",null,null,detail);}
   catch(_error){/* probe is best effort */}
  }
 }
 return out;
}
// The same refund for an expiry this process never witnessed.
function reconcileTerminalEscrow(){
 let treasury=null,state=null;
 try{treasury=warTreasuryStore();state=warStateStore().read();}
 catch(_error){return []}
 if(!treasury||!state)return [];
 const terminal=(row)=>{
  const campaign=(state.campaigns||{})[row.campaignID];
  const war=(state.wars||{})[row.warID];
  if(war&&war.state==="ENDED")return true;
  // FW-066: a won campaign has no further kill to pay for, so its escrow is terminal.
  return ["CANCELLED","EXPIRED","OCCUPIED"].includes(String(campaign&&campaign.state||""));
 };
 let snapshot=null;
 try{snapshot=treasury.snapshot()}catch(_error){return []}
 const stale=Object.values((snapshot&&snapshot.reservations)||{})
  .filter(row=>row&&row.status==="HELD"&&terminal(row))
  .map(row=>row.campaignID);
 return stale.length?refundExpiredCampaigns([...new Set(stale)]):[];
}
// FW-059 (review): the payout has two legs - release the escrow, then credit the
// pilot - and a failure between them left `ESCROW_RELEASED_NOT_CREDITED` with no
// retry: the ISK had left the escrow and never reached the pilot. The credit is
// keyed by `war-bounty:<campaign>:<proof>`, so replaying it is safe and exact; this
// pass finishes any payout whose credit really did not happen, on every war tick,
// and records what it did. Nothing here creates ISK: the escrow was already released.
function reconcileBountyCredits(){
 let treasury=null,chest=null;
 try{treasury=warTreasuryStore();chest=warChestStore();}
 catch(_error){return []}
 if(!treasury||!chest)return [];
 let snapshot=null;
 try{snapshot=treasury.snapshot()}catch(_error){return []}
 const paid=Object.values((snapshot&&snapshot.reservations)||{})
  .filter(row=>row&&row.status==="PAID"&&row.paidToPilotID&&row.payoutProofID&&
   Number(row.cents)>0);
 const out=[];
 for(const row of paid){
  const eventID="war-bounty:"+row.campaignID+":"+row.payoutProofID;
  let credited=null;
  try{
   credited=chest.creditPilot({pilotID:row.paidToPilotID,cents:Number(row.cents),
    eventID,reason:"war bounty credit reconcile "+String(row.campaignID||"")});
  }catch(error){
   credited={status:"FAILED",reason:String(error&&error.message||error).slice(0,120)};
  }
  if(String(credited&&credited.status||"")!=="APPLIED")continue;
  const detail={status:"APPLIED",pilotID:String(row.paidToPilotID),
   campaignID:String(row.campaignID||""),reservationID:row.reservationID,
   amountCents:Number(row.cents)||0,creditEventID:eventID,
   evidence:"SECOND_PAYOUT_LEG_FINISHED_FROM_THE_PAID_ESCROW_ROW"};
  out.push(detail);
  try{require("./coopRuntimeProbe").observe("living-native-war-bounty-credit-reconciled",
   null,null,detail);}catch(_error){/* probe is best effort */}
 }
 return out;
}
// FW-085: give back escrow that was reserved for a border that was then refused, so a
// funded side is never left holding HELD ISK for a campaign that does not exist.
function warBountyRelease({campaignID,reservationID,corporationID,factionID=0}={}){
 try{
  if(!reservationID||!corporationID)return {status:"BLOCKED",reason:"INVALID_RELEASE"};
  const treasury=warTreasuryStore();
  // The event id must stay inside the treasury's 96-character key budget, so it names the
  // campaign and the side, never the whole reservation id (measured: the long form was
  // refused with INVALID_TREASURY_COMMAND).
  const refunded=treasury.execute({type:"REFUND",
   eventID:"fw:release:"+String(campaignID||"unknown")+":"+String(Number(factionID)||0),
   reservationID:String(reservationID),corporationID:Number(corporationID),
   proofID:"unfunded:"+String(campaignID||"unknown")});
  try{
   require("./coopRuntimeProbe").observe("living-native-war-bounty-released",null,null,{
    status:String(refunded&&refunded.status||"UNKNOWN"),
    reason:String(refunded&&refunded.reason||""),campaignID:String(campaignID||""),
    reservationID:String(reservationID),corporationID:Number(corporationID),
    evidence:"ESCROW_RETURNED_FOR_A_BORDER_THAT_NEVER_OPENED"});
  }catch(_error){/* probe is best effort */}
  return refunded;
 }catch(error){
  return {status:"BLOCKED",reason:String(error&&error.message||error).slice(0,120)};
 }
}
// One real reservation per campaign side, taken before START_CAMPAIGN.
//
// FW-046: this used to RETURN on the first side it could fund, so a war had a
// bounty only for the attacker. Measured on the work stack at 19:15Z: the real
// kill that decided the battle was made by a DEFENDER (coop-pilot-027, faction
// 500011) while the only HELD escrow belonged to 500004, so `coopWarBounty`
// correctly refused with NO_HELD_ESCROW_FOR_FACTION and no ISK could move - a
// funded war where half the fighters can never be paid is not a bounty, and the
// comment above already promised one reservation per side.
// Each side now funds its OWN bounty out of its OWN wallet; a side that cannot
// pay is refused per side (its own reason is kept) and never blocks the other.
// Env-gated because it takes a second real escrow: EVEJS_COOP_WAR_BOUNTY_BOTH_SIDES=1.
// FW-093 (measured 2026-10-29): the side was asked to pay from the corporation its
// PILOTS belong to, and that is not where a faction's money lives. Measured on the
// work stack: faction 500001 fields pilots whose corporation is 1000180 (0 ISK),
// while the same faction's corporation 1000035 really held 90 000 ISK that only
// real mercenary settlements ever put there; faction 500004 had 0 ISK at its
// militia corporation and 530 000 ISK at 1000120. Every border was therefore
// refused `WAR_TREASURY_FUNDS_UNAVAILABLE` with the money sitting in the same
// faction, and the war could not fund itself at all.
//
// The money is still real and still the faction's: `coopWarTreasury` verifies the
// corporation belongs to that faction and debits its native wallet atomically, so
// this only chooses WHICH of the faction's own corporations pays. Order is the
// historical corporation first (identity), then the declared militia corporation,
// then the faction's corporations richest first - and the pilot corporation is
// kept when nothing can pay, so a refusal still names the same corporation.
function warFactionCorporationCandidates(factionID,pilots,ledger){
 const ordered=[],push=id=>{const n=Number(id);
  if(Number.isSafeInteger(n)&&n>0&&!ordered.includes(n))ordered.push(n)};
 push(warFactionCorporation(factionID,pilots,ledger));
 let factions=null;
 try{factions=require("../services/faction/factionState")}catch(_error){factions=null}
 if(factions){
  try{push(factions.getFactionRecord(factionID)?.militiaCorporationID)}catch(_error){/* optional */}
  try{
   const read=require("../gameStore").read("corporations","/");
   const table=read&&read.success&&read.data
    ?(read.data.records&&typeof read.data.records==="object"?read.data.records:read.data):{};
   for(const key of Object.keys(table)){
    const record=table[key];
    if(!record||typeof record!=="object")continue;
    if(Number(record.factionID)!==Number(factionID))continue;
    push(Number(record.corporationID)||Number(record._key)||Number(key));
   }
  }catch(_error){/* an unreadable corporation table is not a funding decision */}
 }
 return ordered;
}
function warCorporationBalanceISK(corporationID){
 try{
  const read=require("./coopCorpWallet").readWallet({gameStore:require("../gameStore"),
   corporationID:Number(corporationID)});
  const division=read&&read.status==="OK"&&read.divisions?read.divisions["1000"]:null;
  const isk=Number(division&&division.balance);
  return Number.isFinite(isk)?isk:null;
 }catch(_error){return null}
}
function warFundingCorporation(factionID,pilots,ledger,needCents){
 // The DECISION is pure (coopVirtualWorldRuntime.pure) so it is testable without a
 // world; this function only reads the real wallets it needs.
 return pickFundingCorporation({ordered:warFactionCorporationCandidates(factionID,pilots,ledger),
  needCents,readBalance:warCorporationBalanceISK});
}

function warBountyReserve({war,campaign,campaignID,warID,persist}){
 if(process.env.EVEJS_COOP_WAR_BOUNTY_ISK==="0")return {status:"REFUSED",reason:"WAR_BOUNTY_OFF"};
 const bountyISK=Math.max(1,Math.round(Number(process.env.EVEJS_COOP_WAR_BOUNTY_ISK)||25000));
 const needCents=bountyISK*100;
 // The declaration must be durable before an escrow can name this war.
 try{if(typeof persist==="function")persist();}
 catch(error){return {status:"REFUSED",reason:"WAR_STATE_PERSIST_FAILED"};}
 const pilots=warPresencePilots(),ledger=warEarnedLedger(),refusals=[];
 const chest=warChestStore(),treasury=warTreasuryStore();
 const reserveSide=(factionID)=>{
  if(!Number.isSafeInteger(factionID)||factionID<=0)
   return {status:"REFUSED",reason:"NO_FACTION",factionID:0};
  const payer=warFundingCorporation(factionID,pilots,ledger,needCents);
  const corporationID=Number(payer.corporationID)||0;
  if(!Number.isSafeInteger(corporationID)||corporationID<=0){
   refusals.push({factionID,reason:"NO_MILITIA_CORPORATION"});
   return {status:"REFUSED",reason:"NO_MILITIA_CORPORATION",factionID};
  }
  if(payer.fallback)refusals.push({factionID,reason:"FUNDED_BY_FACTION_CORPORATION",
   corporationID,walletISK:payer.walletISK,candidates:payer.candidates});
  let funded=null;
  try{
   funded=chest.fund({factionID,corporationID,warID,campaignID,needCents,pilots,ledger,
    eventID:"bounty:"+campaignID+":"+factionID});
  }catch(error){
   const reason="WAR_CHEST_THROW:"+String(error&&error.message||error);
   refusals.push({factionID,reason});
   return {status:"REFUSED",reason,factionID};
  }
  if(funded.status!=="APPLIED"&&funded.status!=="DUPLICATE"){
   const reason=String(funded.reason||funded.status);
   // The levy reads PILOT earned balances, but this world already sweeps those
   // into the corporation wallet on every refinery tick
   // (`living-corp-treasury-swept`, 250 000 ISK moved by a pilot-earned debit).
   // So a war party can hold real ISK in its native wallet and still plan a levy
   // of zero: measured on the work stack, war_funding_diagnose answered
   // NO_REAL_FACTION_INCOME on every side while that wallet held 125 M ISK that
   // only real settlements ever put there. With this opt-in the escrow is backed
   // by that same wallet: `coopWarTreasury` RESERVE verifies the corporation,
   // debits division 1000 with a real journal entry and refuses when the money is
   // not there, so no ISK is invented, only spent from where it already is.
   const walletBacked=process.env.EVEJS_COOP_WAR_BOUNTY_WALLET_FALLBACK==="1"&&
    ["NO_REAL_FACTION_INCOME","INSUFFICIENT_REAL_INCOME"].includes(reason);
   if(!walletBacked){
    refusals.push({factionID,reason});
    return {status:"REFUSED",reason,factionID};
   }
   refusals.push({factionID,reason:"BOUNTY_BACKED_BY_NATIVE_CORP_WALLET",chestRefusal:reason});
  }
  const reservationID="bounty:"+campaignID+":"+factionID;
  let reserved;
  try{
   reserved=treasury.execute({type:"RESERVE",
    eventID:"fw:reserve:"+campaignID+":"+factionID,reservationID,
    corporationID,factionID,warID,campaignID,amountCents:needCents,
    minRemainingCents:0});
  }catch(error){
   const reason="WAR_TREASURY_THROW:"+String(error&&error.message||error);
   refusals.push({factionID,reason});
   return {status:"REFUSED",reason,factionID};
  }
  if(reserved.status!=="APPLIED"&&reserved.status!=="DUPLICATE"){
   const reason=String(reserved.reason||reserved.status);
   refusals.push({factionID,reason});
   return {status:"REFUSED",reason,factionID};
  }
  try{
   require("./coopRuntimeProbe").observe("living-native-war-bounty-reserved",null,null,{
    status:"RESERVED",factionID,corporationID,campaignID,warID,
    amountCents:needCents,reservationID,
    chestJournalID:String(funded.entry?.journalID||""),
    walletAfterCents:Number(funded.entry?.walletAfterCents)||0,
    sources:(funded.entry?.sources||[]).map(s=>s.pilotID),
    escrowJournalID:Number(reserved.receipt?.journalID)||0,
    evidence:"REAL_EARNED_ISK_TO_NATIVE_CORP_WALLET_TO_HELD_ESCROW"});
  }catch(_error){/* probe is best effort */}
  return {status:"RESERVED",reservationID,factionID,corporationID,
   amountCents:needCents,chestJournalID:String(funded.entry?.journalID||""),
   escrowJournalID:Number(reserved.receipt?.journalID)||0};
 };
 const sides=[Number(war.attackerFactionID),Number(war.defenderFactionID)];
 const both=String(process.env.EVEJS_COOP_WAR_BOUNTY_BOTH_SIDES||"0")==="1";
 const planned=require("./coopWarBountyEscrowSides")
  .planSideReservations({sides,both,attackerFactionID:war.attackerFactionID,reserveSide});
 if(!planned.funded.length)
  return {status:"REFUSED",reason:refusals.length?
   refusals.map(r=>r.factionID+":"+r.reason).join("|"):"NO_WAR_PARTY",refusals};
 // The campaign is oriented attacker -> defender, so the attacker's escrow is the
 // one that names this campaign's supply. A defender-only escrow still opens the
 // war (unchanged fallback), it simply is not the supply proof.
 const primary=planned.primary;
 return {...primary,status:"RESERVED",refusals,
  otherSideReservationID:(planned.funded.find(r=>r!==primary)||{}).reservationID||"",
  sides:planned.funded.map(r=>({factionID:r.factionID,
   reservationID:r.reservationID,corporationID:r.corporationID}))};
}
// Read-only: what the chest can really see, so a refusal names its own cause.
function diagnoseWarFunding(){
 const pilots=warPresencePilots(),ledger=warEarnedLedger();
 const need=Math.max(1,Math.round(Number(process.env.EVEJS_COOP_WAR_BOUNTY_ISK)||25000))*100;
 let state=null;
 try{state=warStateStore().read()}catch(_error){state=null}
 const plan=require("./coopWarChestFunding").planLevy;
 const wars=Object.values(state?.wars||{}).filter(w=>w.state==="ACTIVE");
 return {
  flags:{factionWar:process.env.EVEJS_COOP_FACTION_WAR==="1",
   treasury:process.env.EVEJS_COOP_WAR_TREASURY==="1",
   atomicRows:process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"},
  needCents:need,
  pilots:pilots.length,
  earned:{pilots:Object.keys(ledger.pilots||{}).length,
   balances:Object.entries(ledger.pilots||{}).map(([id,row])=>({pilotID:id,
    balance:Number(row?.balance)||0}))},
  wars:wars.map(w=>({warID:w.warID,attackerFactionID:w.attackerFactionID,
   defenderFactionID:w.defenderFactionID,
   sides:[Number(w.attackerFactionID),Number(w.defenderFactionID)].map(factionID=>({
    factionID,corporationID:warFactionCorporation(factionID,pilots,ledger),
    plan:plan({factionID,pilots,ledger,needCents:need})}))})),
  // FW-038: money and navies can sit on opposite sides. Report which faction
  // could hire which, with the real wallet balance that would pay for it.
  mercenary:diagnoseMercenary(wars,pilots,ledger,need),
 };
}
// FW-038B: the settlement that actually pays a mercenary contract. Both wallets
// are real native corporation wallets (division 1000) and the transfer is a
// journaled two-leg operation - see coopWarMercenarySettlement.
let warMercenarySettlementInstance=null;
function warMercenarySettlement(){
 if(warMercenarySettlementInstance)return warMercenarySettlementInstance;
 // FW-038C: the wallet is the idempotency anchor, so the settlement needs only
 // the GameStore pointer API - the same one the corporation wallet itself uses.
 warMercenarySettlementInstance=require("./coopWarMercenarySettlement")
  .createMercenarySettlement({gameStore:require("../gameStore")});
 return warMercenarySettlementInstance;
}
function executeMercenaryContract(request){
 try{
  return warMercenarySettlement().execute({
   eventID:String(request&&request.eventID||""),
   payerCorporationID:Number(request&&request.payerCorporationID),
   payeeCorporationID:Number(request&&request.payeeCorporationID),
   amountCents:Number(request&&request.amountCents),
   dryRun:request&&request.dryRun===true
  });
 }catch(error){
  return {status:"BLOCKED",reason:"WAR_MERCENARY_UNAVAILABLE",
   detail:String(error&&error.message||error).slice(0,120)};
 }
}
function diagnoseMercenarySettlement(){
 try{return warMercenarySettlement().snapshot()}
 catch(error){return {status:"UNAVAILABLE",reason:String(error&&error.message||error)}}
}
// FW-038 read-only: pair a funded faction with a navy-capable faction using the
// real corporation wallets (division 1000). Proposes only; moves no ISK.
function diagnoseMercenary(wars,pilots,ledger,needCents){
 try{
  const capability=warNavyCapability();
  if(!capability)return {status:"UNAVAILABLE",proposals:[]};
  const factions=new Set();
  for(const w of Array.isArray(wars)?wars:[]){
   for(const id of [Number(w.attackerFactionID),Number(w.defenderFactionID)])
    if(Number.isSafeInteger(id)&&id>0)factions.add(id);
  }
  const capabilities=[...factions].map(factionID=>({
   factionID,status:capability.faction(factionID).status}));
  const wallet=require("./coopCorpWallet");
  const treasuries=[];
  for(const factionID of factions){
   const corporationID=warFactionCorporation(factionID,pilots,ledger);
   if(!Number.isSafeInteger(corporationID)||corporationID<=0)continue;
   let balanceCents=0;
   try{
    const read=wallet.readWallet({gameStore:require("../gameStore"),
     corporationID});
    const division=read&&read.status==="OK"&&read.divisions?read.divisions["1000"]:null;
    const isk=Number(division&&division.balance);
    balanceCents=Number.isFinite(isk)&&isk>0?Math.round(isk*100):0;
   }catch(_error){balanceCents=0}
   treasuries.push({factionID,corporationID,balanceCents});
  }
  return require("./coopWarMercenaryContract").proposeContracts({
   capabilities,treasuries,needCents});
 }catch(error){
  return {status:"UNAVAILABLE",reason:String(error&&error.message||error),proposals:[]};
 }
}
// FW-011A: read-only sovereignty projection. Military control is always
// reported; a native sov claim is reported only where a real sov structure and
// a real native claim exist. Nothing is written, so no claim is fabricated.
let warSovProjection=null;
// FW-043: a wiped war record left the territory map EMPTY, and every later phase
// derives its fronts from that very map - so after a container recreate the world
// could never re-derive ownership, project sovereignty, or open a front again. The
// deadlock was self-inflicted: projection iterated `state.territories` to find
// structures, and an empty map simply produced nothing.
//
// Territories are therefore re-derived from REAL PRESENCE (the same resolved
// pilots the front planner uses): a system belongs to the one faction that really
// holds strictly more resolved ships there than any other. Ties register nothing,
// no ISK, hull or system is invented, and the record goes through the same
// validated store the rest of the domain uses.
// FW-044: military control needs a military presence.
//
// Measured right after FW-043: ownership derived from raw presence let ORE - a faction
// with mining hulls and NO combat doctrine at all - own four systems, so every border
// resolved to a party that cannot fight and FW-036 correctly refused every front. A
// mining fleet is not a garrison. A system can only be owned when at least one ARMED
// pilot (role patrol/pirate) of the winning faction is really there, and the owner is
// still the faction with the most resolved pilots among those that can defend.
// A tie owns nothing, and a system with no armed presence stays unowned.
const ARMED_ROLES=new Set(["patrol","pirate"]);
function deriveTerritoryOwners(pilots){
 const counts=new Map();
 for(const pilot of Array.isArray(pilots)?pilots:[]){
  const systemID=Number(pilot&&pilot.systemID),factionID=Number(pilot&&pilot.factionID);
  if(!Number.isSafeInteger(systemID)||systemID<=0||
   !Number.isSafeInteger(factionID)||factionID<=0)continue;
  const key=String(systemID);
  if(!counts.has(key))counts.set(key,new Map());
  const per=counts.get(key);
  const row=per.get(factionID)||{ships:0,armed:0};
  row.ships+=1;
  if(ARMED_ROLES.has(String(pilot&&pilot.role||"")))row.armed+=1;
  per.set(factionID,row);
 }
 const owners=[];
 for(const [key,per] of counts){
  const eligible=[...per.entries()].filter(([,row])=>row.armed>0);
  if(!eligible.length)continue;
  eligible.sort((a,b)=>b[1].ships-a[1].ships||a[0]-b[0]);
  const [factionID,row]=eligible[0];
  if(eligible.length>1&&eligible[1][1].ships>=row.ships)continue; // a tie owns nothing
  owners.push({systemID:Number(key),factionID,ships:row.ships,armed:row.armed});
 }
 owners.sort((a,b)=>a.systemID-b.systemID);
 return owners;
}
// FW-045: a map derived under the old rule must be repairable without wiping the world.
//
// FW-044 corrected WHICH faction may own ground, but it could only act on an empty map,
// and the live map was already mining-weighted, so the world kept refusing every front.
// A territory that has never been fought over (revision 1, no campaign has ever used it)
// whose owner fields NO armed presence there any more is re-derived from presence; a
// system with no armed faction at all loses its owner, because nobody garrisons it.
// Anything that was really captured or is being fought over is never touched.
function planTerritoryBootstrap({territories,pilots}={}){
 const current=territories||{};
 const owners=deriveTerritoryOwners(pilots);
 const desired=new Map(owners.map(o=>[String(o.systemID),o]));
 const armedBySystem=new Map();
 for(const pilot of Array.isArray(pilots)?pilots:[]){
  const systemID=Number(pilot&&pilot.systemID),factionID=Number(pilot&&pilot.factionID);
  if(!Number.isSafeInteger(systemID)||systemID<=0)continue;
  if(!ARMED_ROLES.has(String(pilot&&pilot.role||"")))continue;
  const key=String(systemID);
  if(!armedBySystem.has(key))armedBySystem.set(key,new Set());
  armedBySystem.get(key).add(Number(factionID));
 }
 const add=[],correct=[],release=[],keep=[];
 for(const [key,owner] of desired){
  const existing=current[key];
  if(!existing){add.push(owner);continue;}
  if(Number(existing.revision)>1){keep.push({systemID:Number(key),reason:"ALREADY_FOUGHT_OVER"});continue;}
  const armed=armedBySystem.get(key)||new Set();
  if(armed.has(Number(existing.militaryControllerFactionID))){
   keep.push({systemID:Number(key),reason:"OWNER_STILL_ARMED"});
   continue;
  }
  if(Number(existing.militaryControllerFactionID)!==owner.factionID)correct.push(owner);
  else keep.push({systemID:Number(key),reason:"UNCHANGED"});
 }
 for(const [key,existing] of Object.entries(current)){
  if(desired.has(key))continue;
  if(Number(existing.revision)>1)keep.push({systemID:Number(key),reason:"ALREADY_FOUGHT_OVER"});
  else release.push({systemID:Number(key),factionID:Number(existing.militaryControllerFactionID)});
 }
 return {add,correct,release,keep};
}
function bootstrapTerritoriesFromPresence(state){
 if(!state||!state.territories)return {status:"NO_STATE",added:0};
 let pilots=[];
 try{pilots=warPresencePilots()||[]}catch(_error){pilots=[]}
 if(!pilots.length)return {status:"NO_PRESENCE",added:0};
 const plan=planTerritoryBootstrap({territories:state.territories,pilots});
 if(!plan.add.length&&!plan.correct.length&&!plan.release.length)
  return {status:"NO_CHANGE",added:0,kept:plan.keep.length};
 const at=Date.now(),next={...state,territories:{...(state.territories||{})}};
 const apply=(owner)=>{
  next.territories[String(owner.systemID)]={systemID:owner.systemID,
   originalOwnerFactionID:owner.factionID,militaryControllerFactionID:owner.factionID,
   state:"SECURE",revision:1,changedAt:at};
 };
 for(const owner of plan.add)apply(owner);
 for(const owner of plan.correct)apply(owner);
 for(const gone of plan.release)delete next.territories[String(gone.systemID)];
 warStateStore().write(next);
 return {status:plan.add.length?"REGISTERED_FROM_PRESENCE":"CORRECTED_FROM_PRESENCE",
  added:plan.add.length,corrected:plan.correct.length,released:plan.release.length,
  kept:plan.keep.length,
  systems:[...plan.add,...plan.correct].map(o=>({systemID:o.systemID,
   factionID:o.factionID,ships:o.ships,armed:o.armed})),
  releasedSystems:plan.release};
}
function advanceNativeWarSovereigntyProjection(){
 if(process.env.EVEJS_COOP_WAR_SOVEREIGNTY_PROJECTION!=="1")return;
 let state=null;
 try{state=warStateStore().read()}catch(_error){state=null}
 if(!state||!state.territories)return;
 // FW-043: an empty map is a bootstrap, not an answer.
 try{
  const boot=bootstrapTerritoriesFromPresence(state);
  if(boot.status==="REGISTERED_FROM_PRESENCE"||boot.status==="CORRECTED_FROM_PRESENCE"){
   require("./coopRuntimeProbe").observe("living-native-war-territory-bootstrap",null,null,
    {status:boot.status,added:boot.added,corrected:boot.corrected,
     released:boot.released,kept:boot.kept,systems:boot.systems,
     evidence:"REAL_PRESENCE_STRICT_MAJORITY_ARMED_OWNER_NO_INVENTED_OWNER"});
   state=warStateStore().read();
   if(!state||!state.territories)return;
  }
 }catch(_error){/* a bootstrap failure must never break the phase */}
 let structures=[];
 try{
  const worldData=require("./worldData");
  for(const systemID of Object.keys(state.territories)){
   const rows=worldData.getStructuresForSystem(Number(systemID));
   if(Array.isArray(rows))structures=structures.concat(rows);
  }
 }catch(_error){structures=[]}
 let sovState=null;
 try{sovState=require("../services/sovereignty/sovState")}catch(_error){sovState=null}
 const plan=require("./coopWarSovereigntyProjection").planProjection({
  warState:state,structures,
  getSystemSovClaim:sovState&&typeof sovState.getSystemSovClaim==="function"?
   id=>sovState.getSystemSovClaim(id):null
 });
 if(plan.status!=="PLANNED")return;
 const signature=JSON.stringify(plan.systems.map(s=>[s.systemID,s.factionID,s.mode]));
 if(warSovProjection===signature)return;
 warSovProjection=signature;
 require("./coopRuntimeProbe").observe("living-native-war-sovereignty-projection",null,null,{
  status:"PROJECTED_VIEW",counts:plan.counts,
  systems:plan.systems.map(s=>({systemID:s.systemID,factionID:s.factionID,
   state:s.state,mode:s.mode,reason:s.reason})),
  evidence:"MILITARY_CONTROL_REPORTED_NATIVE_CLAIM_ONLY_WHEN_STRUCTURE_BACKED"
 });
}
function advanceNativeWarOpening(){
 const {enabled}=require("./coopWarMobilizer");
 if(!enabled(process.env))return warSkip("opening","WAR_FLAGS_OFF");
 // A kill can only pay a bounty once the chest payer is installed.
 try{require("./coopWarKillMerit").setBountyPayer(args=>warBountyStore().pay(args));}
 catch(error){warSkip("bounty","WAR_BOUNTY_UNAVAILABLE:"+String(error&&error.message||error));}
 if(!visitedSystems.size)return warSkip("opening","NO_VISITED_SYSTEMS");
 if(!identityRegistry)return warSkip("opening","NO_IDENTITY_REGISTRY");
 try{ensureWarState()}catch(error){
  return warSkip("opening","WAR_STATE_WRITE_FAILED:"+String(error&&error.message||error));
 }
 const store=warStateStore();
 const readWarState=()=>store.read();
 if(!warOpening){
  const npcStore=require("./npc/nativeNpcStore"),
   factions=require("../services/faction/factionState"),
   worldData=require("./worldData");
  warOpening=require("./coopFactionWarOpening").createWarOpening({
   readLinks:()=>Object.values(identityRegistry.snapshot()?.links||{}),
   getNativeEntity:id=>npcStore.getNativeEntity(id),
   getFactionForCorporation:id=>factions.getFactionIDForCorporation(id),
   getStargatesForSystem:id=>worldData.getStargatesForSystem(id),
   getGate:id=>worldData.getStargateByID(id),
   // FW-112: the SDE faction owner of a system nobody has taken yet. Used ONLY when no
   // border between two registered territories exists any more, so a faction that holds
   // its whole frontier pushes into the next system instead of freezing the whole world.
   ownerOfSystem:systemID=>{
    try{
     const row=worldData.getSolarSystemByID(Number(systemID));
     return Number(row&&row.factionID)||0;
    }catch(_error){return 0}
   },
   readWarState,
   writeWarState:state=>store.write(state),
   reserveBounty:warBountyReserve,
   releaseBounty:warBountyRelease,warCasualtySnapshot,
   navyCapability:({attackerFactionID,defenderFactionID})=>{
    try{
     const capability=warNavyCapability();
     if(!capability)return {open:false,reason:"NO_NAVY_CAPABILITY:UNAVAILABLE"};
     return capability.decide({attackerFactionID,defenderFactionID});
    }catch(_error){return {open:false,reason:"NO_NAVY_CAPABILITY:UNAVAILABLE"}}
   },
   // FW-027: a real war fleet is presence too (the roster proves the hulls).
   fleetPresence:args=>{
    try{return require("./coopWarFleetRoster").sharedRoster().presence(args)}
    catch{return []}
   },
   // FW-092 (measured): a faction only earns from a kill it can SELL. The scenes
   // carry the real stations of each system, so market access is a measured fact,
   // not a guess. It is a preference for the planner (an unreachable market is
   // planned last, never refused) and unknown when the scene cannot be built.
   marketAccess:systemID=>{
    try{
     const scene=require("./runtime").ensureScene(Number(systemID),{refreshStargates:false});
     return (scene?.staticEntities||[]).some(x=>x&&x.kind==="station"&&Number(x.itemID)>0);
    }catch(_error){return null}
   },
   minShips:Math.max(1,Number(process.env.EVEJS_COOP_WAR_TERRITORY_MIN_SHIPS)||1)
  });
 }
 // The war domain already knows its own systems. Measured: the frontier refused to
 // open while the territory map clearly held 30003837 (500004) next to 30045344
 // (500011), because the tick only ever saw systems the A-Life walker had visited
 // this process. A system the war state already owns is a real system for the
 // planner, so the two sets are unioned instead of trusting one of them.
 let knownSystems=[...visitedSystems];
 let known=null;
 try{
  known=store.read();
  for(const id of Object.keys((known&&known.territories)||{})){
   const systemID=Number(id);
   if(Number.isSafeInteger(systemID)&&systemID>0&&!knownSystems.includes(systemID))
    knownSystems.push(systemID);
  }
 }catch(_error){/* the war state is optional here */}
 // FW-080: the opener only sees the systems in this list, and the list was cut at
 // twelve while the world legitimately owns more. Measured 15:50Z: 30003829 was
 // registered as a 500001 territory (FW-045) and every hull was standing there, yet the
 // tick list ended at 30045341 - the new front was invisible, and the only refusal the
 // world could publish was an empty map. Owned systems are ordered newest-change first
 // so a freshly taken or freshly registered system is never the one that falls off.
 const ownedIDs=Object.keys((known&&known.territories)||{}).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0);
 const ordered=[...ownedIDs.reverse(),...knownSystems];
 const tickSystems=[...new Set(ordered)].slice(0,24);
 let result;
 // FW-062: hand the opener the real funding state. A live campaign whose escrow
 // vanished (measured: the treasury row reverted and two ASSAULT campaigns kept
 // running with nothing behind them) cannot pay anybody, so it is expired instead of
 // squatting its target forever. Unreadable money is NOT treated as missing.
 let isCampaignFunded=null;
 try{
  const treasury=warTreasuryStore(),snapshot=treasury.snapshot();
  const rows=Object.values((snapshot&&snapshot.reservations)||{});
  const funded=new Set(rows.filter(row=>row&&(row.status==="HELD"||row.status==="PAID"))
   .map(row=>String(row.campaignID||"")));
  isCampaignFunded=campaign=>funded.has(String(campaign&&campaign.campaignID||""));
 }catch(_error){isCampaignFunded=null}
 try{result=warOpening.tick({systemIDs:tickSystems,isCampaignFunded})}
 catch(error){
  warSkip("opening","OPENING_THROW:"+String(error&&error.message||error));
  return;
 }
 // FW-053/053B/059: an expired campaign releases its escrow, a payout left with an
 // unreleased second leg is finished, and the same reconciliation runs for state a
 // previous process left behind.
 if(Array.isArray(result.expiredCampaignIDs)&&result.expiredCampaignIDs.length){
  try{refundExpiredCampaigns(result.expiredCampaignIDs);}
  catch(error){
   console.warn("[CoopFactionWar] expired escrow refund failed",String(error&&error.message||error));
  }
 }
 try{reconcileTerminalEscrow();}
 catch(error){
  console.warn("[CoopFactionWar] terminal escrow reconcile failed",String(error&&error.message||error));
 }
 try{reconcileBountyCredits();}
 catch(error){
  console.warn("[CoopFactionWar] bounty credit reconcile failed",String(error&&error.message||error));
 }
 if(result.status!=="OPENED"){
  const reason=String(result.reason||result.status||"UNKNOWN");
  // The refusal can come from the planner (plan.skipped) or from the applier, which
  // names each border it refused to fund (result.skipped). Both must be published.
  const skips=[].concat(Array.isArray(result.plan?.skipped)?result.plan.skipped:[],
   Array.isArray(result.skipped)?result.skipped:[]);
  // Deduplicate on the reason AND the per-border detail. Measured: a border that
  // changed from "no navy" to "no money" kept the same top-level reason
  // NO_OPENABLE_FRONT, so the new precondition was never published and the world
  // looked frozen for an hour. Every distinct refusal now gets its own event.
  const key=reason+"|"+String(result.refusedCommand||"")+"|"+String(result.refusedEdge?JSON.stringify(result.refusedEdge):"")+"|"+JSON.stringify(skips).slice(0,600);
  if(warSkipReasons["opening"]!==key){
   try{
    require("./coopRuntimeProbe").observe("living-native-war-opening-blocked",null,null,{
     status:"BLOCKED",reason,
     // FW-084: the applier's refusal now carries the planner's own view too.
     territories:result.territories||result.plan?.territories||{},
     presence:result.plan?.summary||result.presence||{},
     fronts:Number(result.fronts)||(result.plan?.fronts||[]).length,
     // FW-081: which command and which border the state machine refused.
     refusedCommand:String(result.refusedCommand||""),
     refusedWarID:String(result.refusedWarID||""),
     refusedCampaignID:String(result.refusedCampaignID||""),
     refusedEdge:result.refusedEdge||null,
     skipped:skips.slice(0,8),
     tickSystems,
     visitedSystems:[...visitedSystems].slice(0,12),
     evidence:"REAL_PRESENCE_DERIVED_NO_FRONT_INVENTED"
    });
   }catch(_error){/* probe is best effort */}
   warSkipReasons["opening"]=key;
  }
  return warSkip("opening",reason);
 }
 console.log("[CoopFactionWar] war opened "+result.warIDs.join(",")+
  " campaigns "+result.campaignIDs.join(","));
 require("./coopRuntimeProbe").observe("living-native-war-opened",null,null,{
  status:result.status,warIDs:result.warIDs,campaignIDs:result.campaignIDs,
  presence:result.presence,territories:result.territories,fronts:result.fronts,
  funding:result.fundings,
  evidence:"REAL_PRESENCE_REAL_RECIPROCAL_GATE_PAPER_TREASURY"
 });
 // One front report per real opening, to the systems it really touches.
 for(const campaignID of result.campaignIDs||[]){
  const campaign=result.state&&result.state.campaigns&&result.state.campaigns[campaignID];
  if(!campaign)continue;
  warFrontChat("war-opened",{
   eventKey:campaignID,
   attackerFactionID:Number(result.state.wars?.[campaign.warID]?.attackerFactionID)||0,
   defenderFactionID:Number(result.state.wars?.[campaign.warID]?.defenderFactionID)||0,
   targetSystemID:campaign.targetSystemID,
  },[campaign.sourceSystemID,campaign.targetSystemID]);
 }
}
// FW-010B: PREPARING becomes ASSAULT only when the mobiliser has really put
// native ships on both sides of that border. No muster, no assault.
function advanceNativeWarAssault(){
 const {enabled}=require("./coopWarMobilizer");
 if(!enabled(process.env))return warSkip("assault","WAR_FLAGS_OFF");
 const registry=nativeWarFleetRegistry();
 if(!registry)return warSkip("assault","NO_WAR_FLEET_REGISTRY");
 try{ensureWarState()}catch(_error){return warSkip("assault","NO_WAR_STATE")}
 const core=require("./coopFactionWarCore"),assault=require("./coopFactionWarAssault");
 const store=warStateStore();
 let state;
 try{state=store.read()}
 catch(_error){return warSkip("assault","INVALID_WAR_STATE")}
 if(!state)return warSkip("assault","NO_WAR_STATE");
 const readiness=assault.campaignReadiness({state,ships:registry.snapshot()?.ships});
 if(readiness.status!=="READY")return warSkip("assault",String(readiness.reason||readiness.status));
 const begun=assault.beginAssault({state,readiness});
 if(begun.status!=="ASSAULT_BEGUN")return warSkip("assault",String(begun.reason||begun.status));
 store.write(begun.state);
 console.log("[CoopFactionWar] assault begun "+begun.campaignID+
  " attacker="+begun.attackerShips.length+" defender="+begun.defenderShips.length);
 require("./coopRuntimeProbe").observe("living-native-war-assault",null,null,{
  status:begun.status,campaignID:begun.campaignID,warID:begun.warID,
  attackerShips:begun.attackerShips,defenderShips:begun.defenderShips,
  evidence:"REAL_NATIVE_MUSTER_ON_BOTH_SIDES"
 });
 const begunCampaign=begun.state&&begun.state.campaigns&&begun.state.campaigns[begun.campaignID];
 warFrontChat("assault-begun",{
  eventKey:begun.campaignID,
  targetSystemID:Number(begunCampaign&&begunCampaign.targetSystemID)||0,
  attackerShips:begun.attackerShips.length,
  defenderShips:begun.defenderShips.length,
 },[
  Number(begunCampaign&&begunCampaign.sourceSystemID)||0,
  Number(begunCampaign&&begunCampaign.targetSystemID)||0,
 ]);
}
// FW-102: the mobiliser is created lazily by the phase that runs inside the world
// cycle, and every other reader of it answered MOBILIZER_NOT_INITIALIZED. MEASURED on
// the play stack 2026-10-30: `war_diagnose` - the one read-only action whose whole job
// is to explain an empty side - returned MOBILIZER_NOT_INITIALIZED while the phase kept
// ticking, so the operator could not see a single per-side rejection reason. The
// factory is shared, so the diagnostic dry-runs the exact same authorities the phase
// uses (a dry run never writes, reserves or orders anything).
function warMobilizerInstance(registry,guard){
 if(warMobilizer)return warMobilizer;
 if(!registry||!guard||!identityRegistry)return null;
 const {createWarMobilizer}=require("./coopWarMobilizer");
 const native=require("./runtime"),npcStore=require("./npc/nativeNpcStore"),
  controllers=require("./npc/npcRegistry"),
  factions=require("../services/faction/factionState"),
  dogma=require("./combat/weaponDogma"),
  capability=require("./npc/npcCapabilityResolver");
 const readiness=require("./coopWarMusterReadiness").createWarMusterReadiness({
  store:npcStore,resolveFamily:dogma.resolveWeaponFamily,
  isOptional:dogma.isChargeOptionalTurretWeapon,
  compatible:capability.isNpcChargeCompatibleWithModule
 });
 warMobilizer=createWarMobilizer({
  registry,
  readWarState:()=>warStateStore().read(),
  readLinks:()=>Object.values(identityRegistry.snapshot().links||{}),
  // Existing scenes only: a military director must never manufacture an
  // enemy or force NPC materialization by observing an unvisited system.
  sceneForSystem:id=>native.scenes instanceof Map?native.scenes.get(id):null,
  getNativeEntity:id=>npcStore.getNativeEntity(id),
  getController:id=>controllers.getControllerByEntityID(id),
  getFactionForCorporation:id=>factions.getFactionIDForCorporation(id),
  inspectReadiness:context=>readiness.inspect(context),
  getOrderLeases:()=>guard.snapshot().leases,
  isTactical:id=>tacticsDirector?.activeIDs()?.has(id)===true,
  // Command size comes from real rank. No pilot has earned merit yet, so every
  // side starts at a recruit's single ship instead of the old blanket two.
  commandCap:({assignedPilotIDs})=>require("./coopFactionWarMerit")
   .sideCommandCap({pilotIDs:assignedPilotIDs,records:warMeritRecords()})
 });
 return warMobilizer;
}
function advanceNativeWarMobilization(){
 const {enabled,createWarMobilizer}=require("./coopWarMobilizer");
 if(!enabled(process.env))return warSkip("mobilization","WAR_FLAGS_OFF");
 if(!visitedSystems.size)return warSkip("mobilization","NO_VISITED_SYSTEMS");
 if(!identityRegistry)return warSkip("mobilization","NO_IDENTITY_REGISTRY");
 const registry=nativeWarFleetRegistry(),guard=npcOrderBridge();
 if(!registry)return warSkip("mobilization","NO_WAR_FLEET_REGISTRY");
 if(!guard)return warSkip("mobilization","NO_ORDER_BRIDGE");
 // The war domain needs a valid state record to exist at all. Without it every
 // mobilisation answers INVALID_MOBILIZATION_STATE, which looks like a broken
 // feature instead of an empty world. One shared, idempotent bootstrap owns it.
 try{ensureWarState()}catch(error){
  warSkip("mobilization","WAR_STATE_WRITE_FAILED:"+String(error&&error.message||error));
  return;
 }
 const mobilizer=warMobilizerInstance(registry,guard);
 if(!mobilizer)return warSkip("mobilization","MOBILIZER_CREATE_FAILED");
 const result=mobilizer.tick({systemIDs:[...visitedSystems].sort((a,b)=>a-b).slice(0,20)});
 // FW-110: custody of a hull the pilot provably left is released, and the release is
 // published. MEASURED 2026-10-30: a restart re-materialized the front fleet with new
 // entity ids while the registry kept the old ones, so every muster answered PILOT_IN_USE
 // and five campaigns expired with assigned 0. Silent custody changes would hide that.
 if(Array.isArray(result.released)&&result.released.length)
  require("./coopRuntimeProbe").observe("living-native-war-custody-stale",null,null,
   {status:"RELEASED",rows:result.released.slice(0,8),
    evidence:"REGISTRY_HULL_NO_LONGER_THE_PILOTS_PHYSICAL_SHIP"});
 if(result.mobilized.length)require("./coopRuntimeProbe").observe(
  "living-native-war-mobilization",null,null,
  {status:result.status,ships:result.mobilized,
   evidence:"EXISTING_NATIVE_PATROLS_RESERVED_NO_SPAWN_OR_FUNDS"});
 else if(Array.isArray(result.blocked)&&result.blocked.length){
  // The native fleet registry refused the real hull. Its own reason is the only
  // honest explanation of an empty side, so publish it once per distinct set.
  const signature=JSON.stringify(result.blocked.map(x=>x.entityID+":"+x.reason));
  if(warSkipReasons["mobilization-blocked"]!==signature){
   warSkipReasons["mobilization-blocked"]=signature;
   require("./coopRuntimeProbe").observe("living-native-war-mobilization-blocked",
    null,null,{status:"BLOCKED",ships:result.blocked.slice(0,8),
     evidence:"NATIVE_FLEET_REGISTRY_REFUSED_ASSIGN"});
  }
 } else{
  // FW-102: "OBSERVED" with an empty mobilized[] is exactly what a stalled front
  // looks like, and the phase published nothing but the word OBSERVED. The per-side
  // report (system tracked? how many candidates passed every native gate? the first
  // rejection reasons) is published once per distinct set, so the reason a side stays
  // empty is visible without attaching an inspector to the live server.
  const report=Array.isArray(result.campaigns)?result.campaigns:[];
  const signature=JSON.stringify(report.map(c=>[c.campaignID,Array.isArray(c.sides)?
   c.sides.map(s=>[s.factionID,s.systemID,s.status,s.assigned,
    (s.rejected||[]).map(r=>r.reason)]):[]]));
  if(report.length&&warSkipReasons["mobilization-idle"]!==signature){
   warSkipReasons["mobilization-idle"]=signature;
   require("./coopRuntimeProbe").observe("living-native-war-mobilization-idle",
    null,null,{status:String(result.status||"UNKNOWN"),campaigns:report.slice(0,4),
     activeCampaignCount:Number(result.activeCampaignCount)||0,
     evidence:"NO_CANDIDATE_PASSED_EVERY_NATIVE_GATE"});
  } else warSkip("mobilization","NO_MOBILIZED_SHIP:"+String(result.status||"UNKNOWN"));
 }
}
// FW-003D: a registered battle-line hull that has no compatible charge left can
// never fire again, and the mobiliser counts every registered hull of a side, so
// one dry hull would block that side for the rest of the campaign. Release only
// war custody (native RELEASE proof), never the hull, its modules or its cargo.
function advanceNativeWarBattleLineRelief(){
 if(process.env.EVEJS_COOP_FACTION_WAR_RELIEF!=="1")return;
 if(!visitedSystems.size)return warSkip("relief","NO_VISITED_SYSTEMS");
 const registry=nativeWarFleetRegistry();
 if(!registry)return warSkip("relief","NO_WAR_FLEET_REGISTRY");
 try{
  if(!warRelief){
   const native=require("./runtime"),npcStore=require("./npc/nativeNpcStore"),
    dogma=require("./combat/weaponDogma"),capability=require("./npc/npcCapabilityResolver"),
    npc=require("./npc/npcRuntime");
   // Restart safety: a hull whose wreck is already in the durable casualty ledger
   // stays out of the battle line even though this process never saw the wreck.
   if(!casualtySeedDone){
    casualtySeedDone=true;
    try{
     const row=require("./coopNativeRowPath").readRow(
      require("../gameStore"),"corporationRuntime","coop-faction-war\u001fcasualties-v1");
     for(const entry of Object.values(row?.byWreck||{})){
      const id=Number(entry?.entityID);
      if(Number.isSafeInteger(id)&&id>0)destroyedNativeShips.add(id);
     }
    }catch(error){
     console.warn("[CoopWarRelief] casualty seed",String(error&&error.message||error));
    }
   }
   // The dry verdict is the mobiliser's own rule, never a second opinion.
   const readiness=require("./coopWarMusterReadiness").createWarMusterReadiness({
    store:npcStore,resolveFamily:dogma.resolveWeaponFamily,
    isOptional:dogma.isChargeOptionalTurretWeapon,
    compatible:capability.isNpcChargeCompatibleWithModule
   });
   warRelief=require("./coopWarBattleLineRelief").createWarBattleLineRelief({
    registry,
    sceneForSystem:id=>native.scenes instanceof Map?native.scenes.get(id):null,
    getNativeEntity:id=>npcStore.getNativeEntity(id),
    inspectReadiness:context=>readiness.inspect(context),
    // A hull this process confirmed as a real native wreck is not merely idle:
    // it is gone, and its slot must not stay occupied by a corpse.
    isDestroyed:id=>destroyedNativeShips.has(Number(id)),
    // Both calls are the same native manual-order API the battle director uses:
    // stop clears the live target, resumeBehavior clears the manual order, which
    // is exactly what the registry's native release proof requires.
    clearOrder:({entityID})=>{npc.issueOrder(entityID,{type:"stop"});
     npc.resumeBehavior(entityID);}
   });
  }
  const result=warRelief.tick({systemIDs:[...visitedSystems].slice(0,12)});
  if(result.released.length)require("./coopRuntimeProbe").observe(
   "living-native-war-battle-line-relief",null,null,
   {status:result.status,ships:result.released,
    evidence:"NO_COMPATIBLE_CHARGE_LEFT_SLOT_RELEASED_HULL_PRESERVED"});
  else if(result.dry.length)warSkip("relief","RELEASE_BLOCKED:"+
   String(result.blocked[0]&&result.blocked[0].reason||"UNKNOWN"));
 }catch(error){
  warSkip("relief","RELIEF_FAILED:"+String(error&&error.message||error));
 }
}
// Read-only operator diagnostic: what would mobilization do right now, and why
// not. Uses the same live authorities and the mobilizer's own dry run, so it can
// never reserve, order or mutate anything.
// Read-only: the war state as the phases really see it. Territories, wars and
// campaigns are the exact rows the opening/assault phases read, so "no front" and
// "0 campaigns" stop being guesses. It never writes, reserves or plans.
function diagnoseWarState(){
 let state;
 try{state=warStateStore().read();}
 catch(error){return {status:"WAR_STATE_UNAVAILABLE",
  reason:String(error&&error.message||error).slice(0,120)};}
 if(!state||typeof state!=="object")return {status:"NO_WAR_STATE"};
 const territories=state.territories&&typeof state.territories==="object"?
  state.territories:{};
 const wars=Object.values(state.wars||{}).map(war=>({
  warID:String(war?.warID||""),
  attackerFactionID:Number(war?.attackerFactionID)||0,
  defenderFactionID:Number(war?.defenderFactionID)||0,
  // The war record carries `state` (the value every phase gates on). Reporting
  // only a `status` field that the record does not have made every war look
  // stateless to an operator.
  state:String(war?.state||""),
  status:String(war?.state||war?.status||""),
  startedAt:Number(war?.startedAt)||0,
 }));
 const campaigns=Object.values(state.campaigns||{}).map(campaign=>({
  campaignID:String(campaign?.campaignID||""),
  warID:String(campaign?.warID||""),
  sourceSystemID:Number(campaign?.sourceSystemID)||0,
  targetSystemID:Number(campaign?.targetSystemID)||0,
  state:String(campaign?.state||""),
  status:String(campaign?.state||campaign?.status||""),
  startedAt:Number(campaign?.startedAt)||0,
  structureID:Number(campaign?.structureID)||0,
 }));
 const campaignStates={};
 for(const campaign of campaigns)
  campaignStates[campaign.state||"UNKNOWN"]=
   (campaignStates[campaign.state||"UNKNOWN"]||0)+1;
 return {status:"OK",version:Number(state.version)||0,
  territories,wars,campaigns,campaignStates,
  counts:{territories:Object.keys(territories).length,wars:wars.length,
   campaigns:campaigns.length},
  presence:presenceSummary()};
}
// The same presence the opening phase derives territories from: per system, how
// many linked pilots resolve to a real faction, and why a link was skipped. A
// funded faction with no territory here can never get a front.
function diagnoseMobilization(){
 if(!visitedSystems.size)return {status:"NO_VISITED_SYSTEMS"};
 // FW-102: build the mobiliser with the same factory the phase uses instead of
 // reporting NOT_INITIALIZED whenever the phase has not ticked in this process yet.
 let runtimeMobilizer=null,why="";
 try{
  const registry=nativeWarFleetRegistry(),guard=npcOrderBridge();
  if(!registry)why="NO_WAR_FLEET_REGISTRY";
  else if(!guard)why="NO_ORDER_BRIDGE";
  else if(!identityRegistry)why="NO_IDENTITY_REGISTRY";
  else runtimeMobilizer=warMobilizerInstance(registry,guard);
 }catch(error){why="MOBILIZER_CREATE_THREW:"+String(error&&error.message||error)}
 if(!runtimeMobilizer)return {status:"MOBILIZER_NOT_INITIALIZED",reason:why||"UNKNOWN"};
 try{
  // Every tracked system is offered to the planner, sorted so the set never
  // depends on the order the world happened to visit systems in. The mobiliser
  // itself reports one block per LIVE campaign (campaigns[]), so a second war
  // can no longer be hidden behind the first one.
  const systemIDs=[...visitedSystems].sort((a,b)=>a-b).slice(0,20);
  const result=runtimeMobilizer.tick({systemIDs,dryRun:true});
  return Object.assign({},result,{systemIDs,
   campaignCount:Array.isArray(result.campaigns)?result.campaigns.length:0});
 }catch(error){
  return {status:"DIAGNOSE_FAILED",reason:String(error&&error.message||error)};
 }
}
// Read-only operator diagnostic for the battle leg. For every registered war
// hull it reports the physical scene, the native controller and the exact
// pairing verdict the director would get, so a silent "no attack order" tick is
// explained instead of guessed at. It never issues an order, reserves a ship,
// writes a row or spends ammo.
function diagnoseCombat(){
 const api=require("./coopWarCombatAuthority");
 const flags={combat:api.combatEnabled(),ammo:api.ammoEnabled()};
 if(!visitedSystems.size)return {status:"NO_VISITED_SYSTEMS",flags};
 let war,fleet;
 try{
  war=warStateStore().read();
  fleet=nativeWarFleetRegistry()?.snapshot();
 }catch(error){
  return {status:"NATIVE_STATE_UNAVAILABLE",flags,
   reason:String(error&&error.message||error)};
 }
 if(war?.version!==1||fleet?.version!==1)
  return {status:"WAR_OR_FLEET_STATE_INVALID",flags};
 const runtime=require("./runtime"),controllers=require("./npc/npcRegistry"),
  entityStore=require("./npc/nativeNpcStore");
 let authority=null;
 try{
  authority=api.createWarCombatAuthority({
   gameStore:require("../gameStore"),
   getController:id=>controllers.getControllerByEntityID(id),
   getNativeEntity:id=>entityStore.getNativeEntity(id),
   getFactionForCorporation:id=>
    require("../services/faction/factionState").getFactionIDForCorporation(id)
  });
 }catch(error){
  return {status:"AUTHORITY_UNAVAILABLE",flags,
   reason:String(error&&error.message||error)};
 }
 const vec=x=>x&&["x","y","z"].every(k=>typeof x[k]==="number"&&
  Number.isFinite(x[k]));
 const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
 const ships=[],entities=new Map();
 for(const row of Object.values(fleet.ships)
  .sort((a,b)=>a.entityID-b.entityID).slice(0,32)){
  const scene=runtime.scenes instanceof Map?
   runtime.scenes.get(row.systemID):null;
  const entity=scene?.getEntityByID?.(row.entityID)||null;
  let ctrl=null,native=null,hp=null;
  try{ctrl=controllers.getControllerByEntityID(row.entityID)}catch{}
  try{native=entityStore.getNativeEntity(row.entityID)}catch{}
  try{
   // The same authoritative native health layers the combat evidence sampler
   // uses: a reported activation is not damage, a measured layer loss is.
   const damage=require("./combat/damage");
   const max=damage.getEntityMaxHealthLayers(entity);
   if(entity&&Object.values(max).some(n=>n>0))
    hp=damage.getEntityCurrentHealthLayers(entity,max);
  }catch{hp=null}
  const campaign=war.campaigns[row.campaignID]||null,
   factionID=Number(row.factionID)||0;
  const opponentSystem=Number(campaign?.targetSystemID)||0;
  ships.push({entityID:row.entityID,pilotID:row.pilotID,
   factionID,systemID:row.systemID,campaignID:row.campaignID,
   warID:row.warID,
   campaignState:String(campaign?.state||"UNKNOWN"),
   warState:String(war.wars[row.warID]?.state||"UNKNOWN"),
   // The battle can only happen in the campaign's target system.
   inBattleSystem:opponentSystem===0||row.systemID===opponentSystem,
   nativeSystemID:Number(native?.systemID)||0,
   nativeTransient:native?.transient===true,
   sceneSystemID:Number(scene?.systemID)||0,
   inScene:Boolean(entity),kind:String(entity?.kind||""),
   nativeNpc:entity?.nativeNpc===true,
   playerSession:Number(entity?.session?.characterID)||0,
   mode:String(entity?.mode||""),
   position:vec(entity?.position)?entity.position:null,
   hp,
   controllerSystemID:Number(ctrl?.systemID)||0,
   currentTargetID:Number(ctrl?.currentTargetID)||0,
   manualOrder:ctrl?.manualOrder?
    {type:String(ctrl.manualOrder.type||""),
     targetID:Number(ctrl.manualOrder.targetID)||0}:null,
   ammoRetreat:nativeAmmoSupply?.activeIDs(row.systemID)?.has(row.entityID)===true,
   tacticalBusy:tacticsDirector?.activeIDs()?.has(row.entityID)===true});
  if(entity)entities.set(row.entityID,entity);
 }
 const pairs=[];
 for(const attacker of ships)for(const target of ships){
  if(attacker.entityID>=target.entityID)continue;
  if(attacker.campaignID!==target.campaignID||
   attacker.factionID===target.factionID)continue;
  const a=entities.get(attacker.entityID),b=entities.get(target.entityID);
  const shared=a&&b&&a.position&&b.position?
   Math.round(dist(a.position,b.position)):null;
  let verdict;
  try{
   verdict=authority.evaluatePair(a,b,{requireAttackIntent:false});
  }catch(error){verdict={status:"BLOCKED",
   reason:String(error&&error.message||error)}}
  pairs.push({attackerID:attacker.entityID,targetID:target.entityID,
   sameSystem:attacker.systemID===target.systemID,
   distanceMeters:shared,
   inRange:shared!==null&&shared<=250000,
   verdict:String(verdict?.status||"UNKNOWN"),
   reason:String(verdict?.reason||""),
   warID:String(verdict?.warID||"")});
 }
 return {status:"OBSERVED",flags,
  visitedSystems:[...visitedSystems].slice(0,12).sort((a,b)=>a-b),
  campaigns:Object.values(war.campaigns).slice(0,16).map(c=>({
   campaignID:c.campaignID,warID:c.warID,state:c.state,
   sourceSystemID:c.sourceSystemID,targetSystemID:c.targetSystemID})),
  ships,pairs};
}
// A PREPARED ammo-bank journal can only be recovered OUTSIDE the native fire
// cycle: a transaction is not re-entrant there, so the hot path can refuse but
// must not repair. This bounded phase recovers journals that the SQLite replay
// fence proves never committed, so one failed transaction cannot leave a real
// warship permanently unable to fire. Nothing is refunded and nothing is
// invented: a fence at the boundary keeps the ship in operator repair.
function ensureNativeWarGateHandoff(runtime){
 if(process.env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER!=="1")return;
 const {flag,createWarGateHandoff}=require("./coopWarGateHandoff");
 if(!flag(process.env))
  throw Error("WAR_GATE_HANDOFF_FLAGS_INCOMPLETE");
 if(warGateHandoff){
  const audit=warGateHandoff.auditStartup();
  if(audit.status!=="CLEAN")
   throw Error("WAR_GATE_HANDOFF_REQUIRES_REPAIR:"+audit.status);
  return;
 }
 if(!identityRegistry)throw Error("WAR_GATE_IDENTITY_MISSING");
 const worldData=require("./worldData"),controllers=require("./npc/npcRegistry"),
  store=require("./npc/nativeNpcStore"),service=require("./npc/nativeNpcService"),
  scramble=require("./modules/hostileModuleRuntime");
 const instance=createWarGateHandoff({
  gameStore:require("../gameStore"),identityRegistry,
  sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  getGate:id=>worldData.getStargateByID(id),
  nativeStore:store,service,
  getController:id=>controllers.getControllerByEntityID(id),
  isScrambled:ship=>scramble.isEntityWarpScrambled(ship),
  journalDir:process.env.EVEJS_COOP_WAR_TRANSFER_JOURNAL_DIR||
   "/var/lib/evejs/coop-war-native-transfers"
 });
 // Keep the controller available to the privileged local operator
 // even if startup is intentionally blocked by an unresolved warship.
 warGateHandoff=instance;
 // The protected recovery channel must stay reachable after quarantine
 // blocks normal world materialization.
 ensureWarRecoverySocket();
 const audit=instance.auditStartup();
 if(audit.status!=="CLEAN")
  throw Error("WAR_GATE_HANDOFF_REQUIRES_REPAIR:"+audit.status);
}
function advanceNativeWarGateStaging(){
 if(process.env.EVEJS_COOP_FACTION_WAR_GATE_APPROACH!=="1")
  return warSkip("gate-staging","GATE_APPROACH_FLAG_OFF");
 if(!visitedSystems.size)return warSkip("gate-staging","NO_VISITED_SYSTEMS");
 const {createWarGateStaging,gateReason}=require("./coopWarGateStaging");
 const flags=gateReason(process.env);
 if(flags)return warSkip("gate-staging",flags);
 const guard=npcOrderBridge();
 if(!guard)return warSkip("gate-staging","NO_ORDER_BRIDGE");
 if(!nativeWarFleetRegistry())return warSkip("gate-staging","NO_WAR_FLEET_REGISTRY");
 if(process.env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1"){
  ensureNativeWarGateHandoff(require("./runtime"));
  const finished=warGateHandoff?.retireCompleted({max:2});
  if(finished?.retired?.length)
   require("./coopRuntimeProbe").observe(
    "living-native-war-transit-retired",null,null,{
     status:finished.status,retired:finished.retired,
     evidence:"PROVEN_TERMINAL_TRANSFER_ARCHIVED_NO_SHIP_MOVEMENT"
    });
 }
 if(!warGateStaging){
  const native=require("./runtime"),npc=require("./npc/npcRuntime"),
   controllers=require("./npc/npcRegistry"),worldData=require("./worldData"),
   gameStore=require("../gameStore"),
   warStore=require("./coopFactionWarStore"),
   fleetStore=require("./coopWarFleetRegistry"),
   treasuryStore=require("./coopWarTreasury"),
   warCore=require("./coopFactionWarCore"),
   nativeRows=require("./coopNativeRowPath");
  function readRow(table,key,validate){
   // War rows live in the atomic-rows keyspace, whose JSON cache path is nested
   // at the \u001f separator; the raw key read reports ENTRY_NOT_FOUND.
   const row=nativeRows.readRow(gameStore,table,key,validate);
   return row||null;
  }
  warGateStaging=createWarGateStaging({
   readWar:()=>readRow(warStore.TABLE,warStore.KEY,warCore.validateState),
   readFleet:()=>readRow(fleetStore.TABLE,fleetStore.KEY,fleetStore.validate),
   readTreasury:()=>readRow(treasuryStore.TABLE,treasuryStore.KEY,treasuryStore.validate),
   sceneForSystem:id=>native.scenes instanceof Map?native.scenes.get(id):null,
   getGate:id=>worldData.getStargateByID(id),
   warpToEntity:(id,targetID,opts)=>npc.warpToEntity(id,targetID,opts),
   getController:id=>controllers.getControllerByEntityID(id),
   bridge:guard,
   transfer:warGateHandoff?(args=>warGateHandoff.transfer(args)):null,
   // The durable, behaviour-loop-respecting form: a native manual movement order
   // on the real gate entity. A one-shot follow loses to the NPC's own loop.
   orderFollow:(entityID,targetID,options)=>{
    try{
     const answer=require("./npc/npcService").issueManualOrder(entityID,{
      type:"follow",targetID,followRangeMeters:Number(options?.rangeMeters)||1000,
      allowWeapons:false});
     if(answer?.success!==true)followOrderReason=String(answer?.errorMsg||"MANUAL_FOLLOW_ORDER_REFUSED");
     return answer?.success===true;
    }catch(error){
     followOrderReason="MANUAL_FOLLOW_ORDER_THROW:"+String(error?.message||error).slice(0,80);
     return false;
    }
   },
   isTactical:id=>tacticsDirector?.activeIDs()?.has(id)===true,
   isAmmoRetreat:(systemID,id)=>nativeAmmoSupply?.activeIDs(systemID)?.has(id)===true
  });
 }
 const result=warGateStaging.tick({systemIDs:[...visitedSystems].slice(0,12)});
 for(const moved of result.orders){
  if(moved.action==="VERIFIED_NATIVE_GATE_TRANSFER")
   visitedSystems.add(Number(moved.targetSystemID));
 }
 // An order is real evidence and is always published. A refusal is published
 // once per distinct set so a front whose attacker never arrives names the
 // exact precondition instead of looking like a silent no-op.
 const skips=Array.isArray(result.skips)?result.skips:[];
 const key=JSON.stringify(skips);
 if(result.orders.length){
  gateStagingSkipKey=key;
  require("./coopRuntimeProbe").observe("living-native-war-gate-staging",
   null,null,{status:result.status,orders:result.orders,
    observations:result.observations,skips,followOrderReason,
    evidence:"PHYSICAL_GATE_APPROACH_ONLY_NO_SYSTEM_TRANSFER"});
 }else if(result.observations.length){
  require("./coopRuntimeProbe").observe("living-native-war-gate-staging",
   null,null,{status:result.status,orders:[],observations:result.observations,
    skips,followOrderReason,evidence:"PHYSICAL_GATE_APPROACH_ONLY_NO_SYSTEM_TRANSFER"});
 }else if(skips.length&&key!==gateStagingSkipKey){
  gateStagingSkipKey=key;
  require("./coopRuntimeProbe").observe("living-native-war-gate-staging",
   null,null,{status:"SKIPPED",reason:skips[0].reason,skips,followOrderReason,
    evidence:"EXPLICIT_PRECONDITION_NOT_MET"});
 }
}
// FW-033: a front that cannot refill is not a war. After real losses a side can
// hold zero hulls while the campaign stays in ASSAULT, and nothing ever puts a
// navy back. This refills a side through the SAME sanctioned spawn path an
// operator uses (`spawn_war_fleet`: real doctrine row, real native ship, real
// free pilot identity) and reports the native status of every attempt.
function advanceNativeWarGarrison(){
 const garrison=require("./coopWarGarrison");
 if(!garrison.enabled(process.env))return warSkip("garrison","FLAG_OFF");
 if(!nativeWarFleetRegistry())return warSkip("garrison","NO_WAR_FLEET_REGISTRY");
 if(!identityRegistry)return warSkip("garrison","NO_IDENTITY_REGISTRY");
 if(!warGarrison)warGarrison=garrison.createWarGarrison({
  readWarState:()=>warStateStore().read(),
  registry:nativeWarFleetRegistry(),
  // FW-115: a commander spawns the formation its EARNED merit allows (recruit 1, pilot 2,
  // wingman 3, squad-lead 5 ...), so a veteran side brings tackle, EWAR and logistics
  // instead of the single identical frigate every side used to field.
  meritOf:pilotID=>{
   try{
    // records() already answers the per-pilot map, not the whole ledger state.
    const row=warMeritRecords()?.[String(pilotID)];
    return Number(row&&row.merit)||0;
   }catch(_error){return 0}
  },
  // N5: a replacement hull must be paid for by the campaign chest, which only
  // ever holds ISK a real market fill paid to an NPC pilot (FW-005B). An unfunded
  // front stops buying navies, which is the only way a force-captured system
  // ever holds zero live defender hulls for the full sustain window (FW-035).
  chestCommitment:({factionID,warID,campaignID})=>{
   try{
    const snapshot=warChestStore().snapshot();
    if(!snapshot||snapshot.status!=="OK")
     return {status:"UNAVAILABLE",reason:"GARRISON_CHEST_UNAVAILABLE"};
    const entry=(snapshot.committed||[]).find(e=>
     Number(e.factionID)===Number(factionID)&&e.warID===warID&&
     e.campaignID===campaignID&&Number(e.totalCents)>0);
    if(!entry)return {status:"UNFUNDED",reason:"GARRISON_CHEST_EMPTY"};
    return {status:"FUNDED",totalCents:Number(entry.totalCents),journalID:entry.journalID};
   }catch(_error){return {status:"UNAVAILABLE",reason:"GARRISON_CHEST_UNAVAILABLE"}}
  },
  // A hull destroyed or despawned without a confirmed wreck keeps its custody
  // row (absence is never destruction), but its identity must not stay bound to
  // a ghost: that starved the garrison of commanders and froze the war with
  // NO_FREE_PILOT_IDENTITY. A link whose ship is in no live scene is reclaimed
  // here, and only then offered as a free pilot.
  listFreePilots:()=>{
   const native=require("./runtime");
   const links=Object.values(identityRegistry.snapshot()?.links||{});
   const linked=new Set(links.map(l=>String(l?.pilotID)));
   const free=(world?.snapshot?.().pilots||[])
    .map(p=>String(p?.id||"")).filter(id=>id&&!linked.has(id));
   for(const link of links){
    const pilotID=String(link?.pilotID||"");
    if(!pilotID)continue;
    const systemID=Number(link?.systemID),entityID=Number(link?.entityID);
    let live=false;
    try{
     const scene=native.scenes instanceof Map?native.scenes.get(systemID):null;
     live=Boolean(scene&&typeof scene.getEntityByID==="function"&&
      scene.getEntityByID(entityID));
    }catch{live=false}
    if(live)continue;
    try{
     const released=releaseSpawnedIdentity({pilotID,entityID,
      reason:"GHOST_HULL_NO_SCENE"});
     if(released?.status==="RELEASED")free.push(pilotID);
    }catch{}
   }
   return free;
  },
  isHullLive:(systemID,entityID)=>{
   try{
    const native=require("./runtime");
    const scene=native.scenes instanceof Map?native.scenes.get(Number(systemID)):null;
    return Boolean(scene&&typeof scene.getEntityByID==="function"&&
     scene.getEntityByID(Number(entityID)));
   }catch{return false}
  },
  spawnFleet:({factionID,systemID,commanderPilotID,merit})=>
   require("./coopAdminBridge").executeRequest({
    action:"spawn_war_fleet",factionID,systemID,merit,commanderPilotID})
 });
 const result=warGarrison.tick();
 if(result.applied.length)require("./coopRuntimeProbe").observe(
  "living-native-war-garrison",null,null,{
   status:result.status,applied:result.applied,
   evidence:"SANCTIONED_WAR_FLEET_SPAWN_NO_INVENTED_HULL"});
 else if(result.skips.length)warSkip("garrison",
  String(result.skips[0].reason||result.status));
}
function advanceNativeWarCombat(){
 const api=require("./coopWarCombatAuthority");
 if(!api.combatEnabled())return warSkip("combat","COMBAT_FLAGS_OFF");
 if(!api.ammoEnabled())return warSkip("combat","AMMO_FLAGS_OFF");
 if(!visitedSystems.size)return warSkip("combat","NO_VISITED_SYSTEMS");
 const guard=npcOrderBridge();
 if(!guard)return warSkip("combat","NO_ORDER_BRIDGE");
 if(!nativeWarFleetRegistry())return warSkip("combat","NO_WAR_FLEET_REGISTRY");
 const runtime=require("./runtime");
 if(!warBattleDirector){
  const npc=require("./npc/npcRuntime");
  const authority=api.createWarCombatAuthority({
   gameStore:require("../gameStore"),
   getController:id=>require("./npc/npcRegistry").getControllerByEntityID(id),
   getNativeEntity:id=>require("./npc/nativeNpcStore").getNativeEntity(id),
   getFactionForCorporation:id=>
    require("../services/faction/factionState").getFactionIDForCorporation(id)
  });
  warBattleDirector=require("./coopWarBattleDirector").createWarBattleDirector({
   authority,bridge:guard,
   sceneForSystem:id=>runtime.scenes instanceof Map?runtime.scenes.get(id):null,
   issueNativeAttack:(id,targetID,options)=>npc.issueAttackOrder(id,targetID,options),
   getController:id=>require("./npc/npcRegistry").getControllerByEntityID(id),
   isAmmoDepleted:(sys,id)=>nativeAmmoSupply?.activeIDs(sys)?.has(id)===true,
   isTactical:id=>tacticsDirector?.activeIDs()?.has(id)===true,
   // FW-117: the role a hull flies, so a destroyer hunts enemy tackle and an EWAR ship
   // hunts enemy support instead of everyone shooting the nearest hull.
   roleOfEntity:warHullRole
  });
 }
 // FW-031: a war hull spawned at a belt anchor sits 150 km from home with a 90 km
 // native leash, so the behaviour loop cleared its combat state every think and an
 // accepted attack order never became a target. Clear the leash and orbit inside
 // the real gun range BEFORE the director issues the order.
 try{
  if(!warPosture)warPosture=require("./coopWarEngagementPosture")
   .createWarEngagementPosture({
    readWarState:()=>warStateStore().read(),
    registry:nativeWarFleetRegistry(),
    getController:id=>require("./npc/npcRegistry").getControllerByEntityID(id),
    setBehaviorOverrides:(id,overrides)=>
     require("./npc/npcService").setBehaviorOverrides(id,overrides),
    // FW-118: each role keeps its own engagement range instead of one 500 m ball.
    roleOfEntity:warHullRole
   });
  const posture=warPosture.tick();
  if(posture.applied.length)require("./coopRuntimeProbe").observe(
   "living-native-war-engagement-posture",null,null,{
    status:posture.status,applied:posture.applied,
    skips:posture.skips.slice(0,4),
    evidence:"NATIVE_BEHAVIOUR_OVERRIDES_NO_LEASH_GUN_ORBIT"
   });
 }catch(error){
  warSkip("combat-posture","THREW:"+String(error?.message||error).slice(0,120));
 }
 const result=warBattleDirector.tick({systemIDs:[...visitedSystems].sort((a,b)=>a-b).slice(0,12)});
 // FW-030: a warp started here is what puts the two sides inside the native
 // 250 km firing envelope at all; the next tick's director can then fire.
 try{
  if(!warEngagement){
   const native=require("./runtime");
   warEngagement=require("./coopWarEngagementWarp")
    .createWarEngagementWarp({
     readWarState:()=>warStateStore().read(),
     registry:nativeWarFleetRegistry(),
     sceneForSystem:id=>native.scenes instanceof Map?native.scenes.get(id):null,
     getController:id=>require("./npc/npcRegistry").getControllerByEntityID(id),
     warpToPoint:(id,point,options)=>
      require("./npc/npcRuntime").warpToPoint(id,point,options),
     warpBatchToPoints:(requests,options)=>
      require("./npc/npcRuntime").warpBatchToPoints(requests,options)
    });
  }
  const engagement=warEngagement.tick({
   systemIDs:[...visitedSystems].sort((a,b)=>a-b).slice(0,12)});
  if(engagement.orders.length)require("./coopRuntimeProbe").observe(
   "living-native-war-engagement-warp",null,null,{
    status:engagement.status,orders:engagement.orders,
    skips:engagement.skips.slice(0,4),
    evidence:"REAL_NATIVE_WARP_TO_ENEMY_NO_DAMAGE"
   });
 }catch(error){
  warSkip("combat-warp","THREW:"+String(error?.message||error).slice(0,120));
 }
 if(result.orders.length)require("./coopRuntimeProbe").observe(
  "living-native-war-attack-orders",null,null,{
   status:result.status,orders:result.orders,
   evidence:"ACK_ONLY_NOT_DAMAGE_OR_KILL"
  });
 // Owner requirement: an enlisted player is one ship in a fleet, so the ranking
 // itself is published - who was considered, at what range, in which order and
 // why the chosen target won. A player who is only one of several candidates is
 // visible here instead of being inferred from the order list.
 if(Array.isArray(result.selections)&&result.selections.length){
  const signature=JSON.stringify(result.selections.map(s=>s.shipID+":"+
   s.candidates.map(c=>c.entityID+(c.chosen?"*":"")).join(",")));
  if(warSkipReasons["battle-selection"]!==signature){
   warSkipReasons["battle-selection"]=signature;
   require("./coopRuntimeProbe").observe("living-native-war-target-selection",
    null,null,{status:"RANKED",ships:result.selections.slice(0,8),
     evidence:"SAME_DISTANCE_RULE_FOR_NPC_AND_PLAYER"});
  }
 }
}
// FW-009B: original stocked native structures, real killmail combat
// proof, fully enumerated physical ships. No independent scheduler and
// no virtual capture. A missing source, unknown scene or absent explicit
// objective-type allowlist keeps military control unchanged.
function advanceNativeWarObjectives(){
 const {enabled,createWarObjectiveDirector}=require("./coopWarObjectiveDirector");
 if(!enabled(process.env)||!visitedSystems.size)return;
 if(!require("./coopWarObjectiveDirector").typesFromEnv(process.env).size)return;
 if(!warObjectiveDirector){
  const gameStore=require("../gameStore"),
   worldData=require("./worldData"),
   runtime=require("./runtime"),
   controllers=require("./npc/npcRegistry"),
   npcStore=require("./npc/nativeNpcStore"),
   factions=require("../services/faction/factionState"),
   structure=require("./coopWarNativeStructureControl"),
   proofApi=require("./coopWarNativeStructureCombatProof"),
   adjudicatorApi=require("./coopWarObjectiveAdjudicator");
  const getNativeStructure=id=>worldData.getStructureByID(id),
   getFactionForCorporation=id=>factions.getFactionIDForCorporation(id);
  const proof=proofApi.createWarStructureCombatProof({
   gameStore,getNativeStructure,getFactionForCorporation,
   getNativeKillmail:id=>
    require("../services/killmail/killmailState").getKillmailRecord(id)
  });
  const occupancy=structure.createNativeStructureControlWitness({
   sceneForSystem:id=>runtime.scenes instanceof Map?
    runtime.scenes.get(id):null,
   listAllPhysicalShips:structure.listPinnedSceneShips,
   getNativeEntity:id=>npcStore.getNativeEntity(id),
   getController:id=>controllers.getControllerByEntityID(id),
   getFactionForCorporation,
   allowMilitiaPlayers:process.env.EVEJS_COOP_FACTION_WAR_PLAYER_CAPTURE==="1",
   getLivePlayerSessions:()=>require("../services/chat/sessionRegistry").getSessions()
  });
  const adjudicator=adjudicatorApi.createWarObjectiveAdjudicator({
   gameStore,getNativeStructure,getFactionForCorporation,
   verifyNativeCombatDestruction:d=>
    proof.verifyNativeCombatDestruction(d),
   observeNativeControl:d=>occupancy.observe(d)
  });
  warObjectiveDirector=createWarObjectiveDirector({
   adjudicator,combatProof:proof,
   getFactionForCorporation,
   listNativeStructures:systemID=>worldData.getStructuresForSystem(systemID),
   readWarState:()=>warStateStore().read()
  });
 }
 const result=warObjectiveDirector.tick({
  systemIDs:[...visitedSystems].slice(0,12)
 });
 if(result.events?.length)
  require("./coopRuntimeProbe").observe(
   "living-native-war-objectives",null,null,{
    status:result.status,events:result.events,
    evidence:"PHYSICAL_STRUCTURE_COMBAT_KILLMAIL_AND_UNCONTESTED_NATIVE_OCCUPANCY"
   });
 // A captured system is a real front event: report it once, to that system.
 for(const event of result.events||[]){
  if(!event||event.kind!=="MILITARY_CONTROL_CAPTURED")continue;
  let capturerFactionID=0;
  try{
   const warState=warStateStore().read();
   const campaign=warState&&warState.campaigns&&warState.campaigns[event.campaignID];
   capturerFactionID=Number(warState?.wars?.[campaign?.warID]?.attackerFactionID)||0;
  }catch(_error){capturerFactionID=0}
  warFrontChat("objective-captured",{
   eventKey:String(event.campaignID||"")+":"+String(event.systemID||"")+":"+String(event.revision||""),
   systemID:event.systemID,
   factionID:capturerFactionID,
  },[event.systemID]);
 }
}
// One existing A-Life 30-second scheduler, no faction-war timer.
function npcOrderBridge(){
 if(!alifeOrderArbitrationEnabled(process.env))return null;
 if(!nativeOrderBridge){
  const native=require("./runtime"),controllers=require("./npc/npcRegistry");
  const arbiter=require("./coopNpcOrderArbiter").createOrderArbiter();
  nativeOrderBridge=require("./coopNpcOrderBridge").createOrderBridge({
   arbiter,assignments:()=>[
    ...(bridge?.snapshot()||[]),
    ...Object.values(identityRegistry?.snapshot()?.links||{})
   ],
   sceneForSystem:id=>native.ensureScene(id,{refreshStargates:false}),
   getController:id=>controllers.getControllerByEntityID(id),
   // Dynamic callback prevents enabling WAR after the bridge was created
   // without its registry guard. Disabled war never grants WAR orders.
   warShipClaim:link=>(
    process.env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
    process.env.EVEJS_COOP_FACTION_WAR==="1"&&
    process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1")?
    (nativeWarFleetRegistry()?.claim(link)||"UNKNOWN"):"UNASSIGNED"
  });
 }
 return nativeOrderBridge;
}
// Read-only: why a native order would be refused for this hull, with the exact
// first blocker and the current lease owner. Never issues or retains a lease.
function diagnoseNpcOrder({entityID,systemID,owner}={}){
 const bridge=npcOrderBridge();
 if(!bridge)return {status:"DISABLED",reason:"COOP_NPC_ORDER_ARBITRATION_OFF"};
 try{return bridge.diagnose({entityID,systemID,owner:String(owner||"RAID")})}
 catch(error){return {status:"BLOCKED",reason:"DIAGNOSE_FAILED",
  details:String(error&&error.message||error).slice(0,120)}}
}
// Read-only: the raid director's own view of one system. "A real pirate with real
// prey and still no order" must be a measurement, not a guess, and the periodic
// diagnose is only published when the system produced no action at all - so a
// hull that is silently excluded (or parked at its own home) was invisible.
// It never issues, releases or retains an order and never moves a ship.
function npcNativeOrder(owner,entityID,action,execute,systemID){
 const guard=npcOrderBridge();
 if(!guard)return owner==="WAR"?{success:false,errorMsg:"COOP_NPC_ORDER_WAR_ARBITER_REQUIRED"}:execute();
 return guard.issue({owner,entityID,action,execute,systemID});
}
function addNpcOrderBlocks(blockedIDs,systemID,owner){
 const guard=npcOrderBridge();
 if(guard)for(const id of guard.blocksForSystem(systemID,owner))blockedIDs.add(id);
 return blockedIDs;
}
// Personal intentions affect only NPC routes; no native funds, kills or cargo.
function npcPersonalGoals(){
 if(process.env.EVEJS_COOP_NPC_PERSONAL_GOALS!=="1"||
    process.env.EVEJS_COOP_NPC_CAPSULEER_AGENCY!=="1"||
    !alifeOrderArbitrationEnabled(process.env))return null;
 if(!personalGoals)personalGoals=require("./coopNpcPersonalGoals").createPersonalGoals({
  file:process.env.EVEJS_COOP_NPC_GOALS_FILE||"/var/lib/evejs/coop-npc-goals.json"
 });
 return personalGoals;
}
function advanceNativeNpcExpeditions(){
 if(process.env.EVEJS_COOP_ALIFE!=="1"||
    process.env.EVEJS_COOP_NPC_EXPEDITIONS!=="1"||
    !alifeOrderArbitrationEnabled(process.env)||
    !world||!identityRegistry||!visitedSystems.size)return;
 const native=require("./runtime"),store=require("./npc/nativeNpcStore"),
  controllers=require("./npc/npcRegistry"),
  signatures=require("../services/exploration/signatures/signatureRuntime"),
  npc=require("./npc/npcRuntime"),probe=require("./coopRuntimeProbe");
 const guard=npcOrderBridge();
 if(!guard)return;
 if(!npcExpeditionDirector)
  npcExpeditionDirector=require("./coopNpcExpeditionDirector").createExpeditionDirector({
   listNativeSites:systemID=>signatures.listSystemSignatureSites(systemID),
   getNativeEntity:id=>store.getNativeEntity(id),
   getController:id=>controllers.getControllerByEntityID(id),
   isNativeProbeScout:(id,systemID)=>{
    // Only the native inventory authority can identify an equipped scout.
    const native=store.getNativeEntity(id);
    if(!native||native.entityID!==id||native.systemID!==systemID||
       native.transient===true)return false;
    const modules=store.listNativeModulesForEntity(id);
    return Array.isArray(modules)&&modules.some(m=>
     m?.entityID===id&&m.ownerID===native.ownerID&&
     m.groupID===481&&m.categoryID===7&&
     Number.isSafeInteger(m.moduleID)&&m.moduleID>0&&
     Number.isSafeInteger(m.flagID)&&m.flagID>0&&
     m.moduleState?.online===true&&m.transient!==true);
   },
   orderBridge:guard,
   warpToPoint:(id,point,options)=>npc.warpToPoint(id,point,options),
   nativeProbeScan:({scene,entityID,assignments})=>{
    if(process.env.EVEJS_COOP_NPC_PROBE_SCAN!=="1")
     return {status:"DISABLED",proofs:[]};
    if(!npcProbeEvidence){
     const auth=require("../services/exploration/explorationAuthority");
     const probeState=require("../services/exploration/probes/probeRuntimeState");
     const scanRuntime=require("../services/exploration/probes/probeScanRuntime");
     npcProbeEvidence=require("./coopNpcProbeScanEvidence").createNpcProbeScanEvidence({
      getNativeEntity:id=>store.getNativeEntity(id),
      getController:id=>controllers.getControllerByEntityID(id),
      listNativeModulesForEntity:id=>store.listNativeModulesForEntity(id),
      listNativeCargoForEntity:id=>store.listNativeCargoForEntity(id),
      getCompatibleProbeChargeTypeIDs:typeID=>auth.getCompatibleProbeChargeTypeIDs(typeID),
      resolveProbeRangeContract:(typeID,step,range)=>
       probeState.resolveProbeRangeContract(typeID,step,range),
      scanNativeResults:(systemID,probes)=>
       scanRuntime.buildSignatureScanResults(systemID,probes),
      listNativeSites:systemID=>signatures.listSystemSignatureSites(systemID)
     });
    }
    // EX-03B2: an independently disabled original cargo debit+physical
    // launcher. One charge row is synchronously flushed before scene spawn.
    // Neither a player session nor a new scheduler is ever constructed.
    if(process.env.EVEJS_COOP_NPC_PROBE_LAUNCH==="1"){
     if(!npcProbeSceneTransition){
      const nativeSpace=require("./runtime");
      const nativeProbeScene=require("../services/exploration/probes/probeSceneRuntime");
      npcProbeSceneTransition=require("./coopNativeNpcProbeSceneTransition")
       .createNativeNpcProbeSceneTransition({
        removeDynamicEntity:(systemID,itemID,options)=>
         nativeSpace.removeDynamicEntity(systemID,itemID,options),
        buildProbeSceneEntity:(probe,options)=>
         nativeProbeScene.buildProbeSceneEntity(probe,options)
       });
     }
     if(!npcProbeFlight){
      const auth=require("../services/exploration/explorationAuthority");
      const probeState=require("../services/exploration/probes/probeRuntimeState");
      const probeScene=require("../services/exploration/probes/probeSceneRuntime");
      const gameStore=require("../gameStore");
      npcProbeFlight=require("./coopNativeNpcProbeFlight").createNativeNpcProbeFlight({
       getNativeEntity:id=>store.getNativeEntity(id),
       getController:id=>controllers.getControllerByEntityID(id),
       listNativeModulesForEntity:id=>store.listNativeModulesForEntity(id),
       listNativeCargoForEntity:id=>store.listNativeCargoForEntity(id),
       upsertNativeCargo:row=>store.upsertNativeCargo(row),
       flushNpcCargo:()=>gameStore.flushTableSync("npcCargo"),
       relocateNativeProbe:payload=>npcProbeSceneTransition.move(payload),
       refreshNativeCargoProjection:(ship,id)=>{
        const cargo=store.buildNativeCargoItems(id);
        if(!Array.isArray(cargo))return false;
        ship.nativeCargoItems=cargo.filter(item=>
         Number.isSafeInteger(item?.quantity)&&item.quantity>0);
        return true;
       },
       compatibleCharges:typeID=>auth.getCompatibleProbeChargeTypeIDs(typeID),
       resolveProbeRange:(typeID,step,range)=>
        probeState.resolveProbeRangeContract(typeID,step,range),
       buildProbeSceneEntity:(record,options)=>
        probeScene.buildProbeSceneEntity(record,options)
      });
     }
     const launched=npcProbeFlight.tick({scene,entityID,assignments});
     if(launched.status==="NATIVE_PROBE_LAUNCHED"||
        launched.status==="NATIVE_PROBE_PENDING_RECONCILIATION"||
        launched.status==="BLOCKED"&&backgroundTicks%10===0)
      probe.observe("living-npc-native-probe-flight",null,
       {spaceState:{systemID:scene.systemID}},
       {entityID,status:launched.status,reason:launched.reason||null,
        originalCargoID:launched.cargoID||null,
        source:"ORIGINAL_NPC_CARGO_DURABLE_BEFORE_SCENE",
        nativeWalletMutation:false,nativeLootGranted:false});
    }
    // EX-03B5 original native probe lifecycle: source transition durably
    // commits before a sealed physical probe is removed from the scene.
    // Single existing A-Life scan tick, no independent schedule or player RPC.
    if(process.env.EVEJS_COOP_NPC_PROBE_LIFECYCLE==="1" &&
       process.env.EVEJS_COOP_NPC_PROBE_LAUNCH==="1"){
     if(!npcProbeLifecycle){
      const gameStore=require("../gameStore");
      const runtime=require("./runtime");
      npcProbeLifecycle=require("./coopNativeNpcProbeLifecycle").createNativeNpcProbeLifecycle({
       getNativeEntity:id=>store.getNativeEntity(id),
       getController:id=>controllers.getControllerByEntityID(id),
       listNativeCargoForEntity:id=>store.listNativeCargoForEntity(id),
       upsertNativeCargo:row=>store.upsertNativeCargo(row),
       flushNpcCargo:()=>gameStore.flushTableSync("npcCargo"),
       removeNativeProbe:(systemID,probeID)=>
        runtime.removeDynamicEntity(systemID,probeID,
         {allowSessionOwned:false,broadcast:true}),
       refreshNativeCargoProjection:(ship,id)=>{
        const cargo=store.buildNativeCargoItems(id);
        if(!Array.isArray(cargo))return false;
        ship.nativeCargoItems=cargo.filter(item=>
         Number.isSafeInteger(item?.quantity)&&item.quantity>0);
        return true;
       }
      });
     }
     const lifecycle=npcProbeLifecycle.tick({scene,entityID,assignments});
     if(lifecycle.status==="BLOCKED"&&backgroundTicks%10===0||
        lifecycle.status!=="NO_LIFECYCLE_ACTION"&&lifecycle.status!=="BLOCKED")
      probe.observe("living-npc-original-probe-lifecycle",null,
       {spaceState:{systemID:scene.systemID}},
       {entityID,status:lifecycle.status,reason:lifecycle.reason||null,
        originalCargoID:lifecycle.cargoID||null,
        nativeWalletMutation:false,nativeLootGranted:false});
    }
    const result=npcProbeEvidence.scan({scene,entityID,assignments});
    if(npcProbeLifecycle&&result.proofs?.length>0&&
       process.env.EVEJS_COOP_NPC_PROBE_LIFECYCLE==="1")
      npcProbeLifecycle.tick({scene,entityID,assignments,requestRecall:true});
    // EX-03B4: independently opt-in blind sweep, AFTER native result
    // certainty is checked, never use system-private site coordinates.
    if(process.env.EVEJS_COOP_NPC_PROBE_SWEEP==="1" &&
       process.env.EVEJS_COOP_NPC_PROBE_LAUNCH==="1" &&
       result.status==="NATIVE_PROBE_SCANNED" &&
       !result.proofs.length){
     if(!npcProbeSweep){
      const gameStore=require("../gameStore");
      npcProbeSweep=require("./coopNativeNpcProbeSweep").createNativeNpcProbeSweep({
       getNativeEntity:id=>store.getNativeEntity(id),
       getController:id=>controllers.getControllerByEntityID(id),
       listNativeCargoForEntity:id=>store.listNativeCargoForEntity(id),
       upsertNativeCargo:row=>store.upsertNativeCargo(row),
       flushNpcCargo:()=>gameStore.flushTableSync("npcCargo"),
       relocateNativeProbe:payload=>npcProbeSceneTransition.move(payload)
      });
     }
     const moved=npcProbeSweep.tick({scene,entityID,assignments});
     if(moved.moved||moved.status==="BLOCKED"&&backgroundTicks%10===0)
      probe.observe("living-npc-native-probe-sweep",null,
       {spaceState:{systemID:scene.systemID}},
       {entityID,status:moved.status,reason:moved.reason||null,
        originalCargoID:moved.originalCargoID||null,
        nativeWalletMutation:false,nativeLootGranted:false});
    }
    return result;
   }
  });
 const roles=Object.fromEntries((world.snapshot()?.pilots||[])
  .filter(p=>typeof p?.id==="string").map(p=>[p.id,p.role]));
 // Only the durable NPC materialization registry authorizes named hulls.
 const assignments=Object.values(identityRegistry.snapshot()?.links||{});
 for(const systemID of [...visitedSystems].sort((a,b)=>a-b).slice(0,2)){
  // A read-only observer must never instantiate an absent native scene.
  const scene=native.scenes instanceof Map?native.scenes.get(systemID):null;
  if(!scene)continue;
  const result=npcExpeditionDirector.tick({scene,assignments,roles});
  if(result.orders||result.observed||result.observedPlayers||result.contested||result.remoteScans||result.blocked&&backgroundTicks%10===0)
   probe.observe("living-npc-expedition",null,{spaceState:{systemID}},
    {status:result.status,orders:result.orders,observed:result.observed,
     observedPlayers:result.observedPlayers||0,contested:result.contested||0,
     remoteNativeProbeScans:result.remoteScans||0,
     scoutWarpOrders:result.scoutWarpOrders||0,
     patrolWarpOrders:result.patrolWarpOrders||0,
     sourceScoutOnGridVerified:result.scoutOnGridVerified||0,
     blocked:result.blocked||0,source:result.source||"NATIVE_SITE_OBSERVE",
     nativeLootGranted:false,nativeWalletMutation:false});
  // EX-03B15: the same existing native 30-second A-Life tick drives
  // legitimate hacking turns, original ItemStore pickup and warehouse
  // delivery. Re-check the scout's CURRENT physical site witness, never
  // execute from a cached private catalog coordinate.
  if(process.env.EVEJS_COOP_NPC_EXPEDITION_HACK==="1"||
     process.env.EVEJS_COOP_NPC_EXPEDITION_LOOT==="1"){
   if(!npcExpeditionOperations){
    const items=require("../services/inventory/itemStore"),
     data=require("./worldData"),
     fitting=require("../services/fitting/liveFittingState"),
     types=require("../services/inventory/itemTypeRegistry"),
     state=require("../services/corporation/corporationState"),
     gameStore=require("../gameStore");
    npcExpeditionOperations=
     require("./coopNpcExpeditionOperations").createNpcExpeditionOperations({
      nativeStore:store,itemStore:items,gameStore,
      getController:id=>controllers.getControllerByEntityID(id),
      getStation:id=>data.getStationByID(id),
      getStationsForSystem:id=>data.getStationsForSystem(id),
      isNpcCorporation:id=>state.isNpcCorporationID(id),
      siteService:require("../services/dungeon/dungeonUniverseSiteService"),
      hackingService:require("../services/exploration/hackingMgrService"),
      typeHasEffectName:fitting.typeHasEffectName,
      resolveItemByTypeID:types.resolveItemByTypeID,
      orderBridge:guard,
      warpToPoint:(id,point,options)=>npc.warpToPoint(id,point,options)
     });
   }
   const ops=npcExpeditionOperations.tick({scene,assignments,
    tips:npcExpeditionDirector.operations(),flags:{
     hack:process.env.EVEJS_COOP_NPC_EXPEDITION_HACK==="1",
     loot:process.env.EVEJS_COOP_NPC_EXPEDITION_LOOT==="1"&&
      process.env.EVEJS_COOP_NPC_EXPEDITION_WRECK==="1"
    }});
   if(ops.hacked||ops.picked||ops.delivered||ops.orderedReturn||
      ops.blocked&&backgroundTicks%10===0)
    probe.observe("living-npc-original-expedition-loot",null,
     {spaceState:{systemID}},{...ops,nativeWalletMutation:false});
  }
  // EX-03B16: an independently opt-in native wormhole jump can be considered
  // ONLY after this exact scanner scout physically witnesses a real endpoint.
  // Never iterate the private wormhole catalog to discover a destination.
  if(process.env.EVEJS_COOP_NPC_EXPEDITION_WORMHOLES==="1"){
   if(!npcWormholeTransit){
    npcWormholeTransit=require("./coopNpcWormholeTransit")
     .createNpcWormholeTransit({
      store,service:require("./npc/nativeNpcService"),
      registry:identityRegistry,gameStore:require("../gameStore"),
      wormholes:require("../services/exploration/wormholes/wormholeRuntime"),
      wormholeState:require("../services/exploration/wormholes/wormholeRuntimeState"),
      sceneForSystem:id=>native.scenes instanceof Map?native.scenes.get(id):null,
      root:process.env.EVEJS_COOP_NPC_WORMHOLE_JOURNAL_DIR||
       "/var/lib/evejs/coop-npc-wormholes"
     });
   }
   const liveTips=npcExpeditionDirector.operations();
   for(const tip of liveTips.slice(0,2)){
    let exact;
    try{
     const matches=signatures.listSystemSignatureSites(systemID).filter(x=>
      x.siteID===tip.siteID&&x.family==="wormhole"&&
      (x.solarSystemID===systemID||x.systemID===systemID));
     exact=matches.length===1?matches[0]:null;
    }catch{continue}
    if(!exact)continue;
    const link=assignments.find(x=>x.pilotID===tip.scoutPilotID&&
     x.systemID===systemID&&Number.isSafeInteger(x.entityID));
    if(!link||assignments.some(x=>x.pilotID===tip.scoutPilotID&&
     (x.entityID!==link.entityID||x.systemID!==systemID)))continue;
    let hull,endpoint;
    try{hull=scene.getEntityByID(link.entityID);
     endpoint=scene.getEntityByID(tip.siteID)}
    catch{continue}
    if(!hull||!endpoint||endpoint.kind!=="wormhole"||
     endpoint.itemID!==tip.siteID||!hull.position||!endpoint.position)continue;
    const gap=Math.max(0,Math.hypot(
     hull.position.x-endpoint.position.x,
     hull.position.y-endpoint.position.y,
     hull.position.z-endpoint.position.z)-
     Math.max(0,Number(hull.radius)||0)-
     Math.max(0,Number(endpoint.radius)||0));
    const approachKey=link.entityID+":"+tip.siteID;
    if(gap>5000){
     // The source-native NPC flight commands the approach; no direct
     // coordinate update or instant wormhole teleport is permitted.
     if(gap<=150000&&!npcWormholeApproaches.has(approachKey))
      try{
       if(!guard.blocked({entityID:link.entityID,systemID,owner:"EXPEDITION"})){
        const approach=guard.issue({entityID:link.entityID,systemID,
         owner:"EXPEDITION",action:"expedition-wormhole-approach",
         execute:()=>npc.follow(link.entityID,tip.siteID,2500,
          {wakeController:true})});
        if(approach?.success===true)npcWormholeApproaches.add(approachKey);
       }
      }catch{}
     continue;
    }
    npcWormholeApproaches.delete(approachKey);
    // The original arbiter fences an ambiguous mass/ship handoff.
    let moved;
    try{
     if(guard.blocked({entityID:link.entityID,systemID,owner:"EXPEDITION"}))
      continue;
     moved=guard.issue({entityID:link.entityID,systemID,
      owner:"EXPEDITION",action:"expedition-wormhole-cross",execute:()=>{
       const state=npcWormholeTransit.cross({
        pilotID:tip.scoutPilotID,entityID:link.entityID,
        scene,endpointID:tip.siteID,assignments});
       if(state.status==="NATIVE_NPC_WORMHOLE_ARRIVED")
        return {success:true,data:state};
       // Native mass/ship may have changed. An ambiguous arbiter response
       // fences the hull; persistent wormhole receipt prevents replay.
       if(state.status==="NEEDS_OPERATOR_REPAIR")
        return {status:"NATIVE_WORMHOLE_OUTCOME_UNKNOWN"};
       return {success:false,errorMsg:state.reason||"EX03_WORMHOLE_BLOCKED"};
      }});
    }catch{continue}
    if(moved?.success===true&&
       moved.data?.status==="NATIVE_NPC_WORMHOLE_ARRIVED"){
     visitedSystems.add(moved.data.destinationSystemID);
     probe.observe("living-npc-original-wormhole-cross",null,
      {spaceState:{systemID}},{
       entityID:link.entityID,
       destinationSystemID:moved.data.destinationSystemID,
       originalPairID:moved.data.originalPairID,
       preservedCargo:moved.data.preservedCargo,
       preservedModules:moved.data.preservedModules,
       nativeMassRefunded:false,nativeWalletMutation:false
      });
     // Bounded physical same-corp expedition wingmen. A leader's perfect
     // probe scan can authorize at most 2 companions ALREADY on its grid.
     // Every follower separately pays source mass and polarization,
     // preserves its original entity/modules/cargo and owns a journal.
     let crossedWingmen=0;
     for(const wing of assignments){
      if(crossedWingmen>=2)break;
      if(wing?.pilotID===tip.scoutPilotID||
         wing?.systemID!==systemID||
         !Number.isSafeInteger(wing?.entityID)||wing.entityID<=0)continue;
      let ship,source;
      try{
       ship=scene.getEntityByID(wing.entityID);
       source=store.getNativeEntity(wing.entityID);
      }catch{continue}
      if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true||
         ship.itemID!==wing.entityID||ship.session?.characterID||
         source?.corporationID!==tip.corpID||
         source.systemID!==systemID||source.ownerID!==ship.ownerID||
         !ship.position||!endpoint.position||
         Math.max(0,Math.hypot(
          ship.position.x-endpoint.position.x,
          ship.position.y-endpoint.position.y,
          ship.position.z-endpoint.position.z)-
          Math.max(0,Number(ship.radius)||0)-
          Math.max(0,Number(endpoint.radius)||0))>5000)continue;
      let wingResult;
      try{
       if(guard.blocked({entityID:wing.entityID,systemID,owner:"EXPEDITION"}))
        continue;
       wingResult=guard.issue({entityID:wing.entityID,systemID,
        owner:"EXPEDITION",action:"expedition-wormhole-wingman",execute:()=>{
         const state=npcWormholeTransit.cross({
          pilotID:wing.pilotID,entityID:wing.entityID,
          scene,endpointID:tip.siteID,assignments});
         if(state.status==="NATIVE_NPC_WORMHOLE_ARRIVED")
          return {success:true,data:state};
         if(state.status==="NEEDS_OPERATOR_REPAIR")
          return {status:"NATIVE_WORMHOLE_OUTCOME_UNKNOWN"};
         return {success:false,errorMsg:state.reason||"EX03_WORMHOLE_BLOCKED"};
        }});
      }catch{continue}
      if(wingResult?.success===true&&
         wingResult.data?.status==="NATIVE_NPC_WORMHOLE_ARRIVED"){
       crossedWingmen++;
       visitedSystems.add(wingResult.data.destinationSystemID);
       probe.observe("living-npc-original-wormhole-cross",null,
        {spaceState:{systemID}},{
         entityID:wing.entityID,role:"EXPEDITION_WINGMAN",
         destinationSystemID:wingResult.data.destinationSystemID,
         originalPairID:wingResult.data.originalPairID,
         preservedCargo:true,preservedModules:true,
         nativeMassRefunded:false,nativeWalletMutation:false
        });
      }
     }
    }else if(moved?.errorMsg==="COOP_NPC_ORDER_REPAIR_REQUIRED")
     probe.observe("living-npc-original-wormhole-repair",null,
      {spaceState:{systemID}},{entityID:link.entityID,
       status:"NEEDS_OPERATOR_REPAIR",nativeMassRefunded:false});
   }
  }
 }
}
function observeNativeMiningProof(){
 if(!world||!visitedSystems.size)return;
 const runtime=require("./runtime"),mining=require("../services/mining/miningNpcOperations"),
  miningState=require("../services/mining/miningRuntimeState"),
  store=require("./npc/nativeNpcStore"),probe=require("./coopRuntimeProbe");
 if(!nativeMiningWitness)nativeMiningWitness=
  require("./coopAlifeNativeMiningWitness").createNativeMiningWitness();
 // Never create a scene for an observer: physical mining must already exist.
 for(const systemID of [...visitedSystems].sort((a,b)=>a-b).slice(0,2)){
  const scene=runtime.scenes instanceof Map?runtime.scenes.get(systemID):null;
  if(!scene)continue;
  const result=nativeMiningWitness.tick({
   scene,fleets:mining.getMiningFleetsForSystem(systemID),
   getNativeEntity:id=>store.getNativeEntity(id),
   listNativeCargo:id=>store.listNativeCargoForEntity(id),
   isMineableStaticEntity:miningState.isMineableStaticEntity,
   getMineableState:(sc,id)=>miningState.getMineableState(sc,id)
  });
  if(result.status!=="OBSERVED"){
   if(backgroundTicks%10===0)probe.observe("alife-native-mining-blocker",null,
    {spaceState:{systemID}},{status:result.status,source:"NATIVE_MINING_READ_ONLY"});
   continue;
  }
  for(const row of result.results){
   if(row.status!=="NATIVE_MINING_ACTIVE_NO_YIELD_DELTA"||
      backgroundTicks%10===0)
    probe.observe("alife-native-mining-proof",null,
     {spaceState:{systemID}},row);
  }
 }
}
function start(){
 if(process.env.EVEJS_COOP_VIRTUAL_WORLD!=="1"){
  if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT==="1")
   console.warn("[CoopLivingWorld] BLOCKED_RUNTIME_CONFIG: headless boot is enabled but virtual world is disabled");
  return;
 }
 if(world)return;
 // Diagnostic invocation only; no claim of booted native ships or world.
 require("./coopRuntimeProbe").observe("living-startup-entered",null,null,
  {status:"START_REQUESTED_NOT_READY",headlessConfigured:process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT==="1"});
 const route=String(process.env.EVEJS_COOP_VIRTUAL_ROUTE||"30000142,30000144").split(",").map(Number);
 let nextWorld,nextLife;
 try{
  const {createWorld}=require("./coopVirtualWorld");
  nextWorld=createWorld({file:process.env.EVEJS_COOP_VIRTUAL_STATE_FILE||"/var/lib/evejs/coop-virtual-world.json",
    route,population:Number(process.env.EVEJS_COOP_VIRTUAL_POPULATION||16),
    travelMs:Number(process.env.EVEJS_COOP_VIRTUAL_TRAVEL_MS||120000),
    migrateFactions:process.env.EVEJS_COOP_FACTION_LAYOUT_V2==="1"});
  const {createLife}=require("./coopNpcLife");
  nextLife=createLife({file:process.env.EVEJS_COOP_LIFE_FILE||"/var/lib/evejs/coop-npc-life.json",
   recoveryMs:Number(process.env.EVEJS_COOP_CLONE_RECOVERY_MS||1800000)});
 }catch(error){
  // Never delete or reinitialize real persisted state to fake a ready world.
  require("./coopRuntimeProbe").observe("living-startup-failed",null,null,
   {status:"BLOCKED_PERSISTED_WORLD_INIT",phase:"persistent-state-load",
    errorCode:String(error?.code||error?.name||"UNKNOWN").replace(/[^A-Za-z0-9_]/g,"_").slice(0,48)});
  throw error;
 }
 world=nextWorld;life=nextLife;
 // Headless bootstrap must resolve persisted native pilot links before
 // advancing virtual travel; otherwise a real parked ship can be
 // virtually transported to another system during process startup.
 if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT!=="1")world.advance();
 if(process.env.EVEJS_COOP_VIRTUAL_ECONOMY==="1"){
  safeNpcPhase("economy-init",()=>{
   const {createEconomy}=require("./coopVirtualEconomy");
   economy=createEconomy({
    file:process.env.EVEJS_COOP_ECONOMY_FILE||"/var/lib/evejs/coop-economy.json"
   });
   economy.advance(world.snapshot().pilots);
  });
  safeNpcPhase("native-depot-init",syncNativeDeliveries);
  if(economy)safeNpcPhase("faction-init",()=>{
   const {createFactionDirector}=require("./coopFactionDirector");
   factionDirector=createFactionDirector({
    file:process.env.EVEJS_COOP_FACTION_FILE||"/var/lib/evejs/coop-factions.json"
   });
   factionDirector.advance(economy.snapshot().systems);
  });
 }
 worldPhaseCoordinator=require("./coopLivingWorldPhaseCoordinator").createPhaseCoordinator({
 execute:safeNpcPhase,onCycle:row=>{
  if(row.sequence%10!==0&&!row.unknownNames.length)return;
  require("./coopRuntimeProbe").observe("living-world-phase-cycle",null,null,{
   status:row.status,sequence:row.sequence,phaseCount:row.phaseCount,
   groups:row.groups,unknownNames:row.unknownNames,
   source:row.source,nativeSettlementVerified:false});
 }});
 // Opt-in perf report: which phases really cost time, every minute.
 if(require("./coopPerfMetrics"+(__filename.endsWith(".js")?"":".cjs")).enabled()){
  perfTimer=setInterval(()=>{
   try{
    const top=require("./coopPerfMetrics"+(__filename.endsWith(".js")?"":".cjs")).metrics().top(8);
    require("./coopRuntimeProbe").observe("coop-perf-sample",null,null,{top});
   }catch(_ignored){}
  },60000);
  perfTimer.unref?.();
 }
 timer=setInterval(()=>worldPhaseCoordinator.tick(runPhase=>{
  backgroundTicks++;
  syncWarRuntime();
  for(const fleetSystemID of warFleetSystemIDs())visitedSystems.add(fleetSystemID);
  // Read-only courier pass (COOP-024). It never mutates a contract: it only
  // reports what the decision core thinks of the outstanding courier contracts,
  // so the live wiring can be verified before anything is accepted.
  if(process.env.EVEJS_COOP_COURIER_OBSERVE==="1")runPhase("courier-observe",()=>{
   const {listContractRecords}=require("../services/contracts/contractRuntimeState");
   const {evaluateContract}=require("./coopCourierDispatch");
   for(const record of listContractRecords()){
    if(Number(record&&record.type)!==3||Number(record&&record.status)!==0)continue;
    const decision=evaluateContract(record,{sameSystemOnly:true,requireZeroCollateral:false},{walletIsk:0,hullCapacityM3:465000});
    console.log(`[CoopCourier] contract ${record.contractID} volume ${record.volume} -> ${decision.status}`);
   }
  });
  // Real courier dispatch (COOP-024). Opt-in and default OFF: it accepts the
  // owner's genuine native courier contract with a seeded courier character,
  // flies it natively and completes it. Observe above stays read-only.
  // Universe sites for the systems this world plays in. The seeder only ever saw the AWAKE systems, so
  // the systems the player flies through had no anomalies at all; this reconciles the visited set
  // through the same persistent-site seeder (rate limited: new system or every 10 minutes).
  if(process.env.EVEJS_COOP_UNIVERSE_SITES!=="0"&&visitedSystems.size)runPhase("universe-sites",()=>{
   const result=require("./coopUniverseSites").reconcile({visitedSystems,nowMs:Date.now()});
   if(result.status==="RECONCILED")console.log(`[CoopUniverseSites] systems=${result.systemIDs.length} desired=${result.desired} created=${result.created} spawned=${result.materialized} anomalies=${JSON.stringify(result.anomalies)} wormholes=${result.wormholes?result.wormholes.openedCount:"-"} ${JSON.stringify(result.wormholes&&result.wormholes.skipped||{})}`);
   else if(result.status==="FAILED")console.warn(`[CoopUniverseSites] ${result.reason}`);
  });
  if(process.env.EVEJS_COOP_ADMIN_BRIDGE==="1")runPhase("admin-bridge",()=>{
    const adminBridge=require("./coopAdminBridge");
    // The world tick can be a minute apart, so admin calls must not wait for it:
    // startFastDrain is idempotent and answers one request per ~1 s.
    adminBridge.startFastDrain({log:console.log});
    adminBridge.drain({log:console.log});
  });
  if(process.env.EVEJS_COOP_COURIER_DISPATCH==="1")runPhase("courier-dispatch",()=>{
   if(!courierDispatch)courierDispatch=require("./coopCourierRuntime").createCourierDispatch({
    contracts:require("../services/contracts/contractRuntimeState"),
    gameStore:require("../gameStore"),
    itemStore:require("../services/inventory/itemStore"),
    worldData:require("./worldData"),
    transitions:require("./transitions"),
    space:require("./runtime"),
    sceneForSystem:id=>require("./runtime").ensureScene(id,{refreshStargates:false}),
    pilots:String(process.env.EVEJS_COOP_COURIER_PILOTS||courierPilotIDs().join(",")).split(","),
    sendMail:mail=>require("../services/mail/mailState").sendMail({
     senderID:mail.senderID,toCharacterIDs:mail.toCharacterIDs,saveSenderCopy:false,title:mail.title,body:mail.body}),
    log:console.log
   });
   courierDispatch.tick();
  });
  runPhase("virtual-travel",()=>{
   // A real physical EveJS ship is pinned to its actual system.
   const pins={};
   if(bridge)for(const entry of bridge.snapshot())pins[entry.pilotID]=entry.systemID;
   if(identityRegistry)for(const [pilotID,entry] of Object.entries(identityRegistry.snapshot().links)){
    if(!pins[pilotID]&&identityRegistry.get(pilotID))pins[pilotID]=entry.systemID;
   }
   if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT!=="1"||identityRegistry)
    world.advance(pins);
  });
  if(economy)runPhase("virtual-economy",()=>economy.advance(world.snapshot().pilots));
  runPhase("native-depot",syncNativeDeliveries);
  // ALIFE-04: existing 30s tick only; original native mining rock locks,
  // active module effects, and real nativeNpcStore cargo identity.
  if(process.env.EVEJS_COOP_ALIFE==="1"&&
   process.env.EVEJS_COOP_NATIVE_MINING==="1"&&
   process.env.EVEJS_COOP_ALIFE_MINING_PROOF==="1")
   runPhase("alife-native-mining-proof",observeNativeMiningProof);
  // COOP-042: one A-Life 30-second tick; READ ONLY, no extra scheduler.
  if(process.env.EVEJS_COOP_ALIFE==="1"&&process.env.EVEJS_COOP_ALIFE_ECONOMY==="1")
   runPhase("alife-native-economy-observe",()=>{
    void observeAlifeEconomy().catch(error=>console.warn("[CoopAlifeEconomy] observation",error.message));
   });
  if(factionDirector&&economy)runPhase("faction",()=>factionDirector.advance(economy.snapshot().systems));
  // Opt-in normal ammo orders flow from native A-Life decisions; survival
  // still receives an immediate authoritative native retreat attempt.
  if(require("./coopAlifeNativeResupplyBridge").nativeResupplyActEnabled()){
   runPhase("native-ammo-readiness",()=>
    advanceNativeAmmoSupply({mode:"MONITOR_ONLY"}));
   runPhase("native-ammo-survival",()=>
    advanceNativeAmmoSupply({mode:"SURVIVAL"}));
  }
  else runPhase("native-ammo-supply",advanceNativeAmmoSupply);
  runPhase("native-ammo-bank-recovery",advanceNativeAmmoBankRecovery);
  runPhase("native-raids",advanceNativeRaids);
  runPhase("native-tactics",advanceNativeTactics);
  if(process.env.EVEJS_COOP_ALIFE==="1"&&process.env.EVEJS_COOP_NPC_EXPEDITIONS==="1")
   runPhase("native-expeditions",advanceNativeNpcExpeditions);
  runPhase("native-pve-boss-wreck",advanceNativePveBossWreck);
  runPhase("native-pve-site-defense",advanceNativePveSiteDefense);
  runPhase("native-pve-wave-reinforcements",advanceNativePveWaveReinforcements);
  runPhase("native-pve-objective-doctrine",advanceNativePveObjectiveDoctrine);
  runPhase("native-faction-war-demobilization",advanceNativeWarDemobilization);
  runPhase("native-faction-war-opening",advanceNativeWarOpening);
  // A dry hull releases its campaign slot first, so the same tick can field one
  // that can really fire.
  runPhase("native-faction-war-battle-line-relief",advanceNativeWarBattleLineRelief);
  runPhase("native-faction-war-mobilization",advanceNativeWarMobilization);
  // FW-033: refill a side that lost its garrison, before the assault phase counts it.
  runPhase("native-faction-war-garrison",advanceNativeWarGarrison);
  runPhase("native-faction-war-assault",advanceNativeWarAssault);
  runPhase("native-faction-war-gate-staging",advanceNativeWarGateStaging);
  runPhase("native-faction-war-sovereignty-projection",advanceNativeWarSovereigntyProjection);
  // FW-035: a system flips military controller when its defending garrison is
// really destroyed - a verified defender wreck plus zero live defender hulls,
// sustained for 60 s - through the same authoritative war core.
function advanceNativeWarCaptureByForce(){
 const api=require("./coopWarCaptureByForce");
 if(process.env.EVEJS_COOP_WAR_CAPTURE_BY_FORCE!=="1")return warSkip("capture-by-force","FLAG_OFF");
 if(!warCaptureByForce)warCaptureByForce=api.createWarCaptureByForce({
  gameStore:require("../gameStore"),
  // FW-035 x FW-032: only a hull really present in the scene blocks a capture;
  // a custody row whose ship is gone from every scene is reconciled by FW-032,
  // not counted as a defending garrison.
  isHullLive:(systemID,entityID)=>{
   try{
    const native=require("./runtime");
    const scene=native.scenes instanceof Map?native.scenes.get(Number(systemID)):null;
    return Boolean(scene&&typeof scene.getEntityByID==="function"&&
     scene.getEntityByID(Number(entityID)));
   }catch{return false}
  }
 });
 const result=warCaptureByForce.tick();
 if(result.captured.length)require("./coopRuntimeProbe").observe(
  "living-native-war-capture-by-force",null,null,{
   status:result.status,events:result.captured,
   evidence:"NATIVE_WRECK_AND_EMPTY_DEFENDER_ONLY"});
 else if(result.skips.length)warSkip("capture-by-force",
  String(result.skips[0].reason||result.status));
}
runPhase("native-faction-war-battle",advanceNativeWarCombat);
 runPhase("native-faction-war-capture-by-force",advanceNativeWarCaptureByForce);
  runPhase("native-faction-war-objectives",advanceNativeWarObjectives);
  runPhase("native-ammo-observe",observeNativeAmmoConsumption);
  runPhase("native-wreck-claim-reconcile",advanceNativeWreckClaimReconcile);
  runPhase("native-wreck-recovery",advanceNativeWreckRecovery);
  runPhase("native-salvage-rivals",advanceNativeSalvageRivals);
  // Source-backed market decisions share this tick and never start a second
  // scheduler. Awaiting Rust does not stall NPC physics or fleet movement.
  if(process.env.EVEJS_COOP_ALIFE_SALVAGE_MARKET==="1")
   runPhase("native-salvage-market",()=>{
    void require("./coopAlifeSalvageMarketRuntime").advance({
     systems:()=>new Set(visitedSystems)
    }).then(result=>{
     if(result?.status==="ALIFE_SALVAGE_MARKET_ATTEMPT"||
      result?.status==="ALIFE_SALVAGE_MARKET_RECOVERY")
      require("./coopRuntimeProbe").observe("alife-native-salvage-market",
       null,null,{status:result.status,wreckItemID:result.wreckItemID,
        resultStatus:result.result?.status,priceCents:result.priceCents||null,
        nativeEscrowVerified:result.result?.nativeEscrowVerified===true,
        corporationWalletCredited:result.result?.walletCredited===true,
        virtualISK:false});
    }).catch(error=>console.warn("[CoopSalvageMarket] tick",error.message));
   });
  runPhase("native-wreck-custody",advanceNativeWreckCustody);
  runPhase("native-loot-station-delivery",advanceNativeLootStationDelivery);
  runPhase("native-gate-approach",advanceNativeGateApproach);
  runPhase("native-patrols",advanceNativePatrolRoutes);
  runPhase("npc-recognition",advanceNpcRecognition);
  runPhase("native-civilians",advanceNativeCivilianOrders);
  // Real NPC market RPC is async: explicitly handle rejection, never fire
  // overlapping economy transactions from the 30-second timer.
  if(process.env.EVEJS_COOP_NATIVE_NPC_MARKET==="1")
   runPhase("native-market-schedule",()=>{
    void advanceNativeMarket().catch(error=>console.warn("[CoopNativeMarket] tick",error.message));
   });
  // Which ore really has a buyer here. Pure advice for the next haul.
  if(process.env.EVEJS_COOP_ECONOMY_DESTINATION==="1")
   runPhase("economy-destination-ore",observeEconomyOre);
  runPhase("native-activity",observeNativeActivity);
  if(backgroundTicks%4===0&&process.env.EVEJS_COOP_MATERIALIZE_NPCS==="1")
   for(const systemID of visitedSystems)runPhase("npc-reconcile:"+systemID,
    ()=>observeSession(null,{itemID:0,spaceState:{systemID}}));
 }),30000);
 timer.unref?.();
 // NPC fights can end before the ordinary 30s economy tick. A read-only
 // 5s sampling loop captures HP changes without altering EveJS combat.
 if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT==="1"&&!combatTimer){
  const configured=Number(process.env.EVEJS_COOP_NATIVE_COMBAT_SAMPLE_MS||5000);
  const every=Number.isFinite(configured)?Math.max(2000,Math.min(15000,configured)):5000;
  combatTimer=setInterval(()=>safeNpcPhase("native-combat-evidence",observeNativeCombat),every);
  combatTimer.unref?.();
 }
 // A wreck can only be looted inside the boot that made it: the physical native
 // entity never survives a restart. This claim-driven loop therefore runs only
 // while a live claim really has its physical wreck in the scene, and gives the
 // recovery + custody legs a fast cadence instead of the 30s economy tick.
 // With no such claim it does nothing at all (no orders, no store writes).
 if(process.env.EVEJS_COOP_NPC_WRECK_RECOVERY==="1"&&!wreckRecoveryTimer){
  const configured=Number(process.env.EVEJS_COOP_NPC_WRECK_RECOVERY_MS||5000);
  const every=Number.isFinite(configured)?
   Math.max(2000,Math.min(15000,configured)):5000;
  wreckRecoveryTimer=setInterval(()=>{
   if(wreckRecoveryFastBusy)return;
   wreckRecoveryFastBusy=true;
   try{
    if(!hasPhysicalWreckClaim()){
     // No claim has its wreck in the scene yet: heal the claims first (a boot
     // drops every physical wreck), then recover in the same boot.
     safeNpcPhase("native-wreck-claim-reconcile-fast",
      advanceNativeWreckClaimReconcile);
     return;
    }
    safeNpcPhase("native-wreck-recovery-fast",advanceNativeWreckRecovery);
    safeNpcPhase("native-wreck-custody-fast",advanceNativeWreckCustody);
   }finally{wreckRecoveryFastBusy=false;}
  },every);
  wreckRecoveryTimer.unref?.();
 }
 scheduleHeadlessWorldBoot(route);
}
// True only when a live durable claim really has its physical native wreck in a
// visited scene. This is the sole trigger of the fast loot loop.
function scheduleHeadlessWorldBoot(route){
 if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT!=="1"||headlessBootTimer)return;
 const systems=new Set(route.filter(id=>Number.isSafeInteger(id)&&id>0));
 if(!systems.size)return;
 require("./coopRuntimeProbe").observe("living-headless-boot-requested",null,null,
  {systems:[...systems],status:"SCHEDULED_NOT_VERIFIED"});
 let attempts=0;
 const attempt=()=>{
  headlessBootTimer=null;
  attempts++;
  // Distinguish a scheduled but never fired boot timer from a real scene
  // initialization failure. This is emitted BEFORE any native scene work.
  require("./coopRuntimeProbe").observe("living-headless-boot-attempt",null,null,{
   attempt:attempts,pendingSystems:[...systems]});
  for(const systemID of [...systems]){
   try{
    const runtime=require("./runtime");
    const miningEnabled=process.env.EVEJS_COOP_NATIVE_MINING==="1";
    observeSession(null,{itemID:0,spaceState:{systemID}});
    const scene=runtime.ensureScene(systemID,{refreshStargates:false});
    // Non-mining worlds must not depend on EveJS mining service being
    // configured, available, or importable merely to finish boot.
    const fleetRecords=miningEnabled
     ?require("../services/mining/miningNpcOperations").getMiningFleetsForSystem(systemID)||[]:[];
    const fleetShips=miningEnabled
     ?fleetRecords.flatMap(f=>[...(f.minerEntityIDs||[]),...(f.haulerEntityIDs||[])])
       .filter(id=>{
        const entity=scene?.getEntityByID?.(Number(id));
        return entity?.nativeNpc===true&&entity?.kind==="ship";
       })
     :[];
    const links=Object.values(identityRegistry?.snapshot().links||{})
     .filter(link=>{
      if(Number(link.systemID)!==systemID)return false;
      const ship=scene?.getEntityByID?.(Number(link.entityID));
      return ship?.kind==="ship"&&ship.nativeNpc===true;
     });
    const topology=require("./coopNpcTopology").waypoints(scene);
    const beltCount=topology.filter(p=>p.kind==="asteroidBelt").length;
    const sdeBelts=require("./worldData").getAsteroidBeltsForSystem(systemID).length;
    const policy=require("./coopHeadlessScenePolicy");
    const tracked=policy.shouldTrackNativeScene({
     systemID,scene,realWaypointCount:topology.length});
    // An actual initialized scene is worth rechecking even when the first
    // native spawn attempt failed. Previously only a successful pilot link
    // made a system eligible for the 2-minute reconcile loop.
    if(tracked)visitedSystems.add(systemID);
    const miningStartup=policy.nativeMiningStartupPolicy({
     systemID,sdeBelts,sceneBelts:beltCount});
    const startupSystems=String(process.env.EVEJS_MINING_NPC_STARTUP_SYSTEM_IDS||"")
     .split(",").map(x=>Number(x.trim())).filter(id=>Number.isSafeInteger(id)&&id>0);
    const requireSlots=miningEnabled&&sdeBelts>0&&beltCount>0&&
     process.env.EVEJS_COOP_MINING_STARTUP_RETRY==="1"&&
     process.env.EVEJS_MINING_NPC_STARTUP_ENABLED==="true"&&
     (!startupSystems.length||startupSystems.includes(Number(systemID)));
    const startupSlots=requireSlots
     ?require("./coopNativeMiningReadiness").inspect({
       scene,systemID,fleets:fleetRecords,
       expectedCount:Number(process.env.EVEJS_MINING_NPC_STARTUP_FLEET_COUNT||1)
      })
     :{status:"NOT_REQUIRED",ready:true,missingSlots:[]};
    // Zero belts in Jita are expected SDE geography; a global SDE belt
    // counter cannot prove a mineable belt in the physical system scene.
    require("./coopRuntimeProbe").observe("living-native-system-site-readiness",null,
     {spaceState:{systemID}},{systemID,realAsteroidBelts:beltCount,
      authoritativeSdeBelts:sdeBelts,realWaypoints:topology.length,
      trackingForReconcile:tracked,stockMiningStartup:miningStartup,
      source:"PINNED_EVEJS_SYSTEM_STATIC_SCENE",
      status:sdeBelts===0?"SDE_SYSTEM_HAS_NO_BELTS":
       beltCount===0?"SDE_BELTS_MISSING_FROM_SCENE":"REAL_BELT_PRESENT"});
    const verified=isHeadlessNativeReady({
     miningEnabled,
     physicalNpcCount:links.length,waypointCount:topology.length,
     beltCount,physicalMiningShips:fleetShips.length,
     sdeBeltCount:sdeBelts,startupSlotsReady:startupSlots.ready
    });
    // A real named native NPC can operate even if stock mining or static
    // topology is incomplete. Readiness remains a stricter separate gate.
    if(verified)systems.delete(systemID);
    require("./coopRuntimeProbe").observe("living-headless-boot-system",null,
     {spaceState:{systemID}},
     {attempt:attempts,status:verified?"NATIVE_SCENE_READY":"PENDING_NATIVE_SCENE",
      realAsteroidBelts:beltCount,authoritativeSdeBelts:sdeBelts,
      miningApplicable:miningEnabled&&sdeBelts>0,
      trackedForReconcile:tracked,
      miningStartupStatus:miningStartup.status,
      nativeStartupSlots:startupSlots,
      physicalMiningShips:fleetShips.length,
      actualNamedNpcShips:links.length,sceneReady:Boolean(scene)});
   }catch(error){
    console.warn("[CoopHeadlessWorld] system "+systemID,error.message);
    require("./coopRuntimeProbe").observe("living-headless-boot-system",null,
     {spaceState:{systemID}},{attempt:attempts,status:"FAILED",reason:String(error.message).slice(0,120)});
   }
  }
  if(systems.size){
   const retryMs=nextHeadlessRetryMs(attempts);
   // One warning at the end of quick boot, then infrequent unresolved
   // warnings. Continue trying autonomously; never busy-loop.
   if(attempts===6||(attempts>6&&(attempts-6)%12===0))
    require("./coopRuntimeProbe").observe("living-headless-boot-incomplete",null,null,
     {pendingSystems:[...systems],attempts,retryMs,retrying:true});
   headlessBootTimer=setTimeout(attempt,retryMs);
   headlessBootTimer.unref?.();
  }
 };
 headlessBootTimer=setTimeout(attempt,10000);
 headlessBootTimer.unref?.();
}
function ensurePatrolNavigator(runtime,npc){
 if(patrolNavigator)return;
 const {createPatrolNavigator}=require("./coopPatrolNavigator");
 patrolNavigator=createPatrolNavigator({
  sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  warp:(id,point,options)=>npcNativeOrder("PATROL",id,"warp",
   ()=>npc.warpToPoint(id,point,options)),
  orbit:(id,targetID,range)=>npcNativeOrder("PATROL",id,"orbit",
   ()=>npc.orbit(id,targetID,range))
 });
}
function advanceNativeGateApproach(){
 if(process.env.EVEJS_COOP_NATIVE_GATE_APPROACH!=="1"||
  !bridge||!identityRegistry||!world||!visitedSystems.size)return;
 const route=String(process.env.EVEJS_COOP_VIRTUAL_ROUTE||"")
  .split(",").map(Number).filter(id=>Number.isSafeInteger(id)&&id>0);
 if(route.length<2)return;
 const runtime=require("./runtime"),npc=require("./npc/npcRuntime");
 const worldData=require("./worldData"),controllers=require("./npc/npcRegistry");
 // Both flags are opt-in and OFF by default. If the world is already
 // initialized, this call is idempotent; otherwise observeSession() recovers
 // before any registry pruning on first native boot.
 ensureNativeGateTransfer(runtime);
 if(!gateTravelDirector){
  gateTravelDirector=require("./coopNpcGateTravel").createGateTravel({
   warp:(entityID,gateID,options)=>npcNativeOrder("GATE",entityID,"warp-to-gate",
    ()=>npc.warpToEntity(entityID,gateID,options)),
   getGate:id=>worldData.getStargateByID(id),
   transfer:nativeGateTransfer?(args=>npcNativeOrder("GATE",args.entityID,
    "transfer",()=>nativeGateTransfer.transfer(args),args.gate?.sourceSystemID)):null
  });
 }
 const roles=economy?.snapshot().pilots||{};
 const links=bridge.snapshot().filter(a=>a?.pilotID&&a.entityID);
 const blockedIDs=tacticsDirector?.activeIDs()||new Set();
 if(raidDirector)for(const id of raidDirector.activePirateIDs(system=>
  runtime.ensureScene(system,{refreshStargates:false})))blockedIDs.add(id);
 if(wreckRecoveryDirector)for(const sys of visitedSystems)
  for(const id of wreckRecoveryDirector.activeIDs(sys))blockedIDs.add(id);
 if(lootCommerce)for(const sys of visitedSystems)
  for(const id of lootCommerce.activeIDs(sys))blockedIDs.add(id);
 for(const systemID of visitedSystems){
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  const assignments=links.filter(a=>Number(a.systemID)===Number(systemID));
  addNpcOrderBlocks(blockedIDs,systemID,"GATE");
  const evidence=gateTravelDirector.tick({systemID,scene,assignments,route,roles,
   getController:id=>controllers.getControllerByEntityID(id),blockedIDs});
  for(const move of evidence.orders){
   if(move.action!=="VERIFIED_NATIVE_GATE_TRANSFER")continue;
   // The destination must join real NPC simulation immediately after
   // confirmed physical arrival; never wait for a future headless boot.
   visitedSystems.add(Number(move.targetSystemID));
   require("./coopRuntimeProbe").observe("living-native-gate-transfer",null,
    {spaceState:{systemID:Number(move.targetSystemID)}},{
     pilotID:move.pilotID,entityID:move.entityID,
     sourceSystemID:Number(systemID),
     destinationSystemID:Number(move.targetSystemID),
     sourceGateID:move.sourceGateID,
     status:"SAME_NATIVE_SHIP_ARRIVED",
     evidenceSource:"NATIVE_DEMATERIALIZE_REMATERIALIZE"
    });
  }
  if(evidence.orders.length||evidence.observations.length)
   require("./coopRuntimeProbe").observe("living-native-gate-approach",null,
    {spaceState:{systemID}},{
     status:evidence.status,gateCount:evidence.gateCount,
     orders:evidence.orders,observations:evidence.observations,
     nativeTransferVerified:evidence.orders.some(o=>o.action==="VERIFIED_NATIVE_GATE_TRANSFER")
    });
 }
}
// This does not infer hits, and it never edits native cargo. The strict native
// reload policy is hooked separately into the pinned missile/local-cycle code.
let salvageRivalDirector=null,salvageRivalStationDelivery=null;
function advanceNativeSalvageRivals(){
 if(process.env.EVEJS_COOP_ALIFE_SALVAGE_RIVALS!=="1"||
  !alifeOrderArbitrationEnabled(process.env)||
  !identityRegistry||!bridge||!visitedSystems.size)return;
 const fs=require("node:fs"),path=require("node:path");
 const root=process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
  "/var/lib/evejs/coop-native-warehouse";
 const runtime=require("./runtime"),store=require("./npc/nativeNpcStore"),
  npc=require("./npc/npcRuntime"),controllers=require("./npc/npcRegistry"),
  gameStore=require("../gameStore"),
  items=require("../services/inventory/itemStore");
 const atomic=gameStore.coopAtomicNativeRows;
 if(typeof atomic?.transact!=="function")return;
 if(!salvageRivalDirector)
  salvageRivalDirector=require("./coopSalvageNpcRivals").createSalvageRivals({
   atomic,
   readCases:systemID=>{
    const dir=path.join(root,"salvage-provenance");
    let names;
    try{names=fs.readdirSync(dir)}catch(e){
     if(e?.code==="ENOENT")return [];
     throw e;
    }
    if(names.length>256||names.some(n=>!/^[0-9]+-[0-9]+-[0-9]+[.]json$/.test(n)))
     throw Error("SALVAGE_RIVAL_MANIFEST_DIRECTORY_UNTRUSTED");
    const found=[];
    for(const name of names){
     let rec;
     try{rec=jsonFileCache.readJsonFile(path.join(dir,name),{maxBytes:131072});}
     catch(error){if(String(error?.message)==="JSON_FILE_TOO_LARGE")throw Error("SALVAGE_RIVAL_WITNESS_TOO_LARGE");throw error;}
     if(rec?.v!==1||rec.manifestKey!==name.slice(0,-5)||
      !Array.isArray(rec.rows))throw Error("SALVAGE_RIVAL_WITNESS_INVALID");
     if(rec.systemID===systemID)found.push(rec);
    }
    return found;
   },
   readEscrow:key=>{
    const result=gameStore.read("corporationRuntime","/coopSalvageEscrows");
    if(!result?.success)return {status:result?.errorMsg==="ENTRY_NOT_FOUND"?"NOT_FOUND":"UNKNOWN"};
    const saved=result.data?.byContract?.["salvage-"+key];
    return saved?{status:saved.status}:{status:"NOT_FOUND"};
   },
   getController:id=>controllers.getControllerByEntityID(id),
   getNativeEntity:store.getNativeEntity,
   getNativeWreck:store.getNativeWreck,
   getNativeWreckItems:store.listNativeWreckItemsForWreck,
   readCargo:store.listNativeCargoForEntity,
   getUnitVolume:typeID=>Number(items.getItemMetadata(typeID)?.volume),
   warp:(id,wreckID)=>npcNativeOrder("CIVILIAN",id,"salvage-warp",
    ()=>npc.warpToEntity(id,wreckID),runtime.ensureScene(
     store.getNativeEntity(id)?.systemID,{refreshStargates:false})?.systemID),
   orbit:(id,wreckID,meters)=>npcNativeOrder("CIVILIAN",id,"salvage-orbit",
    ()=>npc.orbit(id,wreckID,meters),runtime.ensureScene(
     store.getNativeEntity(id)?.systemID,{refreshStargates:false})?.systemID)
  });
 if(!salvageRivalStationDelivery)
  salvageRivalStationDelivery=require("./coopSalvageNpcStationDelivery")
   .createNpcSalvageDelivery({
    atomic,readNativeCargo:store.listNativeCargoForEntity,
    readNativeItems:()=>Object.values(items.getAllItems()),
    readRivalJournal:()=>{
     const r=gameStore.read("corporationRuntime","/coopSalvageRivalMoves");
     if(r?.errorMsg==="ENTRY_NOT_FOUND")
      return {version:1,moves:{}};
     if(!r?.success)throw Error("SALVAGE_RIVAL_JOURNAL_UNAVAILABLE");
     return r.data;
    },
    readNativeEntity:store.getNativeEntity,
    getController:id=>controllers.getControllerByEntityID(id),
    getStation:id=>require("./worldData").getStationByID(id),
    buildInventoryItem:items.buildInventoryItem,
    warp:(id,stationID)=>npcNativeOrder("CIVILIAN",id,"rival-station-warp",
     ()=>npc.warpToEntity(id,stationID)),
    orbit:(id,stationID,meters)=>npcNativeOrder("CIVILIAN",id,"rival-station-orbit",
     ()=>npc.orbit(id,stationID,meters))
   });
 const roles=world?.snapshot()?.pilots||[];
 const links=[...bridge.snapshot(),...Object.values(
  identityRegistry.snapshot()?.links||{})];
 for(const systemID of visitedSystems){
  const scene=runtime.scenes instanceof Map?runtime.scenes.get(systemID):null;
  if(!scene)continue;
  const blockedIDs=new Set();
  if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
  if(gateTravelDirector)for(const id of gateTravelDirector.activeIDs())blockedIDs.add(id);
  if(raidDirector)for(const id of raidDirector.activePirateIDs(sid=>
   runtime.ensureScene(sid,{refreshStargates:false})))blockedIDs.add(id);
  if(wreckRecoveryDirector)for(const id of wreckRecoveryDirector.activeIDs(systemID))
   blockedIDs.add(id);
  addNpcOrderBlocks(blockedIDs,systemID,"CIVILIAN");
  const delivery=salvageRivalStationDelivery.tick({scene,
   assignments:links,blockedIDs});
  if(delivery.orders.length||delivery.deliveries.length)
   require("./coopRuntimeProbe").observe("alife-salvage-rival-station",
    null,{spaceState:{systemID}},{
     status:delivery.status,orders:delivery.orders,
     nativeStockDeliveries:delivery.deliveries,
     nativeInventoryAtomic:true,iskGranted:false
    });
  // A cargo-occupied NPC returning to a station must not also receive
  // a new wreck warp order from another A-Life director in this tick.
  if(delivery.orders.length||delivery.deliveries.length)continue;
  const result=salvageRivalDirector.tick({scene,assignments:links,roles,
   blockedIDs});
  if(result.orders.length||result.pickups.length)
   require("./coopRuntimeProbe").observe("alife-salvage-competition",
    null,{spaceState:{systemID}},{
     status:result.status,nativeOrders:result.orders,
     nativeCargoReceipts:result.pickups,
     npcSpawned:false,iskGranted:false
    });
 }
}
function advanceNativeWreckRecovery(){
 if(process.env.EVEJS_COOP_NPC_WRECK_RECOVERY!=="1"||
  process.env.EVEJS_COOP_NATIVE_WEAPON_EVIDENCE!=="1"||
  !alifeOrderArbitrationEnabled(process.env)||
  !identityRegistry||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),npc=require("./npc/npcRuntime"),
  store=require("./npc/nativeNpcStore"),controllers=require("./npc/npcRegistry");
 const journal=require("./coopNpcWreckClaims").getWreckClaims();
 if(!wreckRecoveryDirector)
  wreckRecoveryDirector=require("./coopNpcWreckRecovery").createWreckRecovery({
   warp:(entityID,wreckID,options)=>npcNativeOrder("CIVILIAN",entityID,"wreck-warp",
    ()=>npc.warpToEntity(entityID,wreckID,options)),
   orbit:(entityID,wreckID,meters)=>npcNativeOrder("CIVILIAN",entityID,"wreck-orbit",
    ()=>npc.orbit(entityID,wreckID,meters))
  });
 const assignments=bridge.snapshot().concat(
  Object.values(identityRegistry.snapshot().links||{}));
 for(const systemID of visitedSystems){
  const claims=journal.active(systemID);
  if(!claims.length)continue;
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  const blockedIDs=new Set();
  // A hull that owns a live claim must actually be able to fly to it. The stock
  // behaviour loop re-acquires its old prey every tick, so the loot phase clears
  // that unexecutable order itself and issues the wreck order in the SAME tick:
  // a release that waits for the next tick is undone before it can be used.
  if(typeof raidDirector?.releaseExcluded==="function"){
   try{
    const stale=claims.map(claim=>Number(claim.attackerEntityID)||0)
     .filter(entityID=>{
      if(!(entityID>0))return false;
      const ctrl=controllers.getControllerByEntityID(entityID);
      return String(ctrl?.manualOrder?.type||"").toLowerCase()==="attack"||
       Number(ctrl?.currentTargetID)>0;
     });
    const released=stale.length?
     raidDirector.releaseExcluded(stale,"WRECK_CLAIM_OWNS_HULL",{force:true}):[];
    for(const row of released)
     require("./coopRuntimeProbe").observe("living-native-raid-release",null,
      {spaceState:{systemID}},{...row,status:row.released?
       "RAID_ORDER_RELEASED_FOR_LOOT":"RAID_ORDER_RELEASE_REFUSED",
       iskGranted:false});
   }catch(_error){/* the refusal below still reports the exact state */}
  }
  if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
  if(gateTravelDirector)for(const id of gateTravelDirector.activeIDs())blockedIDs.add(id);
  if(raidDirector)for(const id of raidDirector.activePirateIDs(sys=>
    runtime.ensureScene(sys,{refreshStargates:false})))blockedIDs.add(id);
  if(lootCommerce)for(const id of lootCommerce.activeIDs(systemID))blockedIDs.add(id);
  // Deliver what the hull already carries before taking more: a hold that is
  // full of verified wreck cargo cannot loot anyway (NATIVE_CARGO_FULL), and
  // the recovery lease would otherwise starve the station delivery forever.
  if(lootCommerce){
   for(const claim of claims){
    const pilotID=String(claim.attackerPilotID||""),
     entityID=Number(claim.attackerEntityID)||0;
    if(!(entityID>0)||!pilotID)continue;
    try{
     if(lootCommerce.stock({pilotID,entityID}).length)blockedIDs.add(entityID);
    }catch(_error){/* an unreadable custody journal simply blocks nothing */}
   }
  }
  addNpcOrderBlocks(blockedIDs,systemID,"CIVILIAN");
  const result=wreckRecoveryDirector.tick({systemID,scene,claims,assignments,store,
   getController:id=>controllers.getControllerByEntityID(id),blockedIDs,
   pickupDistance:process.env.EVEJS_COOP_NPC_WRECK_TRANSFER==="1"?2500:0});
  if(result.orders.length||result.inspections.length)
   require("./coopRuntimeProbe").observe("living-npc-postraid-wreck-recovery",null,
    {spaceState:{systemID}},{orders:result.orders,inspections:result.inspections,
     transferStatus:"NOT_IMPLEMENTED_NO_NATIVE_ATOMIC_CUSTODY"});
  else{
   // A live claim with no order is a measured refusal, never a silent no-op:
   // publish the exact state the recovery director reads for that hull.
   const nowMs=Date.now();
   for(const claim of claims.slice(0,2)){
    const key="recovery:"+systemID+":"+claim.wreckID;
    if(nowMs-(wreckRecoveryNotes.get(key)||0)<300000)continue;
    wreckRecoveryNotes.set(key,nowMs);
    const hunterID=Number(claim.attackerEntityID)||0;
    const hunter=scene.getEntityByID(hunterID);
    const physical=scene.getEntityByID(Number(claim.wreckID)||0);
    const ctrl=controllers.getControllerByEntityID(hunterID);
    const gap=(a,b)=>(a&&b&&["x","y","z"].every(k=>
     Number.isFinite(Number(a[k]))&&Number.isFinite(Number(b[k]))))?
     Math.hypot(a.x-Number(b.x),a.y-Number(b.y),a.z-Number(b.z)):null;
    try{
     require("./coopRuntimeProbe").observe("living-npc-postraid-wreck-recovery-blocked",
      null,{spaceState:{systemID}},{status:"NO_ORDER",wreckID:Number(claim.wreckID)||0,
       hunterID,blocked:blockedIDs.has(hunterID),
       hunterMode:String(hunter?.mode||""),hunterPresent:Boolean(hunter),
       wreckPresent:physical?.nativeNpcWreck===true,
       manualType:String(ctrl?.manualOrder?.type||""),
       currentTargetID:Number(ctrl?.currentTargetID)||0,
       lastAggressorID:Number(ctrl?.lastAggressorID)||0,
       distanceMeters:gap(hunter?.position,physical?.position),
       pickupDistance:process.env.EVEJS_COOP_NPC_WRECK_TRANSFER==="1"?2500:0,
       claims:claims.length});
    }catch(_error){/* telemetry must never block recovery */}
   }
  }
 }
}
// A restart drops the physical native wreck entity while the durable native
// wreck row and its stored loot survive. This phase has exactly two honest
// outcomes per live claim: re-spawn the SAME native wreck entity from its own
// durable row through the stock spawnNativeWreck path, or close the claim with
// the measured reason. It never builds a wreck, moves an item or grants ISK.
function advanceNativeWreckClaimReconcile(){
 if(process.env.EVEJS_COOP_NPC_WRECK_RECOVERY!=="1"||
  process.env.EVEJS_COOP_NATIVE_WEAPON_EVIDENCE!=="1"||
  !alifeOrderArbitrationEnabled(process.env)||!visitedSystems.size)return;
 const runtime=require("./runtime"),store=require("./npc/nativeNpcStore"),
  wreckService=require("./npc/nativeNpcWreckService"),
  journal=require("./coopNpcWreckClaims").getWreckClaims();
 if(!wreckClaimReconcile)
  wreckClaimReconcile=require("./coopNpcWreckClaimReconcile");
 const configured=Number(process.env.EVEJS_COOP_NPC_WRECK_CLAIM_GRACE_MS||45000);
 const graceMs=Number.isFinite(configured)?
  Math.max(15000,Math.min(900000,configured)):45000;
 const nowMs=Date.now(),bootAgeMs=nowMs-worldBootAtMs;
 for(const systemID of visitedSystems){
  const claims=journal.active(systemID);
  if(!claims.length)continue;
  let scene=null;
  try{scene=runtime.scenes instanceof Map?runtime.scenes.get(systemID):null;}
  catch(_error){scene=null;}
  // A scene that does not exist yet can prove nothing about a wreck: wait.
  if(!scene||typeof scene.getEntityByID!=="function")continue;
  const result=safeNpcPhase("native-wreck-claim-reconcile",()=>
   wreckClaimReconcile.reconcile({systemID,scene,claims,store,nowMs,bootAgeMs,
    graceMs,
    restore:({systemID:sys,wreckID})=>wreckService.spawnNativeWreck(sys,wreckID),
    close:args=>journal.close(args)}));
  if(!result||result.status!=="OK")continue;
  for(const row of result.results||[]){
   if(row.status==="RESTORED")
    require("./coopRuntimeProbe").observe("living-npc-wreck-claim-restored",null,
     {spaceState:{systemID}},row);
   else if(row.status==="CLOSED"&&row.closeStatus==="CLAIM_CLOSED")
    require("./coopRuntimeProbe").observe("living-npc-wreck-claim-closed",null,
     {spaceState:{systemID}},{...row,
      status:row.loot===null?"LOOT_LOST_UNMEASURABLE":
       (Number(row.loot?.stacks)===0?"NOTHING_TO_RECOVER":"LOOT_LOST"),
      iskGranted:false,cargoMoved:false});
  }
 }
}
// Native source-first wreck debit -> native cargo credit. This phase is
// separate from mere wreck inspection and disabled by default.
function advanceNativeWreckCustody(){ if(process.env.EVEJS_COOP_NPC_WRECK_TRANSFER!=="1"||
  process.env.EVEJS_COOP_NPC_WRECK_RECOVERY!=="1"||
  process.env.EVEJS_COOP_NATIVE_WEAPON_EVIDENCE!=="1"||
  !alifeOrderArbitrationEnabled(process.env)||
  nativeMarketTickRunning||!identityRegistry||!bridge)return;
 const runtime=require("./runtime"),store=require("./npc/nativeNpcStore"),
  controllers=require("./npc/npcRegistry");
 if(!wreckCustody)wreckCustody=require("./coopNpcWreckCustody").createWreckCustody({
  store,sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  resolveType:id=>require("../services/inventory/itemTypeRegistry").resolveItemByTypeID(id),
  root:process.env.EVEJS_COOP_NPC_WRECK_CUSTODY_ROOT||
   "/var/lib/evejs/coop-npc-wreck-custody"
 });
 const recovered=wreckCustody.recover();
 if(recovered.status!=="CLEAN"){
  require("./coopRuntimeProbe").observe("living-npc-wreck-custody-blocked",
   null,null,{status:recovered.status,
    pending:recovered.pending?.slice(0,5)});
  return;
 }
 const claims=require("./coopNpcWreckClaims").getWreckClaims();
 const byPilot=new Map();
 for(const row of [...bridge.snapshot(),
  ...Object.values(identityRegistry.snapshot().links||{})]){
  if(!row?.pilotID||!Number.isSafeInteger(Number(row.entityID)))continue;
  const key=String(row.pilotID)+":"+String(row.entityID)+":"+String(row.systemID);
  byPilot.set(key,row);
 }
 const assignments=[...byPilot.values()];
 let count=0;
 for(const systemID of visitedSystems){
  if(count>=2)break;
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  for(const claim of claims.active(systemID)){
   if(count>=2)break;
   const ship=scene.getEntityByID(claim.attackerEntityID),
    wreck=scene.getEntityByID(claim.wreckID);
   if(ship?.kind!=="ship"||ship.nativeNpc!==true||
    wreck?.nativeNpcWreck!==true||!ship.position||!wreck.position||
    !["x","y","z"].every(k=>Number.isFinite(ship.position[k])&&
     Number.isFinite(wreck.position[k]))||
    Math.hypot(ship.position.x-wreck.position.x,
     ship.position.y-wreck.position.y,
     ship.position.z-wreck.position.z)>2500)continue;
   if(tacticsDirector?.activeIDs().has(Number(claim.attackerEntityID))||
    gateTravelDirector?.activeIDs().has(Number(claim.attackerEntityID))||
    raidDirector?.activePirateIDs(sys=>runtime.ensureScene(sys,{refreshStargates:false}))
     .has(Number(claim.attackerEntityID)))continue;
   const items=store.listNativeWreckItemsForWreck(claim.wreckID);
   if(!Array.isArray(items))continue;
   for(const item of items.slice(0,2)){
    if(count>=2)break;
    const result=wreckCustody.transfer({claim,scene,
     entityID:Number(claim.attackerEntityID),
     wreckItemID:Number(item.wreckItemID),assignments,
     getController:id=>controllers.getControllerByEntityID(id),
     verifyClaim:({claim:presented})=>
      claims.active(systemID).some(saved=>
       Number(saved.wreckID)===Number(presented.wreckID)&&
       Number(saved.sourceEntityID)===Number(presented.sourceEntityID)&&
       Number(saved.attackerEntityID)===Number(presented.attackerEntityID)&&
       saved.attackerPilotID===presented.attackerPilotID&&
       Number(saved.at)===Number(presented.at)),
     canLoot:({wreck,native})=>
      Number(wreck.ownerID)>0&&Number(wreck.ownerID)===Number(native.ownerID)||
      Number(wreck.lootRightCorpID)>0&&
       Number(wreck.lootRightCorpID)===Number(native.corporationID)&&
       Number(native.corporationID)>0});
    if(result.status==="NATIVE_WRECK_CARGO_SETTLED"){
     count++;
     require("./coopRuntimeProbe").observe("living-npc-wreck-cargo-settled",null,
      {spaceState:{systemID}},result);
    }else if(!["NATIVE_LOOT_RIGHTS_NOT_VERIFIED","INVALID_NATIVE_CUSTODY_PROOF",
     "NATIVE_WRECK_OR_SHIP_UNVERIFIED","NATIVE_COMBAT_ORDER_ACTIVE",
     "NATIVE_CARGO_FULL","ALREADY_SETTLED"].includes(result.status)){
     require("./coopRuntimeProbe").observe("living-npc-wreck-custody-refused",null,
      {spaceState:{systemID}},{status:result.status,
       wreckID:claim.wreckID,itemID:item.wreckItemID});
     }else if(result.status!=="ALREADY_SETTLED"){
      // These statuses used to return silently, so "why is the loot still in the
      // wreck" had no answer. Publish each claim+status once per 5 minutes.
      const noteKey=systemID+":"+claim.wreckID+":"+result.status;
      const at=Date.now();
      if(at-(wreckCustodyNotes.get(noteKey)||0)>=300000){
       wreckCustodyNotes.set(noteKey,at);
       require("./coopRuntimeProbe").observe("living-npc-wreck-custody-skip",null,
        {spaceState:{systemID}},{status:result.status,
         wreckID:Number(claim.wreckID)||0,itemID:Number(item.wreckItemID)||0,
         hunterID:Number(claim.attackerEntityID)||0,
         pilotID:String(claim.attackerPilotID||""),
         hunterMode:String(ship?.mode||""),
         distanceMeters:Math.hypot(ship.position.x-wreck.position.x,
          ship.position.y-wreck.position.y,
          ship.position.z-wreck.position.z),
         quantity:Number(item.quantity)||0,typeID:Number(item.typeID)||0,
         cargoTransferred:false,iskGranted:false});
         }
    }
   }
  }
 }
}
// Move only source-authenticated recovered wreck cargo; no market side effects.
function advanceNativeLootStationDelivery(){
 if(process.env.EVEJS_COOP_NPC_LOOT_COMMERCE!=="1"||
  process.env.EVEJS_COOP_NPC_WRECK_TRANSFER!=="1"||
  !alifeOrderArbitrationEnabled(process.env)||
  !identityRegistry||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),npc=require("./npc/npcRuntime"),
  controllers=require("./npc/npcRegistry"),
  store=require("./npc/nativeNpcStore"),worldData=require("./worldData");
 if(!lootCommerce)lootCommerce=require("./coopNpcLootCommerce").createLootCommerce({
  root:process.env.EVEJS_COOP_NPC_WRECK_CUSTODY_ROOT||
   "/var/lib/evejs/coop-npc-wreck-custody",
  store,sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  getController:id=>controllers.getControllerByEntityID(id),
  getStation:id=>worldData.getStationByID(id),
  warp:(id,stationID,opts)=>npcNativeOrder("CIVILIAN",id,"loot-station-warp",
   ()=>npc.warpToEntity(id,stationID,opts)),
  orbit:(id,stationID,range)=>npcNativeOrder("CIVILIAN",id,"loot-station-orbit",
   ()=>npc.orbit(id,stationID,range))
 });
 const byKey=new Map();
 for(const row of [...bridge.snapshot(),
  ...Object.values(identityRegistry.snapshot().links||{})])
  if(row?.pilotID&&Number(row.entityID)>0&&Number(row.systemID)>0)
   byKey.set(row.pilotID+":"+row.entityID+":"+row.systemID,row);
 const assignments=[...byKey.values()],blockedIDs=new Set();
 if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
 if(gateTravelDirector)for(const id of gateTravelDirector.activeIDs())blockedIDs.add(id);
 if(raidDirector)for(const id of raidDirector.activePirateIDs(sys=>
   runtime.ensureScene(sys,{refreshStargates:false})))blockedIDs.add(id);
 if(wreckRecoveryDirector)for(const sys of visitedSystems)
  for(const id of wreckRecoveryDirector.activeIDs(sys))blockedIDs.add(id);
 for(const sys of visitedSystems)addNpcOrderBlocks(blockedIDs,sys,"CIVILIAN");
 const result=lootCommerce.tick({assignments,blockedIDs});
 if(result.orders.length||result.ready.length)
  require("./coopRuntimeProbe").observe("living-npc-loot-station",null,null,{
   nativeMovementOrders:result.orders,physicallyReady:result.ready,
   source:"AUTHENTICATED_NATIVE_WRECK_CARGO",iskCredited:false
  });
 else{
  // A hull that really carries custody-verified wreck cargo and still gets no
  // station order is a measured refusal, never silence: publish why.
  const nowMs=Date.now();
  for(const row of assignments){
   const entityID=Number(row?.entityID)||0,pilotID=String(row?.pilotID||"");
   const systemID=Number(row?.systemID)||0;
   if(!(entityID>0)||!pilotID||!(systemID>0))continue;
   let stock=[];
   try{stock=lootCommerce.stock({pilotID,entityID});}catch(_error){stock=[];}
   if(!stock.length)continue;
   const key="loot-station:"+entityID;
   if(nowMs-(lootStationNotes.get(key)||0)<300000)continue;
   lootStationNotes.set(key,nowMs);
   let ship=null,ctrl=null,stations=0,nearest=null;
   try{
    const scene=runtime.ensureScene(systemID,{refreshStargates:false});
    ship=scene?.getEntityByID?.(entityID)||null;
    ctrl=controllers.getControllerByEntityID(entityID);
    const list=(scene?.staticEntities||[]).filter(p=>p?.kind==="station"&&
     Number(p.itemID)>0&&p.position);
    stations=list.length;
    if(ship?.position&&list.length){
     const gap=p=>Math.hypot(ship.position.x-p.position.x,
      ship.position.y-p.position.y,ship.position.z-p.position.z);
     const best=list.slice().sort((a,b)=>gap(a)-gap(b))[0];
     nearest={stationID:Number(best.itemID)||0,distanceMeters:gap(best)};
    }
   }catch(_error){/* telemetry must never block the leg */}
   try{
    require("./coopRuntimeProbe").observe("living-npc-loot-station-blocked",null,
     {spaceState:{systemID}},{status:"NO_ORDER",pilotID,entityID,systemID,
      blocked:blockedIDs.has(entityID),mode:String(ship?.mode||""),
      pendingWarp:Boolean(ship?.pendingWarp||ship?.warpState),
      currentTargetID:Number(ctrl?.currentTargetID)||0,
      manualType:String(ctrl?.manualOrder?.type||""),
      cargoIDs:stock.map(c=>Number(c.cargoID)),stationCount:stations,nearest,
      cargoMoved:false,iskGranted:false});
   }catch(_error){/* ignore */}
  }
 }
}
function advanceNativePatrolRoutes(){
 if(!patrolDirector||!patrolNavigator||process.env.EVEJS_COOP_FACTION_PATROLS!=="1")return;
 for(const [systemID,entityIDs] of Object.entries(patrolDirector.snapshot())){
  const blockedIDs=gateTravelDirector?.activeIDs()||new Set();
  if(wreckRecoveryDirector&&process.env.EVEJS_COOP_NPC_WRECK_RECOVERY==="1")
   for(const id of wreckRecoveryDirector.activeIDs(Number(systemID)))blockedIDs.add(id);
  if(lootCommerce)for(const id of lootCommerce.activeIDs(Number(systemID)))blockedIDs.add(id);
  if(nativeAmmoSupply)for(const id of nativeAmmoSupply.activeIDs(Number(systemID)))blockedIDs.add(id);
  // Keep the existing patrol scheduling path unchanged when arbitration is OFF.
  if(alifeOrderArbitrationEnabled(process.env)){
   if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
   if(raidDirector)for(const id of raidDirector.activePirateIDs(sys=>{
    const native=require("./runtime");return native.ensureScene(sys,{refreshStargates:false});
   }))blockedIDs.add(id);
   addNpcOrderBlocks(blockedIDs,Number(systemID),"PATROL");
  }
  const result=patrolNavigator.tick(Number(systemID),entityIDs,{blockedIDs});
  if(result.orders?.length)console.info("[CoopFactionPatrol] native waypoint orders",JSON.stringify({systemID,orders:result.orders}));
 }
}
function ensureNativeMining(scene,systemID){
 if(process.env.EVEJS_COOP_NATIVE_MINING!=="1"||!scene)return;
 if(initializedNativeMiningScenes.has(scene)){
  // Reconsider real convoy losses at the normal bounded world reconcile
  // interval; do not re-run general mining scene init after startup.
  // The pinned upstream startup hook + native renewal policy enforce
  // loss cooldown and spawn caps before any replacement is permitted.
  if(process.env.EVEJS_COOP_CONVOY_RENEWAL==="1")
   require("../services/mining/miningNpcOperations").handleSceneCreated(scene);
  return;
 }
 // Stock EveJS mining operations prevent duplicate fleet seeding.
 // If the scene was only partially initialized, retry on the next pass.
 require("../services/mining/miningRuntime").handleSceneCreated(scene);
 const mining=require("../services/mining/miningNpcOperations");
 const expected=Number(process.env.EVEJS_MINING_NPC_STARTUP_FLEET_COUNT||1);
 const configured=String(process.env.EVEJS_MINING_NPC_STARTUP_SYSTEM_IDS||"")
  .split(",").map(x=>Number(x.trim())).filter(x=>Number.isSafeInteger(x)&&x>0);
 // A lone ship, a GM fleet or just the first of multiple startup
 // slots is not enough: keep retrying missing native fleet slots.
 if(process.env.EVEJS_COOP_MINING_STARTUP_RETRY==="1"&&
  process.env.EVEJS_MINING_NPC_STARTUP_ENABLED==="true"&&
  (!configured.length||configured.includes(Number(systemID)))){
  const outcome=require("./coopNativeMiningReadiness").inspect({
   scene,systemID,expectedCount:expected,
   fleets:mining.getMiningFleetsForSystem(systemID)
  });
  if(outcome.ready)initializedNativeMiningScenes.add(scene);
 }else if((mining.getMiningFleetsForSystem(systemID)||[]).some(f=>
   [...(f.minerEntityIDs||[]),...(f.haulerEntityIDs||[])]
    .some(id=>scene.getEntityByID?.(Number(id)))))
  initializedNativeMiningScenes.add(scene);
}
function ensureCivilianOrders(runtime,npc){
 if(civilianOrders)return;
 const {createCivilianOrders}=require("./coopCivilianOrders");
 civilianOrders=createCivilianOrders({
  sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  warp:(id,point,options)=>npcNativeOrder("CIVILIAN",id,"warp",
   ()=>npc.warpToPoint(id,point,options)),
  orbit:(id,targetID,range)=>npcNativeOrder("CIVILIAN",id,"orbit",
   ()=>npc.orbit(id,targetID,range)),
  // With a player on grid, a scheduled civilian route must not warp the NPC
  // away in front of them (they visually vanish). OFF by default.
  playerHoldMeters:process.env.EVEJS_COOP_NPC_ROUTE_HOLD==="1"?200000:0
 });
}
function observeNativeCombat(){
 if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT!=="1"||!identityRegistry||!visitedSystems.size)return;
 if(!combatEvidenceDirector)
  combatEvidenceDirector=require("./coopNativeCombatEvidence").createCombatEvidence();
 const runtime=require("./runtime");
 const damage=require("./combat/damage");
 const controllers=require("./npc/npcRegistry");
 const links=Object.values(identityRegistry.snapshot().links||{});
 for(const systemID of visitedSystems){
  try{
   const scene=runtime.ensureScene(systemID,{refreshStargates:false});
   const getHealth=entity=>{
    const max=damage.getEntityMaxHealthLayers(entity);
    if(!Object.values(max).some(n=>n>0))return null;
    return damage.getEntityCurrentHealthLayers(entity,max);
   };
   const getController=id=>controllers.getControllerByEntityID(id);
   const result=combatEvidenceDirector.sample({
    systemID,scene,links,getHealth,getController
   });
   if(result.status==="SAMPLED"&&result.damageEvents)
    require("./coopRuntimeProbe").observe("living-native-combat-damage",null,
     {spaceState:{systemID}},result);
   // Named pirate -> unnamed genuine stock miner is a valid native PvE
   // encounter, but cannot be reported as named-vs-named damage.
   if(process.env.EVEJS_COOP_NPC_RAIDS==="1"){
    if(!stockCombatEvidenceDirector)
     stockCombatEvidenceDirector=require("./coopStockFleetCombatEvidence")
      .createStockFleetCombatEvidence();
    const mining=require("../services/mining/miningNpcOperations");
    const fleetShips=require("./coopNativeRaidEligibility").liveFleetShips(
     mining.getMiningFleetsForSystem(systemID),scene,systemID);
    const stock=stockCombatEvidenceDirector.sample({
     systemID,scene,links,pilots:world?.snapshot()?.pilots||[],
     fleetShips,getHealth,getController
    });
    if(stock.status==="SAMPLED"&&stock.damageEvents)
     require("./coopRuntimeProbe").observe("living-native-stock-fleet-combat",null,
      {spaceState:{systemID}},stock);
   }
  }catch(error){console.warn("[CoopNativeCombatEvidence] sample",systemID,error.message);}
 }
}
function observeNativeActivity(){
 if(process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT!=="1"||!identityRegistry||!visitedSystems.size)return;
 if(!activityDirector)activityDirector=require("./coopNativeActivity").createActivity();
 const runtime=require("./runtime");
 const store=require("./npc/nativeNpcStore");
 const registry=require("./npc/npcRegistry");
 const links=Object.values(identityRegistry.snapshot().links||{});
 for(const systemID of visitedSystems){
  try{
   const scene=runtime.ensureScene(systemID,{refreshStargates:false});
   const sample=activityDirector.sample({
    systemID,scene,links,
    getCargo:id=>store.listNativeCargoForEntity(id),
    getController:id=>registry.getControllerByEntityID(id)
   });
   // A sample with no activity is not a PASS. Emit occasional liveness
   // evidence without growing the log on every quiet NPC tick.
   if(sample.status==="SAMPLED"&&
      (sample.observedMovement||sample.oreGrowth||sample.engagedNativeNpcs||backgroundTicks%10===0)){
     require("./coopRuntimeProbe").observe("living-native-activity",null,
      {spaceState:{systemID}},sample);
   }
  }catch(error){console.warn("[CoopNativeActivity] sample",systemID,error.message);}
 }
}
async function observeAlifeEconomy(){
 // COOP-043: still one existing 30-second A-Life tick, no competing timer.
 if(alifeEconomyAuthorityBusy)return;
 alifeEconomyAuthorityBusy=true;
 try{
  if(!world||!identityRegistry||!visitedSystems.size){
   if(backgroundTicks%10===0)require("./coopRuntimeProbe").observe(
    "alife-economy-blocker",null,null,{reason:"NATIVE_ALIFE_WORLD_NOT_READY",
     status:"BLOCKED",source:"NATIVE_ECONOMY_SENSOR"});
   return;
  }
  const native=require("./runtime"),npcStore=require("./npc/nativeNpcStore");
  const controllers=require("./npc/npcRegistry");
  const worldData=require("./worldData"),probe=require("./coopRuntimeProbe");
  if(!alifeEconomyObserver)alifeEconomyObserver=require("./coopAlifeEconomy")
   .createAlifeEconomyObserver({emit:event=>probe.observe(event.event,null,
     {spaceState:{systemID:event.systemID}},event)});
  const roles=new Map(world.snapshot().pilots.map(p=>[p.id,p.role]));
  const links=Object.values(identityRegistry.snapshot().links||{});
  const authorityEnabled=process.env.EVEJS_COOP_ALIFE_ECONOMY_AUTHORITY==="1";
  if(authorityEnabled&&!alifeStationAuthority){
   const {createRuntimeStationAuthority,parseTargets}=require("./coopAlifeStationAuthorityRuntime");
   const products=parseTargets(process.env.EVEJS_COOP_ALIFE_ECONOMY_PRODUCTS||"");
   alifeStationAuthority=createRuntimeStationAuthority({products,deps:{
    worldData,
    itemStore:require("../services/inventory/itemStore"),
    industryStatic:require("../services/industry/industryStaticData"),
    industryParity:require("../services/industry/industryParityHelpers"),
    gameStore:require("../gameStore"),
    marketClient:require("../services/market/marketDaemonClient").marketDaemonClient
   }});
  }
  // Global read budget across all systems, not eight stations per system.
  let remainingStations=8;
  const stationEvidenceCache=new Map();
  for(const systemID of [...visitedSystems].sort((a,b)=>a-b).slice(0,4)){
   const scene=native.ensureScene(systemID,{refreshStargates:false});
   const snap=require("./coopAlifeEconomySensor").readEconomySnapshot({
    systemID,scene,links,roles,
    getController:id=>controllers.getControllerByEntityID(id),
    getStation:id=>worldData.getStationByID(id),
    getNativeEntity:id=>npcStore.getNativeEntity(id),
    listNativeCargo:id=>npcStore.listNativeCargoForEntity(id),
    inspectNativeAmmo:(entityID,pilotID)=>nativeAmmoSupply?.inspect({
     scene,entityID,pilotID,assignments:links})||null,
    readStationEconomy:()=>null
   });
   if(authorityEnabled&&alifeStationAuthority&&snap.authoritativeNative===true){
    // Bound to the pilot's actual native corporation; never broadcast another
    // corporation's station stock to a trader or a player-owned ship.
    const cache=stationEvidenceCache;
    for(const pilot of snap.pilots){
     if(pilot.role!=="trader"||!pilot.stationID||!pilot.ownerID)continue;
     const key=pilot.ownerID+":"+pilot.stationID;
     if(cache.has(key)){pilot.economy=cache.get(key);continue;}
     if(remainingStations--<=0){pilot.economy={authoritativeNative:false,
       reason:"NATIVE_ALIFE_STATION_BUDGET_EXCEEDED"};continue;}
     const observed=await alifeStationAuthority.read({
      ownerID:pilot.ownerID,stationID:pilot.stationID,systemID});
     pilot.economy=observed;
     cache.set(key,observed);
    }
   }
   const decision=alifeEconomyObserver.tick(snap);
   // LW-04B: use this existing A-Life authority tick for manufacturing
   // admission only. Shipped native industry bindings are NOT live-safe.
   if(process.env.EVEJS_COOP_ALIFE_ECONOMY_ACT==="1"){
    // Manufacturing admission is independent of the remaining A-Life phases.
    // A failed native source callback cannot suppress NPC resupply or buyer
    // observations in this 30-second world cycle; never retry the intent.
    try{
     if(!alifeManufacturingRuntime)alifeManufacturingRuntime=
      require("./coopAlifeNativeManufacturingRuntime").createRuntimeAlifeManufacturing({
       getNativeEntity:id=>npcStore.getNativeEntity(id),
       getController:id=>controllers.getControllerByEntityID(id),
       sceneForSystem:id=>native.scenes instanceof Map?native.scenes.get(id):null,
       getStation:id=>worldData.getStationByID(id)
      });
     const result=await alifeManufacturingRuntime.tick({
      snapshot:snap,decision,registry:identityRegistry});
     if(result.status==="BLOCKED"||result.status==="ADMISSION_EVALUATED")
      probe.observe("alife-native-manufacturing-admission",null,
       {spaceState:{systemID}},
       {status:result.status,reason:result.reason||null,
        count:result.count||0,
        directorReportedNativeAction:result.results?.some(x=>x.nativeMutation===true)===true,
        nativeSettlementVerified:false,
        source:"NATIVE_SOURCE_ADMISSION_NOT_NATIVE_SETTLEMENT"});
    }catch(_error){
     probe.observe("alife-native-manufacturing-admission",null,
      {spaceState:{systemID}},
      {status:"BLOCKED",reason:"NATIVE_MANUFACTURING_ADMISSION_EXCEPTION",
       nativeSettlementVerified:false,
       source:"NATIVE_SOURCE_ADMISSION_NOT_NATIVE_SETTLEMENT"});
    }
   }
   if(require("./coopAlifeNativeResupplyBridge").nativeResupplyActEnabled())
    safeNpcPhase("alife-native-resupply-act",()=>
     advanceNativeAmmoSupply({mode:"PLANNED",systemIDFilter:systemID,decision}));
   // COOP-049: exactly one existing A-Life authority may dispatch the
   // opt-in native corporate buyer. Independent legacy market writers block it.
   if(process.env.EVEJS_COOP_ALIFE_NATIVE_BUYER==="1"){
    if(process.env.EVEJS_COOP_NATIVE_NPC_MARKET==="1"||nativeMarketTickRunning){
     probe.observe("alife-native-buyer-blocked",null,{spaceState:{systemID}},
      {reason:"PARALLEL_NATIVE_MARKET_WRITER_ENABLED",status:"BLOCKED"});
    }else{
     if(!alifeBuyerRuntime)alifeBuyerRuntime=require("./coopAlifeNativeBuyerRuntime")
      .createRuntimeAlifeBuyer({file:process.env.EVEJS_COOP_NPC_CORP_BUY_JOURNAL||
       "/var/lib/evejs/coop-npc-corp-buy-journal.json"});
     const purchased=await alifeBuyerRuntime.tick({snapshot:snap,decision,
      registry:identityRegistry,world});
     if(purchased.purchases?.length||purchased.status==="BLOCKED")
      probe.observe("alife-native-buyer-result",null,{spaceState:{systemID}},
       {status:purchased.status,purchases:purchased.purchases||[],
        reason:purchased.reason||null});
    }
   }
  }
 }finally{alifeEconomyAuthorityBusy=false}
}
let nativeSellPricing=null;
function sellPricing(){
 if(process.env.EVEJS_COOP_NPC_SELL_PRICING!=="1")return null;
 if(!nativeSellPricing)nativeSellPricing=require("./coopNpcSellPricing").createSellPricing({
  intervalMs:Math.max(30000,Math.min(3600000,
   Number(process.env.EVEJS_COOP_NPC_SELL_STEP_INTERVAL_MS||120000))),
  stepPct:Math.max(0.01,Math.min(0.5,
   Number(process.env.EVEJS_COOP_NPC_SELL_STEP_PCT||0.05))),
  minPct:Math.max(0.2,Math.min(0.99,
   Number(process.env.EVEJS_COOP_NPC_SELL_FLOOR_PCT||0.55)))});
 return nativeSellPricing;
}
// One durable guarded trader for the whole process: the arrival sale and the
// normal market tick must share the same in-memory ledger, never a second copy.
// The refinery leaves its minerals in the corporation hangar, and a hangar stack
// cannot be sold by a ship trader. One custody-safe load puts the exact quantity
// into the hauler's real native cargo hold (durable receipt per lift), and the
// proven sale path above then liquidates it against the seeded bids of the very
// station the hauler is docked at. OFF by default.
let mineralLiftEngine=null,mineralLiftBlocked=false;const mineralLiftNotes=new Map();
function ensureMineralLift(){
 if(mineralLiftEngine||mineralLiftBlocked)return mineralLiftEngine;
 try{
  const store=require("./npc/nativeNpcStore"),items=require("../services/inventory/itemStore");
  const worldData=require("./worldData");
  const {createMineralLift}=require("./coopNpcMineralLift");
  const engine=createMineralLift({store,items,
   call:(method,params)=>require("../services/market/marketDaemonClient")
    .marketDaemonClient.call(method,params),
   getStation:id=>worldData.getStationByID(id),
   resolveType:id=>require("../services/inventory/itemTypeRegistry").resolveItemByTypeID(id),
   corpID:Math.max(1,Number(process.env.EVEJS_COOP_FACTORY_CORP_ID||1000129)),
   root:process.env.EVEJS_COOP_NPC_MINERAL_LIFT_DIR||"/var/lib/evejs/coop-mineral-lift",
   probe:require("./coopRuntimeProbe")});
  const round=engine.recover();
  if(round.status==="NEEDS_OPERATOR_REPAIR"){
   // Freight that is neither still in the hangar nor verifiably aboard is a
   // human decision. Never lift again while that is unresolved.
   mineralLiftBlocked=true;
   require("./coopRuntimeProbe").observe("living-npc-mineral-lift-blocked",null,
    {spaceState:{reason:"NEEDS_OPERATOR_REPAIR",pending:round.pending}});
   return null;
  }
  mineralLiftEngine=engine;
 }catch(error){
  mineralLiftBlocked=true;
  return null;
 }
 return mineralLiftEngine;
}

// Close the world's own RPC_CALLING journals from market proof (space/coopMarketJournalBoot.js
// owns the logic; every authority is injected so this file keeps no state for it).
let journalBootReconciler=null;
const reconcileMarketJournalsAtBoot=(force=false)=>(journalBootReconciler||
 (journalBootReconciler=require("./coopMarketJournalBoot").createFromEnvironment()))(force);
// The co-op loop advances an operator-journaled gate crossing with the same verified
// adapter the war layer uses; nothing else may reach it.
const nativeGateTransferAdapter=()=>nativeGateTransfer;
const identityRegistryAdapter=()=>identityRegistry;
function ensureMarketTrader(){ if(nativeMarketTrader||nativeMarketBlocked)return nativeMarketTrader;
 if(!identityRegistry||!world)return null;
 const runtime=require("./runtime"),store=require("./npc/nativeNpcStore");
 const worldData=require("./worldData"),inventory=require("../services/inventory/itemTypeRegistry");
 const controllers=require("./npc/npcRegistry");
 const marketClient=require("../services/market/marketDaemonClient").marketDaemonClient;
 const {createNpcMarketTrader}=require("./coopNativeNpcMarket");
 const market=createNpcMarketTrader({
  call:(method,params)=>marketClient.call(method,params),
  store,registry:identityRegistry,getStation:id=>worldData.getStationByID(id),
  sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
  getController:id=>controllers.getControllerByEntityID(id),
  resolveType:id=>inventory.resolveItemByTypeID(id),
  root:process.env.EVEJS_COOP_NPC_MARKET_ROOT||"/var/lib/evejs/coop-native-market",
  maxQuantity:Math.max(1,Math.min(20,Number(process.env.EVEJS_COOP_NPC_MARKET_MAX_QTY||5))),
  // A sale is bounded by the real seeded bid volume, like a player's. The
  // small MAX_QTY stays a BUY spending guard and never starves the economy.
  maxSellQuantity:Math.max(1,Math.min(1000000,
   Number(process.env.EVEJS_COOP_NPC_MARKET_MAX_SELL_QTY||100000))),
  maxPrice:Math.max(0.01,Math.min(1000000,Number(process.env.EVEJS_COOP_NPC_MARKET_MAX_PRICE||10000))),
  cooldownMs:Math.max(30000,Math.min(3600000,Number(process.env.EVEJS_COOP_NPC_MARKET_COOLDOWN_MS||300000))),
  priceFloorFor:process.env.EVEJS_COOP_NPC_SELL_PRICING==="1"?
   (typeID,bestBid,stationID)=>{
    const pricing=sellPricing();
    if(!pricing)return 0;
    const key=Number(stationID)+":"+Number(typeID);
    pricing.offer(key,bestBid);
    const decision=pricing.decide({key,bestBid});
    return decision.price||0;
   }:null
 });
 // A pending RPC of unknown outcome can never be retried automatically - but it can be
 // SETTLED from the market's own order row, and until that runs every later sale of the
 // pilot is refused with UNRESOLVED_MARKET_JOURNAL (measured 2026-10-28: one crashed
 // partial fill stopped the corporation from selling anything at all). The proof is
 // read-only, so the world closes its own journal at boot instead of waiting for an
 // operator; the per-trade journal guard still refuses every trade until it is closed.
 const recovered=market.recover();
 if(recovered.status==="NEEDS_OPERATOR_REPAIR"){
  require("./coopRuntimeProbe").observe("living-native-market-repair-required",null,null,recovered);
 } else if(recovered.recovered)
  require("./coopRuntimeProbe").observe("living-native-market-recovered",null,null,recovered);
 // Always once per boot, whether or not recover() complained: a journal at RPC_CALLING is
 // exactly what recover() leaves alone, and that is the one an operator had to close by
 // hand. The reconcile is read-only and reports what it did either way.
 reconcileMarketJournalsAtBoot();
 nativeMarketTrader=market;
 return market;
}
async function advanceNativeMarket(){ if(process.env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1"||
  nativeMarketBlocked||nativeMarketTickRunning||
  !identityRegistry||!world||!visitedSystems.size)return;
 const sellTypes=nativeMarketAllowlist("EVEJS_COOP_NPC_MARKET_SELL_TYPES");
 const buyTypes=nativeMarketAllowlist("EVEJS_COOP_NPC_MARKET_BUY_TYPES");
 if(!sellTypes.length&&!buyTypes.length)return;
 nativeMarketTickRunning=true;
 try{
  const runtime=require("./runtime"),store=require("./npc/nativeNpcStore");
  const worldData=require("./worldData"),inventory=require("../services/inventory/itemTypeRegistry");
  const controllers=require("./npc/npcRegistry");
  const marketClient=require("../services/market/marketDaemonClient").marketDaemonClient;
  const market=ensureMarketTrader();
  if(!market)return;
  const roles=new Map(world.snapshot().pilots.map(p=>[p.id,p.role]));
  const rearmEnabled=process.env.EVEJS_COOP_NPC_EARN_SPEND_REARM==="1"&&
   process.env.EVEJS_COOP_NPC_LOOT_COMMERCE==="1"&&
   alifeOrderArbitrationEnabled(process.env);
  if(rearmEnabled&&!nativeRearm)
   nativeRearm=require("./coopNpcNativeRearm").createNativeRearm({
    store,registry:identityRegistry,
    sceneForSystem:id=>runtime.ensureScene(id,{refreshStargates:false}),
    getController:id=>controllers.getControllerByEntityID(id),
    getStation:id=>worldData.getStationByID(id),
    resolveType:id=>inventory.resolveItemByTypeID(id),
    compatible:(module,typeID)=>require("./npc/npcCapabilityResolver")
     .isNpcChargeCompatibleWithModule(module,typeID),
    verifyCombatCharge:(ship,module)=>require("./npc/npcEquipment")
     .getNpcLoadedChargeForModule(ship,module),
    root:process.env.EVEJS_COOP_NPC_MARKET_ROOT||
     "/var/lib/evejs/coop-native-market"
   });
  const rearmTypes=rearmEnabled?nativeMarketAllowlist(
   "EVEJS_COOP_NPC_REARM_CHARGE_TYPES").filter(x=>buyTypes.includes(x)):[];
  const blocked=tacticsDirector?.activeIDs()||new Set();
  if(gateTravelDirector)for(const id of gateTravelDirector.activeIDs())blocked.add(id);
  if(raidDirector)for(const id of raidDirector.activePirateIDs(id=>
   runtime.ensureScene(id,{refreshStargates:false})))blocked.add(id);
  for(const sys of visitedSystems)addNpcOrderBlocks(blocked,sys,"CIVILIAN");
  const links=Object.values(identityRegistry.snapshot().links||{})
   .filter(l=>l?.pilotID&&l.entityID)
   .sort((a,b)=>String(a.pilotID).localeCompare(String(b.pilotID)));
  let completed=0;
  for(const systemID of visitedSystems){
   if(completed>=2)break;
   const scene=runtime.ensureScene(systemID,{refreshStargates:false});
   const stations=(scene.staticEntities||[]).filter(x=>x?.kind==="station"&&Number(x.itemID)>0);
   if(!stations.length)continue;
   for(const link of links.filter(x=>Number(x.systemID)===Number(systemID))){
    if(completed>=2)break;
    const role=roles.get(link.pilotID)||link.role;
    // FW-005C: the hull that really earned the wreck must be able to sell what
    // it recovered. The allowed roles are opt-in (default: pirate only), so a
    // war `patrol` hull is never given market authority by accident.
    const recoveredPirate=require("./coopNpcLootSellRoles").maySellLoot({
     role,env:process.env,hasCommerce:lootCommerce!==null});
    const rearmingPirate=role==="pirate"&&rearmEnabled&&
     nativeRearm!==null&&rearmTypes.length>0;
    if(!["trader","hauler"].includes(role)&&!recoveredPirate&&
       !rearmingPirate||blocked.has(Number(link.entityID)))continue;
    const ship=scene.getEntityByID(Number(link.entityID));
    const ctrl=controllers.getControllerByEntityID(Number(link.entityID));
    if(!ship||ship.nativeNpc!==true||Number(ctrl?.currentTargetID)>0||
     ctrl?.manualOrder?.type==="attack"||
     String(ship.mode||"").toUpperCase().includes("WARP"))continue;
    const station=stations.find(x=>{
     const dx=ship.position?.x-x.position?.x,dy=ship.position?.y-x.position?.y,
      dz=ship.position?.z-x.position?.z;
     return [dx,dy,dz].every(Number.isFinite)&&Math.hypot(dx,dy,dz)<=10000+
      Math.max(0,Number(x.radius)||0)+Math.max(0,Number(ship.radius)||0);
    });
    if(!station)continue;
    const nativeCargo=recoveredPirate?
     lootCommerce.stock({pilotID:link.pilotID,entityID:Number(link.entityID)}):
     store.listNativeCargoForEntity(Number(link.entityID))||[];
    const eligible= nativeCargo.filter(c=>Number(c.moduleID||0)===0&&
     c.singleton!==true&&Number(c.quantity)>0&&sellTypes.includes(Number(c.typeID)));
    const tradeCandidates=recoveredPirate?
     eligible.filter(c=>lootCommerce.readyFor({
      pilotID:link.pilotID,entityID:Number(link.entityID),systemID,
      stationID:Number(station.itemID),cargoID:Number(c.cargoID)
     })).map(c=>({side:"sell",typeID:Number(c.typeID),
      cargoID:Number(c.cargoID),
      verifyCargo:row=>lootCommerce.verifiedCargo({
       pilotID:link.pilotID,entityID:Number(link.entityID),cargo:row})})):
     ["trader","hauler"].includes(role)?
      [...new Set(eligible.map(c=>Number(c.typeID)))]
       .map(typeID=>({side:"sell",typeID}))
       .concat(buyTypes.map(typeID=>({side:"buy",typeID}))):[];
    // Only a genuinely earned positive native NPC ledger balance may fund
    // new seeded-market charge purchases. No virtual bounties or free ISK.
    let loadPlan=null;
    if(rearmingPirate&&nativeMarketTrader.snapshot().pilots[link.pilotID]?.balance>0){
     loadPlan=nativeRearm.candidates({pilotID:link.pilotID,
      entityID:Number(link.entityID),systemID,
      stationID:Number(station.itemID),allowedTypes:rearmTypes});
     if(loadPlan.status==="REARM_READY"){
      const loaded=nativeRearm.load({pilotID:link.pilotID,
       entityID:Number(link.entityID),systemID,
       stationID:Number(station.itemID),cargoID:loadPlan.cargoID,
       moduleID:loadPlan.moduleID});
      if(loaded.status==="NATIVE_NPC_CHARGE_LOADED"||
       loaded.status==="ALREADY_LOADED"){
       completed++;
       require("./coopRuntimeProbe").observe("living-npc-earned-rearm",null,
        {spaceState:{systemID}},loaded);
      }else require("./coopRuntimeProbe").observe("living-npc-rearm-blocked",null,
       {spaceState:{systemID}},{status:loaded.status,
        pilotID:link.pilotID,entityID:Number(link.entityID)});
      continue;
     }
     if(loadPlan.status==="REARM_NEEDS_PURCHASE")
      tradeCandidates.push({side:"buy",typeID:loadPlan.typeID});
    }
    for(const trade of tradeCandidates){
     const result=await nativeMarketTrader.execute({
      scene,pilotID:link.pilotID,entityID:Number(link.entityID),
      stationID:Number(station.itemID),
      ...trade,buyTypes,sellTypes
     });
     if(result.status==="TRADE_SETTLED"){

      // FW-122: the faction that HOLDS this system takes its share of the tax this sale
      // already charged. The amount is the real sale and never an invented one; a system
      // with no controller pays nobody, and that refusal is published instead of swallowed.
      try{
       const saleIsk=Number(result.isk)||Number(result.gross)||0;
       const taxCents=Math.max(0,Math.round(saleIsk*100*0.02));
       if(taxCents>0){
        if(!warTaxIncome)warTaxIncome=require("./coopFactionTaxIncome").createFactionTaxIncome({
         readWarState:()=>warStateStore().read(),
         getStation:id=>require("./worldData").getStationByID(Number(id)),
         corporationFor:factionID=>warFactionCorporation(factionID,warPresencePilots(),
          warEarnedLedger()),
         treasury:{execute:command=>warTreasuryStore().execute(command)}
        });
        const taxProof="sale:"+Number(station.itemID)+":"+Number(trade.typeID)+":"+
         Math.round(Number(trade.quantity)||0)+":"+String(result.referenceID||"");
        const taxed=warTaxIncome.collect({stationID:Number(station.itemID),
         amountCents:taxCents,proofID:taxProof,eventID:"tax:"+taxProof});
        require("./coopRuntimeProbe").observe(
         taxed.status==="APPLIED"||taxed.status==="DUPLICATE"?
          "living-faction-tax-paid":"living-faction-tax-refused",null,
         {spaceState:{systemID}},{status:taxed.status,reason:String(taxed.reason||""),
          systemID:Number(taxed.systemID)||Number(systemID),
          factionID:Number(taxed.factionID)||0,
          corporationID:Number(taxed.corporationID)||0,
          amountCents:Number(taxed.amountCents)||0});
       }
      }catch(_error){/* a tax failure must never stop a real sale */}
      completed++;
      // A sale resets this stack's asking price for the next haul.
      if(trade.side==="sell"){
       const pricing=sellPricing();
       if(pricing)pricing.noteSold(Number(station.itemID)+":"+Number(trade.typeID));
      }
      require("./coopRuntimeProbe").observe(
       rearmingPirate&&trade.side==="buy"?
        "living-native-npc-ammo-purchased":
        recoveredPirate?"living-native-loot-market-settled":"living-native-market-trade",
       null,{spaceState:{systemID}},{
        ...result,marketCurrency:"NPC_LEDGER_ONLY_NOT_EVEJS_PLAYER_WALLET",
        sourceOfFunds:trade.side==="buy"?
         "PREVIOUS_NPC_MARKET_LEDGER_EARNINGS":"SEED_MARKET_FILLED_ORDER"
       });
      // The actual native market purchase is already settled. Bind that
      // very cargo ID to an already fitted compatible module; if loading
      // fails, the bought stack remains real cargo for later reconciliation.
      if(rearmingPirate&&trade.side==="buy"&&loadPlan?.moduleID){
       const loaded=nativeRearm.load({pilotID:link.pilotID,
        entityID:Number(link.entityID),systemID,
        stationID:Number(station.itemID),cargoID:result.cargoID,
        moduleID:loadPlan.moduleID});
       require("./coopRuntimeProbe").observe(
        ["NATIVE_NPC_CHARGE_LOADED","ALREADY_LOADED"].includes(loaded.status)?
         "living-npc-earned-rearm":"living-npc-rearm-blocked",null,
        {spaceState:{systemID}},{...loaded,
         purchaseSettled:true,cargoID:result.cargoID});
      }
      break;
     }
     if(result.status==="PRICE_BELOW_FLOOR"){
      require("./coopRuntimeProbe").observe("living-npc-sell-policy",null,
       {spaceState:{systemID}},{...result,decision:"HOLD_UNTIL_FLOOR_STEPS_DOWN",
        marketCurrency:"NPC_LEDGER_ONLY_NOT_EVEJS_PLAYER_WALLET"});
      continue;
     }
     if(result.status==="UNRESOLVED_MARKET_JOURNAL"){
      // The world refuses the trade (correct: the journal is not settled) but it also
      // tries to settle it from the market own row instead of staying blocked until a
      // restart: measured 2026-10-28 one crashed partial fill stopped every sale.
      reconcileMarketJournalsAtBoot(true);
      continue;
     }
     if(["RPC_OUTCOME_UNKNOWN","RPC_ACK_NOT_VERIFIABLE","NEEDS_MARKET_REPAIR"].includes(result.status)){
      nativeMarketBlocked=true;
      require("./coopRuntimeProbe").observe("living-native-market-repair-required",null,
       {spaceState:{systemID}},{pilotID:link.pilotID,status:result.status});
      return;
     }
    }
   }
  }
 }finally{nativeMarketTickRunning=false;}
}
function advanceNativeCivilianOrders(){
 if(!bridge||!civilianOrders||process.env.EVEJS_COOP_MATERIALIZE_NPCS!=="1")return [];
 const current=new Map(world.snapshot().pilots.map(p=>[p.id,p.systemID]));
 const assignments=bridge.snapshot().filter(p=>current.get(p.pilotID)===p.systemID);
 const blockedIDs=raidDirector?.activePirateIDs?.(systemID=>{
  const runtime=require("./runtime");
  return runtime.ensureScene(systemID,{refreshStargates:false});
 })||new Set();
 if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
 if(gateTravelDirector)for(const id of gateTravelDirector.activeIDs())blockedIDs.add(id);
 if(wreckRecoveryDirector&&process.env.EVEJS_COOP_NPC_WRECK_RECOVERY==="1")
  for(const sys of new Set(assignments.map(x=>Number(x.systemID))))
   for(const id of wreckRecoveryDirector.activeIDs(sys))blockedIDs.add(id);
 if(lootCommerce)for(const sys of new Set(assignments.map(x=>Number(x.systemID))))
  for(const id of lootCommerce.activeIDs(sys))blockedIDs.add(id);
 if(nativeAmmoSupply)for(const sys of new Set(assignments.map(x=>Number(x.systemID))))
  for(const id of nativeAmmoSupply.activeIDs(sys))blockedIDs.add(id);
 // A physically observing squad scout must stay on-grid for the 15s relay:
 // don't let generic civilian waypoints warp that SAME native ship away.
 if(process.env.EVEJS_COOP_NPC_SQUAD_RAIDS==="1"&&squadDirector)
  for(const sys of new Set(assignments.map(x=>Number(x.systemID))))
   for(const scoutID of squadDirector.activeScoutIDs(sys))blockedIDs.add(scoutID);
 for(const sys of new Set(assignments.map(x=>Number(x.systemID))))
  addNpcOrderBlocks(blockedIDs,sys,"CIVILIAN");
 const roles=economy?.snapshot().pilots||{};
 const goals=npcPersonalGoals(),routeOverrides={};
 if(goals){
  const snapshots=goals.snapshot().pilots;
  const runtime=require("./runtime");
  for(const pilot of assignments){
   if(roles[pilot.pilotID]?.role!=="pirate")continue;
   const scene=runtime.ensureScene(pilot.systemID,{refreshStargates:false});
   const ship=scene?.getEntityByID?.(Number(pilot.entityID));
   if(ship?.nativeNpc!==true||ship.kind!=="ship"||ship.session?.characterID)continue;
   if(!snapshots[pilot.pilotID]||snapshots[pilot.pilotID].systemID!==Number(pilot.systemID))
    goals.decide({pilotID:pilot.pilotID,systemID:pilot.systemID,...npcRealPoints(scene)});
   const role=goals.routeRole({pilotID:pilot.pilotID,systemID:pilot.systemID});
   if(role)routeOverrides[pilot.pilotID]=role;
  }
 }
 // FW-013D: one owner per record. A pirate hull's movement belongs to the raid
 // director (owner RAID). When the civilian route director orbited it, the
 // CIVILIAN lease stayed live and every raid order was refused with
 // COOP_NPC_ORDER_NATIVE_COMMAND_ACTIVE - real prey, zero raids.
 const civilianAssignments=assignments.filter(a=>roles[a.pilotID]?.role!=="pirate");
 const orders=civilianOrders.tick(civilianAssignments,roles,{blockedIDs,routeOverrides});
 if(goals)for(const order of orders){
  if(!routeOverrides[order.pilotID])continue;
  try{goals.observeNativeOrder({pilotID:order.pilotID,
    systemID:assignments.find(a=>a.pilotID===order.pilotID)?.systemID,
    entityID:order.entityID,targetID:order.targetID,action:order.action});
  }catch(error){console.warn("[CoopNpcGoals] native route evidence",error.message);}
 }
 if(orders.length)console.info("[CoopVirtualWorld] native civilian work routes",JSON.stringify(orders));
 return orders;
}
// Physically stranded NPCs cannot invent ammo. Warping away from battle
// uses a real unscrumbled native hull, with safe real station destination.
function advanceNativeAmmoSupply({mode="LEGACY",systemIDFilter=null,decision=null}={}){
 if(process.env.EVEJS_COOP_NPC_AMMO_SUPPLY!=="1"||
  process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  !alifeOrderArbitrationEnabled(process.env)||
  !bridge||!identityRegistry||!world||!visitedSystems.size)return;
 const runtime=require("./runtime"),npc=require("./npc/npcRuntime"),
  store=require("./npc/nativeNpcStore"),controllers=require("./npc/npcRegistry"),
  equipment=require("./npc/npcEquipment"),dogma=require("./combat/weaponDogma"),
  types=require("./npc/npcCapabilityResolver"),
  worldData=require("./worldData"),
  scramble=require("./modules/hostileModuleRuntime");
 if(!nativeAmmoSupply)nativeAmmoSupply=
  require("./coopNpcAmmoSupply").createAmmoSupply({
   store,getWeaponModules:equipment.getNpcWeaponModules,
   resolveFamily:weapon=>dogma.resolveWeaponFamily(weapon),
   isOptional:weapon=>dogma.isChargeOptionalTurretWeapon(weapon),
   compatible:types.isNpcChargeCompatibleWithModule,
   getController:id=>controllers.getControllerByEntityID(id),
   getStation:id=>worldData.getStationByID(id),
   warp:(id,targetID,options)=>npcNativeOrder("TACTICS",id,"ammo-retreat-warp",
    ()=>npc.warpToEntity(id,targetID,options)),
   orbit:(id,targetID,range)=>npcNativeOrder("CIVILIAN",id,"ammo-resupply-orbit",
    ()=>npc.orbit(id,targetID,range)),
   isScrambled:ship=>scramble.isEntityWarpScrambled(ship)
  });
 const roles=new Map(world.snapshot().pilots.map(p=>[p.id,p.role]));
 const assignments=bridge.snapshot().filter(x=>roles.get(x.pilotID)==="pirate");
 for(const systemID of visitedSystems){
  if(systemIDFilter!==null&&Number(systemIDFilter)!==Number(systemID))continue;
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  const blockedIDs=new Set();
  if(lootCommerce)for(const id of lootCommerce.activeIDs(systemID))blockedIDs.add(id);
  if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
  let chosen=assignments,selected=null;
  if(mode==="SURVIVAL"||mode==="PLANNED"){
   selected=require("./coopAlifeNativeResupplyBridge").selectAmmoResupply({
    mode,systemID,assignments,decision,scene,
    getController:id=>controllers.getControllerByEntityID(id),
    inspectAmmo:args=>nativeAmmoSupply.inspect(args)});
   if(selected.status!=="SELECTED"||selected.selected.length===0)continue;
   chosen=selected.selected;
  }
  const result=nativeAmmoSupply.tick({scene,assignments:chosen,blockedIDs,
   observeOnly:mode==="MONITOR_ONLY"});
  if(result.orders.length||result.events.length)
   require("./coopRuntimeProbe").observe("living-native-ammo-supply",null,
    {spaceState:{systemID}},{orders:result.orders,events:result.events,
     nativeCargoSupplyOnly:true,cargoCredited:false,alifeMode:mode});
  if(mode==="PLANNED"&&result.orders.length)
   for(const order of result.orders){
    const intent=selected.intents.get(order.pilotID);
    if(!intent||Number(intent.entityID)!==Number(order.entityID))continue;
    require("./coopRuntimeProbe").observe("alife-native-act-order",null,
     {spaceState:{systemID}},{pilotID:order.pilotID,entityID:order.entityID,
      stage:"RESUPPLY",intentID:intent.intentID,stationID:order.stationID,
      nativeAction:order.action,proof:"NATIVE_ORDER_ACCEPTED",
      nativeMutation:true,cargoCredited:false,iskCredited:false});
   }
 }

}
// FW-017: one shared real warp-point authority for the whole process. It only
// decides which verified point a hull may carry, fits it through the native
// store and activates it through the same generic module call the stock hostile
// loop makes. No gate, distance constant or damage number is touched here.
function advanceNativeRaids(){
 if(process.env.EVEJS_COOP_NPC_RAIDS!=="1"||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),npc=require("./npc/npcRuntime");
 const mining=require("../services/mining/miningNpcOperations");
 const nativeStore=require("./npc/nativeNpcStore");
 const controllers=require("./npc/npcRegistry");
 if(!raidDirector){
  raidDirector=require("./coopNativeRaids").createRaids({
   warp:(pirateID,targetID,options)=>npcNativeOrder("RAID",pirateID,"warp-to-prey",()=>{
    const {distanceMeters,...native}=options||{};
    raidLeashScope(pirateID,distanceMeters);
    return npc.warpToEntity(pirateID,targetID,native);
   }),
   attack:(pirateID,targetID,options)=>npcNativeOrder("RAID",pirateID,"attack",()=>{
    // FW-018: the attack is flown at the hull's own gun range. `orbitDistanceMeters`
    // is the native behaviour override the stock mining code itself uses to park a
    // hull at its engagement distance, so the stock loop orbits at exactly this
    // range with weapons on. A standalone manual `orbit` order would replace the
    // attack intent and the native NPC hostility invariant would then treat the
    // prey as friendly (measured live: target cleared, mode STOP, no fire).
    const engagementRange=Number(options?.engagementRangeMeters)||0;
    // The approach the raid just ordered decides how far the hull may fly from
    // its own home; the leash is restored on release (see raidLeashScope).
    raidLeashScope(pirateID,Number(options?.distanceMeters)||0);
    if(engagementRange>0){
     try{
      // setBehaviorOverrides REPLACES the whole override object, so the hull's
      // existing overrides are carried over: only the engagement distance is ours.
      let existing={};
      try{
       const controller=require("./npc/npcRegistry").getControllerByEntityID(pirateID);
       if(controller&&controller.behaviorOverrides&&typeof controller.behaviorOverrides==="object")
        existing=controller.behaviorOverrides;
      }catch(_error){existing={};}
      require("./npc/npcService").setBehaviorOverrides(pirateID,
       {...existing,orbitDistanceMeters:engagementRange});
     }catch(error){
      require("./coopRuntimeProbe").observe("living-native-raid-engagement-range",
       null,null,{status:"REFUSED",pirateID,
        reason:String(error&&error.message||error).slice(0,80)});
     }
    }
    return npc.issueAttackOrder(pirateID,targetID,options);
   }),
   // The range comes from the fitted module/charge dogma the stock resolver
   // reads, never from a constant of ours.
   gunRange:entity=>{
    if(!nativeGunRange)nativeGunRange=require("./coopNpcGunRange");
    return nativeGunRange.shared().rangeOf(entity);
   },
   // One owner per record: only the raid director releases the order it issued.
   release:(pirateID,reason)=>npcNativeOrder("RAID",pirateID,"release-order",
    ()=>{raidLeashRestore(pirateID);return npc.resumeBehavior(pirateID);}),
   // FW-017: a real warp point is fitted and engaged on the prey, and a really
   // scrambled prey keeps its attack order instead of losing the lock. Both are
   // OFF unless the flag is on, and neither ever guesses a module or a target.
   ensurePoint:process.env.EVEJS_COOP_NPC_WARP_POINT==="1"?
    ({pirateID,targetID})=>{
     const director=nativeWarpPoint();
     const pirate=nativeStore.getNativeEntity(pirateID);
     return director.note(director.engage({
      scene:runtime.ensureScene(Number(pirate?.systemID)||0,{refreshStargates:false}),
      pirateID,targetID,entityRecord:pirate}));
    }:null,
   preyScrambled:process.env.EVEJS_COOP_NPC_WARP_POINT==="1"?
    targetID=>{
     const prey=nativeStore.getNativeEntity(targetID);
     if(!prey)return false;
     const preyScene=runtime.ensureScene(Number(prey.systemID)||0,{refreshStargates:false});
     const preyShip=preyScene?.getEntityByID?.(Number(targetID));
     return preyShip?nativeWarpPoint().isScrambled(preyShip):false;
    }:null
  });
 }
 if(process.env.EVEJS_COOP_NPC_CAPSULEER_AGENCY==="1"&&!huntPolicy) {
  // Opt-in NPC-vs-NPC assessment only. Native stock raid eligibility remains
  // authoritative; players can only count as potential defenders, not prey.
  huntPolicy=require("./coopNpcHuntPolicy").createHuntPolicy({
   file:process.env.EVEJS_COOP_NPC_INTEL_FILE||"/var/lib/evejs/coop-npc-intel.json",
   onDecision:decision=>require("./coopRuntimeProbe").observe("living-npc-opportunity",null,null,decision)
  });
 }
 // Validate persisted goal state before allowing any new native raid command.
 const goals=npcPersonalGoals();
 for(const systemID of visitedSystems){
  // Once a pilot has genuinely recovered cargo and begun physical delivery,
  // it must not abandon its sale route to accept an opportunistic new raid.
  const delivering=lootCommerce?.activeIDs(systemID)||new Set();
  const outOfAmmo=nativeAmmoSupply?.activeIDs(systemID)||new Set();
  // FW-020: a hull that holds a live claim on a wreck it really made belongs to
  // the loot phases, not to the raid (one owner per record). Without this the
  // raid re-tasks the killer forever and the wreck recovery can never start.
  // A claim whose physical wreck no longer exists (a restart drops the scene
  // entity, the durable row stays) can never be recovered, so it must not keep
  // the hull out of the raid for the rest of the claim's hour.
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  let wreckClaimOwners=new Set();
  try{
   const claims=require("./coopNpcWreckClaims").getWreckClaims().active(systemID)||[];
   wreckClaimOwners=new Set(claims
    .filter(c=>Boolean(scene.getEntityByID(Number(c.wreckID)||0)))
    .map(c=>Number(c.attackerEntityID))
    .filter(id=>Number.isSafeInteger(id)&&id>0));
  }catch(_error){wreckClaimOwners=new Set();}
  // FW-025: excluding the hull from new raids is not enough while the raid still
  // holds its own lease and the native attack order that came with it. The loot
  // phases cannot issue anything to a hull that is still fighting, so the raid
  // releases exactly its own order for every hull a live claim now owns.
  if(wreckClaimOwners.size&&typeof raidDirector.releaseExcluded==="function"){
   try{
    // Only a hull that really still holds a native combat order is released
    // again; an idle claim owner is left alone.
    const stillFighting=[...wreckClaimOwners].filter(entityID=>{
     try{
      const ctrl=controllers.getControllerByEntityID(entityID);
      return String(ctrl?.manualOrder?.type||"").toLowerCase()==="attack"||
       Number(ctrl?.currentTargetID)>0;
     }catch(_error){return false;}
    });
    const released=raidDirector.releaseExcluded(stillFighting,
     "WRECK_CLAIM_OWNS_HULL");
    for(const row of released)
     require("./coopRuntimeProbe").observe("living-native-raid-release",null,
      {spaceState:{systemID}},{...row,status:row.released?
       "RAID_ORDER_RELEASED_FOR_LOOT":"RAID_ORDER_RELEASE_REFUSED",
       iskGranted:false});
   }catch(_error){/* the recovery phase still publishes its own refusal */}
  }
  // FW-013B: a hull that was really linked AFTER boot was invisible here. The
  // materializer's assignment map is rebuilt only during boot, while the raid
  // legality gate below already reads the identity registry - the same
  // authority. A named pirate that is physically present in this scene is a
  // raid candidate; a stored link with no native ship still is not.
  const systemLinks=Object.values(identityRegistry?.snapshot().links||{})
   .filter(link=>Number(link.systemID)===Number(systemID)&&
    scene.getEntityByID(Number(link.entityID)));
  const pirates=systemLinks.filter(link=>link.role==="pirate"&&
   !delivering.has(Number(link.entityID))&&
   !outOfAmmo.has(Number(link.entityID))&&
   // FW-020: a pirate that just made a real kill stops hunting and loots its
   // own wreck. Otherwise the raid lease and the wreck recovery fight over the
   // same hull forever (one owner per record) and the loot is never recovered.
   !wreckClaimOwners.has(Number(link.entityID))).map(link=>Number(link.entityID));
  if(!pirates.length)continue;
  const fleets=mining.getMiningFleetsForSystem(systemID);
  const raidPolicy=require("./coopNativeRaidEligibility");
  // Authoritative live EveJS mining fleet membership is the only source
  // of valid targets. Unnamed stock miners are not invisible to pirates.
  const fleetShips=raidPolicy.liveFleetShips(fleets,scene);
  const activeLinks=systemLinks;
  const actualPilots=world.snapshot().pilots;
  const factionByPilot=new Map(actualPilots.map(p=>[p.id,p.faction]));
  const squadContacts=activeLinks.map(p=>({...p,
   faction:factionByPilot.get(p.pilotID)}));
  // Squad coordination is optional, NPC-on-NPC only, and never a second
  // attack loop. Existing native stock mining raid legality still runs first.
  const squadEnabled=process.env.EVEJS_COOP_NPC_SQUAD_RAIDS==="1"&&
   process.env.EVEJS_COOP_NPC_CAPSULEER_AGENCY==="1"&&
   alifeOrderArbitrationEnabled(process.env);
  if(squadEnabled&&!squadDirector)
   squadDirector=require("./coopNpcSquadDirector").createSquadDirector();
  const squads=squadEnabled?squadDirector:null;
  // Native ore custody is only a server-side eligibility prefilter,
  // NEVER cargo-scan knowledge supplied to the NPC or shared report.
  const raidCandidates=squads?fleetShips.filter(candidate=>
   (nativeStore.listNativeCargoForEntity(candidate.id)||[]).some(c=>
    Number(c?.moduleID||0)===0&&Number(c?.quantity)>0)):fleetShips;
  const squadState=squads?.observe({systemID,scene,
   pirates:squadContacts.filter(p=>p.role==="pirate"),
   pilots:actualPilots,fleetShips:raidCandidates,
   canAttack:({pirateID,targetID})=>raidPolicy.isAuthorizedStockMiningRaid({
    systemID,attacker:scene.getEntityByID(pirateID),
    target:scene.getEntityByID(targetID),links:activeLinks,
    pilots:actualPilots,fleetShips:raidCandidates
   })});
  if(squadState?.teams?.length&&backgroundTicks%10===0)
   require("./coopRuntimeProbe").observe("living-npc-scout-relay",null,
    {spaceState:{systemID}},{teams:squadState.teams});
  const assessments=new Map();
  const canAttack=({pirateID,targetID})=>{
   // The existing source-verified NPC combat gate ALWAYS runs first.
   if(!raidPolicy.isAuthorizedStockMiningRaid({
    systemID,attacker:scene.getEntityByID(pirateID),
    target:scene.getEntityByID(targetID),links:activeLinks,
    pilots:actualPilots,fleetShips
   }))return false;
   if(process.env.EVEJS_COOP_NPC_CAPSULEER_AGENCY!=="1")return true;
   if(!huntPolicy)return false;
   const pirateLink=activeLinks.find(x=>Number(x.entityID)===Number(pirateID));
   const targetRole=fleetShips.find(x=>Number(x.id)===Number(targetID))?.role;
   if(!pirateLink||!targetRole)return false;
   const report=squads?.permit({systemID,scene,pirateID,targetID});
   if(report&&!report.allowed)return false;
   const damage=require("./combat/damage");
   const scramble=require("./modules/hostileModuleRuntime");
   const decision=huntPolicy.assess({systemID,scene,pirateID,targetID,
    targetRole,piratePilotID:pirateLink.pilotID,contacts:squadContacts,
    sharedIntel:report?.report||null,
    getHealth:entity=>{
     const maximum=damage.getEntityMaxHealthLayers(entity);
     const actual=damage.getEntityCurrentHealthLayers(entity,maximum);
     if(!maximum||!actual||![maximum.shield,maximum.armor,maximum.structure].some(x=>Number(x)>0))return NaN;
     const armor=Number(maximum.armor)>0?Number(actual.armor)/Number(maximum.armor):1;
     const structure=Number(maximum.structure)>0?
       Number(actual.structure)/Number(maximum.structure):1;
     return Math.min(armor,structure);
    },
    isScrambled:entity=>scramble.isEntityWarpScrambled(entity)
   });
   const seen=assessments.get(Number(pirateID))||[];
   seen.push(decision.decision);
   assessments.set(Number(pirateID),seen);
   return decision.decision==="RAID";
  };
  const result=raidDirector.tick({
   systemID,scene,pirates,fleetShips,canAttack,
   getCargo:id=>nativeStore.listNativeCargoForEntity(id),
   getController:id=>controllers.getControllerByEntityID(id)
  });
  // FW-017: the real point is re-engaged at the native hostile-maintenance
  // cadence, not only when the 60 s attack lease is re-issued. The stock retreat
  // fires within seconds of the first aggression, so a one-shot attempt at order
  // time is not enough. Only a real raid target of this fleet is ever pointed at,
  // and the outcome is published by note() once per change (refusal included).
  if(process.env.EVEJS_COOP_NPC_WARP_POINT==="1"){
   const point=nativeWarpPoint();
   for(const rawID of pirates){
    const pirateID=Number(rawID);
    const ctrl=controllers.getControllerByEntityID(pirateID);
    const targetID=Number(ctrl?.currentTargetID)||0;
    if(!(targetID>0))continue;
    if(!fleetShips.some(t=>Number(t.id)===targetID))continue;
    if(!scene.getEntityByID(pirateID)||!scene.getEntityByID(targetID))continue;
    point.note(point.engage({scene,pirateID,targetID,
     entityRecord:nativeStore.getNativeEntity(pirateID)}));
   }
  }
  // A pirate that really exists and still gets no order must be measurable: the
  // first blocker is published once per changed shape, never every tick.
  if(!result.actions.length){
   const oreBearing=fleetShips.filter(t=>
    (nativeStore.listNativeCargoForEntity(t.id)||[]).some(c=>
     Number(c?.moduleID||0)===0&&Number(c?.quantity)>0)).length;
   const signature=[pirates.length,fleetShips.length,oreBearing,
    Number(result.eligibleTargetCount)||0].join(":");
   if(raidDiagnose.get(Number(systemID))!==signature){
    raidDiagnose.set(Number(systemID),signature);
    // Why a real pirate with real prey still got no order: the exact per-hull
    // state the director reads, plus how many targets the legality gate allowed.
    const pirateDetail=pirates.slice(0,4).map(rawID=>{
     const id=Number(rawID),ship=scene.getEntityByID(id),ctrl=controllers.getControllerByEntityID(id);
     const link=activeLinks.find(x=>Number(x.entityID)===id);
     let warClaim="",orderBlocked=null,orderDiagnosis=null;
     try{warClaim=String(nativeWarFleetRegistry()?.claim(link)||"")}catch(_error){warClaim="THREW"}
     try{
      const guard=npcOrderBridge();
      orderBlocked=guard?guard.blocked({entityID:id,systemID:Number(systemID),owner:"RAID"}):"NO_GUARD";
      orderDiagnosis=guard&&typeof guard.diagnose==="function"?
       guard.diagnose({entityID:id,systemID:Number(systemID),owner:"RAID"})
       :{status:"NO_DIAGNOSE"};
     }catch(error){orderBlocked="THREW:"+String(error&&error.message||error).slice(0,60)}
     return {entityID:id,mode:String(ship?.mode||""),
      currentTargetID:Number(ctrl?.currentTargetID)||0,
      manualType:String(ctrl?.manualOrder?.type||""),
      warClaim,orderBlocked,orderDiagnosis,
      authorized:fleetShips.filter(t=>{
       try{return raidPolicy.isAuthorizedStockMiningRaid({systemID,
        attacker:scene.getEntityByID(id),target:scene.getEntityByID(t.id),
        links:activeLinks,pilots:actualPilots,fleetShips})}catch(_error){return false}
      }).length};
    });
    require("./coopRuntimeProbe").observe("living-native-raid-diagnose",null,
     {spaceState:{systemID}},{status:"NO_RAID_ORDER",pirates:pirates.length,
      fleetShips:fleetShips.length,oreBearingTargets:oreBearing,
      eligibleTargets:Number(result.eligibleTargetCount)||0,
      pirateDetail,evidence:"NAMED_PIRATE_LINK_PLUS_LIVE_NATIVE_FLEET"});
   }
  }
  if(goals){
   const points=npcRealPoints(scene),active=new Set(result.actions.map(a=>Number(a.pirateID)));
   const leased=raidDirector.activePirateIDs(sys=>
    runtime.ensureScene(sys,{refreshStargates:false}));
   for(const rawID of pirates){
    const id=Number(rawID),link=activeLinks.find(a=>Number(a.entityID)===id);
    const ship=scene.getEntityByID(id);
    if(!link||!ship||ship.nativeNpc!==true||ship.session?.characterID)continue;
    const decisions=assessments.get(id)||[];
    const assessment=decisions.includes("RETREAT")?"RETREAT":
      (active.has(id)||leased.has(id))?"RAID":
      decisions.includes("WORK")?"WORK":
      decisions.includes("RAID")?"RAID":"SCOUT";
    const planned=goals.decide({pilotID:link.pilotID,systemID,assessment,
      verifiedRaid:active.has(id)||leased.has(id),...points});
    if(planned.status==="PLANNED")
     require("./coopRuntimeProbe").observe("living-npc-personal-goal",null,
      {spaceState:{systemID}},{pilotID:link.pilotID,intent:planned.intent,
       reason:planned.reason,verifiedRaid:active.has(id)||leased.has(id)});
   }
  }
  // A release is a runtime decision, not a raid: it is published with its own
  // explicit status so a hull that cannot execute an order never looks idle.
  const releasedActions=result.actions.filter(action=>
   action.action==="approach-unflyable"||action.action==="attack-no-lock"||
   action.action==="attack-unreachable"||action.released===true);
  for(const action of releasedActions){
   const status=action.reason==="FOR_APPROACH"?"RAID_ORDER_RELEASED_FOR_APPROACH":
    action.reason==="APPROACH_NOT_WARPING"?"RAID_APPROACH_UNFLYABLE":
    action.reason==="ATTACK_NO_NATIVE_LOCK"?"RAID_ATTACK_NO_LOCK":
    action.reason==="ATTACK_TARGET_UNREACHABLE"?"RAID_ATTACK_UNREACHABLE":
    "RAID_ORDER_RELEASE_REFUSED";
   require("./coopRuntimeProbe").observe("living-native-raid-order-released",null,
    {spaceState:{systemID}},{status,action:action.action,
     pirateID:action.pirateID,targetID:action.targetID,
     distanceMeters:action.distanceMeters,released:action.released===true,
     reason:String(action.reason||""),errorMsg:String(action.errorMsg||"")});
  }
  // Only a real native order is a raid. A release must never be reported as one.
  const orders=result.actions.filter(action=>
   action.action==="warp-to-hauler"||action.action==="attack");
  if(orders.length){
   // Only a successful native ATTACK order against another named NPC
   // is faction tension evidence. Warp approaches aren't battles.
   if(factionDirector&&identityRegistry){
    const actualLinks=Object.values(identityRegistry.snapshot().links||{})
     .filter(link=>Number(link.systemID)===Number(systemID)&&
      scene.getEntityByID(Number(link.entityID)));
    const byEntity=new Map(actualLinks.map(link=>[Number(link.entityID),link]));
    const factions=new Map(world.snapshot().pilots.map(p=>[p.id,p.faction]));
    for(const action of orders){
     if(action.action!=="attack")continue;
     const attacker=byEntity.get(Number(action.pirateID));
     const defender=byEntity.get(Number(action.targetID));
     if(!attacker||!defender)continue;
     const aggressorFaction=factions.get(attacker.pilotID);
     const defenderFaction=factions.get(defender.pilotID);
     if(!aggressorFaction||!defenderFaction||aggressorFaction===defenderFaction)continue;
     factionDirector.onEngagement({
      eventID:"native-raid:"+systemID+":"+action.pirateID+":"+action.targetID+":"+Math.floor(Date.now()/600000),
      systemID,aggressorFaction,defenderFaction,
      attackerPilotID:attacker.pilotID,defenderPilotID:defender.pilotID
     });
    }
   }
   console.info("[CoopLivingWorld] Native pirate raid",JSON.stringify({systemID,actions:orders}));
   require("./coopWorldSignals").notifyRaid(scene,orders);
   require("./coopRuntimeProbe").observe("living-pirate-raid",null,
    {spaceState:{systemID}},{actions:orders});
  }
 }
}
// PVE-002: no scheduler, spawn, wallet, or objective side effects.
// Only existing transient native-combat defenders recorded in an exact
// authored dungeon encounter are allowed to assist after verified aggression.
// PVE-003A: only existing waves' source-proven transient NPCs may warp.
// No new site, native NPC spawn, reward, or timer.
// PVE-003B: original destructible dungeon objectives + native combat
// target / warp / orbit commands, never virtual HP, damage or payouts.
// PVE-004A: never spawn boss NPCs, mint drops or advance missions here.
// Verify original authored combat hull/HP, native death and existing wreck rows.
function advanceNativeTactics(){
 if(process.env.EVEJS_COOP_NATIVE_TACTICS!=="1"||!bridge||!visitedSystems.size)return;
 const runtime=require("./runtime"),npc=require("./npc/npcRuntime");
 const controllers=require("./npc/npcRegistry");
 const damage=require("./combat/damage"),scramble=require("./modules/hostileModuleRuntime");
 if(!tacticsDirector){
  tacticsDirector=require("./coopNpcTactics").createTactics({
   warpToPoint:(id,point,options)=>npcNativeOrder("TACTICS",id,"retreat-warp",
    ()=>npc.warpToPoint(id,point,options)),
   warpToEntity:(id,targetID,options)=>{
    const systemID=Number(controllers.getControllerByEntityID(id)?.systemID);
    if(nativeAmmoSupply?.activeIDs(systemID).has(Number(id)))
     return {success:false,errorMsg:"NATIVE_AMMO_EXHAUSTED"};
    return npcNativeOrder("TACTICS",id,"rescue-warp",
     ()=>npc.warpToEntity(id,targetID,options));
   },
   attack:(id,targetID,options)=>{
    const systemID=Number(controllers.getControllerByEntityID(id)?.systemID);
    if(nativeAmmoSupply?.activeIDs(systemID).has(Number(id)))
     return {success:false,errorMsg:"NATIVE_AMMO_EXHAUSTED"};
    return npcNativeOrder("TACTICS",id,"rescue-attack",
     ()=>npc.issueAttackOrder(id,targetID,options));
   },
   resumeBehavior:id=>npcNativeOrder("TACTICS",id,"resume",
    ()=>npc.resumeBehavior(id)),
   stopOrder:id=>npcNativeOrder("TACTICS",id,"stop",
    ()=>npc.issueOrder(id,{type:"stop"})),
   authorizePlayerDefense:({systemID,scene,victim,helper,attacker,session,witnessedAggression})=>{
    if(process.env.EVEJS_COOP_PVE_NPC_RETALIATION!=="1")return false;
    const verified=require("./coopNativeConsequences").resolveVerifiedPlayerID(scene,attacker);
    const aggression=controllers.getControllerByEntityID(Number(victim?.itemID));
    return require("./coopPveRetaliationGuard").authorize({
     systemID,scene,victim,helper,attacker,session,
     verifiedCharacterID:verified,aggression,witnessedAggression,now:Date.now()
    });
   },
   // Real self-defence needs to know who actually shot this NPC. The verified
   // damage witness is that source when the native controller has no aggressor.
   aggressionFor:({systemID,victimEntityID,nowMs})=>
    require("./coopNpcAggressionLedger").getSharedLedger()
     .lastFor({systemID,victimEntityID,nowMs}),
   notify:event=>{
    require("./coopRuntimeProbe").observe("living-npc-tactical-event",null,
     {spaceState:{systemID:event.systemID}},{...event});
    if(!["npc-help-request","npc-retreat"].includes(event.kind))return;
    const scene=runtime.ensureScene(event.systemID,{refreshStargates:false});
    const ship=scene?.getEntityByID(event.entityID);
    const name=String(ship?.itemName||ship?.name||"An NPC").slice(0,70);
    const message=event.kind==="npc-help-request"
     ?"[Living Universe] "+name+" called "+event.responders+" allied NPCs for help after coming under fire."
     :"[Living Universe] "+name+" is badly damaged and trying to warp away.";
    const chat=require("../services/chat/chatHub");
    for(const session of scene?.sessions?.values?.()||[]){
     if(session?._space?.initialStateSent!==true||!session.characterID)continue;
     try{chat.sendSystemMessage(session,message);}catch(error){console.warn("[CoopNpcTactics] chat",error.message);}
    }
   }
  });
 }
 const ships=[...new Map([...bridge.snapshot(),...Object.values(identityRegistry?.snapshot().links||{})]
  .filter(x=>x.entityID&&x.pilotID).map(x=>[Number(x.entityID),x])).values()],
  pilotData=new Map(world.snapshot().pilots.map(p=>[p.id,p]));
 const roles=economy?.snapshot().pilots||{};
 for(const systemID of visitedSystems){
  const scene=runtime.ensureScene(systemID,{refreshStargates:false});
  const assignments=ships.filter(p=>Number(p.systemID)===Number(systemID))
    .map(a=>({...a,role:roles[a.pilotID]?.role||"patrol",
      faction:pilotData.get(a.pilotID)?.faction||"independent"}));
  if(!assignments.length)continue;
  const activeControllers={};
  for(const a of assignments)activeControllers[a.entityID]=controllers.getControllerByEntityID(a.entityID);
  const output=tacticsDirector.tick({
   systemID,scene,assignments,controllers:activeControllers,
   waypoints:require("./coopNpcTopology").waypoints(scene),
   isScrambled:entity=>scramble.isEntityWarpScrambled(entity),
   additionalResponders:(victim,attackerID,liveScene)=>{
    if(process.env.EVEJS_COOP_NPC_MEMORY!=="1")return 0;
    const aggressor=liveScene?.getEntityByID(attackerID);
    const characterID=require("./coopNativeConsequences").resolveAuthenticatedPlayerID(liveScene,aggressor);
    if(!characterID)return 0;
    const memory=require("./coopNpcMemory").getNativeMemory().recall({
     pilotID:victim.pilotID,characterID
    });
    return memory.status==="KNOWN"&&memory.score<=-30?1:0;
   },
   health:entity=>{
    const max=damage.getEntityMaxHealthLayers(entity),
      now=damage.getEntityCurrentHealthLayers(entity,max);
    return {
     armor:max.armor>0?now.armor/max.armor:1,
     structure:max.structure>0?now.structure/max.structure:1
    };
   }
  });
  // Persist only genuine successful native NPC attack orders, not virtual
  // background timers or imagined battle outcomes.
  if(factionDirector)for(const event of output.events){
   if(event.kind!=="reinforcement-attack")continue;
   const byEntity=new Map(assignments.map(x=>[Number(x.entityID),x]));
   const aggressor=byEntity.get(Number(event.responderID));
   const defender=byEntity.get(Number(event.targetID));
   if(!aggressor||!defender||aggressor.faction===defender.faction)continue;
   factionDirector.onEngagement({
    eventID:"native-order:"+systemID+":"+event.responderID+":"+event.targetID+":"+Math.floor(Date.now()/600000),
    aggressorFaction:aggressor.faction,defenderFaction:defender.faction,systemID,
    attackerPilotID:aggressor.pilotID,defenderPilotID:defender.pilotID
   });
  }
  if(output.events.length)console.info("[CoopLivingWorld] Native tactics",JSON.stringify({systemID,events:output.events}));
 }
}
function observeSession(session,ship){
 if(process.env.EVEJS_COOP_VIRTUAL_WORLD!=="1")return;
 try{
  start();
  const systemID=Number(ship?.spaceState?.systemID||session?._space?.systemID||session?.solarsystemid);
  if(!Number.isSafeInteger(systemID)||systemID<=0)return;
  if(session)visitedSystems.add(systemID);
  const allResidents=world.residents(systemID);
  const roles=economy?.snapshot().pilots||{};
  // Reserve scarce named hull slots for pirates and genuine patrol NPCs;
  // role sorting is shared with isolated regression tests.
  const residents=require("./coopNpcRolePriority").orderForMaterialization(
   allResidents.map(p=>({
    ...p,role:roles[p.id]?.role||
      ["miner","hauler","patrol","trader","pirate"][(Number(p.id.slice(-3))-1)%5]
   })).filter(p=>life?.canFly(p.id)!==false)
  );
  for(const p of residents)life?.recover(p.id);
  if(economy)economy.advance(world.snapshot().pilots);
   safeNpcPhase("observed-native-depot",syncNativeDeliveries);
  if(process.env.EVEJS_COOP_MATERIALIZE_NPCS==="1"){
    try{
      const runtime=require("./runtime");
      const npc=require("./npc/npcRuntime");
      const scene=runtime.ensureScene(systemID,{refreshStargates:false});
      // A passing TCP test can still run against an empty virtual space.
      // Record real topology of the authoritative EveJS scene on arrival.
      if(session||process.env.EVEJS_COOP_HEADLESS_WORLD_BOOT==="1"){
        const points=require("./coopNpcTopology").waypoints(scene);
        require("./coopRuntimeProbe").observe("living-world-topology",session,ship,{
          systemID,realWaypoints:points.length,
          realAsteroidBelts:points.filter(p=>p.kind==="asteroidBelt").length,
          realStations:points.filter(p=>p.kind==="station").length,
          realStargates:points.filter(p=>p.kind==="stargate").length,
          sceneReady:Boolean(scene),evidenceSource:session?"CLIENT_SESSION":"HEADLESS_NATIVE_SCENE"
        });
      }
      safeNpcPhase("observed-native-mining",()=>ensureNativeMining(scene,systemID));
      const nativeMining=process.env.EVEJS_COOP_NATIVE_MINING==="1";
      if(!bridge){
        const {createBridge}=require("./coopNpcMaterializer");
        const {createRegistry}=require("./coopIdentityRegistry");
        identityRegistry=createRegistry({
          file:process.env.EVEJS_COOP_IDENTITY_FILE||"/var/lib/evejs/coop-npc-links.json",
          exists:(system,id)=>{
           const ship=runtime.ensureScene(system,{refreshStargates:false})?.getEntityByID(id);
           return ship?.kind==="ship"&&ship.nativeNpc===true;
          }
        });
        // Recover an interrupted native gate movement first; then restore
        // saved real NPC hulls before the materializer may prune stale links.
        ensureNativeGateTransfer(runtime);
        ensureNativeWarGateHandoff(runtime);
        if(process.env.EVEJS_COOP_DURABLE_NPC_SHIPS==="1"){
          const recovered=require("./coopNativeRestore").restoreNamedShips({
            registry:identityRegistry,sceneForSystem:id=>
             runtime.ensureScene(id,{refreshStargates:false}),
            store:require("./npc/nativeNpcStore"),
            service:require("./npc/nativeNpcService"),
            lostShips:Object.values(life?.snapshot()?.wrecks||{}),
            // A hull whose durable record really relocated leaves a stale link
            // behind. Only an explicit operator flag may reconcile it, and only
            // after the same native ship is physical in the record's system.
            allowRelocation:process.env.EVEJS_COOP_DURABLE_RELOCATE_RESTORE==="1"
          });
          require("./coopRuntimeProbe").observe("living-native-durable-recovery",null,null,
           {status:recovered.status,recovered:recovered.recovered,
            alreadyPhysical:recovered.alreadyPhysical,
            legacyTransient:recovered.legacyTransient,
            confirmedLosses:recovered.confirmedLosses,
            relocated:Number(recovered.relocated)||0,
            errors:recovered.errors});
          if(recovered.status!=="OK")
           throw Error("DURABLE_NPC_RECOVERY_REQUIRES_REPAIR: "+JSON.stringify(recovered.errors).slice(0,210));
        }
        const materializeLimit=require("./coopMaterializeLimit" +
         (__filename.endsWith(".js")?"":".cjs"))
         .resolveMaterializeLimit(process.env.EVEJS_COOP_MATERIALIZE_LIMIT);
        bridge=createBridge({
          registry:identityRegistry,
          limit:materializeLimit.limit,
          exemptRoles:nativeMining?["miner","hauler"]:[],
          exists:(system,id)=>{
           const ship=runtime.ensureScene(system,{refreshStargates:false})?.getEntityByID(id);
           return ship?.kind==="ship"&&ship.nativeNpc===true;
          },
          spawn:(system,pilot)=>{
            const nativeScene=runtime.ensureScene(system,{refreshStargates:false});
            const anchor=require("./coopNpcTopology").anchorOptionsForRole(nativeScene,pilot.role);
            if(!anchor)return {success:false,errorMsg:"NO_NATIVE_SYSTEM_ANCHOR"};
            const pool=require("./coopNpcSpawnPools").spawnPoolForRole(pilot.role,
             {enabled:process.env.EVEJS_COOP_NPC_ROLE_POOLS==="1"});
            return npc.spawnBatchInSystem(system,{
              ...anchor,amount:1,entityType:"npc",
              transient:process.env.EVEJS_COOP_DURABLE_NPC_SHIPS!=="1",
              // EX-03B4: one in four newly materialized named patrols may
              // author genuine original scanner hardware. Non-patrols,
              // existing hulls and generic spawns remain unchanged.
              coopExpeditionScout:process.env.EVEJS_COOP_NPC_SCOUT_LOADOUT==="1"&&
               process.env.EVEJS_COOP_DURABLE_NPC_SHIPS==="1"&&
               pilot.role==="patrol"&&
               /^coop-pilot-[0-9]{3,}$/.test(pilot.id)&&
               Number(pilot.id.split("-").pop())%4===0,
              broadcast:true,
              ...pool,
              // Pirates actively hunt players and rival NPCs; civilians and
              // ordinary guards move and work without attacking a capsuleer.
              ...require("./coopNpcSpawnPools").behaviorOverridesForRole(pilot.role,
               {enabled:process.env.EVEJS_COOP_NPC_ROLE_POOLS==="1"})
            });
          }
        });
        // A bridge that never gets assigned is a silent world-wide outage of
        // every bridge-driven phase. Publish the effective cap once.
        require("./coopRuntimeProbe").observe("living-native-bridge",null,null,{
         status:"READY",configuredLimit:String(materializeLimit.configured||""),
         effectiveLimit:materializeLimit.limit,clamped:materializeLimit.clamped===true,
         reason:materializeLimit.reason,
         evidence:"BRIDGE_CREATED_WITH_BOUNDED_LIMIT"});
      }
      const present=require("./coopNpcPresentation").presentVirtualPilot;
      let industry={status:"DISABLED",fleets:[],assignments:[]};
      if(nativeMining){
        try{
          const mining=require("../services/mining/miningNpcOperations");
          const cargo=require("./npc/nativeNpcStore");
          industry=require("./coopNativeIndustry").observe({
            systemID,scene,pilots:residents,registry:identityRegistry,
            getFleets:id=>mining.getMiningFleetsForSystem(id),
            getCargo:id=>cargo.listNativeCargoForEntity(id),
            getController:id=>require("./npc/npcRegistry").getControllerByEntityID(id),
            present
          });
          require("./coopRuntimeProbe").observe("living-native-industry",session,ship,{
            status:industry.status,fleets:industry.fleets,
            linkedPilots:industry.assignments
          });
          const unsynced=industry.assignments.filter(x=>
           x.presented==="BROADCAST_FAILED"||x.presented==="BROADCAST_UNAVAILABLE");
          if(unsynced.length)require("./coopRuntimeProbe").observe(
           "living-native-presentation-pending",session,ship,{systemID,
            unresolved:unsynced.map(x=>({pilotID:x.pilotID,entityID:x.entityID,
             reason:x.presented}))});
        }catch(error){console.warn("[CoopNativeIndustry]",error.message);}
      }
      // Never create a generic fake miner/hauler when EveJS already has
      // physical mining NPCs with actual mining lasers and ore cargo.
      const materialize=(nativeMining?residents.filter(p=>p.role!=="miner"&&p.role!=="hauler"):residents)
       .map(p=>({...p,durable:process.env.EVEJS_COOP_DURABLE_NPC_SHIPS==="1"}));
      // Trust EveJS's active mining-fleet ship IDs, never a persisted
      // "miner" label alone, when making stock NPC capacity exemptions.
      const stockMiningIDs=industry.fleets.flatMap(f=>[
       ...(f.minerIDs||[]),...(f.haulerIDs||[])
      ]);
      const result=bridge.reconcile(systemID,materialize,{
       exemptEntityIDs:stockMiningIDs
      });
      // Explicit actionable failures. Previously the World report only saw
      // "0 assignments" and hid whether the pilot had no residents,
      // no native spawn anchor, an invalid pool, or a failed native service.
      require("./coopRuntimeProbe").observe("living-native-materialization-attempt",session,
       {spaceState:{systemID}},{systemID,
        residents:allResidents.length,eligibleResidents:residents.length,
        requestedSpawns:materialize.length,
        realAnchors:require("./coopNpcTopology").waypoints(scene).length,
        nativeMiningEnabled:nativeMining,
        miningFleetShips:stockMiningIDs.length,
        linkedIndustryPilots:industry.assignments.length,
        successfulAssignments:result.filter(x=>Number(x.entityID)>0).length,
        spawnErrors:result.filter(x=>x.error).slice(0,10).map(x=>({
         pilotID:x.pilotID,error:String(x.error).slice(0,120),
         ...(x.nativeReason?{nativeReason:String(x.nativeReason).slice(0,100)}:{}),
         ...(x.occupied!==undefined?{occupied:x.occupied,limit:x.limit}:{})
        })),
        pendingTransit:result.filter(x=>x.pendingTransit).length
       });
      ensureCivilianOrders(runtime,npc);
      // Optional voice for NPCs that are already physical in this scene. The
      // module refuses to speak about a ship it cannot see, and throttles both
      // per pilot and per system so Local never becomes spam.
      if(process.env.EVEJS_COOP_NPC_CHATTER==="1"){try{
        const chatter=runtime.__coopNpcChatter||(runtime.__coopNpcChatter=require("./coopNpcChatter")
         .createChatter({send:(target,text)=>require("../services/chat/chatHub").sendSystemMessage(target,text),
          observe:event=>require("./coopRuntimeProbe").observe("living-npc-chatter",null,null,event)}));
        const spoke=chatter.speak({systemID,residents,
         scene,sessions:require("../services/chat/sessionRegistry").getSessions()});
        if(spoke.sent)require("./coopRuntimeProbe").observe("living-npc-chatter-delivered",null,null,
         {spaceState:{systemID},...spoke});
      }catch(error){console.warn("[CoopNpcChatter]",error.message);}}
      // ALIFE news: the same observed events become a short in-client digest.
      // It never invents an event and is throttled per system.
      if(process.env.EVEJS_COOP_ALIFE_NEWS==="1"){try{
        const probe=require("./coopRuntimeProbe");
        const sessions=require("../services/chat/sessionRegistry").getSessions();
        const news=runtime.__coopAlifeNews||(runtime.__coopAlifeNews=require("./coopAlifeNews").createNews());
        if(!runtime.__coopAlifeNewsSubscribed){
          probe.subscribe(record=>{
            if(process.env.EVEJS_COOP_ALIFE_NEWS!=="1")return;
            news.record(record.event,{...record,
             systemID:Number(record.systemID||record.spaceState?.systemID||0)});
          });
          runtime.__coopAlifeNewsSubscribed=true;
        }
        const digest=news.digest(systemID);
        if(digest){
          let delivered=0;
          for(const session of sessions){
            if(!session||Number(session?._space?.systemID)!==Number(systemID))continue;
            try{require("../services/chat/chatHub").sendSystemMessage(session,digest.text);delivered++;}
            catch(_error){}
          }
          if(delivered){
            news.markSent(systemID);
            probe.observe("living-alife-news-delivered",null,{spaceState:{systemID}},
             {items:digest.items,delivered,text:digest.text});
          }
        }
      }catch(error){console.warn("[CoopAlifeNews]",error.message);}}
      const pilotsByID=new Map(residents.map(p=>[p.id,p]));
      const presented=[];
      for(const link of result){
        if(!link.entityID||!pilotsByID.has(link.pilotID))continue;
        const change=present(scene,link.entityID,pilotsByID.get(link.pilotID));
        if(change.status==="UPDATED"||change.status==="BROADCAST_FAILED"||
           change.status==="BROADCAST_UNAVAILABLE")
          presented.push({pilotID:link.pilotID,...change});
      }
      if(presented.length)require("./coopRuntimeProbe").observe("virtual-world-identity-projected",session,ship,{presented});
      // A reused durable pirate keeps the controller it was born with, so the
      // new aggression policy above only reaches fresh spawns. Push the same
      // target classes onto the live controller, otherwise a pirate that was
      // already linked still ignores a capsuleer parked next to it.
      if(process.env.EVEJS_COOP_NPC_ROLE_POOLS==="1"){
        const aggression=require("./coopNpcSpawnPools")
          .behaviorOverridesForRole("pirate",{enabled:true}).behaviorOverrides;
        for(const link of result){
          if(!link.entityID||pilotsByID.get(link.pilotID)?.role!=="pirate")continue;
          try{
            const behavior=require("./npc/npcBehaviorLoop");
            const controller=require("./npc/npcRegistry").getControllerByEntityID(link.entityID);
            if(!controller)continue;
            const current=controller.behaviorOverrides||{};
            if(Array.isArray(current.autoAggroTargetClasses)&&
               current.autoAggroTargetClasses.includes("player")&&current.autoAggro===true)continue;
            const applied=behavior.setBehaviorOverrides(link.entityID,{...current,...aggression});
            if(applied?.success)
              require("./coopRuntimeProbe").observe("living-pirate-aggression",session,ship,{
                pilotID:link.pilotID,entityID:link.entityID,
                previousClasses:Array.isArray(current.autoAggroTargetClasses)
                  ?current.autoAggroTargetClasses:null
              });
          }catch(_error){/* controller index is optional during startup */}
        }
      }
      for(const entry of result){
        if(!entry.entityID||observedNpcIDs.has(entry.entityID))continue;
        const npcID=entry.entityID;
        // Headless boot has no authenticated player ship. Do not open
        // a bogus 0-ship combat probe; native wreck hooks still record losses.
        if(!session||!Number.isSafeInteger(Number(ship?.itemID))||Number(ship.itemID)<=0)continue;
        observedNpcIDs.add(npcID);
        const probe=require("./coopRuntimeProbe");
        require("./coopCombatProbe").launch({
          scene,shipIDs:[Number(ship.itemID)],npcIDs:[npcID],
          session,ship,probe,intervalMs:1000,maxSamples:180,
          onConfirmedWreck:wreck=>confirmedWreck(session,ship,wreck.sourceNpcID,wreck.wreckID)
        });
      }
      if(session&&process.env.EVEJS_COOP_LOCAL_INTEL==="1"){
        try{
          if(!intelAnnouncer){
            const {createAnnouncer}=require("./coopSystemIntel");
            intelAnnouncer=createAnnouncer({
              send:(pilot,message)=>require("../services/chat/chatHub").sendSystemMessage(pilot,message)
            });
          }
          const pirateIDs=result.filter(x=>x.entityID&&pilotsByID.get(x.pilotID)?.role==="pirate")
            .map(x=>x.entityID);
          const intel=intelAnnouncer.announce(session,scene,{fleets:industry.fleets,pirateIDs});
          if(intel.status==="DELIVERED")
            require("./coopRuntimeProbe").observe("living-local-intel",session,ship,{
              locationCount:intel.activity.length,messages:intel.messages
            });
        }catch(error){console.warn("[CoopSystemIntel]",error.message);}
      }
      // Stage J: use an already materialized REAL A-Life trader hull, never
       // manufacture a rival, an ISK reward or a virtual wreck item.
       if(process.env.EVEJS_COOP_RESCUE_NPC_RIVALS==="1"&&
          process.env.EVEJS_COOP_ALIFE_SALVAGE_RIVALS!=="1"&&
          alifeOrderArbitrationEnabled(process.env)){
        try{
         const nativeStore=require("./npc/nativeNpcStore");
         const npcRuntime=require("./npc/npcRuntime");
         const controllers=require("./npc/npcRegistry");
         if(!runtime.__coopRescueNpcRivals){
          runtime.__coopRescueNpcRivals=
           require("./coopRescueNpcRivalry").createRescueRivalry({
            getWrecks:nativeStore.listNativeWrecks,
            getWreckItems:nativeStore.listNativeWreckItemsForWreck,
            readVerifiedLoss:()=>require("./coopConvoyOutcomeProof").createOutcomes().snapshot(),
            atomicRows:(tables,fn)=>require("../gameStore").coopAtomicNativeRows.transact(tables,fn),
            warpToEntity:(entityID,wreckID)=>npcNativeOrder("CIVILIAN",
             entityID,"rescue-rival-warp",
             ()=>npcRuntime.warpToEntity(entityID,wreckID)),
            orbit:(entityID,wreckID,meters)=>npcNativeOrder("CIVILIAN",
             entityID,"rescue-rival-orbit",
             ()=>npcRuntime.orbit(entityID,wreckID,meters)),
            readController:controllers.getControllerByEntityID});
         }
         const blockedIDs=new Set();
         if(tacticsDirector)for(const id of tacticsDirector.activeIDs())blockedIDs.add(id);
         if(gateTravelDirector)for(const id of gateTravelDirector.activeIDs())blockedIDs.add(id);
         if(lootCommerce)for(const id of lootCommerce.activeIDs(systemID))blockedIDs.add(id);
         addNpcOrderBlocks(blockedIDs,systemID,"CIVILIAN");
         const candidates=result.filter(x=>x.entityID&&
          pilotsByID.get(x.pilotID)?.role==="trader").map(x=>{
          const row=nativeStore.getNativeEntity(x.entityID);
          return {role:"trader",entityID:Number(x.entityID),systemID:Number(systemID),
           corporationID:Number(row?.corporationID)||0};
         });
         const claimed=runtime.__coopRescueNpcRivals.tick({scene,candidates,blockedIDs});
         if(!runtime.__coopRescueNpcDepot)
          runtime.__coopRescueNpcDepot=
           require("./coopRescueNpcDepot").createRescueNpcDepot({
            getCargo:nativeStore.listNativeCargoForEntity,
            getStations:require("./worldData").getStationsForSystem,
            atomicRows:(tables,fn)=>require("../gameStore").coopAtomicNativeRows.transact(tables,fn),
            warpToPoint:(entityID,target)=>npcNativeOrder("CIVILIAN",
             entityID,"rescue-rival-delivery-warp",
             ()=>npcRuntime.warpToPoint(entityID,target)),
            orbit:(entityID,stationID,meters)=>npcNativeOrder("CIVILIAN",
             entityID,"rescue-rival-delivery-orbit",
             ()=>npcRuntime.orbit(entityID,stationID,meters)),
            getMetadata:require("../services/inventory/itemStore").getItemMetadata
           });
         const delivered=runtime.__coopRescueNpcDepot.tick({
          scene,candidates,blockedIDs});
         if(delivered.events?.length)
          require("./coopRuntimeProbe").observe("living-alife-native-rescue-depot",
           session,ship,{systemID,events:delivered.events});
         if(claimed.orders?.length)
          require("./coopRuntimeProbe").observe("living-alife-native-rescue-rivals",
           session,ship,{systemID,orders:claimed.orders});
        }catch(error){console.warn("[CoopRescueRivals]",
         String(error?.message||error).slice(0,120))}
       }
      const civilianActions=advanceNativeCivilianOrders();
      require("./coopRuntimeProbe").observe("virtual-world-materialization",session,ship,{
        civilianActions,
        assignments:result,sceneReady:Boolean(scene),
        livingShips:[
          ...result.filter(x=>x.entityID).map(x=>({pilotID:x.pilotID,entityID:x.entityID,role:pilotsByID.get(x.pilotID)?.role})),
          ...industry.assignments.map(x=>({pilotID:x.pilotID,entityID:x.entityID,role:x.role}))
        ],
        realMiningFleets:industry.fleets.length
      });
    }catch(error){console.warn("[CoopMaterializer]",error.message);}
  }
  if(process.env.EVEJS_COOP_FACTION_PATROLS==="1"&&factionDirector){
    try{
      const runtime=require("./runtime"),npc=require("./npc/npcRuntime");
      if(!patrolDirector){
        const {createPatrolDirector}=require("./coopFactionPatrolRuntime");
        patrolDirector=createPatrolDirector({
          spawn:(id)=>{
            const nativeScene=runtime.ensureScene(id,{refreshStargates:false});
            const anchor=require("./coopNpcTopology").anchorOptions(nativeScene);
            if(!anchor)return {success:false,errorMsg:"NO_NATIVE_SYSTEM_ANCHOR"};
            return npc.spawnBatchInSystem(id,{
              // The pool types itself: concord_police answers concord_police_cruiser, whose
              // profile entityType is "concord". Asking the spawner for "npc" rejected every
              // entry, so the director answered POOL_EMPTY on every tick and no faction patrol
              // could deploy (the spawner defaults a missing type back to "npc", so omitting it
              // did not help). Ask for the type the pool's own profile declares - verified in
              // the container: the same pool resolves with entityType "concord".
              ...anchor,amount:1,transient:true,broadcast:true,
              ...(() => {
                // Faction patrols are law enforcement, not pirates: CONCORD-owned hulls read as
                // friendly/neutral brackets in the client.
                const pool=require("./coopNpcSpawnPools").spawnPoolForRole("patrol",
                 {enabled:process.env.EVEJS_COOP_NPC_ROLE_POOLS==="1"});
                const profile=require("./npc/npcData").getNpcProfile(pool.fallbackProfileID);
                return {...pool,entityType:String((profile&&profile.entityType)||"npc")};
              })(),
              behaviorOverrides:{autoAggro:false,autoActivateWeapons:false,targetPreference:"none"}
            });
          },
          exists:(id,entityID)=>Boolean(runtime.ensureScene(id,{refreshStargates:false})?.getEntityByID(entityID))
        });
      }
      const factions=Object.values(factionDirector.snapshot().factions);
      const deployment=patrolDirector.reconcile(systemID,factions);
      if(deployment.active?.length){
        // Real point-of-interest warps; no player ship orbit anchor.
        ensurePatrolNavigator(runtime,npc);
        const routeOrders=patrolNavigator.tick(systemID,deployment.active);
        require("./coopRuntimeProbe").observe("virtual-faction-patrol-route",session,ship,routeOrders);
      }
      require("./coopRuntimeProbe").observe("virtual-faction-patrol",session,ship,deployment);
    }catch(error){console.warn("[CoopFactionPatrol]",error.message);}
  }
  require("./coopRuntimeProbe").observe("virtual-world-presence",session,ship,{
    residentCount:residents.length,residents:residents.map(p=>({id:p.id,name:p.name,role:p.role,faction:p.faction,journeys:p.journeys})),
    virtualEconomy:economy?.snapshot().systems[String(systemID)]||null
  });
 }catch(error){console.warn("[CoopVirtualWorld] observe",error.message);}
}
function confirmedNativeNpcWreck(systemID,npcID,wreckID,destroyedShip=null){
 // FW-009C: the authoritative native wreck callback is the only witness that a
 // registered warship is really gone, so a destroyed hull can leave the battle
 // line instead of blocking its campaign slot forever.
 if(Number.isSafeInteger(Number(npcID))&&Number(npcID)>0)destroyedNativeShips.add(Number(npcID));
 // Native service calls this only AFTER original source rows are written
 // and a physical wreck is spawned; do not wait for the next A-Life tick.
 if(process.env.EVEJS_COOP_PVE_NATIVE_BOSSES==="1"&&
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE==="1"&&pveNativeBossDirector){
  try{
   const native=require("./runtime");
   const system=Number(systemID);
   const scene=native.scenes instanceof Map?native.scenes.get(system):null;
   const result=pveNativeBossDirector.confirmNativeWreck({
    systemID:system,scene,entityID:Number(npcID),wreckID:Number(wreckID)
   });
   if(result.status==="ORIGINAL_BOSS_WRECK_CONFIRMED"&&
      process.env.EVEJS_COOP_PVE_BOSS_LOOT_PROFILE_AUDIT==="1")
    try{require("./coopPveBossLootProfileAudit").note(result.witness)}
    catch(error){console.warn("[CoopPveBoss] loot table audit",String(error?.code||"UNAVAILABLE"))}
   if(result.status==="ORIGINAL_BOSS_WRECK_CONFIRMED")
    require("./coopRuntimeProbe").observe("living-pve-native-boss-death",null,
     {spaceState:{systemID:system}},{status:result.status,
      instanceID:result.witness.instanceID,wreckID:result.witness.wreckID,
      itemCount:result.witness.originalItems.length,
      evidence:"NATIVE_ORIGINAL_WRECK_AND_ITEMS_AFTER_DEATH"});
  }catch(error){console.warn("[CoopPveBoss] native death witness",String(error?.code||"UNAVAILABLE"));}
 }
 if(process.env.EVEJS_COOP_VIRTUAL_WORLD!=="1")return;
 try{
  // A real wreck is the ONLY authority to mark a named pilot as defeated.
  const fs=require("node:fs");
  const linksFile=process.env.EVEJS_COOP_IDENTITY_FILE||"/var/lib/evejs/coop-npc-links.json";
  let registry;
  try{registry=jsonFileCache.readJsonFile(linksFile,{clone:true});}
  catch(error){if(error.code==="ENOENT")registry={links:{}};else throw error;}
  const link=Object.values(registry?.links||{}).find(x=>
   Number(x.entityID)===Number(npcID)&&Number(x.systemID)===Number(systemID));
  // Stock miners have no co-op pilot link. Verify an actual upstream
  // mining-fleet membership and physical wreck without granting the
  // unnamed victim a synthetic pilot or fabricated ship loss.
  if(!link&&destroyedShip&&process.env.EVEJS_COOP_NPC_RAIDS==="1"){
   const mining=require("../services/mining/miningNpcOperations");
   const fleets=mining.getMiningFleetsForSystem(Number(systemID));
   const belonged=fleets.some(f=>Number(f?.systemID)===Number(systemID)&&
    [...(f.minerEntityIDs||[]),...(f.haulerEntityIDs||[])]
     .some(id=>Number(id)===Number(npcID)));
   if(belonged){
    const runtime=require("./runtime"),store=require("./npc/nativeNpcStore");
    // The actual ship has already been removed by upstream EveJS, but
    // the destruction callback still owns its source object. Capture
    // real last-moment HP loss before recording the verified wreck.
    if(stockCombatEvidenceDirector){
     try{
      const damage=require("./combat/damage");
      const terminal=stockCombatEvidenceDirector.terminalDamage({
       systemID,entityID:npcID,ship:destroyedShip,wreckID,
       getHealth:entity=>{
        const max=damage.getEntityMaxHealthLayers(entity);
        if(!Object.values(max).some(n=>n>0))return null;
        return damage.getEntityCurrentHealthLayers(entity,max);
       }
      });
      if(terminal.status==="NATIVE_STOCK_TERMINAL_HP_DROP")
       require("./coopRuntimeProbe").observe("living-native-stock-fleet-combat",null,
        {spaceState:{systemID}},{status:"SAMPLED",systemID,
         damageEvents:1,terminalNativeWreckID:wreckID,events:[terminal.event]});
     }catch(error){console.warn("[CoopStockCombatEvidence] terminal",error.message);}
    }
    const proof=require("./coopStockFleetWreckEvidence").verifyStockFleetWreck({
     systemID,ship:destroyedShip,wreckID,fleets,
     scene:runtime.ensureScene(Number(systemID),{refreshStargates:false}),
     getWreck:id=>store.getNativeWreck(id),
     getWreckItems:id=>store.listNativeWreckItemsForWreck(id)
    });
    require("./coopRuntimeProbe").observe("living-native-stock-fleet-wreck-evidence",
     null,{spaceState:{systemID}},proof);
    // Physical hauler destruction must be observed before any native convoy outcome.
    if(process.env.EVEJS_COOP_CONVOY_OPERATIONS==="1"&&
       proof.status==="PHYSICAL_NATIVE_STOCK_FLEET_WRECK_VERIFIED"&&
       proof.victimRole==="hauler"){
     try{require("./coopConvoyOutcomeProof").noteLoss(proof)}
     catch(error){console.warn("[CoopConvoyOutcomeProof] hauler loss",String(error?.message||error))}
    }
   }
   return;
  }
  if(!link)return;
  // This callback is invoked only after EveJS successfully spawned the
  // wreck. Verify that its physical entity and stored loot really exist.
  // Never invent a loss from a missing or failed native wreck.
  const runtime=require("./runtime");
  const store=require("./npc/nativeNpcStore");
  const proof=require("./coopNativeCombatEvidence").verifyWreck({
   systemID,npcID,wreckID,
   scene:runtime.ensureScene(Number(systemID),{refreshStargates:false}),
   links:Object.values(registry.links||{}),
   getWreck:id=>store.getNativeWreck(id),
   getWreckItems:id=>store.listNativeWreckItemsForWreck(id)
  });
  if(proof.status!=="PHYSICAL_NATIVE_WRECK_VERIFIED"){
   require("./coopRuntimeProbe").observe("living-native-wreck-evidence",null,
    {spaceState:{systemID}},proof);
   return;
  }
  // FW-009A: native casualty evidence uses the same verified physical
  // wreck callback, never combat orders, hit counters or missing NPCs.
  // This is a SQLite ledger of actual victim ships, NOT victory or kill
  // credit. Any ambiguous SQLite commit is inspected on next callback
  // with this SAME physical wreck ID, never a synthetic replacement ID.
  if(process.env.EVEJS_COOP_FACTION_WAR_NATIVE_CASUALTIES==="1"&&
     process.env.EVEJS_COOP_FACTION_WAR==="1"&&
     process.env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
     process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"){
   try{
    if(!warCasualtyLedger)
     warCasualtyLedger=require("./coopWarCasualtyLedger").createWarCasualtyLedger({
      gameStore:require("../gameStore"),
      getFactionForCorporation:id=>
       require("../services/faction/factionState").getFactionIDForCorporation(id),
      verifyNativeWreck:({systemID:sys,entityID:id,wreckID:wid,pilotID:pid})=>{
       // The authoritative callback already read the on-disk native
       // pilot link; do not require the virtual A-Life registry to be
       // initialized before this synchronous physical wreck hook.
       const links=Object.values(registry.links||{});
       return require("./coopNativeCombatEvidence").verifyWreck({
        systemID:sys,npcID:id,wreckID:wid,
        scene:runtime.ensureScene(sys,{refreshStargates:false}),
        links:links.filter(x=>x?.pilotID===pid),
        getWreck:w=>store.getNativeWreck(w),
        getWreckItems:w=>store.listNativeWreckItemsForWreck(w)
       });
      }
     });
    // FW-087: a hull is a WAR casualty only if the war actually mobilised it.
    // Measured 17:33:25Z: a dead ship in a contested system counted as a campaign
    // casualty (and could feed a capture) while it was in NO registry and had NO
    // identity anywhere - disk 0, live 0, fleet 0 - so its death could never be
    // attributed and the bounty could never be paid. The registry row is the proof of
    // participation, and it also carries the campaign the hull really belongs to.
    let fleetRow=null;
    try{
     const ships=nativeWarFleetRegistry()?.snapshot?.()?.ships||{};
     fleetRow=ships[String(Number(npcID))]||ships[Number(npcID)]||null;
    }catch(_error){fleetRow=null}
    if(!fleetRow||!fleetRow.campaignID){
     try{
      require("./coopRuntimeProbe").observe("living-native-war-casualty-skipped",null,
       {spaceState:{systemID:Number(systemID)}},
       {status:"SKIPPED",reason:"NOT_A_MOBILISED_WAR_HULL",entityID:Number(npcID),
        pilotID:String(link&&link.pilotID||""),wreckID:Number(wreckID),
        evidence:"NO_WAR_FLEET_ROW_SO_THIS_DEATH_IS_NOT_A_CAMPAIGN_CASUALTY"});
     }catch(_error){/* probe is best effort */}
     return;
    }
    const casualty=warCasualtyLedger.record({
     systemID:Number(systemID),entityID:Number(npcID),
     wreckID:Number(wreckID),pilotID:link.pilotID,
     campaignID:String(fleetRow.campaignID),warID:String(fleetRow.warID||""),
     factionID:Number(fleetRow.factionID)||0
    });
    if(casualty.status==="RECORDED"||
       casualty.status==="DUPLICATE")
     require("./coopRuntimeProbe").observe(
      "living-native-war-casualty",null,{spaceState:{systemID}},
      {status:casualty.status,receipt:casualty.receipt,
       captureAuthorized:false,killCreditAssigned:false});
    else
     // FW-109: a REFUSED casualty was silent. MEASURED on the play stack 2026-10-30:
     // five verified enemy wrecks in the front system produced no casualty row and no
     // event, so the assault could never name the exact predicate that refused them -
     // the capture phase only ever said NO_DEFENDER_WRECK. The ledger's own reason is
     // the evidence; without it the next step is guesswork.
     require("./coopRuntimeProbe").observe(
      "living-native-war-casualty-skipped",null,{spaceState:{systemID}},
      {status:String(casualty.status||"UNKNOWN"),
       reason:String(casualty.reason||(casualty&&casualty.status)||"").slice(0,80),
       entityID:Number(npcID),pilotID:String(link&&link.pilotID||""),
       wreckID:Number(wreckID),campaignID:String(fleetRow.campaignID||""),
       evidence:"WAR_CASUALTY_LEDGER_REFUSED"});
    // FW-032: a confirmed wreck must actually leave the war. Otherwise the dead
    // hull keeps its exclusive custody slot and roster entry, the side looks
    // mustered with a corpse, and the killed pilot can never man a replacement.
    if(casualty.status==="RECORDED"||casualty.status==="DUPLICATE"){
     try{
      if(!warLossReconcile)
       warLossReconcile=require("./coopWarLossReconcile")
        .createWarLossReconcile({
         registry:nativeWarFleetRegistry(),
         roster:require("./coopWarFleetRoster").sharedRoster(),
         releaseIdentity:({pilotID,entityID:releaseEntity,reason})=>
          releaseSpawnedIdentity({pilotID,entityID:releaseEntity,reason})
        });
      const reconciled=warLossReconcile.reconcile({
       entityID:Number(npcID),wreckID:Number(wreckID),pilotID:link.pilotID
      });
      require("./coopRuntimeProbe").observe(
       "living-native-war-loss-reconciled",null,{spaceState:{systemID}},
       {...reconciled,
        evidence:"NATIVE_WRECK_RELEASES_CUSTODY_AND_PILOT"});
     }catch(error){
      console.warn("[CoopNativeWarLossReconcile]",error.message);
     }
    }
   }catch(error){
    console.warn("[CoopNativeWarCasualty] strict native evidence",error.message);
   }
  }
  // The ship is already removed from the EveJS scene at this point,
  // but its authoritative source object is still held by the wreck
  // service. Capture a missed final HP delta only against a fresh
  // earlier native scene sample; never synthesize a fatal hit.
  if(combatEvidenceDirector&&destroyedShip){
   try{
    const damage=require("./combat/damage");
    const terminal=combatEvidenceDirector.terminalDamage({
     systemID,entityID:npcID,pilotID:link.pilotID,
     ship:destroyedShip,wreckID,
     getHealth:entity=>{
      const max=damage.getEntityMaxHealthLayers(entity);
      if(!Object.values(max).some(n=>n>0))return null;
      return damage.getEntityCurrentHealthLayers(entity,max);
     }
    });
    if(terminal.status==="NATIVE_TERMINAL_HP_DROP")
     require("./coopRuntimeProbe").observe("living-native-combat-damage",null,
      {spaceState:{systemID}},{status:"SAMPLED",systemID,
       damageEvents:1,correlatedNpcDamage:terminal.event.attackerPilotIDs.length?1:0,
       terminalNativeWreckID:wreckID,events:[terminal.event]});
   }catch(error){console.warn("[CoopNativeCombatEvidence] terminal HP",error.message);}
  }
  // Emit the authoritative physical wreck *after* its terminal HP
  // observation. The strict report requires damage before wreck, not
  // the reverse order imposed by the callback's bookkeeping.
  require("./coopRuntimeProbe").observe("living-native-wreck-evidence",null,
   {spaceState:{systemID}},proof);
  start();
  const killed=life.markLoss({pilotID:link.pilotID,systemID,shipID:npcID,wreckID});
  require("./coopRuntimeProbe").observe("living-npc-destroyed",null,
   {itemID:npcID,spaceState:{systemID}},{
    pilotID:link.pilotID,name:link.name,faction:link.faction,
    status:killed.status,recoveryAt:killed.readyAt,wreckID
   });
  if(killed.status!=="RECOVERING"||!economy)return;
  const {createLossBridge}=require("./coopNpcLossBridge");
  if(!lossBridge)lossBridge=createLossBridge({
   file:process.env.EVEJS_COOP_LOSS_LEDGER_FILE||"/var/lib/evejs/coop-loss-ledger.json",
   recordLoss:(system,amount)=>economy.recordLoss(system,amount)
  });
  const result=lossBridge.accept({systemID,npcID,wreckID,pilotID:link.pilotID});
  if(result.status==="COMMITTED"&&factionDirector)
   factionDirector.onLoss({eventID:"wreck:"+wreckID,faction:link.faction||"independent",systemID});
  require("./coopRuntimeProbe").observe("living-npc-economic-loss",null,
   {itemID:npcID,spaceState:{systemID}},{
    pilotID:link.pilotID,name:link.name,wreckID,status:result.status
   });
 }catch(error){console.warn("[CoopVirtualWorld] native wreck consequence",error.message);}
}
// Option A: the merchant sells at the station BEFORE the warehouse takes the
// cargo. The native arrival tick is synchronous, so the first call starts the
// market job and the arrival pauses until it settles, bounded by a hard
// timeout: a hung RPC can never freeze a hauler or fake a sale.
// A hull parked at a station is not engaged, but the market refuses ANY sale while
// the controller still holds a target. The fleet's own approach uses an orbit order
// on its asteroid, and that sets controller.currentTargetID (measured 2026-10-28:
// NATIVE_NPC_BUSY with target 5020484740197 while the hauler sat at station 60003724
// with its minerals ready to sell). Only a NON-COMBAT target is released here: a ship
// target, an attack order or a fresh aggressor keeps the refusal exactly as before.
function releaseStationIdleTarget({systemID,stationID,haulerID,scene=null}={}){
 try{
  const live=scene||require("./runtime").ensureScene(Number(systemID),{refreshStargates:false});
  const ship=live?.getEntityByID?.(Number(haulerID));
  if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true)return false;
  if(String(ship.mode||"").toUpperCase()==="WARP"||ship.pendingWarp||ship.warpState)return false;
  const controller=require("./npc/npcRegistry").getControllerByEntityID(Number(haulerID));
  if(!controller||Number(controller.entityID)!==Number(haulerID))return false;
  const targetID=Number(controller.currentTargetID||0);
  if(!(targetID>0))return false;
  if(String(controller.manualOrder?.type||"")==="attack")return false;
  const aggressionAge=Date.now()-Number(controller.lastAggressedAtMs);
  if(Number(controller.lastAggressorID)>0&&Number.isFinite(aggressionAge)&&
   aggressionAge>=0&&aggressionAge<=120000)return false;
  // A static object (asteroid, belt, station, planet) cannot be an engagement. A
  // hull, drone, fighter or missile keeps its target and keeps the sale refused.
  const target=live?.getEntityByID?.(targetID)||null;
  const staticList=Array.isArray(live?.staticEntities)?live.staticEntities:[];
  const isStatic=staticList.some(x=>Number(x?.itemID)===targetID)||
   String(target?.kind||"")==="asteroid";
  if(!isStatic)return false;
  controller.currentTargetID=0;
  controller.preferredTargetID=0;
  if(String(controller.manualOrder?.type||"")==="orbit")controller.manualOrder=null;
  try{require("./coopRuntimeProbe").observe("living-npc-station-target-cleared",null,
   {spaceState:{systemID:Number(systemID),stationID:Number(stationID)}},
   {haulerID:Number(haulerID),releasedTargetID:targetID,
    kind:String(target?.kind||"static")});}catch(_error){}
  return true;
 }catch(_error){return false;}
}
// Payroll: the corporation pays its own pilot out of its REAL corporation wallet so that a
// purchase can settle at all. The market refuses a buy when the PILOT's earned balance is
// short, and the treasury sweep leaves every pilot at 0 - measured 2026-10-31 the corporation
// walled 1.45 billion ISK while no pilot could afford a 92 720 ISK blueprint.
let payrollInstance=null;
function pilotPayroll(){
 if(payrollInstance)return payrollInstance;
 try{
  const gameStore=require("../gameStore");
  const trader=ensureMarketTrader();
  if(!trader||typeof trader.adjustEarned!=="function")return null;
  payrollInstance=require("./coopPilotPayroll").createPilotPayroll({gameStore,
   adjustEarned:args=>trader.adjustEarned(args),
   journalFile:process.env.EVEJS_COOP_PAYROLL_JOURNAL||"/var/lib/evejs/coop-payroll-journal.json"});
  return payrollInstance;
 }catch(_error){return null;}
}
// One bounded salary per pilot, type and hour: a retry of the same attempt never pays twice,
// and the wallet is only debited for what the pilot actually receives.
const PAYROLL_SALARY_CENTS=10000000; // 100 000.00 ISK
function payPilotForPurchase({pilotID,typeID,stationID,systemID}={}){
 try{
  const payroll=pilotPayroll();
  if(!payroll)return {status:"PAYROLL_UNAVAILABLE"};
  const hour=Math.floor(Date.now()/3600000);
  const answer=payroll.pay({pilotID:String(pilotID),cents:PAYROLL_SALARY_CENTS,
   reason:"purchase "+Number(typeID),eventID:"purchase:"+String(pilotID)+":"+Number(typeID)+":"+hour});
  try{require("./coopRuntimeProbe").observe("living-npc-payroll",null,
   {spaceState:{systemID:Number(systemID),stationID:Number(stationID)}},
   {pilotID:String(pilotID),typeID:Number(typeID),status:String(answer&&answer.status||""),
    isk:Number(answer&&answer.isk||0),walletAfter:Number(answer&&answer.walletAfter||0)});}catch(_error){}
  return answer||{status:"NO_ANSWER"};
 }catch(error){return {status:"PAYROLL_THREW",reason:String(error&&error.message||error).slice(0,80)};}
}
// Buying ONE unit of a seeded station stock (a blueprint, in practice) with the same trader and
// the same identity registry the arrival sale uses. The co-op economy could never grow new
// products because it owned four blueprints; the seeded world sells 2 772 of them, and this is
// the only path that spends real ISK for a real item. Nothing is created: the trader matches a
// seeded ask, debits the corporation and puts the real copy in the hangar.
async function buyFromStationStock({systemID,stationID,typeID,haulerID,scene=null}={}){
 if(process.env.EVEJS_COOP_BLUEPRINT_PURCHASE!=="1")return {status:"DISABLED"};
 if(process.env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1")return {status:"MARKET_OFF"};
 const pilotID=String((identityRegistry?.snapshot?.()?.links||{})[Object.keys(identityRegistry?.snapshot?.()?.links||{})
  .find(key=>Number(identityRegistry.snapshot().links[key].entityID)===Number(haulerID))]?.pilotID||"");
 const trader=ensureMarketTrader();
 if(!trader)return {status:"MARKET_UNAVAILABLE"};
 const link=Object.values(identityRegistry?.snapshot?.()?.links||{})
  .find(row=>Number(row.entityID)===Number(haulerID))||null;
 if(!link)return {status:"NO_IDENTITY_LINK"};
 try{
  let answer=await trader.execute({scene:scene||require("./runtime").ensureScene(Number(systemID),
   {refreshStargates:false}),pilotID:link.pilotID,entityID:Number(haulerID),
   stationID:Number(stationID),side:"buy",typeID:Number(typeID),buyTypes:[Number(typeID)],sellTypes:[]},
   {withinBatch:false});
  // The market settles a purchase out of the PILOT's earned balance, and the treasury sweep
  // empties every pilot after each sale. Measured 2026-10-31: Miner I Blueprint bought for
  // 92 720 ISK while every pilot stood at 0 and the corporation wallet held 1.45 billion - so
  // the refusal is funded from the corporation's OWN wallet, never invented.
  if(answer&&String(answer.status)==="INSUFFICIENT_EARNED_ISK"){
   const paid=payPilotForPurchase({pilotID:link.pilotID,typeID:Number(typeID),
    stationID:Number(stationID),systemID:Number(systemID),
    balance:Number(answer.balance||0),price:Number(answer.price||0)});
   if(paid&&paid.status==="PAID")
    answer=await trader.execute({scene:scene||require("./runtime").ensureScene(Number(systemID),
     {refreshStargates:false}),pilotID:link.pilotID,entityID:Number(haulerID),
     stationID:Number(stationID),side:"buy",typeID:Number(typeID),buyTypes:[Number(typeID)],
     sellTypes:[]},{withinBatch:false});
  }
  try{require("./coopRuntimeProbe").observe("living-npc-blueprint-bought",null,null,
   {systemID:Number(systemID),stationID:Number(stationID),typeID:Number(typeID),
    haulerID:Number(haulerID),status:String(answer&&answer.status||"UNKNOWN"),
    price:Number(answer&&answer.price||0),quantity:Number(answer&&answer.quantity||0)});}catch(_error){}
  return answer||{status:"NO_ANSWER"};
 }catch(error){return {status:"BUY_THREW",reason:String(error&&error.message||error).slice(0,80),
  stack:String(error&&error.stack||"").split("\n").slice(1,3).join(" | ").slice(0,160)};}
}
function sellOnArrival({systemID,stationID,haulerID,types=[],scene=null}={}){
 if(process.env.EVEJS_COOP_NPC_MARKET_SELL_ON_ARRIVAL!=="1")return {status:"DISABLED"};
 if(process.env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1")return {status:"MARKET_OFF"};
 const sellTypes=nativeMarketAllowlist("EVEJS_COOP_NPC_MARKET_SELL_TYPES");
 if(!sellTypes.length)return {status:"NO_SELL_TYPES"};

 const key=Number(stationID)+":"+Number(haulerID);
 const running=arrivalSales.get(key);
 if(running){
  if(running.settled)return running.settled;
  if(Date.now()-running.startedAt>45000){
   arrivalSales.delete(key);
   noteSaleSkip(systemID,stationID,haulerID,"SALE_TIMEOUT");
   return {status:"NOT_SOLD",reason:"SALE_TIMEOUT"};
  }
  return {status:"PENDING"};
 }
 // Reuse the identity mechanism that already names the mining fleet: a real
// fleet hauler is adopted by a free miner/hauler resident exactly the way
// coopNativeIndustry.observe does, so it keeps a NORMAL coop-pilot identity and
// ledger instead of inventing a second identifier scheme.
 function adoptMerchant(scene,haulerID,systemID){
  const registry=identityRegistry;
  if(!registry||typeof registry.link!=="function"||typeof registry.get!=="function")
   return null;
  // The role is a virtual label, not a property of the world file: the virtual world
  // keeps id/name/faction/route and the economy ledger owns the role. Filtering only on
  // pilot.role matched nothing, so every sale died with HAULER_NOT_NAMED while the
  // fleet carried real ore to a real station. Read the role from whichever layer has
  // it, prefer a hauler/miner resident, then any free resident.
  const ledger=(()=>{try{return economy&&typeof economy.snapshot==="function"?
   (economy.snapshot().pilots||{}):{}}catch(_error){return {}}})();
  const roleOf=pilot=>String(pilot?.role||(ledger&&ledger[pilot?.id]&&ledger[pilot.id].role)||"");
  const residents=(world?.snapshot()?.pilots||[]).filter(p=>p&&p.id);
  const preferred=residents.filter(p=>["hauler","miner"].includes(roleOf(p)));
  const pilots=[...preferred,...residents.filter(p=>!preferred.includes(p))];
  const links=Object.values(registry.snapshot()?.links||{});
  if(links.some(x=>Number(x.entityID)===Number(haulerID)))return null;
  for(const pilot of pilots){
    if(registry.get(pilot.id))continue;
    let linked=null;
    try{linked=registry.link(pilot,Number(systemID),Number(haulerID));}
    catch(_error){continue;}
    if(!linked||Number(linked.entityID)!==Number(haulerID))continue;
    try{require("./coopNpcPresentation").presentVirtualPilot(scene,Number(haulerID),pilot);}
    catch(_error){/* a failed name broadcast must not block the sale */}
    return linked;
  }
  // Every resident may already be linked, because each station trip used to
  // consume one identity for good. A hauler that is absent from every active
  // scene, carries nothing and only sits in the store has finished its shift;
  // its pilot can name the ship that is physically here instead of the sale
  // dying with HAULER_NOT_NAMED forever.
  const nativeStore=require("./npc/nativeNpcStore");
  const sceneIDs=new Set(Array.from(scene?.dynamicEntities?.keys?.()||[]).map(Number));
  for(const entry of links){
   if(!["hauler","trader"].includes(String(entry.role)))continue;
   if(entry.durable===true)continue;
   if(Number(entry.systemID)!==Number(systemID))continue;
   if(sceneIDs.has(Number(entry.entityID)))continue;
   if(!nativeStore.getNativeEntity(Number(entry.entityID)))continue;
   if((nativeStore.listNativeCargoForEntity(Number(entry.entityID))||[]).length)continue;
   const donor=pilots.find(p=>String(p?.id)===String(entry.pilotID));
   if(!donor)continue;
   let freed=null;
   try{freed=registry.release(entry.pilotID,{expectedEntityID:Number(entry.entityID)});}
   catch(_error){continue;}
   if(freed?.status!=="RELEASED")continue;
   let reused=null;
   try{reused=registry.link(donor,Number(systemID),Number(haulerID));}
   catch(_error){continue;}
   if(!reused||Number(reused.entityID)!==Number(haulerID))continue;
   try{require("./coopNpcPresentation").presentVirtualPilot(scene,Number(haulerID),donor);}
   catch(_error){/* a failed name broadcast must not block the sale */}
   try{
    require("./coopRuntimeProbe").observe("living-npc-merchant-identity-reused",null,
     {spaceState:{pilotID:String(donor.id),fromEntityID:Number(entry.entityID),
      toEntityID:Number(haulerID),systemID:Number(systemID)}});
   }catch(_error){}
   return reused;
  }
  return null;
 }
 let link=Object.values(identityRegistry?.snapshot()?.links||{})
  .find(entry=>Number(entry.entityID)===Number(haulerID)&&
   Number(entry.systemID)===Number(systemID));
 if(!link)link=adoptMerchant(scene||require("./runtime").ensureScene(Number(systemID),
  {refreshStargates:false}),haulerID,systemID);
 if(!link){noteSaleSkip(systemID,stationID,haulerID,"HAULER_NOT_NAMED");return {status:"NOT_SOLD",reason:"HAULER_NOT_NAMED"};}
 // Last leg of the loop: the refinery leaves its minerals in the corporation
 // hangar, and a hangar stack cannot be sold by a ship trader. One custody-safe
 // load puts the exact quantity into the hauler real native cargo hold and the
 // proven sale path then liquidates it against the seeded bids of THIS station.
 // Any lift-tagged mineral cargo this hauler already carries must be sold even when
 // this arrival loads nothing new. Declared at FUNCTION scope: inside the gate below it
 // was invisible to the sale filter and every arrival died with `liftedTypes is not
 // defined` (measured on the fresh work-stack world, 3 deliveries, 0 sales).
 const liftedTypes=new Set();
 if(process.env.EVEJS_COOP_NPC_MINERAL_LIFT==="1"){
  const MINERAL_LIFT_CARGO_TAG=/^coop-mineral-lift:v1:/;
  try{
   const held=require("./npc/nativeNpcStore").listNativeCargoForEntity(Number(haulerID))||[];
   for(const row of held)
    if(MINERAL_LIFT_CARGO_TAG.test(String(row.customInfo||""))&&Number(row.typeID)>0)
     liftedTypes.add(Number(row.typeID));
  }catch(_error){/* an unreadable hold never blocks the ore sale */}
 }
 // The market refuses a sale while the hauler's controller holds a target, and the
 // fleet's asteroid orbit sets one. Release only a non-combat target (see above).
 releaseStationIdleTarget({systemID,stationID,haulerID,scene:scene||null});
 const trader=ensureMarketTrader();
 if(!trader){noteSaleSkip(systemID,stationID,haulerID,"MARKET_UNAVAILABLE");return {status:"NOT_SOLD",reason:"MARKET_UNAVAILABLE"};}
 const job={startedAt:Date.now(),settled:null};
 arrivalSales.set(key,job);
 void (async()=>{
  const sold=[];let last="NO_ELIGIBLE_STACK",settlements=0;
  try{
   const scene=require("./runtime").ensureScene(Number(systemID),{refreshStargates:false});
   // The lift is ASYNC. Awaiting it here is what puts the refined minerals into this
   // hull's real native hold (and their types into the sale list) BEFORE the sale is
   // priced. Measured 2026-10-28: the promise was read as a result, so no mineral type
   // ever joined sellTypes, not one mineral was ever sold, and 47 lift-tagged rows sat
   // in a single hold while the station surplus could not move.
   if(process.env.EVEJS_COOP_NPC_MINERAL_LIFT==="1"){
    let loaded=null;
    try{
     loaded=await ensureMineralLift()?.lift({systemID,stationID,haulerID,
      cap:Math.max(1,Number(process.env.EVEJS_COOP_NPC_MINERAL_LIFT_MAX_QTY||100000))});
    }catch(_error){loaded=null;}
    if(loaded&&loaded.status==="LIFTED")
     for(const row of loaded.lifted||[]){
      const typeID=Number(row.typeID);
      if(!sellTypes.includes(typeID))sellTypes.push(typeID);
      liftedTypes.add(typeID);
     }
    else if(loaded&&loaded.status!=="LIFTED"){
     const note="lift:"+Number(stationID)+":"+String(loaded.status);
     const now=Date.now();
     if(now-(mineralLiftNotes.get(note)||0)>300000){
      mineralLiftNotes.set(note,now);
      try{require("./coopRuntimeProbe").observe("living-npc-mineral-lift-skipped",null,
       {spaceState:{systemID:Number(systemID),stationID:Number(stationID),
        haulerID:Number(haulerID),status:String(loaded.status||"UNKNOWN")}});}catch(_error){}
     }
    }
   }
   // What the hull REALLY carries is sellable too. A stack lifted on an earlier arrival,
   // or produced by manufacturing, is not in this trip's manifest - so the batch never
   // asked the market for it and it rode along for ever. Measured 2026-10-28: 5 Mining
   // Survey Chipsets sat in a hauler through a full ore haul while 23 seeds bid 53 700.
   const carried=new Set();
   try{
    const rows=require("./npc/nativeNpcStore").listNativeCargoForEntity(Number(haulerID))||[];
    for(const row of rows)carried.add(Number(row.typeID));
    // A carried type OUTSIDE the allowlist was never ASKED for: the filter below only
    // kept allowlisted types, so a hauled good rode along for ever. Measured 2026-10-30: a
    // distribution hull held Republic Fleet Depleted Uranium while Jita bid 560 000 for it,
    // and every sale answered NO_REAL_NATIVE_CARGO because 28338 is not in the env list.
    for(const typeID of carried)
     if(Number(typeID)>0&&!sellTypes.includes(Number(typeID)))sellTypes.push(Number(typeID));
   }catch(_error){/* an unreadable hold simply adds no type */}
   const wanted=[...new Set(sellTypes.filter(typeID=>
    liftedTypes.has(Number(typeID))||carried.has(Number(typeID))||
    !types.length||types.map(Number).includes(Number(typeID))))];
   // The finished good the hull carries goes first, then the stock the lift just put
   // aboard, then everything else. A raw ore stack keeps selling on the next visit, but
   // a manufactured product is the scarcest cargo this corporation owns, and a batch
   // bounded to 8 settlements and 30 s must not spend itself on bulk minerals before it
   // ever asks for the product (measured 2026-10-28: 5 chipsets rode along unsold).
   const isRaw=typeID=>{
    try{
     const type=require("../services/inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID));
     const category=Number(type&&type.categoryID);
     return category===4||category===25; // Mineral / Ore
    }catch(_error){return true}
   };
   // Explicit passes instead of a comparator: the finished good goes first, then the
   // stock the lift just put aboard, then everything else. A raw ore stack keeps selling
   // on the next visit, but a manufactured product is the scarcest cargo this
   // corporation owns, and a batch bounded to 8 settlements and 30 s must not spend
   // itself on bulk minerals before it ever asks for the product (measured 2026-10-28:
   // 5 chipsets rode along unsold while the batch sorted them behind the ore).
   const carriedGood=wanted.filter(typeID=>carried.has(Number(typeID))&&!isRaw(typeID));
   const liftedRest=wanted.filter(typeID=>!carriedGood.includes(typeID)&&
    liftedTypes.has(Number(typeID)));
   const ordered=[...carriedGood,...liftedRest,
    ...wanted.filter(typeID=>!carriedGood.includes(typeID)&&!liftedRest.includes(typeID))];
   try{
    require("./coopRuntimeProbe").observe("living-npc-sale-batch",null,
     {spaceState:{systemID:Number(systemID)}},
     {stationID:Number(stationID),haulerID:Number(haulerID),typesGiven:types.length,
      ordered:ordered.slice(0,10),carriedGood:[...carriedGood].slice(0,6),
      carried:[...carried].slice(0,8),lifted:[...liftedTypes].slice(0,8)});
   }catch(_error){/* telemetry must never stop a sale */}
   if(!ordered.length)last="NO_ALLOWED_ORE";
   for(const typeID of ordered){
    // Several stacks of one ore type are still one merchant action. Keep going
    // while the market really buys, so a haul is liquidated instead of decaying
    // in the warehouse, but stay strictly bounded in count and time.
    let hardFail=false;
    for(;;){
     if(settlements>=8||Date.now()-job.startedAt>30000)break;
     const result=await trader.execute({scene,pilotID:link.pilotID,
      entityID:Number(haulerID),stationID:Number(stationID),
      side:"sell",typeID,buyTypes:[],sellTypes},
      {withinBatch:settlements>0});
     if(result.status!=="TRADE_SETTLED"){
      last=String(result.status||"UNKNOWN");
      // Every refusal of every type is observable: a whole batch used to end on an
      // unrelated type and the settlement only carried the LAST status, which hid which
      // type the market was actually asked for (measured 2026-10-28).
      try{
       // FW-108: when the market refuses because THIS station does not bid for the type,
       // say how far the station that does bid really is. Measured 2026-10-30: combat loot
       // is quoted only by Jita 60003760 while the front's region quotes it nowhere, so
       // "no counterparty" hid a several-jump journey that nothing in the server could
       // describe - there was no route finder at all.
       let buyers=(result&&Array.isArray(result.seededBuyers)?result.seededBuyers:[])
        .slice(0,3).map(b=>{
         let buyerSystemID=0;
         try{
          const station=worldData.getStationByID(Number(b.stationID));
          buyerSystemID=Number(station&&station.solarSystemID)||0;
         }catch(_error){buyerSystemID=0}
         let hops=null;
         if(buyerSystemID>0&&pos(Number(systemID))){
          try{
           const found=require("./coopGateRoutes").shortestGateRoute({
            fromSystemID:Number(systemID),toSystemID:buyerSystemID,
            neighbours:id=>worldData.getStargatesForSystem(id)
             .map(g=>Number(g&&g.destinationSolarSystemID)).filter(x=>x>0)});
           hops=Number.isFinite(found.hops)?found.hops:null;
          }catch(_error){hops=null}
         }
         return {stationID:Number(b.stationID),price:Number(b.price)||0,
          volume:Number(b.volume)||0,systemID:buyerSystemID,hops};
        });
       require("./coopRuntimeProbe").observe("living-npc-sale-type",null,
        {spaceState:{systemID:Number(systemID)}},
        {stationID:Number(stationID),haulerID:Number(haulerID),typeID:Number(typeID),
         status:last,good:carriedGood.includes(typeID),carried:carried.has(Number(typeID)),
         lifted:liftedTypes.has(Number(typeID)),
         ...(buyers.length?{seededBuyers:buyers}:{})});
      }catch(_error){/* telemetry must never stop a sale */}
      // "Nothing of THIS type aboard" is not a failure of the haul: the hold carries
      // several types and one empty allowlisted type used to break the loop before the
      // minerals were ever tried (measured 2026-10-28: a drain visit settled
      // NOT_SOLD NO_REAL_NATIVE_CARGO while 56 lift rows sat in the hold).
      // "This station does not bid for THIS type" is the same story one step later:
      // measured 2026-10-28 the 5 manufactured chipsets were lifted into the hauler and
      // the batch ended NO_SEEDED_COUNTERPARTY on an unrelated ore type, so the one type
      // this station really bids 53 700 for was never asked for at all.
      hardFail=!["NO_REAL_NATIVE_CARGO","NO_ELIGIBLE_STACK","TYPE_NOT_ALLOWLISTED",
        "NO_SEEDED_COUNTERPARTY"].includes(last);
      break;
     }
     settlements++;
     sold.push({typeID,quantity:result.quantity,price:result.price,
      isk:Math.round(result.price*result.quantity),balance:result.balance});
    }
    if(hardFail)break;
   }
  }catch(error){last="SALE_ERROR:"+String(error?.message||error).slice(0,60);}
  job.settled=sold.length?
   {status:"SOLD",sold:JSON.parse(JSON.stringify(sold)),lastStatus:last,
    quantity:sold.reduce((sum,entry)=>sum+entry.quantity,0),
    isk:sold.reduce((sum,entry)=>sum+entry.isk,0)}:
   {status:"NOT_SOLD",reason:last};
 // One line per settled sale: a refusal used to exist only for the five seconds the map
 // keeps it, which is why a distribution run could call all day and learn nothing.
 try{require("./coopRuntimeProbe").observe("living-npc-sale-settlement",null,null,{systemID:Number(systemID),stationID:Number(stationID),haulerID:Number(haulerID),status:String(job.settled&&job.settled.status||""),reason:String(job.settled&&(job.settled.reason||job.settled.lastStatus)||"").slice(0,60),quantity:Number(job.settled&&job.settled.quantity||0),isk:Number(job.settled&&job.settled.isk||0)});}catch(_coopSaleError){}
 })().finally(()=>{
  // Keep the settled result readable for the next arrival tick only.
  const timer=setTimeout(()=>{if(arrivalSales.get(key)===job)arrivalSales.delete(key);},5000);
  if(typeof timer?.unref==="function")timer.unref();
 });
 // The split runtime owns nativeWarFleetRegistry() but not the module state it
 // reads: hand it the live bridge and identity registry after they exist.
 syncWarRuntime();
 return {status:"PENDING"};
}
// This is deliberately NOT an EveJS client RPC or HTTP admin endpoint.
// The caller must be trusted in-process server code providing a separately
// authenticated admin/RBAC decision for every inspection and mutation.
// The split runtime reads live objects this file creates. They appear in a
// different order than the module assumes, so hand them over on every cycle
// instead of guessing one moment when all of them already exist.
// The war layer only looked at systems a client had flown into. A real war
// fleet spawned into a system creates a native scene there and the durable
// roster proves those hulls, so that system is observed too.
function warFleetSystemIDs(){
 try{
  return require("./coopWarObservedSystems")
   .fleetSystemIDs(require("./coopWarFleetRoster").sharedRoster().snapshot());
 }catch(_error){return []}
}
function syncWarRuntime(){
 try{
  require("./coopVirtualWorldRuntime.pure").bindWarRuntime({
   bridge,identityRegistry,economy,nativeGateTransfer,recognitionAnnouncer,
   nativeAmmoWitness,lossBridge,factionDirector,raidDirector,tacticsDirector,pveSiteDefenseDirector,pveWaveReinforcementsDirector,pveObjectiveDoctrineDirector,pveNativeBossDirector,warpPointDirector,nativeGunRange,warGateHandoff,warRecoverySocket,nativeOrderBridge,lootCommerce,nativeAmmoSupply,warTreasuryInstance});
 }catch(_ignored){}
}
function livingWorldPhases(){return worldPhaseCoordinator?.snapshot()||{active:false,sequence:0,last:null}}
// World-setup seam used by the admin bridge. A ship spawned outside the
// materializer is only a real presence for the war layer once the identity
// registry knows which roster pilot flies it, so this links the pair and refuses
// unless the native entity really exists in that system and the pilot is a real,
// still-unlinked roster identity.
// FW-027: a pilot identity can be released from a hull that no longer needs it
// (a retired or reassigned ship), so a new real hull can be crewed. The release
// is the identity registry's own operation and never touches the ship itself.
function linkSpawnedIdentity({pilotID,systemID,entityID,role}={}){
 if(!identityRegistry)return {status:"IDENTITY_REGISTRY_UNAVAILABLE"};
 const pilotId=String(pilotID||"").trim();
 const system=Number(systemID),entity=Number(entityID);
 if(!pilotId||!Number.isSafeInteger(system)||system<=0||
  !Number.isSafeInteger(entity)||entity<=0)return {status:"INVALID_IDS"};
 // A reserve roster pilot may carry no role yet. The caller may state the job the
 // hull really does (a spawned armed interceptor is a patrol), and only these
 // four labels are accepted - never an arbitrary string.
 const LINK_ROLES=new Set(["patrol","pirate","miner","hauler","trader"]);
 const requestedRole=String(role||"").trim();
 if(requestedRole&&!LINK_ROLES.has(requestedRole))
  return {status:"INVALID_LINK_ROLE",role:requestedRole};
 let roster=[];
 try{roster=world?.snapshot?.().pilots||[]}catch{roster=[]}
 const found=roster.find(p=>String(p?.id)===pilotId);
 if(!found)return {status:"UNKNOWN_ROSTER_PILOT",pilotID:pilotId};
 const pilot=requestedRole?{...found,role:requestedRole}:found;
 let links={};
 try{links=identityRegistry.snapshot()?.links||{}}catch{links={}}
 if(Object.values(links).some(l=>String(l?.pilotID)===pilotId))
  return {status:"PILOT_ALREADY_LINKED",pilotID:pilotId};
 if(Object.values(links).some(l=>Number(l?.entityID)===entity))
  return {status:"SHIP_ALREADY_LINKED",entityID:entity};
 try{
  const native=require("./npc/nativeNpcStore").getNativeEntity(entity);
  if(!native||Number(native.systemID)!==system)
   return {status:"NATIVE_ENTITY_NOT_IN_SYSTEM",entityID:entity};
  identityRegistry.link(pilot,system,entity);
  return {status:"LINKED",pilotID:pilotId,systemID:system,entityID:entity};
 }catch(error){
  return {status:"LINK_FAILED",reason:String(error?.message||error)};
 }
}
module.exports={nativeGateTransferAdapter,identityRegistryAdapter,buyFromStationStock,reconcileMarketJournalsAtBoot,witnessedNativeBossWreck,createWarRecoveryAdmin,start,observeSession,confirmedWreck,confirmedNativeNpcWreck,nextHeadlessRetryMs,isHeadlessNativeReady,alifeOrderArbitrationEnabled,sellOnArrival,nativeWarFleetRegistry,livingWorldPhases,linkSpawnedIdentity,releaseSpawnedIdentity,diagnoseMobilization,identityLinks,deriveTerritoryOwners,planTerritoryBootstrap,bootstrapTerritoriesFromPresence,chooseWarRestore,readWarMirror,legacyWarStateMirrorEnabled,refundExpiredCampaigns,reconcileTerminalEscrow,reconcileBountyCredits,warBountyRelease,diagnoseWarPayout,diagnoseNavy,diagnoseCombat,diagnoseWarFunding,executeMercenaryContract,diagnoseMercenarySettlement,diagnoseNpcOrder,diagnoseNativeRaids,diagnoseWarState,warFrontChat};
