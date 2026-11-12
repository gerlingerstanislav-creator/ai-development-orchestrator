import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverProjectCi,classifyProjectCi} from './ci-test-discovery.mjs';

test('discovers actual tests in the problematic eight-lines PR without pytest config or npm',()=>{
 const files=['Makefile','README.md','index.html','lines.html','tests','tests/check_lines.py','tests/test_lines.py'];
 const plan=discoverProjectCi(files,'.PHONY: test\n\ntest:\n\tpython3 tests/check_lines.py\n');
 assert.equal(plan.pytest,true,'pytest discovers tests/test_lines.py without pytest.ini');
 assert.deepEqual(plan.pythonTests,['tests/test_lines.py']);
 assert.equal(plan.makeTest,true,'existing Makefile target can also run');
 assert.equal(plan.makefile,'Makefile');
 assert.equal(classifyProjectCi([{name:'merge compatibility',exitCode:0},{name:'python tests',exitCode:0}],1),'passed');
});

test('an executable Python test without config is recognized and is not treated as no CI',()=>{
 assert.equal(discoverProjectCi(['src/app.py','tests/test_app.py']).pytest,true);
 assert.equal(discoverProjectCi(['src/app.py','tests/app_test.py']).pytest,true);
 assert.equal(discoverProjectCi(['src/app.py','pytest.ini']).pytest,true);
 assert.equal(discoverProjectCi(['src/app.py']).pytest,false);
 assert.equal(discoverProjectCi(['README.md']).pytest,false);
});

test('a real failing test is a product failure; missing test discovery is blocked, never failed',()=>{
 assert.equal(classifyProjectCi([{name:'supported tests',exitCode:null}],0),'blocked');
 assert.equal(classifyProjectCi([{name:'merge compatibility',exitCode:0}],0),'blocked');
 assert.equal(classifyProjectCi([{name:'python tests',exitCode:1}],1),'failed');
 assert.equal(classifyProjectCi([{name:'python tests',exitCode:0}],1),'passed');
 assert.throws(()=>classifyProjectCi([], -1),/Invalid/);
});

test('Makefile discovery requires an explicit test recipe, not .PHONY or comments',()=>{
 assert.equal(discoverProjectCi(['Makefile'],'# test:\n.PHONY: test\nall:\n\ttrue').makeTest,false);
 assert.equal(discoverProjectCi(['Makefile'],'.PHONY: test\ntest: check\n\tpython3 tests/check_lines.py').makeTest,true);
 assert.equal(discoverProjectCi(['GNUmakefile'],'test:\n\tpython3 tests/check_lines.py').makeTest,true);
 assert.equal(discoverProjectCi(['README.md'],'test:\n\ttrue').makeTest,false);
});
