import test from 'node:test';
import assert from 'node:assert/strict';
import {qaPrerequisiteError} from './qa-preflight.mjs';

test('QA identifies a broken Python runner as infrastructure, not manual QA',()=>{
 assert.match(qaPrerequisiteError(['README.md','retry_delivery.py'],'node: available\npython3_runtime: unavailable'),/Ошибка окружения QA/);
 assert.match(qaPrerequisiteError(['pkg/requirements.txt'],'python3: available'),/Python 3/);
 assert.match(qaPrerequisiteError(['src/main.py'],'python3_runtime: unavailable'),/docker compose/);
 assert.equal(qaPrerequisiteError(['src/main.py'],'python3_runtime: ok'),null);
});
test('QA does not block Node-only projects for missing Python',()=>{
 assert.equal(qaPrerequisiteError(['src/index.js','package.json'],'python3_runtime: unavailable'),null);
 assert.equal(qaPrerequisiteError(['README.md','Dockerfile'],'python3_runtime: unavailable'),null);
});
