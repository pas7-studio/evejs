"use strict";
// FW-009B native A-Life orchestration, NO extra timer and NO client commands.
// The stock EveJS structure must be chosen from an explicit type allowlist;
// otherwise no real-world object is retasked or destroyed for a war.
const POS=x=>Number.isSafeInteger(x)&&x>0;
const ID=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,90}$/.test(x);
const enabled=env=>env.EVEJS_COOP_FACTION_WAR==="1"&&
 env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
 env.EVEJS_COOP_FACTION_WAR_NATIVE_OBJECTIVES==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
 env.EVEJS_COOP_ALIFE==="1";
function typesFromEnv(env=process.env){
 const raw=env.EVEJS_COOP_WAR_OBJECTIVE_STRUCTURE_TYPE_IDS;
 if(typeof raw!=="string"||!raw.trim()||
  raw.length>512)return new Set();
 const values=raw.split(",");
 if(values.length>20)return new Set();
 const out=new Set();
 for(const v of values){
  const n=v.trim();
  if(!/^[1-9][0-9]{0,15}$/.test(n)||
   !Number.isSafeInteger(Number(n)))return new Set();
  out.add(Number(n));
 }
 return out;
}
function createWarObjectiveDirector({adjudicator,combatProof,
 readWarState,listNativeStructures,getFactionForCorporation,
 clock=()=>Date.now(),env=process.env,maxOperations=2}={}){
 if(!adjudicator||["snapshot","bind","neutralize","sample","capture"]
  .some(k=>typeof adjudicator[k]!=="function")||
  typeof combatProof?.receiptForStructure!=="function"||
  [readWarState,listNativeStructures,getFactionForCorporation,clock]
   .some(fn=>typeof fn!=="function")||
  !Number.isSafeInteger(maxOperations)||maxOperations<1||maxOperations>3)
  throw Error("WAR_OBJECTIVE_DIRECTOR_NATIVE_DEPENDENCIES_REQUIRED");
 let busy=false;
 function tick({systemIDs=[]}={}){
  if(!enabled(env))return {status:"DISABLED",events:[]};
  const types=typesFromEnv(env);
  if(!types.size)return {status:"NO_APPROVED_OBJECTIVE_TYPES",events:[]};
  if(busy)return {status:"BUSY",events:[]};
  if(!Array.isArray(systemIDs)||systemIDs.length>512||
   systemIDs.some(x=>!POS(x)))
   return {status:"INVALID_SYSTEMS",events:[]};
  busy=true;
  const events=[];
  try{
   const now=clock();
   if(!POS(now))return {status:"CLOCK_INVALID",events};
   let war;
   try{war=readWarState()}catch{return {status:"WAR_STATE_UNAVAILABLE",events}}
   if(war?.version!==1||!war.wars||!war.campaigns||
    !war.territories)return {status:"INVALID_WAR_STATE",events};
   const observed=new Set(systemIDs);
   const campaigns=Object.values(war.campaigns)
    .filter(c=>ID(c?.campaignID)&&ID(c.warID)&&
     c.state==="ASSAULT"&&POS(c.targetSystemID)&&
     observed.has(c.targetSystemID)&&
     war.wars[c.warID]?.state==="ACTIVE")
    .sort((a,b)=>a.campaignID.localeCompare(b.campaignID)).slice(0,16);
   for(const c of campaigns){
    if(events.length>=maxOperations)break;
    let s;
    try{s=adjudicator.snapshot({campaignID:c.campaignID})}
    catch{return {status:"NATIVE_OBJECTIVE_SNAPSHOT_UNAVAILABLE",events}}
    if(s?.status!=="OBSERVED")continue;
    if(!s.objective){
     let structures;
     try{structures=listNativeStructures(c.targetSystemID)}
     catch{continue}
     if(!Array.isArray(structures)||structures.length>300)continue;
     const defenderID=war.wars[c.warID].defenderFactionID;
     const candidates=structures.filter(n=>POS(n?.structureID)&&
      n.solarSystemID===c.targetSystemID&&
      types.has(n.typeID)&&!n.destroyedAt&&
      POS(n.ownerCorpID)&&
      getFactionForCorporation(n.ownerCorpID)===defenderID)
      .sort((a,b)=>a.structureID-b.structureID);
     if(candidates.length!==1)continue; // no arbitrary target choice
     const target=candidates[0];
     const command={campaignID:c.campaignID,
      structureID:target.structureID,
      eventID:"fwb:"+c.campaignID+":"+target.structureID,
      expectedRevision:c.revision};
     let out;
     try{out=adjudicator.bind(command)}
     catch{return {status:"WAR_OBJECTIVE_COMMIT_UNCERTAIN",events}}
     if(out?.status==="APPLIED")
      events.push({kind:"BOUND",campaignID:c.campaignID,
       structureID:target.structureID});
     continue;
    }
    if(s.objective.state==="BOUND"){
     let evidence;
     try{evidence=combatProof.receiptForStructure(s.objective.structureID)}
     catch{return {status:"NATIVE_COMBAT_RECEIPT_UNAVAILABLE",events}}
     if(evidence?.status!=="VERIFIED"||
      evidence.receipt?.structureID!==s.objective.structureID)continue;
     const command={campaignID:c.campaignID,
      structureID:s.objective.structureID,
      eventID:"fwn:"+c.campaignID+":"+evidence.receipt.killID,
      expectedRevision:c.revision,
      combatProofID:evidence.receipt.proofID};
     let out;
     try{out=adjudicator.neutralize(command)}
     catch{return {status:"WAR_OBJECTIVE_COMMIT_UNCERTAIN",events}}
     if(out?.status==="APPLIED")
      events.push({kind:"NEUTRALIZED",campaignID:c.campaignID,
       structureID:s.objective.structureID,
       killID:evidence.receipt.killID});
     continue;
    }
    if(s.objective.state!=="NEUTRALIZED")continue;
    const sample={campaignID:c.campaignID,
     eventID:"fws:"+c.campaignID+":"+now,
     expectedRevision:c.revision};
    let out;
    try{out=adjudicator.sample(sample)}
    catch{return {status:"WAR_OBJECTIVE_COMMIT_UNCERTAIN",events}}
    if(out?.status!=="APPLIED")continue;
    events.push({kind:"OBSERVED",campaignID:c.campaignID,
     consecutiveSamples:out.receipt.consecutiveSamples,
     captureReady:out.receipt.captureReady});
    if(!out.receipt.captureReady||events.length>=maxOperations)continue;
    try{out=adjudicator.capture({campaignID:c.campaignID,
      eventID:"fwcap:"+c.campaignID+":"+s.objective.structureID,
      expectedRevision:c.revision,
      captureProofID:"native-uncontested:"+s.objective.structureID});}
    catch{return {status:"WAR_CAPTURE_COMMIT_UNCERTAIN",events}}
    if(out?.status==="APPLIED")
     events.push({kind:"MILITARY_CONTROL_CAPTURED",campaignID:c.campaignID,
      systemID:c.targetSystemID,revision:out.receipt.revision});
   }
   return {status:"OBSERVED",events};
  }finally{busy=false}
 }
 return Object.freeze({tick});
}
module.exports={typesFromEnv,enabled,createWarObjectiveDirector};
