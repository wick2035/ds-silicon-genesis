import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {BODY_ACTIONS} from '../vendor/pet-plugins/behavior/embodiment.mjs';

for(const [itemId,expected] of [['parent','吃白饭'],['rice-inventory','吃饭·碗饭']]) {
  test(`${itemId}: 喂饭与自主进食使用各自动画，播放结束才报告完成`,async()=>{
    const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8');
    const receipts=[],poses=[];let ended,frames=0;
    const video={readyState:2,paused:false,playbackRate:1,addEventListener(name,cb){if(name==='ended')ended=cb;}};
    class Sprite{playIdle(){} switchTo(name){poses.push(name);this.anim=name;} dispose(){} showWhisper(){}}
    vm.runInNewContext(source,{PetSprite:Sprite,window:{petBridge:{reportActionReceipt:async r=>receipts.push(r)}},
      requestAnimationFrame(fn){return setImmediate(()=>{if(++frames===2){assert.deepEqual(receipts.map(r=>r.status),['playing']);ended();}fn();});},
      cancelAnimationFrame:clearImmediate,setTimeout,clearTimeout,setInterval,clearInterval});
    const sprite=new Sprite();Object.assign(sprite,{ac:new AbortController(),dragState:{active:false},front:0,videoA:video,videoB:video,pos:{x:0,y:0},stopMove(){}});
    await sprite.executeBody({id:'feed',actionId:'feed',itemId,index:0,source:'silicon-eat',steps:[{action:'eat'}]},BODY_ACTIONS);
    assert.deepEqual(poses,[expected]);
    assert.deepEqual(receipts.map(r=>r.status),['playing','completed']);
    assert.equal(receipts[1].played,true);
    assert.equal(sprite.bodyExecuting,false);
  });
}
