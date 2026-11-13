#!/usr/bin/env node
// Explicit one-time canonical provisioning. It does not start the application.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { importLegacy } from '../dist/host/legacy-import.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {Client}=require('pg');
const args=process.argv.slice(2);
function option(name) {const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(`缺少参数 ${name}`);return args[i+1];}
const configFile=option('--config'), humanityFile=option('--humanity'), petId=option('--pet'), name=option('--name'), role=option('--role');
if(!path.isAbsolute(configFile)||!path.isAbsolute(humanityFile))throw Error('配置和身心存档需要绝对路径');
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const human=JSON.parse((await fs.readFile(humanityFile,'utf8')).replace(/^\uFEFF/,''));
if(human.version!==1||!human.pets||!human.pets[petId])throw Error('没有找到这只宠物的原身心档案');
const client=new Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-genesis-materialize'});
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext('pet_companion'),hashtext('desktop-pet')) AS acquired");
    if(!lock.rows[0]?.acquired)throw Error('旧版仍持有存档锁；未执行切换');
    const source=await client.query(`SELECT s.revision::text,s.checksum,s.payload,i.source_revision::text,i.source_checksum
      FROM pet_companion.snapshots s JOIN silicon_genesis.legacy_import i ON i.source_key=s.namespace
      WHERE s.namespace='desktop-pet' FOR SHARE OF s`);
    if(source.rows.length!==1||source.rows[0].revision!==source.rows[0].source_revision||source.rows[0].checksum!==source.rows[0].source_checksum)
      throw Error('原存档和导入快照不一致；未执行切换');
    const pet=source.rows[0].payload?.pets?.[petId];
    if(!pet)throw Error('没有找到这只宠物的原养成档案');
    const {envelope,warnings}=importLegacy({petId,identity:{name,role},importedAt:new Date().toISOString(),pet,humanity:human.pets[petId]});
    const inserted=await client.query(`INSERT INTO silicon_genesis.life_state(pet_id,version,payload)
      VALUES($1,0,$2::jsonb) ON CONFLICT(pet_id) DO NOTHING RETURNING pet_id`,[petId,JSON.stringify(envelope)]);
    if(!inserted.rowCount)throw Error('新版宠物状态已存在；拒绝覆盖或重复迁移');
    await client.query('COMMIT');
    console.log(`已创建独立生命状态；${warnings.length} 项原档内容需人工核对，完整原始数据已保留。`);
  } catch(error) {await client.query('ROLLBACK');throw error;}
} finally {await client.end();}
