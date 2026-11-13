#!/usr/bin/env node
// Explicit migration: back up source first, then archive and materialize in one transaction.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {importLegacy} from '../dist/host/legacy-import.js';
import {importConversation} from '../dist/host/legacy-conversation.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {Client}=require('pg');
const args=process.argv.slice(2), options=new Map(), documents=[];
while(args.length){const key=args.shift(), value=args.shift();if(!key?.startsWith('--')||!value)throw Error('迁移参数无效');if(key==='--document')documents.push(value);else {if(options.has(key))throw Error('迁移参数重复');options.set(key,value);}}
const required=key=>{const value=options.get(key);if(!value)throw Error(`缺少参数 ${key}`);return value;};
for(const key of options.keys())if(!['--config','--humanity','--pet','--name','--role','--backup','--attachment-root'].includes(key))throw Error('未知迁移参数');
const configFile=required('--config'),humanityFile=required('--humanity'),backup=required('--backup');
if(![configFile,humanityFile,backup].every(path.isAbsolute))throw Error('配置、身心档案和备份路径必须为绝对路径');
const petId=required('--pet'),name=required('--name'),role=required('--role');
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const humanityText=await fs.readFile(humanityFile,'utf8');
const human=JSON.parse(humanityText.replace(/^\uFEFF/,''));
if(human.version!==1||!human.pets?.[petId])throw Error('没有找到原身心档案');
const docs=[];
for(const spec of documents){const at=spec.indexOf('='),name=spec.slice(0,at),filename=spec.slice(at+1);if(at<1||!/^[a-z0-9_.-]{1,80}$/i.test(name)||!path.isAbsolute(filename)||docs.some(d=>d.name===name))throw Error('文档参数无效');docs.push({name,content:await fs.readFile(filename,'utf8')});}
docs.sort((a,b)=>a.name.localeCompare(b.name));

// Only explicit locators under an operator-supplied root are read; realpath
// blocks traversal and symlinks out of that root. Missing files remain warnings.
const importedAttachments=[], attachmentWarnings=[];
const attachmentRoot=options.get('--attachment-root');
if(attachmentRoot && !path.isAbsolute(attachmentRoot))throw Error('附件根目录必须为绝对路径');
const safeRoot=attachmentRoot?await fs.realpath(attachmentRoot):null;
const memory=docs.find(d=>d.name==='memory.json');
if(memory){let ordinal=0;const value=JSON.parse(memory.content.replace(/^\uFEFF/,''));
 for(const group of Object.values(value||{}))for(const thread of Object.values(group||{}))for(const item of Array.isArray(thread?.messages)?thread.messages:[]){
  const index=ordinal++;const locators=[item?.attachment,item?.attachments,item?.image,item?.images].flat().filter(Boolean);
  for(const raw of locators){const locator=typeof raw==='string'?raw:typeof raw?.path==='string'?raw.path:typeof raw?.locator==='string'?raw.locator:null;
   if(!locator || !safeRoot){attachmentWarnings.push(`聊天记录 ${index} 附件没有可用的受控源路径`);continue;}
   try{const candidate=await fs.realpath(path.resolve(safeRoot,locator)),relative=path.relative(safeRoot,candidate);
    if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw Error('附件路径越界');
    const stat=await fs.stat(candidate);if(!stat.isFile()||stat.size<1||stat.size>5*1024*1024)throw Error('附件大小或类型不支持');
    const b=await fs.readFile(candidate);if(b.length!==stat.size||b.length>5*1024*1024)throw Error('附件读取期间变化');
    const type=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b.subarray(0,6).toString('ascii').match(/^GIF8[79]a$/)?'image/gif':b.subarray(0,4).toString('ascii')==='RIFF'&&b.subarray(8,12).toString('ascii')==='WEBP'?'image/webp':null;
    if(!type)throw Error('附件格式不支持');const id='image:'+createHash('sha256').update(b).digest('hex');importedAttachments.push({index,id,mediaType:type,data:b.toString('base64'),size:b.length});
   }catch{attachmentWarnings.push(`聊天记录 ${index} 附件缺失、越界或格式不支持`);}
  }
 }
}

