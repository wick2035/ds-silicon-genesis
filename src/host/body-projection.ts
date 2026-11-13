import type { BodyProjection, CanonicalEnvelope } from '../storage/postgres.js';

/** Pure projection of the last committed body state; never advances time. */
export const projectBody: BodyProjection = (envelope: Readonly<CanonicalEnvelope>) => {
  const human = envelope.humanity as Record<string, any>;
  const stats = human.stats, emotions = human.emotions;
  if (!stats || !emotions || !Number.isFinite(human.updatedAt)) throw new Error('原身心状态不完整');
  const number = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('原身心数值无效');
    return value;
  };
  const energy=number(stats.energy), stamina=number(stats.stamina), satiety=number(stats.satiety);
  const hydration=number(stats.hydration), comfort=number(stats.comfort), pain=number(stats.pain);
  const stress=number(stats.stress), security=number(stats.security);
  const clamp = (value: number) => Math.max(0,Math.min(100,value));
  const interaction = Number.isFinite(human.lastInteraction) ? human.lastInteraction : human.updatedAt;
  const satisfied = Number.isFinite(human.satisfaction?.curiosity) ? human.satisfaction.curiosity : 0;
  const injury = human.injury && Number.isFinite(human.injury.guardUntil) && human.updatedAt < human.injury.guardUntil;
  return {
    body:{energy,stamina,hunger:100-satiety,hydration,comfort,pain,
      sleeping:human.sleeping === true || (Number.isFinite(human.restingUntil) && human.updatedAt < human.restingUntil),
      // The renderer must explicitly report release; absent observation cannot authorize movement.
      restrained:human.helperReady !== true || human.restrained !== false, injured:!!injury || pain >= 16},
    emotions:{joy:number(emotions.joy),sadness:number(emotions.sadness),anger:number(emotions.anger),fear:number(emotions.fear),love:number(emotions.love),aversion:number(emotions.aversion),longing:number(emotions.longing),
      // Existing humanity calls these desires; expose the same deterministic cues without inventing histories.
      curiosity:clamp(26+energy*.4-stress*.3-pain*.2-satisfied),
      loneliness:clamp(18+Math.max(0,human.updatedAt-interaction)/3600000*4+pain*.12+(100-security)*.12)}
  };
};
