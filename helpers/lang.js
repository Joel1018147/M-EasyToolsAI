/* ═══════════════════════════════════════════════════════════════════════════
   LANGUAGE — the three codes, and text metrics that survive leaving English
   ───────────────────────────────────────────────────────────────────────────
   Shared by the trilingual generation layer and the image lane. One place
   knows what 'ms' means and how to count a Chinese word.

   ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
   Recurring-bugs class #7: CJK text broken by a whitespace/\b word boundary.
   It was live in this repo before this round. generateWithGroq() scored every
   document with:

       text.split(/\s+/).filter(Boolean).length

   Chinese does not put spaces between words, so a 2,000-character Chinese
   article counted as ONE word. Measured, not assumed:

       ZH  chars=59   wordCount=1    sentences=1   readability=100
       EN  chars=170  wordCount=24   sentences=3   readability=30
       BM  chars=150  wordCount=19   sentences=2   readability=30

   The consequences were not cosmetic. documents.word_count stored 1. The SEO
   gate `wordCount >= 300 ? 25 : Math.floor(wordCount/12)` awarded ZERO to
   every Chinese document however long. And the Flesch formula — which is
   defined over English syllables — returned a flattering 100 for the one
   language it cannot describe at all.

   Shipping Chinese generation on top of that scorer would have told every
   Chinese-writing customer their best work was worthless.

   ── HOW WORDS ARE COUNTED NOW ─────────────────────────────────────────────
   Intl.Segmenter, which is in Node 20 and uses ICU's real per-language word
   dictionaries. It is not a regex over character ranges: for Chinese it does
   dictionary segmentation, so 人工智能 is two words rather than four
   characters or one blob.

   ICU's Chinese dictionary is imperfect — it splits 马来西亚 into 马来 + 西亚.
   That is a real limitation and it is recorded here rather than hidden,
   because a number that is approximately right is a completely different
   object from a number that is 1. The alternative is a segmentation
   dependency, and the Engineering Bar's preference for lean equivalents plus
   the fact that nothing downstream needs better than ±10% says no.

   FALLBACK, AND WHY IT IS NOT SILENT: a Node built with small-icu has
   Intl.Segmenter but only English data, and would silently return 1 again for
   Chinese — the exact bug, wearing the fix's clothes. So the fallback is
   detected at load by segmenting a known Chinese string and checking the
   answer is plural, and every metric carries the basis it was computed with.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/** The three languages this ecosystem ships. Order is display order. */
const LANGS = ['en', 'ms', 'zh'];

const LANG_LABELS = { en: 'English', ms: 'Bahasa Malaysia', zh: '中文' };
const LANG_SHORT = { en: 'EN', ms: 'BM', zh: '中文' };

/** BCP-47 tags for the html lang attribute and Intl. zh is Simplified. */
const LANG_TAGS = { en: 'en', ms: 'ms', zh: 'zh-Hans' };

/**
 * Anything unrecognised becomes null, never a default.
 *
 * A silent fallback to English is how a Chinese request comes back in English
 * and nobody can tell whether the model ignored the instruction or the code
 * dropped it. Callers decide what to do with null; this function does not
 * decide for them.
 *
 * ── zh MEANS SIMPLIFIED, AND zh-Hant IS REFUSED ──────────────────────────
 * This used to end `v.startsWith('zh-') → 'zh'`, so `zh-Hant`, `zh-TW` and
 * `zh-HK` all collapsed onto the Simplified pipeline: a request for
 * Traditional was answered in Simplified and nothing anywhere said so. §L's
 * register for this platform is 简体中文 for Malaysian Chinese readers, and
 * Traditional is not a variant of that, it is a different orthography.
 *
 * So the Simplified tags are named explicitly and everything else under `zh-`
 * is null — which reaches the caller as a refusal (a 400 on /api/generate, a
 * throw in generateWithGroq) rather than as a quiet substitution. Refusing to
 * do a thing is honest; doing a different thing without mentioning it is not.
 * Supporting Traditional properly is a real piece of work — a second register
 * block, a second corpus, a second verification target — and it is DEFERRED,
 * not faked.
 */
const ZH_SIMPLIFIED_TAGS = ['zh-hans', 'zh-cn', 'zh-sg', 'zh-my', 'zh-hans-cn', 'zh-hans-sg', 'zh-hans-my'];

function normaliseLang(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (LANGS.includes(v)) return v;
  // Chinese: only the Simplified spellings. zh-Hant / zh-TW / zh-HK / zh-MO /
  // zh-yue are real, different things and are refused, not approximated.
  if (v.startsWith('zh')) return ZH_SIMPLIFIED_TAGS.includes(v) ? 'zh' : null;
  // Malay and English have one orthography each here, so a regional subtag is
  // a genuine variant of the same thing and prefix matching is right.
  if (v === 'ms-my' || v.startsWith('ms-')) return 'ms';
  if (v === 'en-my' || v.startsWith('en-')) return 'en';
  return null;
}

