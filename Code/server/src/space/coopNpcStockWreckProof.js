"use strict";
// Narrow stock NPC mining ship kill proof for post-raid salvage navigation.
// Must be called from the authoritative native destruction callback, never
// from raid intent, target lock or a world-tick inference.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function verifyStockKill({scene,victim,wreck,options={},links=[],fleets=[]}={}){
 const systemID=id(scene?.systemID),victimID=id(victim?.itemID),
  wreckID=id(wreck?.wreckID),attacker=options?.attackerEntity,
  attackerID=id(attacker?.itemID);
 if(!systemID||!victimID||!wreckID||Number(wreck.systemID)!==systemID||
  Number(wreck.sourceEntityID)!==victimID||
  Number(wreck.launcherID)!==victimID||
  victim.kind!=="ship"||victim.nativeNpc!==true||
  !Array.isArray(links)||!Array.isArray(fleets))
  return {status:"INVALID_STOCK_KILL_CONTEXT"};
 const physical=scene.getEntityByID?.(wreckID);
 if(physical?.nativeNpcWreck!==true||Number(physical.itemID)!==wreckID||
  Number(physical.launcherID)!==victimID)
  return {status:"NATIVE_WRECK_NOT_PHYSICAL"};
 if(!attackerID)return {status:"UPSTREAM_ATTACKER_NOT_PROVIDED"};
 if(attacker?.nativeNpc!==true||attacker?.kind!=="ship"||
  attackerID===victimID||scene.getEntityByID?.(attackerID)!==attacker)
  return {status:"ATTACKER_NOT_NATIVE"};
 if([...scene.sessions?.values?.()||[]].some(s=>
  Number(s?._space?.shipID)===attackerID||
  Number(s?._space?.shipID)===victimID))
  return {status:"PLAYER_SHIP_EXCLUDED"};
 // FW-048: a war hull's link follows its virtual pilot, and the virtual world
 // keeps moving that pilot between systems while the native hull stays where it
 // was spawned. Measured at 19:59:42Z: a named war ship's link had already moved
 // to 30045343, so this stock path wrongly treated a NAMED victim as unnamed and
 // then refused NOT_UNIQUE_NAMED_PIRATE - a real kill earned nothing. Locality is
 // proven physically by the scene and the wreck, not by the link's position.
 if(links.some(l=>Number(l.entityID)===victimID))
  return {status:"NAMED_VICTIM_USE_STANDARD_PROOF"};
 const attackerLinks=links.filter(l=>named(l?.pilotID)&&
  Number(l.entityID)===attackerID&&l.role==="pirate");
 if(attackerLinks.length!==1){
  // FW-135: a NAMED war hull that killed a stock mining-fleet hull is not an
  // ambiguous pirate. Measured 16:30:10Z and 16:30:44Z: entity 980000087712
  // (one fleet-registry link, role "patrol") killed stock 980000087715 and this
  // path answered NOT_UNIQUE_NAMED_PIRATE, which reads like a broken identity
  // merge and sent three audits after a phantom. The raid path belongs to a
  // pirate-role hull; anything else is a real but unpaid kill, and it says so.
  const namedLinks=links.filter(l=>named(l?.pilotID)&&
   Number(l.entityID)===attackerID);
  if(namedLinks.length===1)
   return {status:"ATTACKER_NOT_A_RAID_PIRATE",attackerEntityID:attackerID,
    systemID,attackerPilotID:String(namedLinks[0].pilotID),
    attackerRoles:namedLinks.map(l=>String(l.role||""))};
  return {status:"NOT_UNIQUE_NAMED_PIRATE"};
 }
 const stock=[];
 for(const fleet of fleets){
  if(Number(fleet?.systemID)!==systemID)continue;
  if((fleet.minerEntityIDs||[]).some(x=>Number(x)===victimID))
   stock.push({id:victimID,role:"miner"});
  if((fleet.haulerEntityIDs||[]).some(x=>Number(x)===victimID))
   stock.push({id:victimID,role:"hauler"});
 }
 if(stock.length!==1)return {status:"STOCK_FLEET_MEMBERSHIP_MISSING"};
 const ext=__filename.endsWith(".cjs")?".cjs":"";
 const {isAuthorizedStockMiningRaid}=require("./coopNativeRaidEligibility"+ext);
 if(!isAuthorizedStockMiningRaid({systemID,attacker,target:victim,
  links,pilots:[],fleetShips:stock}))
  return {status:"NATIVE_STOCK_RAID_NOT_AUTHORIZED"};
 return {status:"NATIVE_DESTRUCTION_ATTACKER_PROVIDED",
  victimEntityID:victimID,wreckID,systemID,
  attackerEntityID:attackerID,attackerPilotID:attackerLinks[0].pilotID,
  victimClass:"UNNAMED_NATIVE_STOCK_MINING_FLEET",
  attribution:"UPSTREAM_DESTRUCTION_OPTIONS_ATTACKER_ENTITY_PLUS_NATIVE_FLEET_MEMBERSHIP"};
}
module.exports={verifyStockKill};
