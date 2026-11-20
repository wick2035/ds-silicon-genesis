'use strict';
const get = id => document.getElementById(id);
const bridge = window.farmBridge;
const media = '../../assets/farm/';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const labels = {empty:'待播种',seedling:'育秧中',heading:'抽穗中',ripe:'已成熟'};
const activity = {plant:'大肥鱼正在播种',water:'大肥鱼正在浇水',fertilize:'大肥鱼正在施肥',harvest:'大肥鱼正在收割'};
const careLabels = {water:'浇水',fertilize:'施肥'};
const clock = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Hong_Kong',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const growthSteps = [...get('growth').children];
const scene = get('scene'), farmer = get('farmer'), crop = get('crop'), visit = get('visit'), feedback = get('feedback');
const careDetail = get('care-detail'), rainDetail = get('rain-detail');
let inside = false, working = false, polling = false, changing = false, connected = false, poseKey = '';
let renderedStage, renderingCommand;

function populateParticles() {
  for (let i=0;i<37;i++) {
    const particle=document.createElement('i');
    particle.className=i<27?'drop':'ripple';
    particle.style.setProperty('--x',`${i<27?((i*47)%137)+4:24+(i*11)%52}%`);
    particle.style.setProperty('--y',`${40+(i*13)%29}%`);
    particle.style.setProperty('--delay',`${-(i*.187)%2.2}s`);
    particle.style.setProperty('--speed',`${.48+(i%7)*.11}s`);
    get('particles').append(particle);
  }
}

function grow(stage) {
  if (renderedStage===stage) return;
  renderedStage=stage;
  crop.replaceChildren();
  if (stage==='empty') return;
  const plants=document.createDocumentFragment();
  for (let row=0;row<4;row++) {
    for (let col=0;col<6;col++) {
      const plant=document.createElement('img');
      plant.src=media+stage+'.webp';
      plant.alt='';
      const offset=(row+col)%2;
      plant.style.setProperty('--x',`${25-row*1.8+col*(9.2+row*.67)+offset*.65}%`);
      plant.style.setProperty('--y',`${39+row*9.2+offset*.65}%`);
      plant.style.setProperty('--size',`${(stage==='seedling'?6.2:9.6)+row*.72+offset*.45}%`);
      plants.append(plant);
    }
  }
  crop.append(plants);
}

function poseAsset(pose,still) {
  const sprite = pose==='fertilize'?'idle':pose;
  return media+sprite+(sprite==='idle'||still?'.webp':'.gif');
}

function showPose(pose,key=pose) {
  if (poseKey===key) return;
  poseKey=key;
  farmer.dataset.pose=pose;
  farmer.src=poseAsset(pose,reducedMotion.matches)+'?v='+encodeURIComponent(key);
}

function showFeedback(text='') {
  feedback.textContent=text;
  feedback.hidden=!text;
}

function renderCare(field) {
  const growing = field.stage==='seedling'||field.stage==='heading';
  get('care-progress').textContent=growing?`${field.careProgress} / ${field.careTarget} 次`:'—';
  let detail='等待播种';
  if (growing && field.careProgress>=field.careTarget) detail='今日已达标';
  else if (field.weatherBlocked) detail='天气恶劣 · 暂停进田';
  else if (field.stage==='ripe') detail='三个达标日已完成';
  else if (growing && careLabels[field.operation]) detail=`现在可以${careLabels[field.operation]}`;
  else if (growing && field.nextCareAt>Date.now()) {
    const tomorrow=field.nextCareAt>=Date.parse(`${field.date}T00:00:00+08:00`)+86400000;
    detail=`${tomorrow?'明天 ':''}${clock.format(field.nextCareAt)} 后可继续`;
  } else if (growing) detail='等待田况同步';
  if (careDetail.textContent!==detail) careDetail.textContent=detail;
  rainDetail.hidden=!growing;
  if (!rainDetail.hidden) rainDetail.textContent=`人工 ${field.careCompleted} 次 · 雨水 ${field.rain} 次`;
}

