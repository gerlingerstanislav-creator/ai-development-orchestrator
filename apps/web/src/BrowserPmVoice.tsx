import {useEffect,useRef,useState} from 'react';
import {Mic,MicOff,Volume2,VolumeX} from 'lucide-react';

type Result={isFinal:boolean;[index:number]:{transcript:string}};
type Recognition={lang:string;continuous:boolean;interimResults:boolean;onresult:((e:{resultIndex:number;results:ArrayLike<Result>})=>void)|null;onerror:((e:{error:string})=>void)|null;onend:(()=>void)|null;start:()=>void;abort:()=>void};
type RecognitionCtor=new()=>Recognition;
type SpeechWindow=Window&{SpeechRecognition?:RecognitionCtor;webkitSpeechRecognition?:RecognitionCtor};
const speechCtor=()=>typeof window==='undefined'?undefined:(window as SpeechWindow).SpeechRecognition||(window as SpeechWindow).webkitSpeechRecognition;
const cleanSpeech=(s:string)=>s.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g,'Фрагмент кода.')
 .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*_#>|~]/g,'').trim().slice(0,3500);
type Props={latestAssistant:{id:string;body:string}|null;disabled:boolean;onSend:(message:string)=>void};

export function BrowserPmVoice({latestAssistant,disabled,onSend}:Props){
 const supported=!!speechCtor();
 const canSpeak=typeof window!=='undefined'&&'speechSynthesis' in window&&'SpeechSynthesisUtterance' in window;
 const [active,setActive]=useState(false);
 const [listening,setListening]=useState(false);
 const [speaking,setSpeaking]=useState(false);
 const [audioOn,setAudioOn]=useState(true);
 const [hint,setHint]=useState('');
 const rec=useRef<Recognition|null>(null);
 const enabled=useRef(false);
 const waiting=useRef(false);
 const finalText=useRef('');
 const lastReply=useRef(latestAssistant?.id||null);
 const send=useRef(onSend);send.current=onSend;
 const disabledRef=useRef(disabled);disabledRef.current=disabled;
 const audioRef=useRef(audioOn);audioRef.current=audioOn;
 function stop(){
  enabled.current=false;waiting.current=false;
  setActive(false);setListening(false);setSpeaking(false);setHint('');
  rec.current?.abort();rec.current=null;
  if(canSpeak)window.speechSynthesis.cancel();
 }
 function listen(){
  if(!enabled.current||disabledRef.current||rec.current)return;
  const Ctor=speechCtor();
  if(!Ctor){setHint('Распознавание не поддерживается браузером.');return;}
  const instance=new Ctor();rec.current=instance;finalText.current='';
  instance.lang='ru-RU';instance.continuous=false;instance.interimResults=false;
  instance.onresult=e=>{
   for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)finalText.current+=' '+e.results[i][0].transcript;
  };
  instance.onerror=e=>{
   if(e.error==='aborted')return;
   finalText.current='';
   setHint(e.error==='not-allowed'||e.error==='service-not-allowed'
    ?'Разреши микрофон в настройках браузера.'
    :e.error==='no-speech'?'Речь не распознана. Нажми микрофон ещё раз.'
    :'Ошибка распознавания: '+e.error+'. Нажми микрофон ещё раз.');
  };
  instance.onend=()=>{
   if(rec.current!==instance)return;
   rec.current=null;setListening(false);
   if(!enabled.current)return;
   const message=finalText.current.trim();finalText.current='';
   if(!message){setHint(s=>s||'Нажми микрофон ещё раз.');return;}
   lastReply.current=latestAssistant?.id||null;
   waiting.current=true;setHint('Жду ответ ПМ');
   send.current(message);
  };
  try{instance.start();setListening(true);setHint('Слушаю…');}
  catch{rec.current=null;setListening(false);setHint('Не удалось запустить микрофон. Нажми ещё раз.');}
 }
 function speak(body:string){
  if(!enabled.current)return;
  if(!canSpeak||!audioRef.current){listen();return;}
  const text=cleanSpeech(body);
  if(!text){listen();return;}
  window.speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(text);
  utterance.lang='ru-RU';
  utterance.onend=()=>{setSpeaking(false);if(enabled.current)listen();};
  utterance.onerror=()=>{setSpeaking(false);if(enabled.current)setHint('Озвучивание недоступно. Нажми микрофон.');};
  setSpeaking(true);setHint('ПМ отвечает…');
  window.speechSynthesis.speak(utterance);
 }
 useEffect(()=>{
  if(waiting.current&&enabled.current&&latestAssistant&&latestAssistant.id!==lastReply.current){
   waiting.current=false;lastReply.current=latestAssistant.id;speak(latestAssistant.body);
  }else if(!waiting.current)lastReply.current=latestAssistant?.id||null;
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[latestAssistant?.id]);
 useEffect(()=>{if(disabled&&enabled.current)stop();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[disabled]);
 useEffect(()=>()=>{enabled.current=false;rec.current?.abort();rec.current=null;if(canSpeak)window.speechSynthesis.cancel();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 function toggle(){
  if(enabled.current){
   if(!listening&&!speaking&&!waiting.current)listen();
   else stop();
   return;
  }
  if(disabled||!supported)return;
  enabled.current=true;setActive(true);lastReply.current=latestAssistant?.id||null;listen();
 }
 if(!supported)return <button type="button" className="secondary pm-voice-action" disabled title="В этом браузере нет распознавания речи" aria-label="Голосовой ввод недоступен"><MicOff size={16}/></button>;
 return <div className="pm-voice-controls">
  <button type="button" className={'secondary pm-voice-action'+(active?' active':'')} disabled={disabled} onClick={toggle}
   title={active?(listening||speaking||waiting.current?'Остановить голосовой разговор':'Продолжить разговор'):'Начать голосовой разговор'}
   aria-label={active?'Управление голосовым разговором':'Начать голосовой разговор'}>{active&&listening?<MicOff size={16}/>:<Mic size={16}/>}</button>
  {canSpeak&&<button type="button" className="secondary pm-voice-action" title={audioOn?'Отключить озвучивание':'Включить озвучивание'}
   aria-label={audioOn?'Отключить озвучивание':'Включить озвучивание'} onClick={()=>{
    setAudioOn(!audioOn);if(audioOn){window.speechSynthesis.cancel();setSpeaking(false);if(enabled.current&&!listening&&!waiting.current)listen();}
   }}>{audioOn?<Volume2 size={16}/>:<VolumeX size={16}/>}</button>}
  {active&&<span className="pm-voice-hint" title={hint} role="status">{hint||'Голосовой режим'}</span>}
 </div>;
}
