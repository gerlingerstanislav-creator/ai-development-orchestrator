/** A bounded structured answer is a value, not execution evidence. */
export function jsonObject(text:string):Record<string,unknown>{
 const first=text.indexOf('{'),last=text.lastIndexOf('}');
 if(first<0||last<=first)throw new Error('AI не вернул структурированный ответ');
 try{return JSON.parse(text.slice(first,last+1));}
 catch{throw new Error('AI вернул некорректный JSON. Повтори запрос.');}
}
