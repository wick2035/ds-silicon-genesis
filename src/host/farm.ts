import {createHash, randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';

export const FARM_WATER_GAP = 4 * 60 * 60 * 1000;
export const FARM_WEATHER_AWARENESS = '稻田天气是全局环境实况，你在桌面、工地或稻田都能知道当前天气。inside 只表示你是否在稻田。天气起因未知。';
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
export type FarmOperation = 'plant'|'water'|'harvest';
type SeedQuote = {count:number; unitCharge:number};
export type FarmAction = {operation:FarmOperation; seedPurchase?:SeedQuote};
export type FarmVisit = {id:string; epoch:string; actionId?:string};
type FarmCrop = {id:string; growth:number; loss:number; waters:number; rain:number; dayLoss:number; lastWaterAt?:number};
type FarmDay = {date:string; weather:FarmWeather; eventId:string};
type Farm = {seed:string; day:FarmDay; crop:FarmCrop|null; rawBowls:number; lastHarvest:number|null};
type FarmStorage = {farm?:Farm; farmVisit?:FarmVisit; farmSeedBundles?:number};
const storage = (draft:Pick<CanonicalEnvelope,'legacy'>) => draft.legacy as FarmStorage;

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
  const nextWater = growing && watered < 2 ? Math.max(dayStart(day.date),(crop.lastWaterAt ?? 0) + FARM_WATER_GAP) : null;
  const seeds = farmSeedShop(draft.legacy);
  const operation:FarmOperation|null = day.date !== farmDay(at) ? null : !crop ? (seeds.maxPurchase >= seeds.missing ? 'plant' : null) : stage === 'ripe' ? 'harvest' : nextWater !== null && nextWater <= at ? 'water' : null;
  const seedPurchase = operation === 'plant' && seeds.missing > 0 ? {count:seeds.missing,unitCharge:seeds.charge} : null;
  return {date:day.date,weather:day.weather,weatherLabel:farmWeather[day.weather].label, weatherEventId:day.eventId,stage,growth,
    watered,rain:growing ? crop.rain : 0,nextWaterAt:nextWater,rawBowls,lastHarvest,seeds,seedPurchase,
    expectedBowls:crop ? Math.max(0,6 - crop.loss - crop.dayLoss) : null,operation};
}

export function farmActionTarget(draft:CanonicalEnvelope, {operation,seedPurchase}:FarmAction, at:number) {
  const facts = farmFacts(draft,at);
  if (operation === 'plant' && facts?.stage === 'empty') {
    const seeds = facts.seeds;
    if (seeds.missing > 0 && (seeds.maxPurchase < seeds.missing || seedPurchase?.count !== seeds.missing || seedPurchase.unitCharge !== seeds.charge)) throw Error('种子或饭钱不足，或购买报价已变化');
    if (seeds.missing === 0 && seedPurchase !== undefined) throw Error('已有足够种子，可直接播种');
  }
  if (facts?.operation !== operation) throw Error('稻田状态已变化或还没到浇水时间');
  return {date:facts.date,cropId:storage(draft).farm?.crop?.id ?? null};
}

export function completeFarmOperation(draft:CanonicalEnvelope, action:FarmAction, actionId:string, at:number) {
  farmActionTarget(draft,action,at);
  const {operation,seedPurchase} = action;
  const farm = storage(draft).farm!;
  let description:string, bowls:number|undefined;
  switch (operation) {
    case 'plant': {
      if (seedPurchase) purchaseFarmSeeds(draft,seedPurchase.count,seedPurchase.unitCharge,actionId,at);
      storage(draft).farmSeedBundles = (storage(draft).farmSeedBundles ?? 0) - SEEDS_PER_SEASON;
      const weather = farmWeather[farm.day.weather];
      farm.crop = {id:actionId,growth:0,loss:0,waters:0,rain:weather.water,dayLoss:weather.loss};
      description = `我用 ${SEEDS_PER_SEASON} 束种子种下了一季水稻。`;
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