/* ── Script detection ──────────────────────────────────────────────────────
   Used to answer "did the model actually answer in the language it was
   asked for", which is a check M-EasyMember's copywriter does not do and
   which this platform's Localization Bar requires. */

const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
const HAN_GLOBAL_RE = /[㐀-䶿一-鿿豈-﫿]/g;

/* ── Simplified vs Traditional ─────────────────────────────────────────────
   FOUND BY RUNNING THE MODEL, NOT BY READING THE CODE. A blind critic ran ~20
   live generations; one ZH article in six came back entirely in 繁體字 — 46
   distinct Traditional-only characters, 144 occurrences — and localised the
   currency as 馬幣, which the ZH directive explicitly forbids. looksLikeLang()
   answered {ok:true, detected:'zh', hanRatio:0.833} and the row saved
   langVerified:true with no warning. Two §L criteria broken in one output, and
   the checker called it verified. On that criterion the platform was measured
   WORSE than the benchmark it is supposed to beat, which produced Simplified
   five times out of five.

   hanRatio() could never have caught it: 繁體 and 简体 are both Han script. A
   check that only knows "is this Han" cannot answer "is this the orthography
   we asked for". So the orthography gets its own evidence.

   ── HOW ──────────────────────────────────────────────────────────────────
   Two disjoint character sets: forms that occur only in Simplified writing,
   and forms that occur only in Traditional writing. A character that is used
   in BOTH orthographies (后, 里, 台, 干, 面, 只, 出, 了, 才, 占, 表, 准, 欲,
   征, 丑, 杰, 云, 于, 谷, 划, 卷, 松, 丰, 斗, 系) is in NEITHER set — it is not
   evidence, and putting it in a set would make every text look like whichever
   set it landed in. This is why the Traditional set is longer than the
   Simplified one: several Traditional forms (後, 裡, 臺, 幹, 麵, 隻…) have a
   simplified counterpart that Traditional writing also uses, so the
   Traditional form is evidence while its partner is not.

   The verdict is a comparison, not a threshold on one side. An otherwise
   Simplified article quoting 「臺灣珍珠奶茶」 is Simplified copy with a proper
   noun in it; failing that would send good work round the retry loop for a
   place name. So: Traditional only when the Traditional evidence at least
   equals the Simplified evidence.

   This is a heuristic over an incomplete character list and it says so. What
   it must never again do is return "verified Simplified" for an article with
   144 Traditional characters in it. */

/* simplified+traditional, two characters per group. Every left-hand character
   is a form that does not occur in Traditional writing; every right-hand one
   does not occur in Simplified writing. */
