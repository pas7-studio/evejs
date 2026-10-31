"use strict";
// FW-003B: one tiny battle pass on the existing A-Life 30s tick.
// No spawn, jump, scripted hit, loot, kill credit, sovereignty or payout.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const vec=x=>x&&["x","y","z"].every(k=>typeof x[k]==="number"&&Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const warp=x=>String(x?.mode||"").toUpperCase().includes("WARP")||
 !!(x?.pendingWarp||x?.warpState||x?.isWarping);
const {combatEnabled,ammoEnabled}=require("./coopWarCombatAuthority"+
 (__filename.endsWith(".js")?"":".cjs"));
function createWarBattleDirector({authority,bridge,sceneForSystem,
 issueNativeAttack,getController,isAmmoDepleted=()=>false,isTactical=()=>false,
 clock=()=>Date.now(),env=process.env,maxOrders=2,cooldownMs=120000,
 playerOpponents=null,roleOfEntity=null}={}){
 if(!authority?.snapshots||!authority?.evaluatePair||!bridge?.issue||
  [sceneForSystem,issueNativeAttack,getController,isAmmoDepleted,isTactical,clock].some(x=>typeof x!=="function")||
  !Number.isSafeInteger(maxOrders)||maxOrders<1||maxOrders>3||
  !Number.isSafeInteger(cooldownMs)||cooldownMs<30000)
  throw Error("FW_NATIVE_BATTLE_AUTHORITIES_REQUIRED");
 const nextAt=new Map();
 // FW-024: an enlisted player is a legal target for the OPPOSING war ship and
 // for nobody else. The verdict comes from coopMilitiaWarPlayer, which requires
 // an ACTIVE enlistment plus an ACTIVE war whose campaign is in ASSAULT in this
 // system; without one this list is empty and stock behaviour is unchanged.
 // FW-117: the role a hull flies, asked of the doctrine table by the caller. Absent or
 // unreadable is an empty role, never a guess.
 function roleOf(entityID){
  if(typeof roleOfEntity!=="function")return "";
  try{return String(roleOfEntity(Number(entityID))||"")}catch{return ""}
 }
 function militiaTargets({systemID,shipRow,scene}){
  try{
   if(typeof playerOpponents==="function")
    return playerOpponents({systemID,shipRow,scene})||[];
   return require("./coopMilitiaWarPlayer"+
    (__filename.endsWith(".js")?"":".cjs")).native()
    .enemyPlayersForShip({scene,shipRow})||[];
  }catch{return []}
 }
 function tick({systemIDs=[]}={}){
  if(!combatEnabled(env)||!ammoEnabled(env))
   return {status:"DISABLED_OR_UNSAFE_AMMO",orders:[]};
  if(!Array.isArray(systemIDs)||systemIDs.length>512)
   return {status:"INVALID_SYSTEMS",orders:[]};
  const at=clock(),orders=[],selections=[];
  if(!pos(at))return {status:"INVALID_CLOCK",orders};
  let snapshots;
  try{snapshots=authority.snapshots()}catch{}
  if(!snapshots)return {status:"WAR_STATE_UNAVAILABLE",orders};
  const grouped=Object.values(snapshots.fleetState.ships||{})
   .filter(x=>pos(x?.entityID)&&pos(x.systemID)&&pos(x.factionID))
   .sort((a,b)=>a.entityID-b.entityID);
  const eligibleSystems=[...new Set(systemIDs)].filter(pos).sort((a,b)=>a-b);
  for(const systemID of eligibleSystems){
   if(orders.length>=maxOrders)break;
   const scene=sceneForSystem(systemID);
   if(scene?.systemID!==systemID||typeof scene.getEntityByID!=="function")continue;
   const fleet=grouped.filter(x=>x.systemID===systemID).slice(0,80);
   const players=new Set([...(scene.sessions?.values?.()||[])]
    .map(s=>Number(s?._space?.shipID)).filter(pos));
    for(const shipRow of fleet){
     if(orders.length>=maxOrders)break;
     const id=shipRow.entityID,attacker=scene.getEntityByID(id),
       key=String(id),controller=getController(id);
     if(players.has(id)||!attacker||!vec(attacker.position)||warp(attacker)||
       controller?.entityID!==id||controller.systemID!==systemID||
       Number(controller.currentTargetID)>0||
       (controller.manualOrder&&controller.manualOrder.type!=="resumeBehavior")||
       nextAt.get(key)>at||isAmmoDepleted(systemID,id)||isTactical(id))
       continue;
     // ONE candidate list: a hostile native hull and an enlisted enemy player are
     // the same kind of candidate. The only player-specific fact is the proof that
     // makes him hostile at all (an ACTIVE enlistment in the opposing faction), and
     // that proof is re-read immediately before the native order is issued.
     const candidates=[];
     for(const row of fleet){
      if(row.entityID===id||row.factionID===shipRow.factionID||
        row.campaignID!==shipRow.campaignID||row.warID!==shipRow.warID)continue;
      if(players.has(row.entityID))continue;
      const entity=scene.getEntityByID(row.entityID);
      if(!entity||entity.nativeNpc!==true||!vec(entity.position)||warp(entity))continue;
      const distance=dist(attacker.position,entity.position);
      if(distance>250000)continue;
      candidates.push({kind:"WAR_SHIP",entityID:row.entityID,entity,distance,row,
    targetRole:roleOf(row.entityID)});
     }
     for(const target of militiaTargets({systemID,shipRow,scene})){
      if(!pos(target.entityID)||target.entityID===id||!target.entity||
        !vec(target.entity.position)||warp(target.entity))continue;
      const distance=dist(attacker.position,target.entity.position);
      if(distance>250000)continue;
      candidates.push({kind:"MILITIA_PLAYER",entityID:target.entityID,
        entity:target.entity,characterID:Number(target.characterID)||0,distance});
     }
     // FW-117: role first, then the old nearest-first rule. A fleet whose hulls carry no
     // role scores 0 everywhere and is ordered exactly as before.
     const attackerRole=roleOf(id);
     const ordered=require("./coopWarTargetPriority"+
      (__filename.endsWith(".js")?"":".cjs"))
      .orderCandidates({candidates,attackerRole});
     candidates.length=0;
     for(const row of ordered)candidates.push(row);
     const selection=candidates.length?{shipID:id,systemID,
       factionID:shipRow.factionID,warID:shipRow.warID,campaignID:shipRow.campaignID,
       attackerRole,
       candidates:candidates.slice(0,8).map(c=>({entityID:c.entityID,kind:c.kind,
         distanceMeters:Math.round(c.distance),targetRole:String(c.targetRole||""),
         chosen:false,reason:""})),
       ordered:0}:null;
     if(selection)selections.push(selection);
     for(const candidate of candidates){
      if(orders.length>=maxOrders)break;
      const slot=selection.candidates.find(x=>x.entityID===candidate.entityID);
      if(candidate.kind==="WAR_SHIP"){
       // Use the native authority twice: preselect and again immediately
       // before issuing the synchronous native command.
       const authorized=authority.evaluatePair(attacker,candidate.entity,
        {requireAttackIntent:false,proof:snapshots});
       if(authorized.status!=="AUTHORIZED"){
        if(slot)slot.reason="AUTHORITY_"+String(authorized.status||"REFUSED");
        continue;
       }
       const targetID=candidate.entityID,targetController=getController(targetID);
       // A war fleet does not steal a ship already engaged by a player,
       // raid, rescue or another active manual native order.
       if(targetController?.entityID!==targetID||
          targetController.systemID!==systemID||
          (Number(targetController.currentTargetID)>0&&
           Number(targetController.currentTargetID)!==id)||
          (targetController.manualOrder&&
           targetController.manualOrder.type!=="resumeBehavior"&&
           !(targetController.manualOrder.type==="attack"&&
             Number(targetController.manualOrder.targetID)===id))){
        if(slot)slot.reason="TARGET_BUSY";
        continue;
       }
      }else{
       // A player candidate is legal only while the enlistment proof still holds.
       const fresh=militiaTargets({systemID,shipRow,scene})
        .find(x=>x.entityID===candidate.entityID);
       if(!fresh){
        if(slot)slot.reason="WAR_MILITIA_PROOF_CHANGED";
        continue;
       }
      }
      const targetID=candidate.entityID;
      let answer;
      try{
       answer=bridge.issue({entityID:id,systemID,owner:"WAR",action:"attack",
        holdMs:120000,execute:()=>{
         if(!combatEnabled(env)||!ammoEnabled(env)||
           isAmmoDepleted(systemID,id)||isTactical(id)||
           warp(attacker)||warp(candidate.entity)||
           Number(getController(id)?.currentTargetID)>0||
           (candidate.kind==="WAR_SHIP"&&
            Number(getController(targetID)?.currentTargetID)>0&&
            Number(getController(targetID)?.currentTargetID)!==id))
           return {success:false,errorMsg:"WAR_NATIVE_UNSAFE_RECHECK"};
         if(candidate.kind==="WAR_SHIP"){
          const fresh=authority.evaluatePair(attacker,candidate.entity,
           {requireAttackIntent:false});
          if(fresh.status!=="AUTHORIZED")return {success:false,errorMsg:"WAR_NATIVE_PROOF_CHANGED"};
         }else if(!militiaTargets({systemID,shipRow,scene})
          .some(x=>x.entityID===targetID))
          return {success:false,errorMsg:"WAR_MILITIA_PROOF_CHANGED"};
         return issueNativeAttack(id,targetID,{allowWeapons:true,
          keepLock:true,allowPodKill:false});
        }});
      }catch{answer={success:false,errorMsg:"WAR_ORDER_OUTCOME_UNCERTAIN"}}
      // An accepted attack order does NOT prove fired ammo, hits or death.
      if(answer?.success===true){
       if(slot){slot.chosen=true;slot.reason="ORDER_ACCEPTED";}
       if(selection)selection.ordered=1;
       orders.push(candidate.kind==="MILITIA_PLAYER"?
        {status:"NATIVE_ATTACK_ORDER_ACCEPTED",systemID,attackerID:id,
         targetID,targetKind:"MILITIA_PLAYER",characterID:candidate.characterID,
         warID:shipRow.warID,campaignID:shipRow.campaignID,
         evidence:"ACTIVE_ENLISTMENT_IN_THE_OPPOSING_FACTION"}:
        {status:"NATIVE_ATTACK_ORDER_ACCEPTED",systemID,attackerID:id,
         targetID,warID:shipRow.warID,campaignID:shipRow.campaignID});
       nextAt.set(key,at+cooldownMs);
      }else if(answer?.errorMsg==="WAR_ORDER_OUTCOME_UNCERTAIN"||
       answer?.errorMsg==="COOP_NPC_ORDER_REPAIR_REQUIRED"){
       if(slot)slot.reason=String(answer.errorMsg);
       // If the bridge itself escaped with an ambiguous outcome, keep the
       // local hull quarantined rather than retrying after a cooldown.
       nextAt.set(key,Number.POSITIVE_INFINITY);
      }else if(slot)slot.reason=String(answer?.errorMsg||"ORDER_REFUSED");
      // Exactly one native command per hull per tick: a real native order was
      // issued, so no target-hopping after it (success or failure).
      break;
     }
    }
   }
  if(nextAt.size>1024)for(const [key,time] of nextAt)if(time<=at)nextAt.delete(key);
  return {status:"OBSERVED",orders,selections};
 }
 return Object.freeze({tick});
}
module.exports={createWarBattleDirector};
