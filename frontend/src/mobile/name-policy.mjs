export const NICKNAME_MAX_LENGTH = 8;
export const TRAINING_NAME_MAX_LENGTH = 20;

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;

export function nameCharacters(value) {
  return segmenter ? Array.from(segmenter.segment(value), item => item.segment) : Array.from(value);
}

const blockedNicknameTerms = [
  '傻逼', '傻比', '煞笔', '操你妈', '草泥马', '去你妈', '妈卖批', '死全家', '滚你妈',
  '约炮', '招嫖', '卖淫', '裸聊', '成人色情', '代办假证', '出售毒品', '枪支出售', '博彩代理',
  '弓行记客服', '弓行记官方', '弓行记管理员', 'fuck', 'bitch', 'nigger',
];

export function nicknameValidationMessage(value) {
  const name = value.trim();
  if (!name || nameCharacters(name).length > NICKNAME_MAX_LENGTH) return '昵称请填写 1–8 个字。';
  if (/[\p{Cc}\p{Bidi_Control}]/u.test(value)) return '昵称不能包含控制字符。';
  // Normalize only for matching so the displayed nickname retains its original spelling.
  const matchText = name.normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{P}\p{S}\p{Default_Ignorable_Code_Point}]/gu, '');
  return blockedNicknameTerms.some(term => matchText.includes(term)) ? '昵称含有违禁词，请更换。' : '';
}
