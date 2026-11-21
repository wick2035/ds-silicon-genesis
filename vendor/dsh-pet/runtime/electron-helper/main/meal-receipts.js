'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

// Only the authenticated desktop main process writes this private journal.
// Entries survive a lost host response; animations are never replayed to retry delivery.
function createMealReceiptJournal(directory) {
  const file=(petId,actionId)=>path.join(directory,createHash('sha256').update(JSON.stringify([petId,actionId])).digest('hex')+'.json');
  const read=(petId,actionId)=>{try{return JSON.parse(fs.readFileSync(file(petId,actionId),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  return {read,save(petId,receipt,processEpoch){
    if(!directory||!petId||typeof receipt.id!=='string'||!receipt.id||receipt.actionId!==receipt.id||typeof receipt.itemId!=='string'||!receipt.itemId||receipt.index!==0||receipt.surface!=='desktop'||!['completed','interrupted'].includes(receipt.status)||receipt.status==='completed'&&receipt.played!==true||!/^[a-f0-9]{32}$/.test(processEpoch))throw Error('进食终态回执无效');
    const old=read(petId,receipt.actionId);
    const entry={version:1,petId,processEpoch,occurredAt:new Date().toISOString(),receipt:{id:receipt.id,actionId:receipt.actionId,itemId:receipt.itemId,index:0,surface:'desktop',status:receipt.status,played:receipt.played===true}};
    if(old){if(JSON.stringify(old.receipt)!==JSON.stringify(entry.receipt))throw Error('进食终态回执冲突');return old;}
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const target=file(petId,receipt.actionId),temporary=target+'.'+randomUUID()+'.tmp';
    const fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(entry));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,target);return entry;
  }};
}
module.exports={createMealReceiptJournal};
