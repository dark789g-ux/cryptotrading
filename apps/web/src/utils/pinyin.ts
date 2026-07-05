const PINYIN_MAP: Record<string, string> = {
  '强': 'qiang', '弱': 'ruo', '大': 'da', '小': 'xiao', '高': 'gao', '低': 'di',
  '新': 'xin', '旧': 'jiu', '长': 'chang', '短': 'duan', '快': 'kuai', '慢': 'man',
  '早': 'zao', '晚': 'wan', '前': 'qian', '后': 'hou', '上': 'shang', '下': 'xia',
  '左': 'zuo', '右': 'you', '内': 'nei', '外': 'wai', '中': 'zhong', '间': 'jian',
  '正': 'zheng', '负': 'fu', '主': 'zhu', '次': 'ci', '初': 'chu', '终': 'zhong', '段': 'duan',
  '超': 'chao', '非': 'fei', '半': 'ban', '全': 'quan', '整': 'zheng', '零': 'ling',
  '偏': 'pian', '很': 'hen', '极': 'ji', '较': 'jiao', '稍': 'shao',

  '多': 'duo', '空': 'kong', '头': 'tou', '市': 'shi', '牛': 'niu', '熊': 'xiong',
  '猴': 'hou', '涨': 'zhang', '跌': 'die', '横': 'heng', '盘': 'pan', '震': 'zhen',
  '荡': 'dang', '稳': 'wen', '烈': 'lie', '缓': 'huan', '急': 'ji',
  '企': 'qi', '回': 'hui', '调': 'tiao', '弹': 'tan', '拉': 'la', '升': 'sheng',
  '降': 'jiang', '突': 'tu', '破': 'po', '撤': 'che', '转': 'zhuan', '反': 'fan',

  '买': 'mai', '卖': 'mai', '持': 'chi', '观': 'guan', '望': 'wang', '看': 'kan',
  '做': 'zuo', '建': 'jian', '加': 'jia', '减': 'jian', '清': 'qing', '平': 'ping',
  '换': 'huan', '选': 'xuan', '筛': 'shai', '排': 'pai', '停': 'ting', '仓': 'cang',
  '控': 'kong', '止': 'zhi', '盈': 'ying', '损': 'sun',

  '开': 'kai', '收': 'shou', '红': 'hong', '绿': 'lv', '阴': 'yin', '阳': 'yang',
  '量': 'liang', '价': 'jia', '资': 'zi', '金': 'jin', '流': 'liu', '入': 'ru', '出': 'chu',
  '散': 'san', '户': 'hu', '压': 'ya', '支': 'zhi', '撑': 'cheng', '阻': 'zu', '力': 'li',
  '位': 'wei', '顶': 'ding', '底': 'di', '颈': 'jing', '线': 'xian', '趋': 'qu', '势': 'shi',
  '均': 'jun', '移': 'yi', '动': 'dong', '滑': 'hua', '指': 'zhi', '标': 'biao',
  '信': 'xin', '号': 'hao', '图': 'tu', '形': 'xing', '额': 'e', '幅': 'fu',

  '一': 'yi', '二': 'er', '三': 'san', '四': 'si', '五': 'wu', '六': 'liu',
  '七': 'qi', '八': 'ba', '九': 'jiu', '十': 'shi', '百': 'bai', '千': 'qian',
  '万': 'wan', '亿': 'yi',

  '年': 'nian', '月': 'yue', '日': 'ri', '周': 'zhou', '季': 'ji', '度': 'du',
  '天': 'tian', '时': 'shi', '分': 'fen', '秒': 'miao', '频': 'pin', '速': 'su',

  '个': 'ge', '只': 'zhi', '种': 'zhong', '类': 'lei', '项': 'xiang',
  '第': 'di', '版': 'ban', '本': 'ben', '期': 'qi', '名': 'ming', '称': 'cheng',
  '数': 'shu', '据': 'ju', '算': 'suan', '测': 'ce', '试': 'shi', '息': 'xi',

  '风': 'feng', '险': 'xian', '益': 'yi', '利': 'li', '亏': 'kui',
  '率': 'lv', '比': 'bi', '区': 'qu', '范': 'fan', '围': 'wei', '点': 'dian',

  '配': 'pei', '置': 'zhi', '策': 'ce', '略': 'lue', '方': 'fang',
  '法': 'fa', '案': 'an', '计': 'ji', '划': 'hua', '模': 'mo', '式': 'shi',
  '型': 'xing', '规': 'gui', '则': 'ze', '条': 'tiao', '件': 'jian',

  '创': 'chuang', '业': 'ye', '板': 'ban', '象': 'xiang', '限': 'xian',
  '场': 'chang', '股': 'gu', '融': 'rong', '银': 'yin', '行': 'hang',
  '保': 'bao', '地': 'di', '产': 'chan', '医': 'yi', '药': 'yao',
  '消': 'xiao', '费': 'fei', '科': 'ke', '技': 'ji', '能': 'neng', '源': 'yuan',
  '值': 'zhi', '成': 'cheng',
  '健': 'jian', '激': 'ji', '进': 'jin', '波': 'bo',
  '交': 'jiao', '易': 'yi',

  '背': 'bei', '离': 'li', '钝': 'dun', '化': 'hua', '驰': 'chi',
  '包': 'bao', '吞': 'tun', '没': 'mo', '插': 'cha', '针': 'zhen',
  '锤': 'chui', '吊': 'diao', '乌': 'wu', '鸦': 'ya', '星': 'xing',
  '黄': 'huang', '昏': 'hun', '之': 'zhi', '启': 'qi', '明': 'ming',
  '通': 'tong', '道': 'dao', '箱': 'xiang', '体': 'ti', '台': 'tai', '理': 'li',
  '关': 'guan', '口': 'kou',

  '情': 'qing', '绪': 'xu', '预': 'yu', '心': 'xin', '恐': 'kong', '慌': 'huang',
  '贪': 'tan', '婪': 'lan', '谨': 'jin', '慎': 'shen', '乐': 'le', '悲': 'bei',
  '性': 'xing', '热': 're',
}

function charToPinyin(char: string): string {
  return PINYIN_MAP[char] ?? `u${char.charCodeAt(0).toString(16)}`
}

export function labelToKey(label: string): string {
  let result = ''
  for (const char of label) {
    const code = char.charCodeAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) {
      result += `_${charToPinyin(char)}_`
    } else if (/[a-zA-Z0-9]/.test(char)) {
      result += char.toLowerCase()
    } else {
      result += '_'
    }
  }
  return result
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function generateUniqueKey(label: string, existingKeys: string[]): string {
  const base = labelToKey(label) || 'quadrant'
  let key = base
  let suffix = 1
  while (existingKeys.includes(key)) {
    key = `${base}_${suffix}`
    suffix++
  }
  return key
}