const HAN_VARIANT_PAIRS = (
  '爱愛碍礙袄襖罢罷摆擺败敗办辦帮幫绑綁镑鎊谤謗剥剝饱飽宝寶报報鲍鮑辈輩贝貝备備惫憊狈狽钡鋇' +
  '笔筆毕畢闭閉币幣毙斃边邊编編贬貶变變辩辯辫辮标標鳔鰾别別濒瀕滨濱宾賓摈擯饼餅拨撥钵缽补補' +
  '财財参參蚕蠶惨慘灿燦仓倉沧滄舱艙侧側厕廁测測层層诧詫蝉蟬馋饞产產阐闡颤顫场場尝嘗长長偿償' +
  '肠腸厂廠畅暢钞鈔车車彻徹尘塵陈陳衬襯撑撐称稱惩懲诚誠迟遲驰馳耻恥齿齒冲衝虫蟲筹籌绸綢踌躊' +
  '处處触觸厨廚储儲础礎传傳疮瘡创創锤錘纯純绰綽辞辭词詞赐賜聪聰葱蔥从從丛叢凑湊蹿躥窜竄错錯' +
  '达達带帶贷貸担擔单單胆膽诞誕弹彈当當党黨荡蕩档檔导導岛島祷禱灯燈邓鄧敌敵涤滌递遞缔締点點' +
  '电電垫墊淀澱钓釣调調谍諜叠疊东東动動栋棟冻凍独獨读讀赌賭镀鍍缎緞断斷锻鍛对對吨噸顿頓钝鈍' +
  '夺奪堕墮鹅鵝额額恶惡饿餓儿兒尔爾饵餌贰貳发發罚罰阀閥珐琺烦煩范範贩販饭飯访訪纺紡飞飛费費' +
  '废廢纷紛坟墳奋奮愤憤粪糞风風枫楓疯瘋冯馮凤鳳肤膚辐輻妇婦复復该該钙鈣盖蓋赶趕秆稈岗崗刚剛' +
  '钢鋼纲綱鸽鴿个個给給龚龔巩鞏沟溝够夠构構购購顾顧关關观觀馆館惯慣贯貫广廣规規归歸龟龜轨軌' +
  '诡詭柜櫃贵貴刽劊辊輥滚滾锅鍋国國过過骇駭韩韓汉漢号號阂閡鹤鶴贺賀横橫轰轟鸿鴻红紅壶壺护護' +
  '沪滬华華画畫话話怀懷坏壞欢歡环環还還缓緩换換唤喚涣渙谎謊挥揮辉輝毁毀汇彙会會贿賄秽穢诲誨' +
  '绘繪荤葷浑渾伙夥获獲祸禍击擊机機积積饥飢讥譏绩績缉緝级級极極辑輯计計记記际際剂劑济濟继繼' +
  '纪紀颊頰荚莢价價驾駕歼殲监監坚堅艰艱检檢拣揀捡撿俭儉茧繭简簡见見剑劍渐漸贱賤舰艦鉴鑑讲講' +
  '奖獎桨槳蒋蔣酱醬胶膠浇澆骄驕娇嬌缴繳绞絞脚腳搅攪较較阶階节節洁潔结結诫誡届屆紧緊锦錦尽盡' +
  '进進劲勁径徑经經茎莖惊驚竞競净淨旧舊鸠鳩纠糾厩廄驹駒举舉据據锯鋸惧懼剧劇决決诀訣绝絕军軍' +
  '钧鈞骏駿开開凯凱垦墾恳懇壳殼课課铿鏗夸誇块塊侩儈宽寬矿礦亏虧窥窺溃潰扩擴阔闊腊臘蜡蠟来來' +
  '赖賴蓝藍篮籃阑闌栏欄拦攔澜瀾览覽懒懶烂爛滥濫劳勞涝澇乐樂镭鐳垒壘类類泪淚离離厘釐礼禮丽麗' +
  '励勵历歷沥瀝隶隸俩倆联聯连連怜憐莲蓮链鏈练練炼煉恋戀粮糧谅諒辆輛疗療辽遼猎獵临臨邻鄰凛凜' +
  '岭嶺领領刘劉浏瀏龙龍聋聾咙嚨垄壟笼籠娄婁楼樓搂摟篓簍卢盧芦蘆炉爐卤鹵虏虜鲁魯赂賂录錄陆陸' +
  '驴驢吕呂铝鋁侣侶屡屢缕縷虑慮滤濾绿綠峦巒挛攣孪孿滦灤乱亂抡掄轮輪论論罗羅萝蘿逻邏锣鑼箩籮' +
  '骆駱妈媽马馬玛瑪码碼蚂螞骂罵吗嗎买買卖賣迈邁麦麥蛮蠻满滿谩謾猫貓锚錨铆鉚贸貿么麼没沒霉黴' +
  '们們梦夢弥彌谜謎绵綿缅緬灭滅悯憫闽閩鸣鳴铭銘谬謬谋謀亩畝纳納钠鈉难難挠撓脑腦恼惱闹鬧馁餒' +
  '内內拟擬腻膩镊鑷镍鎳宁寧拧擰柠檸狞獰农農脓膿疟瘧诺諾欧歐殴毆呕嘔盘盤庞龐赔賠喷噴鹏鵬骗騙' +
  '飘飄频頻贫貧苹蘋凭憑泼潑铺鋪仆僕朴樸谱譜脐臍齐齊骑騎岂豈启啟气氣弃棄讫訖迁遷签簽谦謙钱錢' +
  '潜潛浅淺谴譴枪槍抢搶呛嗆墙牆蔷薔强強羟羥桥橋侨僑翘翹窃竊亲親寝寢轻輕氢氫倾傾请請庆慶琼瓊' +
  '穷窮趋趨区區驱驅躯軀权權劝勸却卻确確阙闕饶饒扰擾绕繞热熱认認纫紉韧韌荣榮绒絨软軟锐銳闰閏' +
  '润潤洒灑飒颯赛賽伞傘丧喪骚騷扫掃涩澀杀殺纱紗筛篩晒曬闪閃陕陝赡贍伤傷赏賞烧燒绍紹赊賒摄攝' +
  '设設慑懾绅紳审審婶嬸肾腎渗滲声聲绳繩胜勝师師狮獅湿濕诗詩时時蚀蝕实實识識驶駛势勢适適试試' +
  '视視饰飾释釋寿壽兽獸枢樞书書赎贖属屬术術树樹竖豎数數帅帥双雙谁誰税稅顺順说說硕碩丝絲饲飼' +
  '耸聳讼訟颂頌诵誦苏蘇诉訴肃肅虽雖绥綏随隨岁歲孙孫损損笋筍缩縮琐瑣锁鎖挞撻摊攤瘫癱贪貪滩灘' +
  '坛壇昙曇谈談叹嘆汤湯烫燙涛濤绦絛腾騰誊謄题題体體屉屜条條贴貼铁鐵厅廳听聽统統头頭图圖涂塗' +
  '团團颓頹蜕蛻驮馱鸵鴕椭橢洼窪袜襪弯彎湾灣顽頑万萬网網韦韋违違围圍为為维維伟偉伪偽纬緯卫衛' +
  '谓謂温溫闻聞问問瓮甕挝撾窝窩涡渦卧臥乌烏诬誣无無芜蕪吴吳呜嗚务務雾霧误誤锡錫牺犧袭襲习習' +
  '铣銑戏戲细細虾蝦吓嚇侠俠狭狹峡峽厦廈鲜鮮纤纖咸鹹贤賢衔銜显顯险險现現线線宪憲县縣馅餡乡鄉' +
  '详詳响響项項萧蕭销銷晓曉啸嘯协協胁脅谐諧写寫泻瀉谢謝衅釁兴興汹洶锈銹绣繡须須虚虛许許叙敘' +
  '绪緒续續轩軒悬懸选選癣癬绚絢学學勋勳询詢寻尋驯馴训訓讯訊压壓鸦鴉鸭鴨哑啞亚亞烟煙阉閹严嚴' +
  '岩巖颜顏阎閻谳讞验驗厌厭阳陽杨楊扬揚疡瘍养養痒癢样樣谣謠药藥爷爺页頁业業叶葉晔曄医醫仪儀' +
  '颐頤遗遺谊誼艺藝忆憶义義议議亿億呓囈阴陰银銀饮飲隐隱瘾癮应應缨纓莹瑩萤螢营營蝇蠅赢贏痈癰' +
  '拥擁踊踴咏詠涌湧优優忧憂邮郵犹猶诱誘余餘鱼魚渔漁与與屿嶼语語狱獄预預誉譽驭馭鸳鴛渊淵园園' +
  '员員圆圓缘緣远遠愿願约約跃躍钥鑰岳嶽悦悅阅閱郧鄖运運蕴蘊晕暈韵韻杂雜灾災载載暂暫赞贊赃贓' +
  '脏髒凿鑿枣棗灶竈责責择擇则則贼賊赠贈扎紮轧軋闸閘诈詐斋齋债債毡氈盏盞斩斬崭嶄辗輾战戰绽綻' +
  '张張涨漲帐帳账賬胀脹赵趙这這贞貞针針侦偵诊診镇鎮阵陣争爭挣掙睁睜狰猙郑鄭证證织織职職执執' +
  '纸紙掷擲质質滞滯钟鐘终終种種众眾轴軸皱皺猪豬诸諸诛誅烛燭瞩矚嘱囑贮貯驻駐砖磚转轉赚賺桩樁' +
  '庄莊装裝妆妝壮壯状狀坠墜缀綴谆諄浊濁资資渍漬踪蹤总總纵縱邹鄒组組钻鑽槟檳'
).match(/../g);

