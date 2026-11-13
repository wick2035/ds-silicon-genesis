/** The original host owns only ephemeral presentation and explicitly selected
 * appearance configuration here. None of these routes writes companion or
 * humanity JSON, creates memories, or confirms a canonical action outcome.
 * Playback reports are cosmetic; canonical actions use helper IPC receipts. */
export function isPresentationRoute(pathname:string,method:string):boolean {
  const path=pathname.replace(/^\/dsh-pet-7340\//,'');
  if(method==='POST' && ['position','throw','anim','broadcast','focus-session','work-status','pet-avatar','pose/report','menu/click','menu/item','bubble/clear','lock','lock/release','reload','pet-display','pet-config','config'].includes(path))return true;
  if(method==='PUT' && path==='config')return true;
  if(method==='DELETE' && path==='menu/item')return true;
  return method==='POST' && /^playback\/[A-Za-z0-9-]+\/report$/.test(path);
}
