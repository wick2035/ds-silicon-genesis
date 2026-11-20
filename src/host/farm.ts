import {createHash, randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';

const FARM_CARE_GAP = 4 * 60 * 60 * 1000;
const DAILY_CARE_TARGET = 2;
export const FARM_WEATHER_AWARENESS = '稻田天气是全局环境实况，你在桌面、工地或稻田都能知道当前天气。inside 只表示你是否在稻田。天气起因未知。';
export const FARM_WEATHER_BLOCKED = '冰雹或台风期间暂停进田，请等天气转好';
const SEEDS_PER_SEASON = 24;
const SEED_LIMIT = SEEDS_PER_SEASON * 3;
const DEFAULT_SEED_PRICE = 1;
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
export type FarmOperation = 'plant'|'water'|'fertilize'|'harvest';
type SeedQuote = {count:number; unitCharge:number};
export type FarmAction = {operation:FarmOperation; seedPurchase?:SeedQuote};
export type FarmVisit = {id:string; epoch:string; actionId?:string};
type FarmCrop = {id:string; growth:number; loss:number; waters:number; rain:number; dayLoss:number;
  careCompleted?:number; lastCareAt?:number; lastWaterAt?:number; daySources?:string[]};
type FarmDay = {date:string; weather:FarmWeather; eventId:string};
type Farm = {seed:string; day:FarmDay; crop:FarmCrop|null; rawBowls:number; lastHarvest:number|null};
type FarmStorage = {farm?:Farm; farmVisit?:FarmVisit; farmSeedBundles?:number};
const storage = (draft:Pick<CanonicalEnvelope,'legacy'>) => draft.legacy as FarmStorage;
const careCompleted = (crop:FarmCrop) => crop.careCompleted ?? crop.waters;
const careProgress = (crop:FarmCrop) => Math.min(DAILY_CARE_TARGET,careCompleted(crop) + crop.rain);
export const farmSettlementDescription = (completed:number,rain:number,qualified:boolean) =>
  `当天人工照料 ${completed} 次，雨水补给 ${rain} 次，${qualified?'照料已达标，水稻推进一个生长日。':'照料未达标，水稻未推进生长。'}`;
const severeWeather = (weather:FarmWeather) => weather.endsWith('-hail') || weather.endsWith('-typhoon');

export function checkFarmWeatherForEntry(draft:Pick<CanonicalEnvelope,'legacy'>) {
  const farm = storage(draft).farm;
  if (farm && severeWeather(farm.day.weather)) throw Error(FARM_WEATHER_BLOCKED);
}

export function farmSeedShop(legacy:CanonicalEnvelope['legacy']) {
  const pet = legacy as Record<string,any>;
  const stock = (legacy as FarmStorage).farmSeedBundles ?? 0;
  const price = pet.config?.costs?.riceSeed ?? DEFAULT_SEED_PRICE;
  const charge = pet.wallet?.frozen === true ? 0 : price;
  const balance = pet.wallet?.balance;
  const affordable = !Number.isFinite(balance) || balance < 0 ? 0 : charge === 0 ? SEED_LIMIT : Math.floor(Math.round(balance * 100) / Math.round(charge * 100));
  return {stock,limit:SEED_LIMIT,perSeason:SEEDS_PER_SEASON,missing:Math.max(0,SEEDS_PER_SEASON-stock),price,charge,maxPurchase:Math.min(SEED_LIMIT - stock,affordable)};
}

export function purchaseFarmSeeds(draft:Pick<CanonicalEnvelope,'legacy'|'life'|'petId'>, count:number, expectedCharge:number, key:string, at:number) {
  const shop = farmSeedShop(draft.legacy);
  if (shop.charge !== expectedCharge) throw Error('种子价格或消费状态已变化，请刷新后重试');
  if (!Number.isInteger(count) || count < 1 || count > shop.limit - shop.stock) throw Error(`种子库存最多可放 ${shop.limit} 束`);
  if (count > shop.maxPurchase) throw Error('饭钱不足，无法购买这么多种子');
  const pet = draft.legacy as Record<string,any>, wallet = pet.wallet;
  const amount = Math.round(shop.charge * 100) * count / 100;
  const before = wallet.balance;
  wallet.balance = (Math.round(before * 100) - Math.round(amount * 100)) / 100;
  if (before > 0 && wallet.balance === 0) {wallet.emptySince = at;delete wallet.emptyAskedAt;}
  (draft.legacy as FarmStorage).farmSeedBundles = shop.stock + count;
  const description = `买入 ${count} 束水稻种子，花费 ${amount} token，余额 ${wallet.balance} token`;
  const eventId = `finance:${key}`, stamp = new Date(at).toISOString();
  (pet.events ??= []).push({id:eventId,kind:'wallet-spend',text:description,ts:at});
  draft.life.events.push({eventId,petId:draft.petId,type:'wallet.spend',source:'canonical',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{kind:'farm-seeds',count,amount,balance:wallet.balance,description}});
  return {count,amount,stock:shop.stock + count};
}

export const farmDay = (at:number) => hongKongDate.format(at);
const dayStart = (date:string) => Date.parse(`${date}T00:00:00+08:00`);
export const farmVisit = (draft:Pick<CanonicalEnvelope,'legacy'>) => storage(draft).farmVisit;
export const rawRiceBowls = (draft:Pick<CanonicalEnvelope,'legacy'>) => storage(draft).farm?.rawBowls ?? 0;

export function useRawRice(draft:CanonicalEnvelope,bowls:number) {
  const farm=storage(draft).farm;
  if(!farm || !Number.isSafeInteger(bowls) || bowls<1 || farm.rawBowls<bowls)throw Error('米缸里的生米不足');
  farm.rawBowls-=bowls;
}
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

function record(draft:CanonicalEnvelope, type:'farm.weather'|'farm.tended'|'farm.settled', description:string, at:number, facts:Record<string,unknown>, eventId:string, remember:boolean) {
  const time = new Date(at).toISOString();
  draft.life.events.push({eventId,petId:draft.petId,type,source:type==='farm.tended'?'executor':'environment',occurredAt:time,receivedAt:time,evidenceLevel:'observed',payload:{...facts,description}});
  const world=draft.life.worldModel??={facts:[]};
  const day=typeof facts.date==='string'?facts.date:farmDay(at);
  if(type==='farm.weather'){
    const previous=world.facts.slice().reverse().find(fact=>fact.topic===type&&fact.day===day);
    if(previous)previous.validUntil=time;
  }
  world.facts.push({id:'world:'+eventId,label:type,value:description,sourceIds:[eventId],valid:true,topic:type,observedAt:time,day,data:facts,
    ...(type==='farm.weather'?{validUntil:new Date(dayStart(day)+DAY).toISOString()}: {})});
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
  const rain = active ? Math.max(0,effect.water - active.rain) : 0;
  if (active) {
    active.rain = Math.max(active.rain,effect.water);
    active.dayLoss = Math.max(active.dayLoss,effect.loss);
    if(rain||loss)(active.daySources??=[]).push(eventId);
  }
  const description = `稻田迎来${effect.label}。${water ? `雨水补足了${water}次浇水。` : ''}${loss ? `水稻受损，今天的预计收成减少${loss}碗。` : ''}`;
  record(draft,'farm.weather',description,at,{date,weather,water,rain:active?.rain??0,loss},eventId,rain > 0 || loss > 0);
}

export function needsFarmAdvance(draft:CanonicalEnvelope, at:number) {
  const farm = storage(draft).farm;
  return !farm || farm.day.date < farmDay(at);
}

export function advanceFarm(draft:CanonicalEnvelope, at:number, seed?:string) {
  const target = farmDay(at);
  const legacy = storage(draft);
  if (!legacy.farm) {
    const weatherSeed = seed ?? randomUUID();
    legacy.farm = {seed:weatherSeed,day:{date:target,weather:'sunny',eventId:''},crop:null,rawBowls:0,lastHarvest:null};
    setWeather(draft,legacy.farm,randomFarmWeather(weatherSeed,target),at);
    return;
  }
  const farm = legacy.farm;
  while (farm.day.date < target) {
    const crop = farm.crop;
    const next = dayStart(farm.day.date) + DAY;
    if (crop && crop.growth < 3) {
      const completed = careCompleted(crop);
      const progress = careProgress(crop), qualified = progress >= DAILY_CARE_TARGET;
      const facts={date:farm.day.date,seasonId:crop.id,weather:farm.day.weather,watered:Math.min(2,crop.waters+crop.rain),careCompleted:completed,rain:crop.rain,careProgress:progress,qualified,loss:crop.dayLoss};
      record(draft,'farm.settled',farmSettlementDescription(completed,crop.rain,qualified),next,facts,
        `farm-settled:${crop.id}:${farm.day.date}`,false);
      const resolution=draft.life.worldModel!.facts.at(-1)!;
      resolution.sourceIds=[...new Set([...resolution.sourceIds,farm.day.eventId,...(crop.daySources??[])])];
      const event=draft.life.events.at(-1)!;
      Object.assign(event.payload as object,{sourceIds:resolution.sourceIds.filter(id=>id!==event.eventId)});
      crop.daySources=[];
      crop.loss = Math.min(6,crop.loss + crop.dayLoss);
      if (qualified) crop.growth++;
      crop.careCompleted = 0;
      crop.waters = 0;
      crop.rain = 0;
      crop.dayLoss = 0;
    }
    setWeather(draft,farm,randomFarmWeather(farm.seed,farmDay(next)),next);
  }
}

export function changeFarmWeather(draft:CanonicalEnvelope, weather:FarmWeather, at:number) {
  advanceFarm(draft,at);
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
  const completed = growing ? careCompleted(crop) : 0;
  const progress = growing ? careProgress(crop) : 0;
  const weatherBlocked = severeWeather(day.weather);
  const nextCareAt = growing && progress < DAILY_CARE_TARGET && !weatherBlocked
    ? Math.max(dayStart(day.date),(crop.lastCareAt ?? crop.lastWaterAt ?? 0) + FARM_CARE_GAP) : null;
  const seeds = farmSeedShop(draft.legacy);
  let operation:FarmOperation|null = null;
  if (!weatherBlocked && day.date === farmDay(at) && !Object.hasOwn(draft.life.invalidSources,day.eventId)) {
    if (stage === 'empty' && seeds.maxPurchase >= seeds.missing) operation = 'plant';
    if (stage === 'ripe') operation = 'harvest';
    if (nextCareAt !== null && nextCareAt <= at) operation = day.weather === 'sunny' && watered < 2 ? 'water' : 'fertilize';
  }
  const seedPurchase = operation === 'plant' && seeds.missing > 0 ? {count:seeds.missing,unitCharge:seeds.charge} : null;
  return {date:day.date,weather:day.weather,weatherLabel:farmWeather[day.weather].label, weatherEventId:day.eventId,stage,growth,
    weatherBlocked,careCompleted:completed,careProgress:progress,careTarget:DAILY_CARE_TARGET,nextCareAt,
    watered,waterNeeded:growing?2-watered:0,rain:growing ? crop.rain : 0,rawBowls,lastHarvest,seeds,seedPurchase,
    expectedBowls:crop ? Math.max(0,6 - crop.loss - crop.dayLoss) : null,operation};
}

export function farmActionTarget(draft:CanonicalEnvelope, {operation,seedPurchase}:FarmAction, at:number) {
  const facts = farmFacts(draft,at);
  if (facts?.weatherBlocked) throw Error(FARM_WEATHER_BLOCKED);
  if (operation === 'plant' && facts?.stage === 'empty') {
    const seeds = facts.seeds;
    if (seeds.missing > 0 && (seeds.maxPurchase < seeds.missing || seedPurchase?.count !== seeds.missing || seedPurchase.unitCharge !== seeds.charge)) throw Error('种子或饭钱不足，或购买报价已变化');
    if (seeds.missing === 0 && seedPurchase !== undefined) throw Error('已有足够种子，可直接播种');
  }
  if (!facts?.operation || facts.operation !== operation) throw Error('稻田状态已变化或还没到下次农活时间');
  return {date:facts.date,cropId:storage(draft).farm?.crop?.id ?? null,weatherEventId:facts.weatherEventId};
}

export function completeFarmOperation(draft:CanonicalEnvelope, action:FarmAction, actionId:string, at:number, receiptEventId?:string) {
  farmActionTarget(draft,action,at);
  const {operation,seedPurchase} = action;
  const farm = storage(draft).farm!;
  let description:string, bowls:number|undefined;
  const seasonId=farm.crop?.id??actionId;
  switch (operation) {
    case 'plant': {
      if (seedPurchase) purchaseFarmSeeds(draft,seedPurchase.count,seedPurchase.unitCharge,actionId,at);
      storage(draft).farmSeedBundles = (storage(draft).farmSeedBundles ?? 0) - SEEDS_PER_SEASON;
      const weather = farmWeather[farm.day.weather];
      farm.crop = {id:actionId,growth:0,loss:0,waters:0,rain:weather.water,dayLoss:weather.loss,careCompleted:0,daySources:[farm.day.eventId]};
      description = `我用 ${SEEDS_PER_SEASON} 束种子种下了一季水稻。`;
      break;
    }
    case 'water':
    case 'fertilize': {
      const crop = farm.crop!;
      crop.careCompleted = careCompleted(crop) + 1;
      crop.lastCareAt = at;
      if (operation === 'water') crop.waters++;
      (crop.daySources??=[]).push(`farm-tended:${actionId}`,farm.day.eventId);
      description = operation === 'water' ? '我给田里的水稻浇了一次水。' : '我给田里的水稻施了一次肥。';
      break;
    }
    case 'harvest':
      bowls = farmFacts(draft,at)!.expectedBowls!;
      farm.rawBowls += bowls;
      farm.lastHarvest = bowls;
      farm.crop = null;
      description = bowls ? `我收割了水稻，往米缸存了${bowls}碗生米。` : '我收割了水稻，这一季颗粒无收。';
      break;
  }
  record(draft,'farm.tended',description,at,{date:farm.day.date,seasonId,operation,...(operation==='plant'?{rain:farm.crop!.rain}:{}),...(bowls === undefined ? {} : {bowls})},`farm-tended:${actionId}`,operation === 'plant' || operation === 'harvest');
  if(receiptEventId){
    draft.life.worldModel!.facts.at(-1)!.sourceIds.push(receiptEventId);
    Object.assign(draft.life.events.at(-1)!.payload as object,{sourceIds:[receiptEventId]});
  }
}
