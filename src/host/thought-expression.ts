/** A brief subjective feeling/intent, never a reasoning transcript. */
export function extractThought(text:string):{feeling:string;reply:string} {
  if(text.includes('<念头>')&&!text.includes('</念头>'))throw Error('发言前的念头尚未完成');
  const match=/<念头>([\s\S]*?)<\/念头>/u.exec(text);
  return {feeling:match?.[1].trim().slice(0,500)??'',reply:text.replace(/<念头>[\s\S]*?<\/念头>/gu,'').trim()};
}
