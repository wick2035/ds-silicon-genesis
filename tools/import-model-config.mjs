#!/usr/bin/env node
// Selectively copy only model providers referenced by the pet/default selection.
// Never print source data or credentials. Existing target is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJsonc } from '../vendor/dsh-pet/src/host/config/jsonc.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const yaml = require('yaml');
const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || !path.isAbsolute(args[index + 1])) throw Error(`缺少绝对路径参数 ${name}`);
  return args[index + 1];
}
const profileFile = argument('--profile');
const credentialsFile = argument('--credentials');
const petHome = argument('--pet-home');
const outputFile = argument('--output');
function readYaml(file) {
  try { return yaml.parse(fs.readFileSync(file, 'utf8'), {logLevel:'silent'}); }
  catch { throw Error('模型来源文件无法读取或解析'); }
}
const profile = readYaml(profileFile);
const credentials = readYaml(credentialsFile);
const nodes = [];
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const child of value) walk(child, visit); return; }
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}
walk(profile, node => { if (node.config && typeof node.config === 'object') nodes.push(node); });
const findNode = fragment => {
  const matches = nodes.filter(node => [node.name,node.id].some(value => typeof value === 'string' && value.includes(fragment)));
  if (matches.length !== 1) throw Error('原模型配置缺失或不唯一');
  return matches[0].config;
};
const selection = value => value && typeof value.provider === 'string' && value.provider && typeof value.model === 'string' && value.model
  ? {provider:value.provider,model:value.model} : null;
const defaultSelection = selection(findNode('agent-default-model'));
const providerConfig = findNode('llm-pi-ai').providers;
if (!defaultSelection || !providerConfig || !credentials?.refs || typeof credentials.refs !== 'object') throw Error('原模型配置不完整');
const selections = [defaultSelection];
const files = [path.join(petHome,'main-config.jsonc')];
const petDirectory = path.join(petHome,'pet');
if (fs.existsSync(petDirectory)) for (const entry of fs.readdirSync(petDirectory,{withFileTypes:true}))
  if (entry.isFile() && /-config\.(json|jsonc)$/i.test(entry.name)) files.push(path.join(petDirectory,entry.name));
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const parsed = readJsonc(file);
  if (!parsed) throw Error('宠物模型配置无法解析');
  walk(parsed, node => { for (const key of ['chatModel','whisperModel']) { const selected=selection(node[key]); if (selected) selections.push(selected); } });
}
const providers = Object.create(null);
for (const {provider,model} of selections) {
  const item = providerConfig[provider];
  if (!item || !['openai-completions','anthropic-messages'].includes(item.api) || typeof item.baseURL !== 'string' || typeof item.apiKeyEnv !== 'string')
    throw Error('所选模型服务商不支持安全导入');
  let url;
  try { url = new URL(item.baseURL); } catch { throw Error('模型服务地址无效'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('模型服务地址无效');
  const apiKey = credentials.refs[item.apiKeyEnv];
  if (typeof apiKey !== 'string' || !apiKey || /\s/.test(apiKey)) throw Error('所选模型缺少凭据');
  if (!providers[provider]) providers[provider] = {api:item.api,baseURL:item.baseURL,apiKey,models:[]};
  if (!providers[provider].models.includes(model)) providers[provider].models.push(model);
}
const directory = fs.lstatSync(path.dirname(outputFile));
if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('目标目录不安全');
const fd = fs.openSync(outputFile,'wx',0o600);
try {
  if (process.platform === 'win32') {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const who = execFileSync(path.join(sys,'System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
    const sid = who.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
    if (!sid) throw Error('无法识别当前用户');
    execFileSync(path.join(sys,'System32','icacls.exe'),[outputFile,'/inheritance:r','/grant:r',`*${sid}:F`,'*S-1-5-18:F'],{stdio:'pipe',windowsHide:true});
  }
  fs.writeFileSync(fd,JSON.stringify({version:1,defaultSelection,providers}),{encoding:'utf8'});
  fs.fsyncSync(fd);
} catch (error) { fs.closeSync(fd); fs.unlinkSync(outputFile); throw error; }
fs.closeSync(fd);
console.log('所选模型配置已保存到私密目录');
