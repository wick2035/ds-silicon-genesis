// Restore the owner's preferred self-name without replacing the rest of the persona.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJsonc} from '../vendor/dsh-pet/src/host/config/jsonc.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldRule = '自然用“我”说自己的事。';
const rule = '你喜欢自称“本鱼”，尤其在得意、嘴硬、撒娇或替自己争辩时，会顺嘴这样说；平常也会自然用“我”，按当下心情和语境选择，不必每句都重复自称。';
function restore(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw Error('角色提示词不可用');
  if (prompt.includes(rule)) return prompt;
  if (prompt.split(oldRule).length !== 2) throw Error('原自称规则已变化，停止覆盖');
  return prompt.replace(oldRule, rule);
}

const configPath = path.join(root, 'data/dsh/dsh-pet/main-config.jsonc');
const config = readJsonc(configPath);
const pet = Array.isArray(config?.pets) ? config.pets.find(p => p.id === 'main') : config?.pets?.main;
if (!pet) throw Error('main 角色配置不存在');
const edits = [];
for (const name of ['persona.md', 'vendor/pet-plugins/persona.md']) {
  const target = path.join(root, name);
  const before = await fs.readFile(target, 'utf8');
  edits.push({target, before, after: restore(before)});
}
const before = await fs.readFile(configPath, 'utf8');
const prompt = restore(pet.whisperPrompt);
const encoded = JSON.stringify(pet.whisperPrompt);
if (before.split(encoded).length !== 2) throw Error('提示词编码不唯一，停止覆盖');
edits.push({target: configPath, before, after: before.replace(encoded, JSON.stringify(prompt))});
const changed = edits.filter(edit => edit.before !== edit.after);
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({restored: changed.length === 0, pending: changed.map(edit => path.relative(root, edit.target))}));
  if (changed.length) process.exitCode = 1;
} else if (changed.length) {
  const backup = path.join(root, 'data/backups', `self-name-before-${Date.now()}`);
  for (const edit of changed) {
    const copy = path.join(backup, path.relative(root, edit.target));
    await fs.mkdir(path.dirname(copy), {recursive: true});
    await fs.writeFile(copy, edit.before, {flag: 'wx', mode: 0o600});
  }
  for (const edit of changed) await fs.writeFile(edit.target, edit.after);
  console.log(JSON.stringify({restored: true, changed: changed.length, backup, takesEffect: 'next-start'}));
} else {
  console.log(JSON.stringify({restored: true, changed: 0}));
}
