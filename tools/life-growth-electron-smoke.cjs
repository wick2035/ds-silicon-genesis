'use strict';
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dafei-growth-ui-'));
app.setPath('userData',profile);
const directory=path.resolve(__dirname,'../src/ui');
const assets=new Set(['index.html','app.js','bridge.js','style.css','finance.js','companion.js','model.js','memory-graph.js']);
const stamp='2026-11-19T06:00:00Z';
const sources={weather:{text:'下过一场大雨',at:stamp},receipt:{text:'读到了研究资料',at:stamp}};
const goals={items:[
  {id:'research',title:'了解鲸类怎样用歌声交流',kind:'self-directed',status:'active',sourceIds:['weather']},
  {id:'wait',title:'等水稻长好再看看',kind:'explore',status:'deferred',sourceIds:['weather'],
    review:{at:stamp,reason:'田里的水已经够了'}}
],plans:[{id:'reading',goalId:'research',status:'active',steps:[
  {description:'查找鲸鱼歌声的资料',status:'completed',receiptEventId:'receipt'},
  {description:'结合资料想想怎么交流',status:'awaiting_receipt',receiptEventId:'receipt'}
]}],sources};
const growth={sources,worldModel:{facts:[{topic:'farm.weather',value:'雨水补足了两次浇水。',day:'2026-11-19',valid:true,sourceIds:['weather']}]},
  selfModel:{habits:[{label:'work:rest',value:'休息之后再去搬完。',valid:true,sourceIds:['receipt']}]},memories:[],plans:[],observations:[],beliefs:[]};
let server,empty=false;
const deadline=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
  server=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://localhost');
    if(route.pathname.startsWith('/api/life/')){
      const endpoint=route.pathname.split('/').at(-1);
      const data={goals:empty?{items:[],plans:[],sources}:goals,growth:empty?{...growth,worldModel:{facts:[]},selfModel:{habits:[]}}:growth,
        snapshot:{sources,runtime:{paused:false}},'memory-graph':{nodes:[],edges:[]}};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value:data[endpoint]??{sources}}));return;
    }
    const name=route.pathname==='/life/'?'index.html':route.pathname.split('/').at(-1);
    if(!assets.has(name)){res.writeHead(404);res.end();return;}
    const format=name.endsWith('.js')?'javascript':name.endsWith('.css')?'css':'html';
    res.writeHead(200,{'content-type':`text/${format}; charset=utf-8`});
    fs.createReadStream(path.join(directory,name)).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{backgroundThrottling:false}});
  const evaluate=code=>win.webContents.executeJavaScript(code);
  const waitFor=async code=>{
    for(let attempt=0;attempt<120;attempt++){
      if(await evaluate(code))return;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw Error('页面状态超时 '+code+' · '+await evaluate("document.querySelector('#notice').textContent+' '+document.querySelector('#view').innerText.slice(0,180)"));
  };
  const open=async(page,expected)=>{
    await evaluate(`document.querySelector('[data-page="${page}"]').click()`);
    await waitFor(`document.querySelector('#view').textContent.includes(${JSON.stringify(expected)})`);
  };
  const noOverflow=()=>evaluate('document.documentElement.scrollWidth <= window.innerWidth+1');
  const url='http://127.0.0.1:'+server.address().port+'/life/';
  await win.loadURL(url);
  await waitFor("document.querySelector('#connection').textContent==='已连接'");
  for(const width of [1180,390]){
    win.setSize(width,720);
    await open('goals','等待确认');
    assert.ok(await evaluate("document.querySelector('#view').textContent.includes('田里的水已经够了')"));
    await evaluate("document.querySelector('.goal-row summary').click();document.querySelector('.goal-steps summary').click()");
    assert.ok(await evaluate("document.querySelector('.goal-steps details[open]').innerText.includes('读到了研究资料')"));
    assert.equal(await noOverflow(),true);
    await open('growth','成长档案');
    await evaluate("(()=>{const archive=document.querySelector('[data-growth-section=archive]');if(archive.getAttribute('aria-pressed')!=='true')archive.click()})()");
    await waitFor("document.querySelector('#view').textContent.includes('她记住的稻田')");
    assert.ok(await evaluate("document.querySelector('#view').textContent.includes('先恢复再搬')"));
    assert.equal(await noOverflow(),true);
    await evaluate('window.scrollTo(0,0)');
    await waitFor("document.querySelector('[data-growth-section=archive]')?.getAttribute('aria-pressed')==='true'");
    await fs.promises.writeFile(path.join(profile,`growth-${width}.png`),(await win.webContents.capturePage()).toPNG());
  }
  empty=true;
  await win.loadURL(url);
  await waitFor("document.querySelector('#connection').textContent==='已连接'");
  await open('goals','有了她想继续的事');
  await open('growth','成长档案');
  await evaluate("document.querySelector('[data-growth-section=archive]').click()");
  await waitFor("document.querySelector('#view').textContent.includes('这里会积累她能用上的经验')");
  win.destroy();
  console.log('目标与成长页面通过 1180px / 390px 渲染检查，截图目录 '+profile);
}).then(()=>{clearTimeout(deadline);server?.close();app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);server?.close();app.exit(1);});
