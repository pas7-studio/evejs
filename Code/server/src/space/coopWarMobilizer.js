"use strict";
// FW-003C: automatically mobilize EXISTING idle native patrol ships only.
// The original 30s A-Life tick owns scheduling. No hull/ISK/ammo production,
// artificial travel, faction tag, scripted damage or invented military supply.
//
// FW-028: mobilisation is per campaign, not per world. Every live campaign is
// planned and reported on its own, and the tick budget is spent on the most
// starved campaign first, so one un-winnable border can never hide (or starve)
// another border whose two sides really are mustered.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
// FW-069: a candidate's system is the system its HULL is in, not the one its identity
// link remembers. The link follows the virtual pilot, which the world keeps advancing
// along its route while the native hull stays where it was spawned (the same drift
// FW-048/FW-049/FW-051 fixed for attribution, presence and the opener). The mobiliser
// still compared the LINK's system, so every drifted patrol was silently dropped as
// WRONG_SYSTEM - the side then answered NO_PATROL_CANDIDATE while an armed hull stood in
// its system, no assault was ever deployed, and the payout rung could never be reached.
// The native record decides; a link with no readable native system keeps its own value.
// FW-070: a war hull is any ARMED hull of the faction, and "pirate" is a normal war
// role in this world - the Angel Cartel raiders that hold 30045342 are linked as
// `pirate`, and the mobiliser only accepted `patrol`. Measured 10:2xZ: three armed,
// linked, physically present hulls stood in the campaign's system while both sides
// answered NO_PATROL_CANDIDATE, so the ASSAULT could never deploy a ship. This is the
// same definition FW-044 already uses for military ownership (`deriveTerritoryOwners`),
// so one rule now covers both.
const MOBILIZABLE_ROLES = new Set(["patrol", "pirate"]);

const physicalCandidateSystem=(link,getNativeEntity)=>{
 try{
  const native=typeof getNativeEntity==="function"?getNativeEntity(Number(link&&link.entityID)):null;
  const physical=Number(native&&native.systemID);
  if(Number.isSafeInteger(physical)&&physical>0)return physical;
 }catch(_error){/* fall through to the link */}
 const remembered=Number(link&&link.systemID);
 return Number.isSafeInteger(remembered)&&remembered>0?remembered:0;
};
const identifier=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(x);
const warp=s=>String(s?.mode||"").toUpperCase().includes("WARP")||
 !!(s?.pendingWarp||s?.warpState||s?.isWarping);
const enabled=env=>env.EVEJS_COOP_FACTION_WAR==="1"&&
 env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
 env.EVEJS_COOP_FACTION_WAR_MOBILIZE==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
 env.EVEJS_COOP_NPC_STRICT_AMMO==="1"&&
 env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE==="1"&&
 env.EVEJS_COOP_NPC_BANK_ATOMIC==="1"&&
 (env.EVEJS_COOP_ALIFE==="1"||env.EVEJS_COOP_NPC_ORDER_ARBITER==="1");