/* Traditional forms whose Simplified counterpart is a character Traditional
   writing ALSO uses. Only the Traditional side is evidence; the partner is
   listed in the comment above as deliberately absent from both sets. */
const HAN_TRADITIONAL_EXTRA = '後裡裏臺檯颱幹乾麵隻鬆髮醜準慾錶徵傑瞭佔齣纔係繫豐鬥儘複穫捲雲於穀劃遊製誌闆佈鬱沖裝';

const HANS_ONLY = new Set(HAN_VARIANT_PAIRS.map((p) => p[0]));
const HANT_ONLY = new Set(
  HAN_VARIANT_PAIRS.map((p) => p[1]).concat([...HAN_TRADITIONAL_EXTRA])
);
// A character cannot be evidence for both. If authoring ever puts one in both
// lists it must lose, loudly, rather than tip every verdict its way.
for (const c of HANS_ONLY) {
  if (HANT_ONLY.has(c)) {
    HANS_ONLY.delete(c);
    HANT_ONLY.delete(c);
    console.warn('helpers/lang.js: ' + c + ' was listed as both Simplified-only and ' +
      'Traditional-only; it is evidence for neither and has been dropped from both sets');
  }
}

/**
 * Which Chinese orthography is this text written in?
 *
 * @returns {{variant: 'hans'|'hant'|'unknown', simplified: number, traditional: number}}
 *   'unknown' means the text used only characters shared by both orthographies
 *   (or no Han at all) — a real answer, and never to be read as 'hans'.
 */
function hanVariant(text) {
  const s = String(text || '');
  let simplified = 0;
  let traditional = 0;
  for (const ch of s) {
    if (HANS_ONLY.has(ch)) simplified++;
    else if (HANT_ONLY.has(ch)) traditional++;
  }
  let variant = 'unknown';
  if (traditional > 0 && traditional >= simplified) variant = 'hant';
  else if (simplified > 0) variant = 'hans';
  return { variant, simplified, traditional };
}

/* ── Malay, proportionally ─────────────────────────────────────────────────
   ALSO FOUND BY RUNNING THE MODEL. This used to be MALAY_RE.test(s) — one hit
   anywhere in the text — while the Chinese path used a 0.30 proportion. Two
   live outputs verified as Bahasa Malaysia that were not:

     "Hi [Name], Dan from [Business] here! We miss you. Claim your RM10
      voucher…"          → ok:true, on the word "Dan", which is an English
                            given name as much as it is the Malay "and".

     "Halo [Name], kami kangen kamu. Gratis voucher RM10 buat kamu, bisa
      dipakai hari ini!"  → ok:true. That is Indonesian, and `bisa` and
                            `gratis` are two of the four words this platform's
                            own BM directive names as forbidden Indonesian. The
                            prompt knew about them; the checker did not, so the
                            model could break that rule for free.

   A rule stated in a prompt and unenforced in the check is not a rule. */
