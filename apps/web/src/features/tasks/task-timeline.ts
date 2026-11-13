/** Pure user-visible task activity timeline. No App state, API or React dependency. */
export type ActivityItem={id:string;kind:'user'|'assistant'|'event'|'run'|'note';text:string;time:string;title?:string;link?:string;status?:string;pending?:boolean;failed?:boolean};

type TimelineMessage={id:string;role:'user'|'assistant';body:string;created_at?:string;pending?:boolean;failed?:boolean};
type TimelineNote={id:string;author_name:string;target_stage:string;kind:string;body:string;answer?:string|null;status:string;created_at:string};
type TimelineEvent={id:string;event:string;detail:string;created_at:string};
type TimelineProcessEvent={id:string;process_kind:string;stage:string;detail:string;created_at:string;level:string};
type TimelineAgentRun={id:string;task_id:string;status:string;message?:string;created_at?:string;pr_url?:string|null};
type TimelineTestRun={
 id:string;task_id:string;status:string;message?:string;verdict?:string|null;created_at:string;completed_at?:string|null;
 report?:{summary?:string;checks?:Array<{name:string;result:string;details:string}>;
  findings?:Array<{severity:string;description:string;steps?:string}>;
  caseResults?:Array<{case_id:string;result:string;evidence:string}>}|null;
};
export type TaskTimelineArgs={
 taskId:string;messages:TimelineMessage[];notes:TimelineNote[];events:TimelineEvent[];
 processEvents:TimelineProcessEvent[];aiRuns:TimelineAgentRun[];activeTaskId?:string|null;
 taskTestRuns:TimelineTestRun[];testRuns:TimelineTestRun[];
};
export function buildTaskTimeline({
 taskId,messages,notes,events,processEvents,aiRuns,activeTaskId,taskTestRuns,testRuns
}:TaskTimelineArgs):ActivityItem[]{
  return [
   ...messages.map(m=>({id:'msg-'+m.id,kind:m.role,text:m.body,time:m.created_at||new Date().toISOString(),pending:m.pending,failed:m.failed})),
   ...notes.map(note=>({id:'note-'+note.id,kind:'note' as const,title:note.author_name+
    ' → '+(note.target_stage==='all'?'всем участникам':({analysis:'аналитику',development:'разработчику',testing:'тестировщику',merge_queue:'ответственному за слияние',deployment:'DevOps',documentation:'документатору'} as Record<string,string>)[note.target_stage]||note.target_stage)+
    ' · '+(note.kind==='question'?'Вопрос':note.kind==='risk'?'Риск':'Рабочий комментарий'),
    text:note.body+(note.answer?'\n\nОтвет: '+note.answer:note.status==='open'?'\n\nОжидает ответа':''),
    time:note.created_at})),
   ...events.map(ev=>({id:'evt-'+ev.id,kind:'event' as const,title:({
    created:'Задача создана',analyzed:'Анализ завершён',stage_changed:'Переход этапа',spec_changed:'Изменение требований',
    requirements_proposed:'Аналитик · требуется согласование',requirements_reviewed:'Аналитик · ТЗ проверено',requirements_approved:'Изменение ТЗ согласовано',
    requirements_rejected:'Изменение ТЗ отклонено',tests_passed:'Тестирование пройдено',
    tests_failed:'Замечания тестировщика',qa_tools_unavailable:'Тестировщик · проверки ограничены средой',
    qa_waiver_approved:'Непроверенные сценарии согласованы',handoff_blocked:'Передача на следующий этап остановлена',
    merged:'PR слит',deployment_skipped:'Выкладка пропущена',deployment_pending:'Ожидает выкладки',deployment_manual_confirmed:'Ручная выкладка подтверждена',documentation_updated:'Документация обновлена'
   } as Record<string,string>)[ev.event]||'Событие задачи',text:ev.detail,time:ev.created_at})),
   ...processEvents.map(ev=>({id:'process-'+ev.id,kind:'event' as const,title:(ev.process_kind==='testing'?'Тестировщик':ev.process_kind==='analysis'?'Аналитик':ev.process_kind==='development'?'Разработчик':'Процесс')+' · '+({
    review_started:'Сверка требований',needs_approval:'Нужно решение',current:'ТЗ актуально',test_design_started:'Генерация тест-кейсов',
    test_design_ready:'QA-план готов',test_design_failed:'Ошибка подготовки QA',started:'Работа запущена',
    progress:'Выполнение',passed:'Проверки пройдены',failed:'Ошибка или дефект',blocked:'Не удалось проверить',
    approved:'Переход к слиянию',awaiting_manual_qa_decision:'Требуется решение по тестам'
   } as Record<string,string>)[ev.stage]||ev.stage,text:ev.detail,time:ev.created_at,failed:ev.level==='error'})),
   ...aiRuns.filter(r=>r.task_id===taskId).map(r=>({id:'run-'+r.id,kind:'run' as const,title:r.status==='completed'?'Разработка завершена':r.status==='failed'?'Ошибка разработки':r.status==='running'?'Codex работает':'Задача в очереди',text:r.message||'Агент выполняет задачу',time:r.created_at||new Date().toISOString(),status:r.status,link:r.pr_url||undefined})),
   ...(activeTaskId===taskId&&taskTestRuns.length?taskTestRuns:testRuns.filter(r=>r.task_id===taskId)).map(r=>({id:'test-'+r.id,kind:'run' as const,title:r.status==='completed'?(r.verdict==='passed'?'Тесты пройдены':r.verdict==='failed'?'Тестировщик обнаружил ошибки':'Тестирование требует внимания'):r.status==='failed'?'Ошибка тестирования':r.status==='queued'?'Тестировщик в очереди':'AI-тестировщик работает',
    text:[r.report?.summary||r.message||'Тестировщик выполняет проверку',
     ...(r.report?.checks||[]).map(c=>c.name+': '+c.result+(c.details?' — '+c.details:'')),
     ...(r.report?.findings||[]).map(f=>'Дефект ('+f.severity+'): '+f.description+(f.steps?' · '+f.steps:'')),
     ...(r.report?.caseResults||[]).slice(0,30).map(c=>c.case_id+': '+c.result+(c.evidence?' — '+c.evidence:''))
    ].filter(Boolean).join('\n'),time:r.completed_at||r.created_at,status:r.status,failed:r.status==='failed'}))
  ].sort((a,b)=>new Date(a.time).getTime()-new Date(b.time).getTime());
 }

