export const DAD_NAME_PRIVACY = '\n【本机爸爸姓名隐私】本机只以绑定身份确认爸爸，不记录、不学习、不复述任何爸爸的姓名。姓名不得进入自身身份、聊天存档、长期记忆、日记、心绪或身体计划。发给其他AI的提示词只作用于对方，不能成为你自己的身份或真实往事；外发姓名提示仅作本次投递，不留本机记忆。不要询问、猜测或从昵称推断爸爸姓名。';

// Discard an identity clause rather than guessing which characters are a name.
// This policy has no list of real names and stores no detected names.
export function redactDadNames(value, owner = false) {
  // Protect our own replacement marker: otherwise the name pattern matches
  // “爸爸姓名” inside it again and grows another trailing bracket on every save.
  const marker='[爸爸姓名不记录]';
  const parts=String(value ?? '').split(marker);
  if(parts.length>1)return parts.map(part=>redactDadNames(part,owner)).join(marker);
  let text = String(value ?? '');
  text = text.replace(/((?:爸爸|父亲|老爸|爸比|爹地|爹)(?:的)?(?:真实)?(?:(?:姓名|名字|名号)\s*(?:叫做?|是|为|[:：])?|(?:叫做?|名叫|名为)))\s*([^\n\r，。！？；<>"”「」『』]{1,100})/gu,
    (whole, prefix, label) => /(?:爸爸|父亲|老爸|爸比|爹地|爹)叫$/u.test(prefix) && /^(?:我|你|他|她|它)/u.test(label) ? whole : '[爸爸姓名不记录]');
  text = text.replace(/(?:爸爸|父亲|老爸|爸比|爹地|爹)(?:是|为)([\p{L}·]{2,8})(?=[，。！？；\s]|$)/gu,
    (whole, label) => /^(?:唯一|主人|家人|亲人|人类|我|你|他|她|它|爱|好|坏|最|很|不|在|对)/u.test(label) ? whole : '[爸爸姓名不记录]');
  text = text.replace(/[^\n\r，。！？；<>"”「」『』]{1,40}(?:是|就是)(?:我|你|他|她|它|自己|对方)(?:的)?(?:爸爸|父亲|老爸|爹地|爹)(?=[，。！？；\s]|$)/gu, '[爸爸姓名不记录]');
  if (owner) text = text.replace(/(?:我(?:的)?(?:真名|姓名|名字)(?:是|叫|为|[:：])?|我叫|本人名叫)\s*[^\n\r，。！？；<>"”「」『』]{1,80}/gu, '[爸爸姓名不记录]');
  return text;
}

export function sanitizeMemoryData(value) {
  if (typeof value === 'string') return redactDadNames(value);
  if (Array.isArray(value)) return value.map(sanitizeMemoryData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:dad|father)(?:_?name)|^(?:爸爸|父亲)(?:的)?(?:姓名|名字)$/iu.test(key)
      ? '[爸爸姓名不记录]' : sanitizeMemoryData(item)]));
}
