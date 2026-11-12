import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRateLimitCache,normalizeCodexRateLimits,readCodexRateLimits} from './rate-limits.mjs';

const result={rateLimitsByLimitId:{codex:{
 limitName:null,primary:{usedPercent:38,windowDurationMins:300,resetsAt:1770000000},
 secondary:{usedPercent:53,windowDurationMins:10080,resetsAt:1771000000},planType:'plus'
}},rateLimitResetCredits:{availableCount:1}};

test('parse documented Codex app-server limit buckets',()=>{
 const read=normalizeCodexRateLimits(result,'2026-11-12T00:00:00.000Z');
 assert.equal(read.windows.length,1);
 assert.equal(read.windows[0].primary.windowDurationMins,300);
 assert.equal(read.windows[0].secondary.windowDurationMins,10080);
 assert.equal(read.resetCredits,1);
 assert.equal(read.checkedAt,'2026-11-12T00:00:00.000Z');
});
test('legacy single Codex bucket remains supported',()=>{
 const read=normalizeCodexRateLimits({rateLimits:{limitId:'codex',primary:{usedPercent:21}}});
 assert.equal(read.windows[0].primary.usedPercent,21);
 assert.equal(read.windows[0].secondary,null);
});
test('one slow request serves concurrent callers, then caches until TTL',async()=>{
 let clock=1000,reads=0,release;
 const cache=createRateLimitCache(()=>{reads++;return new Promise(resolve=>{release=resolve;});},
  {now:()=>clock,freshMs:75000,backoffMs:15000});
 const a=cache.read();const b=cache.read();
 // Reader starts in a microtask; the two calls must share the same promise.
 await Promise.resolve();
 assert.equal(reads,1);
 release(normalizeCodexRateLimits(result));
 const [first,second]=await Promise.all([a,b]);
 assert.deepEqual(first,second);
 assert.equal(first.stale,false);
 assert.equal((await cache.read()).stale,false);
 assert.equal(reads,1);
 clock+=76000;
 const newer=cache.read();
 await Promise.resolve();
 assert.equal(reads,2);
 release(normalizeCodexRateLimits(result));
 await newer;
});
test('a temporary failure returns a marked snapshot, without launching a process on every poll',async()=>{
 let clock=1000,count=0;
 const cache=createRateLimitCache(async()=>{
  count++;if(count>1)throw Error('Codex app-server не отвечает');
  return normalizeCodexRateLimits(result);
 },{now:()=>clock,freshMs:1000,staleMs:10000,backoffMs:3000});
 await cache.read();
 clock+=2000;
 const stale=await cache.read();
 assert.equal(stale.stale,true);
 assert.match(stale.warning,/Codex app-server/);
 const second=await cache.read();
 assert.equal(second.stale,true);
 assert.equal(count,2);
 clock+=15000;
 await assert.rejects(()=>cache.read(),/Codex app-server/);
 assert.equal(count,3);
});
test('cold failures have cooldown; force refresh bypasses fresh cache but not a network backoff',async()=>{
 let clock=0,count=0;
 const cache=createRateLimitCache(async()=>{count++;throw Error('Upstream unreachable');},
  {now:()=>clock,backoffMs:2000});
 await assert.rejects(()=>cache.read(),/unreachable/);
 await assert.rejects(()=>cache.read({force:true}),/unreachable/);
 assert.equal(count,1);
 clock=2100;
 await assert.rejects(()=>cache.read({force:true}),/unreachable/);
 assert.equal(count,2);
});

test('stdio protocol starts with initialize and only then reads rate limits',async()=>{
 const calls=[];
 let child;
 class FakeChild extends EventEmitter{
  constructor(){super();this.stdout=new EventEmitter();this.stderr=new EventEmitter();this.killed=false;
   this.stdin=new EventEmitter();
   this.stdin.write=(raw,cb)=>{
    const m=JSON.parse(raw);calls.push(m);
    queueMicrotask(()=>{
     if(m.id===1)this.stdout.emit('data',JSON.stringify({id:1,result:{userAgent:'test'}})+'\n');
     if(m.id===2)this.stdout.emit('data',JSON.stringify({id:2,result})+'\n');
    });
    cb?.();
    return true;
   };
  }
  kill(){this.killed=true;return true;}
 }
 const reader=(bin,args,opts)=>{assert.equal(bin,'codex');assert.deepEqual(args,['app-server']);assert.deepEqual(opts.stdio,['pipe','pipe','pipe']);child=new FakeChild();return child;};
 const data=await readCodexRateLimits(reader,{timeoutMs:2000});
 assert.deepEqual(calls.map(m=>m.method),['initialize','initialized','account/rateLimits/read']);
 assert.equal(data.windows[0].primary.usedPercent,38);
 assert.equal(child.killed,true);
});
