import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHealthUrl,validateSshTarget} from '../dist/deployment-automation.js';
import {deploymentDecision} from '../dist/deployment-stage.js';

test('deployment decisions keep automatic as pending and preserve explicit skip/manual',()=>{
 assert.equal(deploymentDecision('automatic').status,'pending');
 assert.equal(deploymentDecision('manual').status,'pending');
 assert.equal(deploymentDecision('skip').status,'skipped');
 assert.equal(deploymentDecision('skip').stage,'documentation');
 assert.throws(()=>deploymentDecision('unknown'));
});
test('health probes reject localhost, raw IP, http, credentials and custom port',()=>{
 for(const url of ['http://example.com/health','https://localhost/','https://127.0.0.1/','https://[::1]/','https://example.com:8443/','https://user:secret@example.com/','https://x.internal/']){
  assert.throws(()=>validateHealthUrl(url),url);
 }
 assert.equal(validateHealthUrl('https://example.com/health'),'https://example.com/health');
});
test('self-hosted SSH target requires a pinned known_hosts entry and safe inputs',()=>{
 const target={host:'deploy.example.com',username:'deploy',path:'/srv/orchestrator',knownHosts:'deploy.example.com ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ'};
 assert.deepEqual(validateSshTarget(target),target);
 for(const item of [
  {...target,host:'127.0.0.1'},
  {...target,host:'host;id'},
  {...target,username:'root;id'},
  {...target,path:'/srv/../etc'},
  {...target,path:'/srv/a;rm'},
  {...target,knownHosts:'evil.example.com ssh-ed25519 AAAA'}
 ])assert.throws(()=>validateSshTarget(item));
});
