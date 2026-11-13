// Geometry comes from the same viewport/regions used by movement, in CSS pixels.
export function spaceReport(input) {
  if (input?.surface === 'web') {
    const { width, height } = input;
    if (![width, height].every(v => Number.isFinite(v) && v > 0 && v <= 100000)) throw Error('家里的尺寸无效');
    return { surface: 'web', width: Math.round(width), height: Math.round(height) };
  }
  if (input?.surface !== 'desktop' || !Array.isArray(input.areas) || !input.areas.length || input.areas.length > 32) throw Error('活动区域无效');
  const areas = input.areas.map(a => {
    if (!a || ![a.x, a.y, a.width, a.height].every(Number.isFinite) || Math.abs(a.x) > 1000000 || Math.abs(a.y) > 1000000 || a.width <= 0 || a.height <= 0 || a.width > 100000 || a.height > 100000) throw Error('屏幕尺寸无效');
    return { x: Math.round(a.x), y: Math.round(a.y), width: Math.round(a.width), height: Math.round(a.height) };
  });
  const currentScreen = input.currentScreen;
  if (!Number.isInteger(currentScreen) || currentScreen < 0 || currentScreen >= areas.length) throw Error('所在屏幕无效');
  return { surface: 'desktop', areas, currentScreen };
}

// Count the union, never the bounding box: holes and mirrored screens add no space.
export function unionArea(rects) {
  const xs = [...new Set(rects.flatMap(a => [a.x, a.x + a.width]))].sort((a,b) => a-b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const spans = rects.filter(a => a.x < xs[i] && a.x + a.width > xs[i-1]).map(a => [a.y, a.y + a.height]).sort((a,b) => a[0]-b[0]);
    let lo, hi, height = 0;
    for (const [a,b] of spans) {
      if (lo === undefined) { lo = a; hi = b; }
      else if (a > hi) { height += hi-lo; lo = a; hi = b; }
      else hi = Math.max(hi,b);
    }
    if (lo !== undefined) height += hi-lo;
    area += (xs[i]-xs[i-1])*height;
  }
  return area;
}

export function updateSpace(previous, report, settings) {
  const next = structuredClone(previous || {});
  if (report) next[report.surface === 'web' ? 'home' : 'outside'] = report;
  next.mode = ['desktop','both'].includes(settings.display) ? 'outside' : settings.display === 'web' ? 'home' : 'hidden';
  next.confined = settings.confined === true;
  const region = next.mode === 'home' ? next.home : next.mode === 'outside' ? next.outside : null;
  const areas = region?.areas ? (next.confined ? [region.areas[region.currentScreen]] : region.areas) : null;
  next.area = areas ? unionArea(areas) : region ? region.width * region.height : null;
  next.screens = areas?.length || 0;
  const before = previous?.noticed;
  let change;
  if (before && before.mode !== next.mode) {
    if (next.mode === 'home') change = { text: '活动边界被限制在软件窗口里，我被关在家里了，不能自己跑到桌面上。', say: '爸爸，怎么把我关在家里啦' };
    if (next.mode === 'outside') change = { text: '活动权限允许我离开软件里的家，到桌面屏幕上活动了。', say: '爸爸，我可以出来溜达啦' };
  } else if (before && next.area && before.area && next.mode !== 'hidden') {
    const ratio = next.area / before.area;
    if (ratio >= 1.12 || ratio <= .88 || (next.screens !== before.screens && ratio !== 1)) {
      const bigger = ratio > 1;
      const subject = next.mode === 'home' ? '软件里的家' : '外面实际可活动的屏幕范围';
      change = { text: `${subject}${bigger ? '变大' : '变小'}了，面积约为原来的 ${Math.round(ratio*100)}%。${next.mode === 'outside' && next.screens > before.screens ? '新增屏幕已经可以自由活动。' : ''}`, say: next.mode === 'home' ? (bigger ? '爸爸，家里变宽敞啦' : '爸爸，家里挤了一点') : (bigger ? '爸爸，外面变大啦！想去逛逛' : '爸爸，能跑的地方变小了') };
    }
    if (!change && next.mode === 'outside' && next.confined !== before.confined) change = { text: next.confined ? '桌面自主活动和抛掷被限制在当前这一块屏幕，其他屏幕暂时不能自由过去。' : '桌面的跨屏活动限制解除了，可以在各块屏幕间活动。', say: next.confined ? '爸爸，只能在这块屏上玩吗' : '爸爸，可以跨过去玩啦' };
  }
  if (!before || change || before.mode !== next.mode || (!before.area && next.area)) next.noticed = { mode: next.mode, area: next.area, screens: next.screens, confined: next.confined };
  return { next, change };
}

export function spacePrompt(space) {
  if (!space) return '\n【空间认知】软件窗口内部是家，外面是桌面屏幕。还没有收到实际尺寸，不能声称空间变大或已经出门。';
  const home = space.home ? `${space.home.width}×${space.home.height} CSS 像素` : '尚未测到';
  const scope = space.mode === 'home' ? '只能在软件窗口内活动，知道自己被关在家里；不能声称已到桌面或新屏幕上玩。' : space.mode === 'outside' ? (space.confined ? '可以在桌面活动，但自主移动和抛掷限制在当前这一块屏幕；新增屏幕不等于获准跨屏。' : `可以离开家，在桌面的 ${space.screens || '尚未测到的'} 块屏幕范围内自由活动。`) : '当前被隐藏，没有可确认的活动范围。';
  return `\n【真实空间感知】家就是软件窗口内部，家的大小随软件可用窗口改变，目前为 ${home}。外面是实际屏幕的活动区域，不是透明桌宠小窗口的大小。${scope}${space.area ? `当前可活动面积约 ${Math.round(space.area)} 平方 CSS 像素。` : '当前活动尺寸尚未测到。'}只根据真实范围变化产生宽敞、拥挤、想探索或被关在家里的反应，不因屏幕存在就虚构已去过。不要每轮重复。`;
}
