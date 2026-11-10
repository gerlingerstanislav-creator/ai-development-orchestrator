import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHealthUrl,deploymentWorkflowTemplate} from '../dist/deployment-automation.js';
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
test('generated workflow is manually dispatched for immutable SHA and scoped environment',()=>{
 const yaml=deploymentWorkflowTemplate();
 assert.match(yaml,/workflow_dispatch:/);
 assert.match(yaml,/inputs.sha/);
 assert.match(yaml,/inputs.request_id/);
 assert.match(yaml,/concurrency:/);
 assert.match(yaml,/git rev-parse HEAD/);
 assert.match(yaml,/persist-credentials: false/);
 assert.match(yaml,/StrictHostKeyChecking=yes/);
 assert.match(yaml,/secrets.DEPLOY_HOST_KEY/);
 assert.doesNotMatch(yaml,/\npush:/);
});