const MALAY_WORDS = [
  'dan', 'atau', 'yang', 'untuk', 'dengan', 'daripada', 'kepada', 'ini', 'itu',
  'anda', 'kami', 'kita', 'akan', 'boleh', 'tidak', 'adalah', 'dalam', 'pada',
  'perniagaan', 'pelanggan', 'jenama', 'kandungan', 'percuma', 'sekarang',
  'juga', 'lebih', 'sila', 'semua', 'bagi', 'oleh', 'sudah', 'ada', 'di', 'ke',
  'setiap', 'hari', 'kedai', 'harga', 'beli', 'dapatkan', 'hubungi', 'nikmati',
  'terbaik', 'kepada', 'seperti', 'supaya', 'kerana', 'tanpa', 'sahaja',
];
const MALAY_RE = new RegExp('\\b(' + MALAY_WORDS.join('|') + ')\\b', 'gi');

/* Indonesian, which is close enough to Malay to fool a function-word test and
   far enough to be wrong copy for a Malaysian audience.

   STRONG markers are Indonesian-only: one is enough. WEAK markers are real
   Malay words that Indonesian uses differently — "buat" is Malay for "make",
   "kamu" is informal Malay — so a single one proves nothing and two together
   do. Splitting them is the difference between catching Indonesian and
   failing legitimate Malay that happened to say "buat". */
const INDONESIAN_STRONG = [
  'bisa', 'gratis', 'banget', 'kangen', 'nggak', 'ngga', 'enggak', 'gimana',
  'kalian', 'aja', 'doang', 'udah', 'kayak', 'dong', 'sih', 'bikin', 'cewek',
  'cowok', 'lho', 'yuk', 'banget',
];
const INDONESIAN_WEAK = ['buat', 'kamu', 'halo'];
const INDONESIAN_STRONG_RE = new RegExp('\\b(' + INDONESIAN_STRONG.join('|') + ')\\b', 'gi');
const INDONESIAN_WEAK_RE = new RegExp('\\b(' + INDONESIAN_WEAK.join('|') + ')\\b', 'gi');

/** Proportion of the string that is Han characters, 0..1. */
function hanRatio(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  const han = (s.match(HAN_GLOBAL_RE) || []).length;
  // Measured against non-whitespace, so trailing layout does not dilute it.
  const solid = s.replace(/\s+/g, '').length || 1;
  return han / solid;
}

/**
 * How much of this text is actually Malay, and is any of it Indonesian?
 *
 * @returns {{words:number, hits:number, distinct:number, ratio:number,
 *            indonesian:string[], indonesianStrong:number, isMalay:boolean}}
 */
function malayMetrics(text) {
  const s = String(text || '');
  const tokens = s.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const words = tokens.length;
  const found = s.match(MALAY_RE) || [];
  const hits = found.length;
  const distinct = new Set(found.map((w) => w.toLowerCase())).size;
  const ratio = words ? hits / words : 0;

  const strong = (s.match(INDONESIAN_STRONG_RE) || []).map((w) => w.toLowerCase());
  const weak = (s.match(INDONESIAN_WEAK_RE) || []).map((w) => w.toLowerCase());
  const indonesian = [...new Set(strong.concat(weak.length >= 2 ? weak : []))];

  /* The bar. 0.10 of the words being Malay function words separates the two
     live failures (0.06 for the English sample) from real Malay (0.28) with
     room either side. The distinct-word requirement stops one repeated "dan"
     from carrying a whole English paragraph; it is relaxed for very short
     copy, where two distinct function words is a lot to ask of one line. */
  const isMalay = ratio >= 0.10 && (words < 10 ? hits >= 1 : distinct >= 2);

  return { words, hits, distinct, ratio, indonesian, indonesianStrong: strong.length, isMalay };
}

/**
 * Best-effort language of a piece of text.
 *
 * Han script is decisive — no amount of Latin text makes a Han-bearing string
 * English, because mixed Chinese copy routinely carries brand names and "RM".
 * Otherwise it is the proportional Malay test, then English as the residual.
 *
 * Indonesian is deliberately NOT excluded here. detectLang() answers "which
 * metrics should score this text", and Malay metrics are the right ones for
 * Indonesian prose. Whether it is acceptable OUTPUT is looksLikeLang()'s
 * question, and that one does exclude it.
 */
function detectLang(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (HAN_RE.test(s) && hanRatio(s) >= 0.10) return 'zh';
  if (malayMetrics(s).isMalay) return 'ms';
  return 'en';
}

/* ── Segmentation ──────────────────────────────────────────────────────────*/

const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

