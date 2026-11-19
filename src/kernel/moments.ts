import type {LifeEvent, LifeState} from './types.js';

export const momentEventType = 'self.moment';
export interface MomentDraft { text: string; sourceId: string }
type MomentHistory = Pick<LifeState, 'events' | 'invalidSources'>;

const hour = 3_600_000;
const hongKongDay = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Hong_Kong', dateStyle:'short'});

function payload(event: LifeEvent) {
  return event.payload as Record<string, unknown> | null;
}

function linkedSources(event: LifeEvent): string[] {
  const links = payload(event)?.sourceIds;
  return Array.isArray(links) ? links.filter((id): id is string => typeof id === 'string') : [];
}

function sourceLabel(event: LifeEvent): string | null {
  const data = payload(event);
  if (event.type === 'self.thought') return '她记下了一个念头';
  if (event.type === 'conversation.assistant' && !data?.silent && ['desktop', 'qq-c2c', 'legacy'].includes(event.source)) return '和爸爸聊了一会儿';
  if (!['observed', 'verified'].includes(event.evidenceLevel)) return null;
  if (event.type === 'farm.weather' && typeof data?.weather === 'string' && data.weather !== 'sunny') return '稻田的天气有了变化';
  if (event.type === 'farm.tended') return ({plant:'在稻田播了种', water:'给稻田浇了水', fertilize:'给水稻施了肥', harvest:'收割了水稻'} as Record<string, string>)[String(data?.operation)] ?? '在稻田干了活';
  if (event.type === 'body.meal') return '吃了饭';
  if (event.type === 'interaction.worksite' && ['touch', 'drag', 'release', 'enter-forced', 'enter-voluntary', 'leave-voluntary'].includes(String(data?.action))) return '在搬砖工地的一次互动';
  if (event.type === 'action.receipt' && data?.status === 'COMPLETED') {
    switch (data.actionType) {
      case 'body.activity': return '在桌面活动了一会儿';
      case 'labor.step': return '搬完了一趟砖';
      case 'learning.observe': return '查到了想了解的资料';
      case 'image.observe': return '看了一张分享给她的图片';
    }
  }
  return null;
}

function matterIds(event: LifeEvent, events: Map<string, LifeEvent>): Set<string> {
  const ids = new Set<string>();
  const pending = [event.eventId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const current = events.get(id);
    if (current?.type === 'self.thought') pending.push(...linkedSources(current));
    if (current?.type === 'conversation.assistant' && current.causationId) pending.push(current.causationId);
  }
  return ids;
}

export function momentLimitReason(history: MomentHistory, now: number): string | null {
  const published = history.events.filter(event => event.type === momentEventType);
  const today = hongKongDay.format(now);
  const stamps = published.map(event => Date.parse(event.occurredAt)).filter(Number.isFinite);
  if(stamps.filter(stamp => hongKongDay.format(stamp) === today).length >= 2)return '今天已发满两条说说，明天可以继续分享';
  if(stamps.some(stamp => now - stamp < 2 * hour))return '距离上一条说说还不足两小时，稍后可以继续分享';
  return null;
}

export function momentSources(history: MomentHistory, now: number): Map<string, string> {
  const sources = new Map<string, string>();
  if(momentLimitReason(history,now))return sources;
  const events = new Map(history.events.map(event => [event.eventId, event]));
  const published = history.events.filter(event => event.type === momentEventType);

  const used = new Set(published.flatMap(event => linkedSources(event).flatMap(id => {
    const source = events.get(id);
    return source ? [...matterIds(source, events)] : [id];
  })));
  for (const event of history.events) {
    const age = now - Date.parse(event.occurredAt);
    if (!(age >= 0 && age <= 24 * hour)) continue;
    const label = sourceLabel(event);
    if (!label) continue;
    const related = matterIds(event, events);
    if ([...related].some(id => used.has(id) || Object.hasOwn(history.invalidSources, id) ||
        (events.get(id)?.type === 'self.thought' && Object.hasOwn(history.invalidSources, 'memory:'+id)))) continue;
    if (event.type === 'self.thought' && [...related].some(id => !events.has(id))) continue;
    const context = event.type === 'self.thought'
      ? [...related].filter(id => id !== event.eventId).map(id => {
          const origin = events.get(id);
          if (origin?.type === 'wallet') return '爸爸调整了饭钱';
          return origin && origin.type !== 'self.thought' ? sourceLabel(origin) : null;
        }).find(Boolean) ?? label
      : label;
    sources.set(event.eventId, context);
  }
  return sources;
}

export function readMoments(history: MomentHistory & Pick<LifeState, 'memories'>) {
  const ids = new Set([...history.events.map(event => event.eventId), ...history.memories.filter(memory => memory.valid).map(memory => memory.id)]);
  return history.events.flatMap(event => {
    if (event.type !== momentEventType || Object.hasOwn(history.invalidSources, event.eventId)) return [];
    const source = linkedSources(event);
    const data = payload(event);
    if (!source.length || source.some(id => !ids.has(id) || Object.hasOwn(history.invalidSources, id)) ||
        typeof data?.text !== 'string' || typeof data.context !== 'string') return [];
    return [{id:event.eventId, at:event.occurredAt, text:data.text, context:data.context}];
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
