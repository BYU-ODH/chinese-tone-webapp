/*
 * pinyin-segment.mjs — categorize ToneAudio-style recording filenames by
 * syllable count (single word / double word / phrase), and build a manifest
 * of the corpus for evaluate-toneaudio.mjs.
 *
 * Filenames encode pinyin + tone digits, but are otherwise messy real-world
 * data: take-index suffixes, "-slow"/"-fast-casual"/"-faster" speech-rate
 * tags, free-text descriptions, "(N)" citation-vs-surface tone annotations,
 * spaces, punctuation, mixed case. Neutral-tone syllables carry no digit
 * (ba4ba = ba4 + ba, two syllables), so syllable count comes from greedy
 * longest-match segmentation against the canonical pinyin inventory, not
 * from counting digits.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PINYIN = new Set(`
a o e ai ei ao ou an en ang eng er
ba bo bai bei bao ban ben bang beng bi bie biao bian bin bing bu
pa po pai pei pao pou pan pen pang peng pi pie piao pian pin ping pu
ma mo me mai mei mao mou man men mang meng mi mie miao miu mian min ming mu
fa fo fei fou fan fen fang feng fu
da de dai dei dao dou dan den dang deng dong di die diao diu dian ding du duo dui duan dun
ta te tai tei tao tou tan tang teng tong ti tie tiao tian ting tu tuo tui tuan tun
na ne nai nei nao nou nan nen nang neng nong ni nie niao niu nian nin niang ning nu nuo nuan nv nve
la le lai lei lao lou lan lang leng long li lia lie liao liu lian lin liang ling lu luo luan lun lv lve lo
ga ge gai gei gao gou gan gen gang geng gong gu gua guo guai gui guan gun guang
ka ke kai kei kao kou kan ken kang keng kong ku kua kuo kuai kui kuan kun kuang
ha he hai hei hao hou han hen hang heng hong hu hua huo huai hui huan hun huang
ji jia jie jiao jiu jian jin jiang jing jiong ju jue juan jun
qi qia qie qiao qiu qian qin qiang qing qiong qu que quan qun
xi xia xie xiao xiu xian xin xiang xing xiong xu xue xuan xun
zha zhe zhi zhai zhei zhao zhou zhan zhen zhang zheng zhong zhu zhua zhuo zhuai zhui zhuan zhun zhuang
cha che chi chai chao chou chan chen chang cheng chong chu chua chuo chuai chui chuan chun chuang
sha she shi shai shei shao shou shan shen shang sheng shu shua shuo shuai shui shuan shun shuang
re ri rao rou ran ren rang reng rong ru rua ruo rui ruan run
za ze zi zai zei zao zou zan zen zang zeng zong zu zuo zui zuan zun
ca ce ci cai cao cou can cen cang ceng cong cu cuo cui cuan cun
sa se si sai sao sou san sen sang seng song su suo sui suan sun
ya ye yao you yan yin yang ying yong yi yu yue yuan yun yo
wa wo wai wei wan wen wang weng wu
`.trim().split(/\s+/));
const MAXLEN = 6; // longest pinyin syllable (e.g. 'zhuang')

/*
 * Cut a filename down to its bare pinyin+tone token.
 *   ba1-01.mp3 -> ba1        bei3jing1-04-faster-casual.mp3 -> bei3jing1
 *   ni2(3)hao3.mp3 -> ni2hao3   (citation-tone annotation stripped)
 */
export function parseToken (fname) {
  let s = fname.replace(/\.mp3$/i, '').toLowerCase();
  s = s.replace(/[ǚǔǘǜü]/g, 'v');
  // Cut at the first separator-delimited 1-2 digit run (take index) and
  // everything after it (speech-rate / description tail).
  const cut = s.search(/[-_ ]\d{1,2}(?=$|[-_ ])/);
  let token = cut >= 0 ? s.slice(0, cut) : s;
  token = token.replace(/\(\d\)/g, ''); // "(3)" citation-tone annotations
  return token;
}

export function toneDigits (token) {
  return (token.match(/[1-5]/g) || []).map(Number);
}

export function countSyllables (token) {
  const letters = token.replace(/[^a-z]/g, '');
  let i = 0, n = 0, guessed = 0;
  while (i < letters.length) {
    let matched = 0;
    for (let L = Math.min(MAXLEN, letters.length - i); L >= 1; L--) {
      if (PINYIN.has(letters.slice(i, i + L))) { matched = L; break; }
    }
    if (matched) { i += matched; n++; } else { i += 1; guessed++; n++; }
  }
  return { n, guessed };
}

export function categoryFor (nSyl) {
  if (nSyl <= 1) return 'single';
  if (nSyl === 2) return 'double';
  return 'phrase';
}

function speakerOf (root, path) {
  const rel = path.slice(root.length + 1);
  const top = rel.split('/')[0];
  return top.replace(/\s+Recording$/i, '');
}

function conditionOf (path) {
  for (const seg of path.split('/')) {
    if (/^noisy$/i.test(seg)) return 'Noisy';
    if (/^quiet$/i.test(seg)) return 'Quiet';
  }
  return null;
}

function walk (dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.toLowerCase().endsWith('.mp3')) out.push(p);
  }
  return out;
}

/**
 * Build the corpus manifest: one entry per mp3, with syllable-count category,
 * expected tones, and speaker/condition inferred from the directory layout.
 */
export function buildManifest (root) {
  const files = walk(root).sort();
  return files.map(path => {
    const token = parseToken(path.split('/').pop());
    const { n } = countSyllables(token);
    return {
      path, token, nSyl: n, tones: toneDigits(token), cat: categoryFor(n),
      speaker: speakerOf(root, path), condition: conditionOf(path)
    };
  });
}
