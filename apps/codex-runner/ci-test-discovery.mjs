/**
 * Technical CI discovery is deterministic and must not depend on the model.
 * Find real tracked tests (not only test framework configuration). In
 * particular, pytest discovers tests/test_*.py without pytest.ini.
 */
const pythonTest=/(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i;
const pythonConfig=/(?:^|\/)(?:pytest\.ini|pyproject\.toml|tox\.ini|setup\.cfg)$/i;
const makefileNames=new Set(['Makefile','GNUmakefile','makefile']);

export function discoverProjectCi(trackedFiles,makefileText=''){
 const tracked=new Set(trackedFiles.filter(path=>typeof path==='string'));
 const pythonTests=[...tracked].filter(path=>pythonTest.test(path));
 const pythonSource=[...tracked].some(path=>/\.py$/i.test(path));
 const pytest=pythonTests.length>0 || (pythonSource && [...tracked].some(path=>pythonConfig.test(path)));
 const makefile=[...makefileNames].find(name=>tracked.has(name));
 // A simple explicit Make target, not a .PHONY declaration or a comment.
 const makeTest=!!makefile && /^test\s*:(?![=])/m.test(String(makefileText||''));
 return {pytest,pythonTests,makeTest,makefile:makefile||null};
}

/** Three outcomes: an unavailable check is not a failed implementation. */
export function classifyProjectCi(checks,executed){
 if(!Number.isInteger(executed)||executed<0)throw Error('Invalid CI execution count');
 if(executed===0)return 'blocked';
 return checks.every(check=>check.exitCode===0)?'passed':'failed';
}
