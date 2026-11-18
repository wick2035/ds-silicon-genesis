import {createHash, randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';

export const FARM_WATER_GAP = 4 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const hongKongDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Hong_Kong', year:'numeric', month:'2-digit', day:'2-digit'});

export const farmWeather = {
  sunny:       {label:'晴天', water:0, loss:0},
  'light-rain':{label:'小雨', water:1, loss:0},
  'heavy-rain':{label:'大雨', water:2, loss:0},
  'light-hail':{label:'轻度冰雹', water:0, loss:1},
  'heavy-hail':{label:'重度冰雹', water:0, loss:2},
  'light-typhoon':{label:'轻度台风', water:0, loss:2},
  'heavy-typhoon':{label:'重度台风', water:0, loss:3},
} as const;

export type FarmWeather = keyof typeof farmWeather;
export type FarmOperation = 'plant'|'water'|'harvest';
export type FarmVisit = {id:string; epoch:string; actionId?:string};
type FarmCrop = {id:string; growth:number; loss:number; waters:number; rain:number; dayLoss:number; lastWaterAt?:number};
type FarmDay = {date:string; weather:FarmWeather; eventId:string};
type Farm = {seed:string; day:FarmDay; crop:FarmCrop|null; rawBowls:number; lastHarvest:number|null};
type FarmStorage = {farm?:Farm; farmVisit?:FarmVisit};
const storage = (draft:CanonicalEnvelope) => draft.legacy as FarmStorage;

export const farmDay = (at:number) => hongKongDate.format(at);
const dayStart = (date:string) => Date.parse(`${date}T00:00:00+08:00`);
export const farmVisit = (draft:CanonicalEnvelope) => storage(draft).farmVisit;
export function setFarmVisit(draft:CanonicalEnvelope, visit?:FarmVisit) {
  if (visit) storage(draft).farmVisit = visit;
  else delete storage(draft).farmVisit;
}

export function randomFarmWeather(seed:string, date:string):FarmWeather {
  const bytes = createHash('sha256').update(seed + ':' + date).digest();
  const chance = bytes.readUInt32BE(0) / 2 ** 32;
  if (chance < .55) return 'sunny';
  if (chance < .80) return 'light-rain';
  if (chance < .92) return 'heavy-rain';
  const heavy = bytes[4] % 2 === 1;
  if (chance < .97) return heavy ? 'heavy-hail' : 'light-hail';
  return heavy ? 'heavy-typhoon' : 'light-typhoon';
}

function record(draft:CanonicalEnvelope, type:'farm.weather'|'farm.tended', description:string, at:number, facts:Record<string,unknown>, eventId:string, remember:boolean) {
  const time = new Date(at).toISOString();
  draft.life.events.push({eventId,petId:draft.petId,type,source:type==='farm.weather'?'environment':'executor',occurredAt:time,receivedAt:time,evidenceLevel:'observed',payload:{...facts,description}});
  if (remember) draft.life.memories.push({id:`farm-memory:${eventId}`,kind:'autobiographical',content:description,sourceIds:[eventId],evidenceLevel:'observed',valid:true,createdAt:time});
}

function setWeather(draft:CanonicalEnvelope, farm:Farm, weather:FarmWeather, at:number) {
  const date = farmDay(at), eventId = `farm-weather:${randomUUID()}`;
  farm.day = {date,weather,eventId};
  const effect = farmWeather[weather], crop = farm.crop;
  const active = crop && crop.growth < 3 ? crop : null;
  const loss = active ? Math.max(0, Math.min(effect.loss,6 - active.loss) - active.dayLoss) : 0;
  const before = active ? Math.min(2, active.waters + active.rain) : 0;
  const water = active ? Math.min(2, active.waters + Math.max(active.rain,effect.water)) - before : 0;
  if (active) {
    active.rain = Math.max(active.rain,effect.water);
    active.dayLoss = Math.max(active.dayLoss,effect.loss);
  }
  const description = `稻田迎来${effect.label}。${water ? `雨水补足了${water}次浇水。` : ''}${loss ? `水稻受损，今天的预计收成减少${loss}碗。` : ''}`;
  record(draft,'farm.weather',description,at,{date,weather,water,loss},eventId,loss > 0);
}

export function needsFarmAdvance(draft:CanonicalEnvelope, at:number) {
  const farm = storage(draft).farm;
  return !!farm && farm.day.date < farmDay(at);
}

export function advanceFarm(draft:CanonicalEnvelope, at:number, activate = false, seed?:string) {
  const target = farmDay(at);
  const legacy = storage(draft);
  if (!legacy.farm) {
    if (!activate) return;
    const weatherSeed = seed ?? randomUUID();
    legacy.farm = {seed:weatherSeed,day:{date:target,weather:'sunny',eventId:''},crop:null,rawBowls:0,lastHarvest:null};
    setWeather(draft,legacy.farm,randomFarmWeather(weatherSeed,target),at);
    return;
  }
  const farm = legacy.farm;
  while (farm.day.date < target) {
    const crop = farm.crop;
    if (crop && crop.growth < 3) {
      crop.loss = Math.min(6,crop.loss + crop.dayLoss);
      if (crop.waters + crop.rain >= 2) crop.growth++;
      crop.waters = 0;
      crop.rain = 0;
      crop.dayLoss = 0;
    }
    const next = dayStart(farm.day.date) + DAY;
    setWeather(draft,farm,randomFarmWeather(farm.seed,farmDay(next)),next);
  }
}

export function changeFarmWeather(draft:CanonicalEnvelope, weather:FarmWeather, at:number) {
  advanceFarm(draft,at,true);
  const farm = storage(draft).farm!;
  if (farm.day.date !== farmDay(at)) throw Error('稻田日期正在等待时钟恢复');
  if (farm.day.weather !== weather) setWeather(draft,farm,weather,at);
}

export function farmFacts(draft:CanonicalEnvelope, at = Date.now()) {
  const farm = storage(draft).farm;
  if (!farm) return null;
  const {crop,day,rawBowls,lastHarvest} = farm;
  const growth = crop?.growth ?? 0;
  const stage = !crop ? 'empty' : growth === 3 ? 'ripe' : growth === 2 ? 'heading' : 'seedling';
  const growing = crop && growth < 3;
  const watered = growing ? Math.min(2,crop.waters + crop.rain) : 0;
  const nextWater = growing && watered < 2 ? Math.max(dayStart(day.date),(crop.lastWaterAt ?? 0) + FARM_WATER_GAP) : null;
  const operation:FarmOperation|null = day.date !== farmDay(at) ? null : !crop ? 'plant' : stage === 'ripe' ? 'harvest' : nextWater !== null && nextWater <= at ? 'water' : null;
  return {date:day.date,weather:day.weather,weatherLabel:farmWeather[day.weather].label, weatherEventId:day.eventId,stage,growth,
    watered,rain:growing ? crop.rain : 0,nextWaterAt:nextWater,rawBowls,lastHarvest,
    expectedBowls:crop ? Math.max(0,6 - crop.loss - crop.dayLoss) : null,operation};
}

export function farmActionTarget(draft:CanonicalEnvelope, operation:FarmOperation, at:number) {
  const facts = farmFacts(draft,at);
  if (facts?.operation !== operation) throw Error('稻田状态已变化或还没到浇水时间');
  return {date:facts.date,cropId:storage(draft).farm?.crop?.id ?? null};
}

export function completeFarmOperation(draft:CanonicalEnvelope, operation:FarmOperation, actionId:string, at:number) {
  farmActionTarget(draft,operation,at);
  const farm = storage(draft).farm!;
  let description:string, bowls:number|undefined;
  switch (operation) {
    case 'plant': {
      const weather = farmWeather[farm.day.weather];
      farm.crop = {id:actionId,growth:0,loss:0,waters:0,rain:weather.water,dayLoss:weather.loss};
      description = '我在稻田里种下了一季水稻。';
      break;
    }
    case 'water':
      farm.crop!.waters++;
      farm.crop!.lastWaterAt = at;
      description = '我给田里的水稻浇了一次水。';
      break;
    case 'harvest':
      bowls = farmFacts(draft,at)!.expectedBowls!;
      farm.rawBowls += bowls;
      farm.lastHarvest = bowls;
      farm.crop = null;
      description = bowls ? `我收割了水稻，往米缸存了${bowls}碗生米。` : '我收割了水稻，这一季颗粒无收。';
      break;
  }
  record(draft,'farm.tended',description,at,{operation,...(bowls === undefined ? {} : {bowls})},`farm-tended:${actionId}`,operation !== 'water');
}
