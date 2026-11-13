#!/usr/bin/env node
// Migration is explicit and one-way: the running legacy schema is never modified.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const args = process.argv.slice(2);
const command = args.shift();
const configIndex = args.indexOf('--config');
if (configIndex < 0 || !args[configIndex + 1]) throw Error('请使用 --config 指定本地 PostgreSQL 配置文件');
const configFile = path.resolve(args[configIndex + 1]);
args.splice(configIndex, 2);
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
if (!config.connection || config.namespace !== 'desktop-pet') throw Error('数据库配置或原命名空间无效');
const client = new Client({ ...config.connection, connectionTimeoutMillis: 5000, statement_timeout: 30000, application_name: 'silicon-genesis-migration' });
await client.connect();
try {
  if (command === 'schema') {
    if (args.length) throw Error('未知参数');
    await client.query(await fs.readFile(path.join(root, 'src/storage/schema.sql'), 'utf8'));
    console.log('独立 schema 已就绪');
  } else if (command === 'import') {
    throw Error('请使用 tools/migrate.mjs 完整备份并导入；不支持单独导入原档');
  } else if (command === 'export') {
    const index = args.indexOf('--output');
    if (index !== 0 || args.length !== 2 || !path.isAbsolute(args[1])) throw Error('请用 --output 指定新的绝对文件路径');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const legacy = await client.query('SELECT * FROM silicon_genesis.legacy_import ORDER BY source_key');
      const documents = await client.query('SELECT * FROM silicon_genesis.legacy_document ORDER BY source_key,name');
      const states = await client.query('SELECT * FROM silicon_genesis.life_state ORDER BY pet_id');
      const outbox = await client.query('SELECT * FROM silicon_genesis.outbox ORDER BY action_id');
      const wakes = await client.query('SELECT * FROM silicon_genesis.wake_state ORDER BY pet_id');
      const data = JSON.stringify({format:'silicon-genesis-export-v1', legacy:legacy.rows, documents:documents.rows, states:states.rows, outbox:outbox.rows, wakes:wakes.rows});
      await fs.writeFile(args[1], data, { flag:'wx', mode:0o600 });
      await client.query('COMMIT');
      console.log('独立 schema 导出完成');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } else if (command === 'restore') {
    if (args.length !== 2 || args[0] !== '--input' || !path.isAbsolute(args[1])) throw Error('请用 --input 指定备份文件绝对路径');
    const archive = JSON.parse(await fs.readFile(args[1], 'utf8'));
    if (archive?.format !== 'silicon-genesis-export-v1' || !Array.isArray(archive.legacy) || !Array.isArray(archive.documents) || !Array.isArray(archive.states) || !Array.isArray(archive.outbox) || !Array.isArray(archive.wakes))
      throw Error('备份格式无效');
    await client.query('BEGIN');
    try {
      const writer=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
      if(!writer.rows[0]?.acquired)throw Error('新版正在使用存档，拒绝恢复');
      // Restoration is only permitted into an entirely empty target, so an old
      // export cannot silently roll back completed actions or newer tombstones.
      await client.query('LOCK TABLE silicon_genesis.legacy_import, silicon_genesis.legacy_document, silicon_genesis.life_state, silicon_genesis.outbox, silicon_genesis.wake_state IN ACCESS EXCLUSIVE MODE');
      const count = await client.query(`SELECT (SELECT count(*) FROM silicon_genesis.legacy_import) +
        (SELECT count(*) FROM silicon_genesis.legacy_document) + (SELECT count(*) FROM silicon_genesis.life_state) + (SELECT count(*) FROM silicon_genesis.outbox) + (SELECT count(*) FROM silicon_genesis.wake_state) AS count`);
      if (Number(count.rows[0].count) !== 0) throw Error('目标已有数据；拒绝用备份覆盖');
      for (const row of archive.legacy) await client.query(`INSERT INTO silicon_genesis.legacy_import
        (source_key,source_revision,source_checksum,snapshot,records,imported_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [row.source_key,row.source_revision,row.source_checksum,JSON.stringify(row.snapshot),JSON.stringify(row.records),row.imported_at]);
      for (const row of archive.documents) await client.query('INSERT INTO silicon_genesis.legacy_document(source_key,name,content) VALUES($1,$2,$3)', [row.source_key,row.name,row.content]);
      for (const row of archive.states) await client.query('INSERT INTO silicon_genesis.life_state(pet_id,version,payload,updated_at) VALUES($1,$2,$3::jsonb,$4)', [row.pet_id,row.version,JSON.stringify(row.payload),row.updated_at]);
      for (const row of archive.outbox) await client.query(`INSERT INTO silicon_genesis.outbox(action_id,pet_id,action_type,payload,state,receipt,created_at,updated_at)
        VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)`, [row.action_id,row.pet_id,row.action_type,JSON.stringify(row.payload),
        row.state,JSON.stringify(row.receipt),row.created_at,row.updated_at]);
      for (const row of archive.wakes) await client.query(`INSERT INTO silicon_genesis.wake_state(pet_id,processed_count,next_wake_at)
        VALUES($1,$2,$3)`,[row.pet_id,row.processed_count,row.next_wake_at]);
      await client.query('COMMIT');
      console.log('已恢复到空的独立 schema');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } else throw Error('命令应为 schema、import、export 或 restore');
} finally { await client.end(); }