const client=new Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-genesis-migration'});
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const writer=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
    if(!writer.rows[0]?.acquired)throw Error('新版正在使用存档，拒绝迁移');
    const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext('pet_companion'),hashtext('desktop-pet')) AS acquired");
    if(!lock.rows[0]?.acquired)throw Error('旧版仍持有存档锁；未执行切换');
    const source=await client.query('SELECT revision::text,checksum,payload FROM pet_companion.snapshots WHERE namespace=$1 FOR SHARE',[config.namespace]);
    if(source.rows.length!==1)throw Error('未找到唯一的原存档');
    const row=source.rows[0];
    const records=await client.query('SELECT pet_id,kind,id,body,deleted,sources,payload FROM pet_companion.records WHERE namespace=$1 ORDER BY pet_id,kind,id',[config.namespace]);
    const archive=JSON.stringify({format:'silicon-genesis-source-backup-v1',namespace:config.namespace,revision:row.revision,checksum:row.checksum,snapshot:row.payload,records:records.rows,humanity:humanityText,documents:docs});
    await fs.mkdir(path.dirname(backup),{recursive:true,mode:0o700});
    try {await fs.writeFile(backup,archive,{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;if(await fs.readFile(backup,'utf8')!==archive)throw Error('备份文件已存在且与当前原档不同，拒绝覆盖');}
    await client.query(await fs.readFile(path.join(root,'src/storage/schema.sql'),'utf8'));
    const inserted=await client.query(`INSERT INTO silicon_genesis.legacy_import(source_key,source_revision,source_checksum,snapshot,records)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT(source_key) DO NOTHING RETURNING source_key`,[config.namespace,row.revision,row.checksum,JSON.stringify(row.payload),JSON.stringify(records.rows)]);
    if(inserted.rowCount){for(const doc of docs)await client.query('INSERT INTO silicon_genesis.legacy_document(source_key,name,content) VALUES($1,$2,$3)',[config.namespace,doc.name,doc.content]);}
    else {
      const saved=await client.query('SELECT source_revision::text,source_checksum FROM silicon_genesis.legacy_import WHERE source_key=$1',[config.namespace]);
      if(saved.rows[0]?.source_revision!==row.revision||saved.rows[0]?.source_checksum!==row.checksum)throw Error('原存档已变化，拒绝覆盖原导入');
      const savedDocs=await client.query('SELECT name,content FROM silicon_genesis.legacy_document WHERE source_key=$1 ORDER BY name',[config.namespace]);
      for(const doc of docs){const previous=savedDocs.rows.find(d=>d.name===doc.name);if(previous && previous.content!==doc.content)throw Error('附加文档与已有导入不同');if(!previous)await client.query('INSERT INTO silicon_genesis.legacy_document(source_key,name,content) VALUES($1,$2,$3)',[config.namespace,doc.name,doc.content]);}
    }
    const pet=row.payload?.pets?.[petId];if(!pet)throw Error('没有找到这只宠物的原养成档案');
    const existing=await client.query('SELECT version::text,payload,payload->\'life\'->\'identity\' AS identity FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE',[petId]);
    if(existing.rowCount && (existing.rows[0].identity?.name!==name || existing.rows[0].identity?.role!==role))throw Error('已有生命状态的身份与迁移参数不一致');
    let warnings=[];
    const importedAt=new Date().toISOString();
    const conversation=docs.find(doc=>doc.name==='memory.json');
    if(!existing.rowCount){const result=importLegacy({petId,identity:{name,role},importedAt,pet,humanity:human.pets[petId]});warnings=result.warnings;if(conversation)warnings.push(...importConversation(result.envelope,conversation.content,importedAt,importedAttachments).warnings);await client.query('INSERT INTO silicon_genesis.life_state(pet_id,version,payload) VALUES($1,0,$2::jsonb)',[petId,JSON.stringify(result.envelope)]);}
    else if(conversation){const envelope=existing.rows[0].payload;const result=importConversation(envelope,conversation.content,importedAt,importedAttachments);warnings.push(...result.warnings);if(result.count){const version=Number(existing.rows[0].version)+1;if(!Number.isSafeInteger(version))throw Error('状态版本无效');envelope.version=version;await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[petId,version,JSON.stringify(envelope)]);}}
    warnings.push(...attachmentWarnings);
    if(warnings.length) console.warn(`迁移提示：${warnings.join('；')}`);
    await client.query('COMMIT');
    console.log(existing.rowCount?'相同原档已迁移，已有生命状态未被覆盖':`已备份原档并完成独立状态迁移；${warnings.length} 项旧内容需核对`);
  }catch(error){await client.query('ROLLBACK');throw error;}
}finally{await client.end();}