/* One line per distinct problem per process. A degraded segmenter would
   otherwise print on every generation and be scrolled past, which is the same
   as not printing at all. */
const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn('helpers/lang.js: ' + message);
}

/* Does this runtime's ICU actually carry Chinese word data, or is it
   small-icu pretending? Segment a string whose correct answer is "several"
   and check we did not get back "one". Computed once, at load. */
const SEGMENTER_HAS_CJK = (() => {
  if (!HAS_SEGMENTER) return false;
  try {
    const probe = '人工智能正在改变营销方式';
    const n = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(probe)]
      .filter((s) => s.isWordLike).length;
    if (n < 3) {
      warnOnce('icu-small', 'this Node has Intl.Segmenter but no Chinese word data ' +
        '(small-icu). Chinese word counts will be estimates, not segmentation.');
      return false;
    }
    return true;
  } catch (err) {
    // false is a real answer here — it means "no CJK segmentation available" —
    // but the reason is worth one line, because the symptom downstream is
    // merely a slightly different number and nobody would trace it back.
    warnOnce('icu-probe', 'Intl.Segmenter probe threw (' + err.message +
      ') — treating this runtime as having no CJK segmentation');
    return false;
  }
})();

/**
 * The word-like segments of a Latin-script string, as strings.
 *
 * Exists so that anything computing a PER-WORD average counts the same words
 * countWords() counted. A metric whose numerator and denominator disagree
 * about what a word is produces a number that is not wrong by a little.
 *
 * Not used for Han text — countWords() estimates there rather than listing.
 */