// A dry run reports every campaign, so its own bound is much larger than the
// write budget. It never writes, so the only risk of a bigger bound is output.
const DRY_RUN_REPORT_LIMIT=64;
const SIDE_REJECT_LIMIT=6;
// FW-110: a war hull is a PHYSICAL ship, not a stored row.
//
// MEASURED on the play stack 2026-10-30, one restart after the front reached ASSAULT:
// 6 of the 10 registered hulls pointed at an entity id the pilot no longer owned
// (coop-pilot-003 registry 980000062777 while its real hull was 980000067050) and 4 pilots
// had no identity link at all. Every later muster therefore answered PILOT_IN_USE for the
// same pilots, both sides reported assigned 0, and r13..r17 expired without a single
// defender hull ever being destroyed. The registry was staffing a campaign with ghosts.
//
// This answers one question only: which custody rows describe a hull the pilot has PROVENLY
// left? A pilot with no link, or with two links, is ambiguous and is never guessed at.
function staleCustodyRows({ships={},links=[]}={}){
 const byPilot=new Map();
 for(const l of Array.isArray(links)?links:[]){
  if(!named(l?.pilotID)||!pos(l?.entityID))continue;
  if(!byPilot.has(l.pilotID))byPilot.set(l.pilotID,[]);
  byPilot.get(l.pilotID).push(Number(l.entityID));
 }
 const out=[];
 for(const row of Object.values(ships||{})){
  if(!row||!pos(row.entityID)||!named(row.pilotID))continue;
  const owned=byPilot.get(row.pilotID)||[];
  if(owned.length!==1)continue;
  const current=owned[0];
  if(current===Number(row.entityID))continue;
  out.push({entityID:Number(row.entityID),pilotID:String(row.pilotID),
   fleetID:String(row.fleetID||""),campaignID:String(row.campaignID||""),
   currentEntityID:current});
 }
 return out.sort((a,b)=>a.entityID-b.entityID);
}

