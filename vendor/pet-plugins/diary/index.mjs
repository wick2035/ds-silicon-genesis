export const name='pet-local-diary';
export const inject=['petCompanion'];
export function apply(ctx){const rt=ctx.petCompanion;rt.diaryEnabled=true;ctx.effect(()=>()=>{rt.diaryEnabled=false;for(const [key,c] of rt.cancel)if(key.endsWith(':diary'))c.abort(new Error('日记插件已卸载'));},'pet-companion diary');}
