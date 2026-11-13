// Mounted with a real web pet card; the native transparent sprite window is never a home.
export function startHomeSpace(base: string, petId: string) {
  let timer = 0, last = '', busy = false, disposed = false;
  const controller = new AbortController();
  const send = async () => {
    if (disposed || document.hidden || busy) return;
    const report = { surface: 'web', width: window.innerWidth, height: window.innerHeight };
    const key = JSON.stringify(report);
    if (key === last || !report.width || !report.height) return;
    busy = true;
    try {
      const res = await fetch(base + '/humanity/companion/space?pet=' + encodeURIComponent(petId), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: key,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      if (res.ok && (await res.json()).ok) last = key;
    } catch { /* Retry on the next sample; no invented observation. */ }
    finally { busy = false; }
  };
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void send(), 400); };
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  const interval = window.setInterval(() => void send(), 15000);
  void send();
  return () => {
    disposed = true; controller.abort(); window.clearTimeout(timer); window.clearInterval(interval);
    window.removeEventListener('resize', schedule); document.removeEventListener('visibilitychange', schedule);
  };
}
