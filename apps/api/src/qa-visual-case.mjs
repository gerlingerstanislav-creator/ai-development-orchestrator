/**
 * Exactly one interpretation of which acceptance criteria require real browser
 * evidence. Shared by API and Runner: a command receipt about a "visual"
 * case must not be counted as a Chromium assertion.
 *
 * This is a classifier for evidence modality, not a source of requirements.
 */
export function isVisualAcceptanceCase(test={}){
 const steps=Array.isArray(test.steps)?test.steps:[];
 const words=[test.title,test.description,test.area,test.execution_mode,
  ...steps.flatMap(step=>[step.action,step.expected])].filter(Boolean).join(' ');
 return /(визуальн|видим|отображен|выгляд|интерфейс|кнопк|расположен|окружност|стрелк|фигур|цвет|геометр|параллел|лини[ияй]|адаптив|скриншот|браузер|отрисов|верстк|перекрыв|размер(?:а|ов)? экрана|ui\b|css\b|canvas|svg|pixel|layout|render|click|responsive|screenshot|viewport|scroll)/i.test(words);
}
