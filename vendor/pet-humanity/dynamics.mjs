// Pure elapsed-time responses. Embedded by install-dynamics.py for both host bundles.
const dynamicClamp = n => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

export function responseLevel(r, now) {
  const age = Math.max(0, (now - r.at) / 1000);
  if (r.kind === 'settle') return 1 - .65 * Math.exp(-age / r.rise);
  const onset = 1 - Math.exp(-age / r.rise);
  return Math.exp(-age / r.decay) * (.58 + .62 * onset + .10 * onset * Math.sin(age * .72));
}

export function settleResponses(s, now) {
  if (!s.responses?.length) return;
  s.responses = s.responses.filter(r => {
    const done = now - r.at >= (r.kind === 'settle' ? r.rise * 12 : r.decay * 12) * 1000;
    const delta = (done ? (r.kind === 'settle' ? 1 : 0) : responseLevel(r, now)) - responseLevel(r, s.updatedAt);
    for (const group of ['stats', 'emotions', 'satisfaction']) {
      if (!r[group]) continue;
      s[group] ||= {};
      for (const [key, amount] of Object.entries(r[group])) s[group][key] = dynamicClamp((s[group][key] || 0) + amount * delta);
    }
    return !done;
  });
}

export function addResponse(s, now, kind, values, rise = 12, decay = 180) {
  const response = { at: now, kind, rise, decay, ...structuredClone(values) };
  for (const group of ['stats', 'emotions', 'satisfaction']) {
    if (!response[group]) continue;
    s[group] ||= {};
    for (const [key, amount] of Object.entries(response[group])) {
      const pending = (s.responses || []).reduce((sum, r) => sum + Math.max(0,
        (r[group]?.[key] || 0) * ((r.kind === 'settle' ? 1 : 1.3) - responseLevel(r, now))), 0);
      const headroom = Math.max(0, 100 - (s[group][key] || 0) - pending);
      const gain = amount > 0 ? Math.min(headroom / (kind === 'pulse' ? 1.3 : 1),
        amount * (kind === 'settle' ? .3 + .7 * headroom / 100 : headroom / 100)) : amount;
      response[group][key] = gain;
      s[group][key] = dynamicClamp((s[group][key] || 0) + gain * responseLevel(response, now));
    }
  }
  if (Object.values(values).some(group => Object.values(group).some(amount => amount !== 0))) {
    s.responses ||= [];
    s.responses.push(response);
  }
}

export function easeEmotions(s, before, now) {
  const changes = {};
  for (const key of Object.keys(s.emotions)) { changes[key] = s.emotions[key] - before[key]; s.emotions[key] = before[key]; }
  addResponse(s, now, 'pulse', { emotions: changes }, 5, 240);
}

export function softenAche(s, now) {
  for (const r of s.responses || []) if (r.kind === 'pulse' && r.stats?.pain > 0) {
    s.stats.pain = dynamicClamp(s.stats.pain - r.stats.pain * responseLevel(r, now) * .15);
    r.stats.pain *= .85;
  }
}

export function validateResponses(s) {
  if (s.responses === undefined) return;
  if (!Array.isArray(s.responses) || s.responses.length > 10000) throw new Error('身心反应记录损坏');
  for (const r of s.responses) {
    if (!r || !['settle', 'pulse'].includes(r.kind) || !Number.isFinite(r.at) || r.at > s.updatedAt ||
      !Number.isFinite(r.rise) || r.rise < 1 || r.rise > 120 || !Number.isFinite(r.decay) || r.decay < 1 || r.decay > 600) throw new Error('身心反应时间损坏');
    for (const group of ['stats', 'emotions', 'satisfaction']) if (r[group] !== undefined) {
      if (!r[group] || typeof r[group] !== 'object' || Array.isArray(r[group])) throw new Error('身心反应数值损坏');
      for (const [key, value] of Object.entries(r[group])) if (!Object.hasOwn(s[group] || {}, key) || !Number.isFinite(value) || Math.abs(value) > 100) throw new Error('身心反应数值损坏');
    }
  }
}
