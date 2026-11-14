import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestSecurity} from '../vendor/dsh-pet/lib/silicon-host.js';

test('生命空间模块可在首次登录前加载，敏感 API 仍需要令牌',()=>{
  const security=createRequestSecurity();
  const request=path=>({url:path,method:'GET',headers:{host:'127.0.0.1:19374'},socket:{localPort:19374}});
  const response=()=>({status:0,writeHead(status){this.status=status;},end(){},setHeader(){}});
  for(const asset of ['/life/app.js','/life/finance.js','/life/companion.js','/life/model.js'])assert.equal(security.authorize(request(asset),response()),true,asset);
  const unauthenticated=response();assert.equal(security.authorize(request('/api/life/companion'),unauthenticated),false);assert.equal(unauthenticated.status,403);
});
