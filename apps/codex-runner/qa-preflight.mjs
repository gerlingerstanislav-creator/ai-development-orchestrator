// A missing project runtime is an infrastructure fault, not a QA waiver.
const pythonSource=/(^|\/)(?:[^/]+\.py|pyproject\.toml|requirements(?:-[^/]*)?\.txt|Pipfile|setup\.cfg|tox\.ini)$/i;

export function qaPrerequisiteError(trackedFiles,capabilities){
 const python=trackedFiles.some(path=>pythonSource.test(String(path)));
 if(!python)return null;
 if(!/^python3_runtime: ok$/m.test(String(capabilities))){
  return 'Ошибка окружения QA: Python 3 не запускается внутри изолированного Codex Runner, хотя требуется репозиторию. Это не ручная проверка и не повод пропускать QA. Пересобери и пересоздай контейнер: docker compose up -d --build --force-recreate codex; затем повтори QA.';
 }
 return null;
}