function createWarMobilizer({registry,readWarState,readLinks,sceneForSystem,
 getNativeEntity,getController,getFactionForCorporation,
 inspectReadiness,getOrderLeases,isTactical=()=>false,
 commandCap=null,
 // FW-113b: three hulls per side instead of two. MEASURED 2026-10-31: 141 ships were
 // physically present around six systems while the whole war registered six of them, so a
 // front was a skirmish of four hulls. The rank cap still binds (a recruit commands one
 // hull), so this only lets experienced sides field what they have earned.
 clock=()=>Date.now(),env=process.env,maxPerTick=2,maxPerSide=3}={}){
 if(!registry?.snapshot||!registry?.execute||
  [readWarState,readLinks,sceneForSystem,getNativeEntity,getController,
   getFactionForCorporation,inspectReadiness,getOrderLeases,isTactical,clock]
   .some(x=>typeof x!=="function")||
  (commandCap!==null&&typeof commandCap!=="function")||
  !Number.isSafeInteger(maxPerTick)||maxPerTick<1||maxPerTick>4||
  !Number.isSafeInteger(maxPerSide)||maxPerSide<1||maxPerSide>4)
  throw Error("WAR_MOBILIZATION_NATIVE_AUTHORITIES_REQUIRED");
 let busy=false;
 function tick({systemIDs=[],dryRun=false}={}){
  if(!enabled(env))return {status:"DISABLED",mobilized:[],campaigns:[]};
  if(busy)return {status:"BUSY",mobilized:[],campaigns:[]};
  if(!Array.isArray(systemIDs)||systemIDs.length>512||systemIDs.some(x=>!pos(x)))
   return {status:"INVALID_SYSTEMS",mobilized:[],campaigns:[]};
  busy=true;
  try{
   const now=clock();
   if(!pos(now))return {status:"CLOCK_UNSAFE",mobilized:[],campaigns:[]};
   let state,assigned,links,leases;
   try{
    state=readWarState();
    assigned=registry.snapshot();
    links=readLinks();
    leases=getOrderLeases();
   }catch{return {status:"NATIVE_AUTHORITIES_UNAVAILABLE",mobilized:[],campaigns:[]}}
   if(state?.version!==1||!state.wars||!state.campaigns||
    assigned?.version!==1||!assigned.ships||
    !Array.isArray(links)||links.length>10000||
    !Array.isArray(leases)||leases.length>10000)
    return {status:"INVALID_MOBILIZATION_STATE",mobilized:[],campaigns:[]};
   // FW-110: release the custody of hulls the pilot has provably left, before any side
   // plans a muster that could only ever answer PILOT_IN_USE for them. Bounded by the
   // same per-tick budget, never during a dry run, never while an order lease is live.
   const released=[],releasedIDs=new Set();
   if(!dryRun){
    for(const row of staleCustodyRows({ships:assigned.ships,links})
     .slice(0,Math.min(4,maxPerTick))){
     if(leases.some(l=>l?.entityID===row.entityID&&
      (l.phase==="OUTCOME_UNKNOWN"||l.phase==="ISSUING"||
       (l.phase==="ACTIVE"&&(l.expiresAt===null||!Number.isFinite(l.expiresAt)||
        l.expiresAt>now)))))continue;
     let answer;
     try{
      answer=registry.execute({type:"RELEASE",
       eventID:"wr:stale:"+row.campaignID+":"+row.entityID+":"+row.currentEntityID,
       entityID:row.entityID,pilotID:row.pilotID,fleetID:row.fleetID,
       currentEntityID:row.currentEntityID,
       proofID:"native-replaced:"+row.campaignID+":"+row.entityID+":"+
        row.currentEntityID});
     }catch(_error){answer={status:"NATIVE_RELEASE_UNCERTAIN"};}
     released.push({entityID:row.entityID,pilotID:row.pilotID,
      currentEntityID:row.currentEntityID,
      status:String(answer&&answer.status||"UNKNOWN"),
      reason:String(answer&&answer.reason||"")});
     if(answer&&(answer.status==="APPLIED"||answer.status==="DUPLICATE"))
      releasedIDs.add(row.entityID);
    }
   }
   const reachable=new Set(systemIDs);
   // One pass per tick instead of scanning the full identity registry
   // for every NPC candidate of every active campaign.
   const pilotCounts=new Map(),entityCounts=new Map();
   for(const l of links){
    if(named(l?.pilotID))
     pilotCounts.set(l.pilotID,(pilotCounts.get(l.pilotID)||0)+1);
    if(pos(l?.entityID))
     entityCounts.set(l.entityID,(entityCounts.get(l.entityID)||0)+1);
   }
   // FW-069/070: the candidate set is built from the ARMED roles and from the system
   // the HULL is in. The old filter required exactly "patrol" and the link's own
   // system, so an Angel Cartel raider (role "pirate") or any hull whose virtual pilot
   // had walked on was never even considered - both sides of a real ASSAULT answered
   // NO_PATROL_CANDIDATE while armed hulls stood in the system.
   const candidateLinks=links.filter(l=>named(l?.pilotID)&&
    pilotCounts.get(l.pilotID)===1&&pos(l.entityID)&&
    entityCounts.get(l.entityID)===1&&
    MOBILIZABLE_ROLES.has(String(l.role||""))&&
    reachable.has(physicalCandidateSystem(l,getNativeEntity)))

    .sort((a,b)=>a.entityID-b.entityID).slice(0,512);
   // FW-072: a registry row whose hull no longer exists is custody of a dead ship, and
   // it must not block the pilot forever. Measured 10:3xZ: both sides of a live ASSAULT
   // answered NO_ELIGIBLE_PATROL with reason PILOT_IN_USE for pilots whose hulls had been
   // destroyed campaigns ago, so no fresh campaign could ever staff a side. A row with a
   // live native record anywhere still reserves its pilot (that ship is real and busy);
   // a row with no native record reserves nothing.
   const rowIsLive=(row)=>{
    try{return Boolean(getNativeEntity(Number(row&&row.entityID)))}catch{return true}
   };
   const liveRows=Object.values(assigned.ships).filter(rowIsLive)
    .filter(row=>!releasedIDs.has(Number(row&&row.entityID)));
   const existing=new Set(liveRows.map(row=>Number(row&&row.entityID)).filter(pos));
   const usedPilots=new Set(liveRows.map(row=>row&&row.pilotID).filter(named));
   const mobilized=[];
   const blocked=[];
   // A hull that was released from a campaign may legitimately be mobilized into
   // it again (e.g. after it was relieved while dry and later re-armed). The
   // registry refuses a reused event ID, so the ID must identify the real
   // assignment attempt: the count of proven ASSIGN receipts already on record.
   const assignmentCounts=new Map();
   for(const receipt of Array.isArray(assigned.history)?assigned.history:[]){
    if(receipt?.type!=="ASSIGN"||!pos(receipt.entityID)||!receipt.campaignID)continue;
    const key=String(receipt.campaignID)+":"+Number(receipt.entityID);
    assignmentCounts.set(key,(assignmentCounts.get(key)||0)+1);
   }
   // Campaign IDs are user-independent server-generated records, never chat
   // input. Sort deterministically to prevent tick-order oscillations.
   const campaigns=Object.values(state.campaigns)
    .filter(c=>c&&identifier(c.campaignID)&&identifier(c.warID)&&
     ["PREPARING","ASSAULT"].includes(c.state)&&
     state.wars[c.warID]?.state==="ACTIVE")
    .sort((a,b)=>(a.startedAt||0)-(b.startedAt||0)||
     a.campaignID.localeCompare(b.campaignID)).slice(0,16);
   // Plan EVERY live campaign before any write: the number of ships its own
   // commander may still field on each side, in the system that side must hold.
   // A side is never filled by a hull that is not physically in its system, so an
   // assault attacker left behind in the source system cannot hold the slot.
   const inSide=(campaignID,factionID,systemID)=>s=>s?.campaignID===campaignID&&
    Number(s.factionID)===Number(factionID)&&Number(s.systemID)===Number(systemID);
   const plans=[];
   for(const c of campaigns){
    const w=state.wars[c.warID];
    if(!pos(w?.attackerFactionID)||!pos(w.defenderFactionID)||
     w.attackerFactionID===w.defenderFactionID||
     !pos(c.sourceSystemID)||!pos(c.targetSystemID))continue;
    const sides=[
     {factionID:w.defenderFactionID,systemID:c.targetSystemID,role:"DEFENDER"},
     {factionID:w.attackerFactionID,systemID:c.state==="PREPARING"?
      c.sourceSystemID:c.targetSystemID,role:"ATTACKER"}
    ];
    const entries=sides.map(side=>{
     const onSide=inSide(c.campaignID,side.factionID,side.systemID);
     // A registry/assignment row is custody, not a hull on the field (the same
     // rule FW-033 already applies to the garrison). Measured on the work stack
     // 2026-10-28: two ghost rows made both sides answer SIDE_MUSTERED with
     // assigned 1 while the only live hull in the system was idle, so the
     // mobiliser reserved nothing, no attack order was ever issued and the
     // campaign stalled in ASSAULT forever. Count only hulls really in the scene
     // when the caller can tell us; with no scene authority the old counting is
     // kept unchanged.
     let sideProbe=null;
     try{
      const scene=sceneForSystem(side.systemID);
      if(scene&&typeof scene.getEntityByID==="function")
       sideProbe=entityID=>Boolean(scene.getEntityByID(Number(entityID)));
     }catch{sideProbe=null}
     const reallyThere=list=>list.filter(onSide)
      .filter(s=>sideProbe?sideProbe(s.entityID):true).length;
     let existingSide=reallyThere(Object.values(assigned.ships));
     existingSide+=reallyThere(mobilized);
     // A side may only field as many ships as its commander's rank allows
     // (recruit 1 ... admiral 25), and never more than the global hard cap.
     let sideLimit=maxPerSide;
     if(typeof commandCap==="function"){
      const commanded=[...Object.values(assigned.ships),...mobilized]
       .filter(onSide).map(s=>s.pilotID);
      let cap=0;
      try{
       cap=Number(commandCap({campaignID:c.campaignID,factionID:side.factionID,
        systemID:side.systemID,assignedPilotIDs:commanded}));
      }catch{cap=0}
      if(!Number.isSafeInteger(cap)||cap<1)cap=1;
      sideLimit=Math.max(1,Math.min(maxPerSide,cap));
     }
     return {side,sideLimit,existingSide};
    });
    const deficit=entries.reduce((sum,e)=>sum+Math.max(0,e.sideLimit-e.existingSide),0);
    plans.push({campaign:c,war:w,entries,deficit});
   }
   // Fair scheduling: a campaign that still has empty slots is served before one
   // whose sides are already full, so the per-tick write budget can never starve
   // a second live campaign forever. Ties keep the deterministic old order.
   plans.sort((a,b)=>b.deficit-a.deficit||
    (a.campaign.startedAt||0)-(b.campaign.startedAt||0)||
    a.campaign.campaignID.localeCompare(b.campaign.campaignID));
   const rejected=[];
   const report=[];
   for(const plan of plans){
    const c=plan.campaign;
    const campaignReport={campaignID:c.campaignID,warID:c.warID,state:c.state,
     sourceSystemID:c.sourceSystemID,targetSystemID:c.targetSystemID,sides:[]};
    report.push(campaignReport);
    for(const entry of plan.entries){
     const side=entry.side;
     const sideReport={role:side.role,factionID:side.factionID,
      systemID:side.systemID,limit:entry.sideLimit,assigned:entry.existingSide,
      mobilizable:[],rejected:[],status:""};
     campaignReport.sides.push(sideReport);
     const note=(entityID,pilotID,reason)=>{
      if(sideReport.rejected.length>=SIDE_REJECT_LIMIT)return;
      sideReport.rejected.push({entityID,pilotID,reason});
      if(rejected.length<DRY_RUN_REPORT_LIMIT)
       rejected.push({entityID,pilotID,side:side.role,reason});
     };
     if(!reachable.has(side.systemID)){sideReport.status="SYSTEM_NOT_TRACKED";continue}
     let scene;
     try{scene=sceneForSystem(side.systemID)}catch{scene=null}
     if(scene?.systemID!==side.systemID||
      typeof scene.getEntityByID!=="function"){sideReport.status="NO_NATIVE_SCENE";continue}
     // A dry run reports the full truth per side; a real tick spends at most
     // maxPerTick assignments for the whole world.
     let filled=entry.existingSide;
     const playerIDs=new Set([...(scene.sessions?.values?.()||[])]
      .map(x=>Number(x?._space?.shipID)).filter(pos));
     for(const link of candidateLinks){
      if(filled>=entry.sideLimit)break;
      if(dryRun?mobilized.length>=DRY_RUN_REPORT_LIMIT:mobilized.length>=maxPerTick)break;
      const id=link?.entityID;
      const cheap=!pos(id)?"INVALID_ENTITY":!named(link.pilotID)?"INVALID_PILOT":
       !MOBILIZABLE_ROLES.has(String(link.role||""))?"NOT_PATROL_ROLE":
       physicalCandidateSystem(link,getNativeEntity)!==side.systemID?"WRONG_SYSTEM":
       existing.has(id)?"ALREADY_ASSIGNED":usedPilots.has(link.pilotID)?"PILOT_IN_USE":
       playerIDs.has(id)?"PLAYER_SHIP":isTactical(id)?"TACTICAL_BUSY":"";
      if(cheap){
       // WRONG_SYSTEM is per-side noise, not a blocker: report only candidates
       // that are really in this side's system.
       if(cheap!=="WRONG_SYSTEM")note(id,String(link?.pilotID||""),cheap);
       continue;
      }
      // Uniqueness already proven using the bounded registry index above.
      if(leases.some(x=>x.entityID===id&&x.systemID===side.systemID&&
       (["ISSUING","OUTCOME_UNKNOWN"].includes(x.phase)||
        (x.phase==="ACTIVE"&&Number(x.expiresAt)>now)))){
       note(id,link.pilotID,"ORDER_LEASE_ACTIVE");
       continue;
      }
      let ship,native,ctrl,ready,faction;
      try{
       ship=scene.getEntityByID(id);native=getNativeEntity(id);
       ctrl=getController(id);
       faction=getFactionForCorporation(native?.corporationID);
       ready=inspectReadiness({entityID:id,ship,
        systemID:side.systemID,corporationID:native?.corporationID});
      }catch{
       note(id,link.pilotID,"NATIVE_LOOKUP_THREW");
       continue;
      }
      let fail="";
      if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true||
       ship.itemID!==id||ship.session?.characterID||warp(ship))fail="SHIP_NOT_IDLE_NATIVE";
      else if(!native||native.entityID!==id||native.systemID!==side.systemID||
       !pos(native.corporationID)||ship.corporationID!==native.corporationID)fail="NATIVE_RECORD_DRIFT";
      else if(faction!==side.factionID)fail="WRONG_FACTION";
      else if(ctrl?.entityID!==id||ctrl.systemID!==side.systemID)fail="NO_CONTROLLER";
      else if(ctrl.currentTargetID||ctrl.manualOrder)fail="CONTROLLER_BUSY";
      else if(ready?.ready!==true)fail="NOT_READY:"+String((ready&&ready.reason)||"UNKNOWN");
      if(fail){
       note(id,link.pilotID,fail);
       continue;
      }
      if(dryRun){
       // Read-only: report what a real tick would mobilize, never write.
       mobilized.push({status:"DRY_RUN_MOBILIZABLE",entityID:id,
        pilotID:link.pilotID,systemID:side.systemID,
        factionID:side.factionID,campaignID:c.campaignID,role:side.role});
       sideReport.mobilizable.push(id);
       filled+=1;
       continue;
      }
      const command={
       type:"ASSIGN",
       eventID:"wm:"+c.campaignID+":"+id+":"+
        (assignmentCounts.get(String(c.campaignID)+":"+id)||0),
       entityID:id,systemID:side.systemID,pilotID:link.pilotID,
       corporationID:native.corporationID,factionID:side.factionID,
       fleetID:"fw-"+c.campaignID+"-"+side.factionID,
       warID:c.warID,campaignID:c.campaignID,
       proofID:"native-muster:"+id
      };
      let result;
      try{result=registry.execute(command)}catch{
       // The SQLite commit may be ambiguous. Never issue another mutation
       // in this tick after an exception from the authoritative writer.
       return {status:"NATIVE_COMMIT_UNCERTAIN",mobilized,rejected,
        blocked,campaigns:report,released};
      }
      if(result?.status!=="APPLIED"){
       // A refused ASSIGN must never be a silent boolean: the native registry's
       // own reason is published so the operator sees why a side stays empty.
       const reason=String(result?.reason||result?.status||"BLOCKED");
       blocked.push({entityID:id,pilotID:link.pilotID,campaignID:c.campaignID,
        role:side.role,reason});
       note(id,link.pilotID,"REGISTRY_"+reason);
       continue;
      }
      existing.add(id);usedPilots.add(link.pilotID);filled+=1;
      mobilized.push({status:"NATIVE_PATROL_MOBILIZED",
       entityID:id,pilotID:link.pilotID,systemID:side.systemID,
       factionID:side.factionID,campaignID:c.campaignID,
       fleetID:command.fleetID,role:side.role});
      sideReport.mobilizable.push(id);
     }
     sideReport.assigned=filled;
     sideReport.status=filled>=entry.sideLimit?"SIDE_MUSTERED":
      sideReport.mobilizable.length?"MOBILIZABLE":
      sideReport.rejected.length?"NO_ELIGIBLE_PATROL":"NO_PATROL_CANDIDATE";
    }
   }
   return {status:dryRun?"DRY_RUN":"OBSERVED",mobilized,rejected,blocked,
    campaigns:report,activeCampaignCount:campaigns.length,released};
  }finally{busy=false}
 }
 return Object.freeze({tick});
}
module.exports={createWarMobilizer,enabled,physicalCandidateSystem,MOBILIZABLE_ROLES,
 staleCustodyRows};
