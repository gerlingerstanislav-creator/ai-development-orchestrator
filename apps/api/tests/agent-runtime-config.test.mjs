import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRuntimeEnabled} from '../dist/agent-runtime-config.js';

test('MCP agent runtime is enabled unless explicitly disabled',()=>{
 assert.equal(agentRuntimeEnabled(undefined),true,'No env override enables new system');
 assert.equal(agentRuntimeEnabled(''),true);
 assert.equal(agentRuntimeEnabled('true'),true);
 assert.equal(agentRuntimeEnabled('TRUE'),true);
 assert.equal(agentRuntimeEnabled('false'),false,'Emergency legacy fallback');
 assert.equal(agentRuntimeEnabled(' FALSE '),false);
 assert.equal(agentRuntimeEnabled('0'),false);
 assert.equal(agentRuntimeEnabled('off'),false);
 assert.equal(agentRuntimeEnabled('no'),false);
});