function wordList(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const l = normaliseLang(lang) || detectLang(s) || 'en';
  if (HAS_SEGMENTER) {
    try {
      const seg = new Intl.Segmenter(LANG_TAGS[l], { granularity: 'word' });
      const out = [];
      for (const part of seg.segment(s)) if (part.isWordLike) out.push(part.segment);
      return out;
    } catch (err) {
      warnOnce('segmenter-list', 'Intl.Segmenter word listing failed for ' +
        LANG_TAGS[l] + ' (' + err.message + ') — falling back to a whitespace split');
    }
  }
  // Whitespace tokens that actually contain a letter or digit. Bare "-" and
  // "##" are not words and must not enter a per-word average.
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/**
 * Word count that means the same thing in all three languages.
 *
 * @returns {{count: number, basis: string}} basis names the method, so a
 *   caller can report how a number was reached instead of implying precision
 *   it does not have.
 */
function countWords(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return { count: 0, basis: 'empty' };
  const l = normaliseLang(lang) || detectLang(s) || 'en';

  if (HAS_SEGMENTER && (l !== 'zh' || SEGMENTER_HAS_CJK)) {
    try {
      const seg = new Intl.Segmenter(LANG_TAGS[l], { granularity: 'word' });
      let n = 0;
      for (const part of seg.segment(s)) if (part.isWordLike) n++;
      return { count: n, basis: 'intl-segmenter:' + LANG_TAGS[l] };
    } catch (err) {
      // RULE 6: not swallowed. The estimate below is a real answer, but it is
      // a WORSE one, so the caller is told which it got — `basis` carries the
      // degradation into every metrics payload and into the reports built on
      // them. Logged once per process so a broken ICU is visible in the
      // Railway log rather than inferred later from odd word counts.
      warnOnce('segmenter-word', 'Intl.Segmenter word segmentation failed for ' +
        LANG_TAGS[l] + ' (' + err.message + ') — falling back to an estimate');
    }
  }

  // Fallback. For Han text, count Han characters and divide by the mean
  // characters-per-word for modern written Chinese (~1.5), then add any
  // Latin-script words present. Approximate and LABELLED as approximate —
  // what it must never do is return 1 for a whole article.
  const han = (s.match(HAN_GLOBAL_RE) || []).length;
  // Same "contains a letter or digit" rule wordList() uses, so the fallback
  // path cannot disagree with the fallback list about what a word is.
  const latin = s.replace(HAN_GLOBAL_RE, ' ').split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (han > 0) {
    return { count: Math.round(han / 1.5) + latin, basis: 'han-char-estimate' };
  }
  return { count: latin, basis: 'whitespace' };
}

/**
 * Sentence count. The point of using Segmenter here rather than /[.!?]+/ is
 * that Chinese ends sentences with 。！？ and Malay abbreviations carry dots
 * that are not sentence ends.
 */
function countSentences(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return 0;
  const l = normaliseLang(lang) || detectLang(s) || 'en';
  if (HAS_SEGMENTER) {
    try {
      const seg = new Intl.Segmenter(LANG_TAGS[l], { granularity: 'sentence' });
      let n = 0;
      for (const part of seg.segment(s)) if (part.segment.trim()) n++;
      if (n > 0) return n;
    } catch (err) {
      // RULE 6, as above. The regex below is a genuine fallback and it does
      // include the full-width terminators, so it is not silently wrong for
      // Chinese — but it is coarser, and a failure here is worth seeing.
      warnOnce('segmenter-sentence', 'Intl.Segmenter sentence segmentation failed for ' +
        LANG_TAGS[l] + ' (' + err.message + ') — falling back to a terminator split');
    }
  }
  // Full-width terminators included, or every Chinese text is one sentence.
  const n = s.split(/[.!?。！？…]+/).filter((x) => x.trim()).length;
  return n || 1;
}

/**
 * Syllables in one English word.
 *
 * Flesch is 84.6 × (syllables / words), so every syllable the counter invents
 * costs the score about twelve points. Two counters were tried and both
 * over-counted the same way:
 *
 *   vowel LETTERS  "generates" → e,e,a,e            = 4   (it is 3)
 *   vowel GROUPS   "generates" → e,e,a,e            = 4   (it is 3)
 *                  "queueing"  → ueuei              = 1   (it is 3)
 *
 * Three syllables of error over an eight-word sentence moved
 * "The platform generates marketing content for small businesses." from its
 * textbook ~30 to 8 — the reading difficulty of a tax statute, for a sentence
 * a child could read. The old code hid that behind a floor of 30; removing the
 * floor is what made it visible.
 *
 * So: drop the silent terminal -e / -es, then chunk vowels in ones and twos
 * rather than in unbounded runs. This is the standard textbook heuristic. It
 * is still an estimate — "business" is two syllables in speech and three here
 * — but it is an estimate that agrees with a dictionary on ordinary marketing
 * prose, which the previous two did not. (Lane C.)
 */
function syllablesEn(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

/**
 * Readability.
 *
 * THIS FUNCTION IS ALLOWED TO SAY IT DOES NOT KNOW, and that is the point.
 * Flesch Reading Ease is defined over English syllables and validated on
 * English prose. Applying it to Chinese produced a serene 100 for text it
 * cannot parse at all — a number that was not merely wrong but confidently
 * wrong in the flattering direction.
 *
 * - en: real Flesch, with a vowel-group syllable count.
 * - ms: NOT Flesch. Malay orthography is near-phonemic and its syllable
 *       structure differs enough that Flesch's constants do not transfer;
 *       reporting one would be borrowing English's authority for a number
 *       nobody validated. Mean words-per-sentence, mapped to 0..100.
 * - zh: mean characters-per-sentence, mapped to 0..100. Chinese readability
 *       research uses character and stroke counts, not syllables.
 *
 * @returns {{score: number|null, basis: string}}
 */
function readability(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return { score: null, basis: 'empty' };
  const l = normaliseLang(lang) || detectLang(s) || 'en';
  const sentences = countSentences(s, l) || 1;

  /* No words, no readability. "... !!! ???" has a length and a sentence count
     and nothing to read, and every formula below divides by a word count. The
     old code returned 100 for it — the flattering-wrong direction that §0.7 is
     about — so this says so instead. (Lane C, found by wiring these metrics
     into scoreContent() and reading the corpus output.) */
  const wordsHere = countWords(s, l).count;
  if (wordsHere === 0) return { score: null, basis: l + '-no-words' };

  if (l === 'zh') {
    const han = (s.match(HAN_GLOBAL_RE) || []).length;
    const perSentence = han / sentences;
    // Anchors: 15 Han chars per sentence is short and plain, 55 is the dense
    // officialese register. Calibrated so ORDINARY marketing copy lands in the
    // 70s-80s rather than pinned at 100 — a scale whose normal case is the
    // ceiling cannot tell good from adequate, which is the only comparison
    // anyone actually uses it for.
    const score = clamp(Math.round(100 - ((perSentence - 15) / 40) * 100), 0, 100);
    return { score, basis: 'zh-chars-per-sentence' };
  }

  const words = wordsHere;
  const wps = words / sentences;

  if (l === 'ms') {
    // Anchors: 8 words per sentence is plain Malay, 30 is the formal register
    // of a government circular. Same calibration reasoning as zh above.
    const score = clamp(Math.round(100 - ((wps - 8) / 22) * 100), 0, 100);
    return { score, basis: 'ms-words-per-sentence' };
  }

  /* English: Flesch Reading Ease.
     Syllables by vowel GROUPS, not by vowel letters — the previous code
     counted every vowel character, so "queueing" scored 6.

     THE NUMERATOR AND THE DENOMINATOR MUST COUNT THE SAME WORDS. This used to
     sum syllables over `s.split(/\s+/)` while dividing by the SEGMENTER's word
     count, so every whitespace token that is not a word — a markdown "-", a
     bare "##" — added a syllable to a denominator that had never counted it.
     "- one\n- two\n- three" came out at 7 syllables over 3 words and scored 8
     out of 100, which is roughly the reading difficulty of a tax statute.
     Counting both over the same word list fixes it; it scores 93.
     (Lane C, found by wiring these metrics into scoreContent().) */
  const syllables = wordList(s, l).reduce((acc, w) => acc + syllablesEn(w), 0);
  const score = clamp(
    Math.round(206.835 - 1.015 * wps - 84.6 * (syllables / (words || 1))),
    0,
    100
  );
  return { score, basis: 'flesch-en' };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

/**
 * Everything a caller needs about a piece of generated text, in one shape.
 * `basis` fields travel with the numbers so a report can say how it counted.
 */
function textMetrics(text, lang) {
  const s = String(text || '');
  const l = normaliseLang(lang) || detectLang(s);
  const w = countWords(s, l);
  const sentences = countSentences(s, l);
  const r = readability(s, l);
  return {
    lang: l,
    chars: s.length,
    charsNoSpace: s.replace(/\s+/g, '').length,
    words: w.count,
    wordBasis: w.basis,
    sentences,
    readability: r.score,
    readabilityBasis: r.basis,
    hanRatio: Number(hanRatio(s).toFixed(3)),
  };
}

/**
 * Did the model answer in the language it was told to use?
 *
 * The Localization Bar requires this because the reference implementation it
 * benchmarks against does not do it: M-EasyMember asks for Bahasa Malaysia
 * and ships whatever comes back, so a model that silently answered in English
 * is indistinguishable from one that complied.
 *
 * Deliberately tolerant of the mixed reality of Malaysian copy — a Chinese ad
 * carries "RM", a brand name and often an English CTA — so this asks whether
 * the text is *predominantly* right, not whether it is pure.
 *
 * Two things it did not check until a blind critic ran the live model and
 * caught both:
 *   · Traditional Chinese returned for a Simplified request (hanRatio cannot
 *     see orthography — see hanVariant above).
 *   · Malay verified on a single token, so an English sentence containing
 *     "Dan" passed, and so did Indonesian (see malayMetrics above).
 *
 * @returns {{ok: boolean, detected: string|null, reason?: string, ...}}
 *   `detected` is 'zh-Hant' — not 'zh' — for Traditional output, because the
 *   caller has to be able to tell the user which thing went wrong.
 */
function looksLikeLang(text, lang) {
  const want = normaliseLang(lang);
  const s = String(text || '');
  if (!want || !s.trim()) return { ok: false, detected: null, reason: 'empty' };

  const ratio = hanRatio(s);
  const detected = detectLang(s);

  if (want === 'zh') {
    if (ratio < 0.30) {
      return { ok: false, detected, hanRatio: ratio, reason: 'too little Han script for Chinese output' };
    }
    const variant = hanVariant(s);
    if (variant.variant === 'hant') {
      return {
        ok: false,
        detected: 'zh-Hant',
        hanRatio: ratio,
        hanVariant: variant,
        reason: 'Traditional Chinese (繁體) returned for a Simplified (简体) request — ' +
          variant.traditional + ' Traditional-only characters against ' +
          variant.simplified + ' Simplified-only',
      };
    }
    return { ok: true, detected: 'zh', hanRatio: ratio, hanVariant: variant };
  }

  if (ratio >= 0.15) {
    return { ok: false, detected: 'zh', hanRatio: ratio, reason: 'Han script in non-Chinese output' };
  }

  const ms = malayMetrics(s);

  if (want === 'ms') {
    if (ms.indonesian.length) {
      return {
        ok: false,
        detected: 'id',
        hanRatio: ratio,
        malay: ms,
        reason: 'Indonesian rather than Bahasa Malaysia — found ' + ms.indonesian.join(', '),
      };
    }
    if (ms.isMalay) return { ok: true, detected: 'ms', hanRatio: ratio, malay: ms };
    return {
      ok: false,
      detected,
      hanRatio: ratio,
      malay: ms,
      reason: 'not enough Malay: ' + ms.hits + ' function word(s) in ' + ms.words +
        ' (' + (ms.ratio * 100).toFixed(1) + '%), ' + ms.distinct + ' distinct',
    };
  }

  // English: the residual. Refuse only on positive evidence of another
  // language, because English shares too much surface with everything.
  if (ms.isMalay && !/\b(the|and|you|your|we|is|are|to|of)\b/i.test(s)) {
    return { ok: false, detected: 'ms', hanRatio: ratio, malay: ms, reason: 'reads as Malay, not English' };
  }
  return { ok: true, detected: 'en', hanRatio: ratio };
}

module.exports = {
  LANGS,
  LANG_LABELS,
  LANG_SHORT,
  LANG_TAGS,
  normaliseLang,
  detectLang,
  hanRatio,
  hanVariant,
  malayMetrics,
  wordList,
  countWords,
  syllablesEn,
  countSentences,
  readability,
  textMetrics,
  looksLikeLang,
  // Exported so a diagnostic surface can report the runtime's real capability
  // rather than assuming it. See the header on small-icu.
  SEGMENTER_HAS_CJK,
  /* Exported so a test can assert the variant sets are real, disjoint and
     non-empty. A checker built on an empty set is a checker that cannot fail. */
  HAN_VARIANT_SETS: { simplified: HANS_ONLY, traditional: HANT_ONLY },
  INDONESIAN_STRONG,
  INDONESIAN_WEAK,
};