function render(state) {
  const field=state.field;
  connected=!!field;
  inside=state.inside;
  visit.disabled=!connected||changing||(!inside && (state.worksiteInside||field.weatherBlocked));
  visit.textContent=inside?'接她回来':'带她进田';
  farmer.hidden=!inside;
  if (!field) return;
  get('field-date').textContent=field.date.replace(/-/g,'.')+'  ·  香港时间';
  get('weather').textContent=field.weatherLabel;
  get('weather-icon').dataset.kind=field.weather.split('-').at(-1);
  scene.dataset.weather=field.weather;
  grow(field.stage);
  get('stage').textContent=labels[field.stage];
  growthSteps.forEach((step,index)=>step.toggleAttribute('data-done',index<field.growth));
  get('growth-detail').textContent=field.stage==='empty'?(field.weatherBlocked?'天气转好后可播种':field.operation?'等大肥鱼播种':'待补种子'):field.stage==='ripe'?`成熟 · 预计收 ${field.expectedBowls} 碗生米`:`已达标 ${field.growth} / 3 日 · 预计 ${field.expectedBowls} 碗`;
  const seeds=field.seeds;
  get('seed-stock').textContent=`${seeds.stock} / ${seeds.limit} 束`;
  const seedHelp=field.stage==='empty'&&seeds.missing?(seeds.maxPurchase>=seeds.missing?`还需买 ${seeds.missing} 束`:'种子和饭钱不足 · 可在「饭钱」页购买'):`每季用 ${seeds.perSeason} 束`;
  get('seed-detail').textContent=seedHelp;
  renderCare(field);
  get('rice').textContent=field.rawBowls;
  get('harvest').textContent=field.lastHarvest===null?'生米需煮熟后才能吃':field.lastHarvest?`上季收成 ${field.lastHarvest} 碗`:'上一季颗粒无收';
  const caption=renderingCommand?activity[renderingCommand.operation]:inside?(field.weatherBlocked?'大肥鱼在避雨处':'大肥鱼在田边'):state.worksiteInside?'大肥鱼在搬砖工地':'大肥鱼还没来稻田';
  if (get('scene-caption').textContent!==caption) get('scene-caption').textContent=caption;
  if (!renderingCommand && inside) {
    if (/hail|typhoon|heavy-rain/.test(field.weather)) {
      showPose('shelter','shelter:'+field.weatherEventId);
    } else showPose('idle');
  }
}

async function playCommand(command) {
  if (!command || renderingCommand || working || changing) return;
  renderingCommand=command;
  working=true;
  try {
    const preload=new Image();
    preload.src=poseAsset(command.operation,reducedMotion.matches);
    await preload.decode();
    render(await bridge.action('start',command.id));
    showPose(command.operation,command.id);
    await farmer.decode();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await new Promise(resolve=>setTimeout(resolve,command.clipMs));
    render(await bridge.action('complete',command.id));
    showFeedback();
  } catch (error) {
    await bridge.action('interrupt',command.id).catch(()=>{});
    showFeedback(error?.message||'这次农活动作已中断');
  } finally {
    renderingCommand=null;
    working=false;
    void refresh();
  }
}

async function refresh() {
  if (polling || working || changing) return;
  polling=true;
  try {
    const state=await bridge.action('snapshot');
    render(state);
    if (state.command) void playCommand(state.command);
  } catch {
    connected=false;visit.disabled=true;farmer.hidden=true;
    get('scene-caption').textContent='连接中断 · 等待重连';
  } finally {polling=false;}
}

visit.addEventListener('click',async()=>{
  if (changing || !connected) return;
  changing=true;visit.disabled=true;
  try {
    const state=await bridge.action(inside?'leave':'enter');
    showFeedback();render(state);
  } catch(error) {showFeedback(error?.message||'位置暂时无法更新');}
  finally {changing=false;void refresh();}
});

reducedMotion.addEventListener('change',()=>{poseKey='';if(renderingCommand)showPose(renderingCommand.operation,renderingCommand.id);else void refresh();});
populateParticles();
if (bridge) {
  void refresh();
  setInterval(()=>void refresh(),700);
}
