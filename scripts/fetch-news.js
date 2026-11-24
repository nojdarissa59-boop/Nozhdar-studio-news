const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const SUPPORTED_LANGS = [
  'ku',
  'bad',
  'kmr',
  'it',
  'en',
  'ar',
  'ma',
  'tn',
  'dz',
  'tr',
  'fa',
  'sq',
  'ur',
  'hi',
  'bn',
  'ps'
];

const LANG_GROUPS = [
  {
    name: 'kurdish',
    langs: ['ku', 'bad', 'kmr'],
    desc: `- ku: Central Kurdish (Sorani, Arabic script)
- bad: Badini Kurdish (Arabic script)
- kmr: Kurmanji Kurdish (Latin script)`
  },
  {
    name: 'arabic',
    langs: ['ar', 'ma', 'tn', 'dz'],
    desc: `- ar: Standard Arabic
- ma: Moroccan Arabic (Darija, Arabic script)
- tn: Tunisian Arabic (Arabic script)
- dz: Algerian Arabic (Arabic script)`
  },
  {
    name: 'others',
    langs: ['en', 'it', 'tr', 'fa', 'sq', 'ur', 'hi', 'bn', 'ps'],
    desc: `- en: English
- it: Italian
- tr: Turkish
- fa: Persian (Farsi)
- sq: Albanian
- ur: Urdu
- hi: Hindi
- bn: Bengali
- ps: Pashto`
  }
];

const FEEDS = [
  {
    name: 'Alto Adige / Südtirol',
    urls: [
      'https://www.altoadige.it/rss',
      'https://www.rainews.it/tgr/bolzano/rss.xml',
      'https://www.rainews.it/tgr/tagesschau/rss.xml'
    ],
    defaultCategory: 'alto-adige'
  },
  {
    name: 'ANSA Cronaca / Italia',
    urls: [
      'https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml',
      'https://www.ansa.it/sito/notizie/politica/politica_rss.xml'
    ],
    defaultCategory: 'italia'
  }
];

const IMMIGRATION_KEYWORDS = [
  'permesso di soggiorno',
  'immigrazione',
  'rifugiati',
  'asilo',
  'questura',
  'cittadinanza',
  'decreto flussi',
  'stranieri',
  'migranti',
  'accoglienza',
  'visto',
  'rinnovo',
  'soggiorno',
  'lavoro'
];

function buildFallbackMap(cleanText, kuText = '') {
  const base = kuText || cleanText;
  const map = {};
  for (const lang of SUPPORTED_LANGS) {
    map[lang] = lang === 'it' ? cleanText : base;
  }
  return map;
}

const FALLBACK_NEWS = [
  {
    id: 'fallback-alto-adige-1',
    category: 'alto-adige',
    source: 'Alto Adige / Südtirol',
    link: 'https://www.altoadige.it',
    pubDate: new Date().toISOString(),
    title: buildFallbackMap(
      'Aggiornamenti locali dall’Alto Adige e Südtirol',
      'زانیاری و هەواڵە ناوخۆییەکانی ئەلتۆ ئادیجێ و باشووری تیرۆل'
    ),
    summary: buildFallbackMap(
      'Ultime comunicazioni su mobilità, servizi pubblici e vita quotidiana sul territorio.',
      'نوێترین ئاگادارییەکانی هاتوچۆ، خزمەتگوزارییە گشتییەکان و کاروباری ڕۆژانەی دانیشتووانی ناوچەکە.'
    )
  },
  {
    id: 'fallback-refugees-1',
    category: 'refugees',
    source: 'ANSA / Cronaca Italia',
    link: 'https://www.ansa.it',
    pubDate: new Date().toISOString(),
    title: buildFallbackMap(
      'Aggiornamenti su permesso di soggiorno e pratiche immigrazione in Italia',
      'نوێترین ڕێنماییەکانی مۆڵەتی مانەوە و کاروباری کۆچبەران لە ئیتاڵیا'
    ),
    summary: buildFallbackMap(
      'Informazioni generali su procedure in Questura, rinnovo documenti e normative vigenti.',
      'زانیاری گشتی سەبارەت بە ڕێکارەکانی کوێستوورا، نوێکردنەوەی بەڵگەنامەکان و ماف و ئەرکە یاساییەکان.'
    )
  }
];

function parseJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

async function translateGroup(apiKey, cleanText, group) {
  const keysTemplate = JSON.stringify(
    Object.fromEntries(group.langs.map((k) => [k, '']))
  );

  const prompt = `Translate this Italian news text into:
${group.desc}

Return ONLY a valid JSON object with exact keys:
${keysTemplate}

Text:
"${cleanText}"`;

  const res = await fetch(
    `[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} (${group.name}): ${errBody.slice(0, 180)}`);
  }

  const data = await res.json();
  const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  const parsed = parseJsonObject(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid JSON for group (${group.name}): ${rawContent.slice(0, 140)}`);
  }

  const out = {};
  for (const lang of group.langs) {
    if (typeof parsed[lang] === 'string' && parsed[lang].trim()) {
      out[lang] = parsed[lang].trim();
    }
  }
  return out;
}

async function translateText(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  const cleanText = (text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return buildFallbackMap('');
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY in environment.');
    return buildFallbackMap(cleanText);
  }

  const collected = {};
  for (const group of LANG_GROUPS) {
    try {
      const part = await translateGroup(apiKey, cleanText, group);
      Object.assign(collected, part);
    } catch (err) {
      console.error(`Group translation error (${group.name}): ${err.message}`);
    }
  }

  const fallbackKu =
    collected.ku || collected.en || cleanText;

  const result = {};
  for (const lang of SUPPORTED_LANGS) {
    if (collected[lang]) {
      result[lang] = collected[lang];
    } else if (lang === 'it') {
      result[lang] = cleanText;
    } else {
      result[lang] = fallbackKu;
    }
  }
  return result;
}

async function fetchFirstWorkingFeed(urls, sourceName) {
  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
        return feed.items;
      }
    } catch (error) {
      console.error(`Feed error (${sourceName} - ${url}): ${error.message}`);
    }
  }
  return [];
}

async function run() {
  const allNews = [];

  for (const feedSource of FEEDS) {
    const items = await fetchFirstWorkingFeed(feedSource.urls, feedSource.name);
    const candidates = items.slice(0, 12);
    let added = 0;

    for (const item of candidates) {
      if (added >= 4) break;

      const title = (item.title || '').trim();
      const rawSummary = (item.contentSnippet || item.content || item.summary || '').trim();
      if (!title) continue;

      const combinedText = `${title} ${rawSummary}`.toLowerCase();
      const isImmigration = IMMIGRATION_KEYWORDS.some((kw) =>
        combinedText.includes(kw)
      );

      if (feedSource.defaultCategory === 'italia' && !isImmigration) {
        continue;
      }

      const category = isImmigration ? 'refugees' : 'alto-adige';
      const translatedTitle = await translateText(title);
      const translatedSummary = await translateText(rawSummary.slice(0, 220));

      allNews.push({
        id: item.guid || item.link || `${category}-${Date.now()}-${allNews.length}`,
        category,
        source: feedSource.name,
        link: item.link || '',
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        title: translatedTitle,
        summary: translatedSummary
      });

      added++;
    }
  }

  const finalNews = allNews.length > 0 ? allNews : FALLBACK_NEWS;
  finalNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const outputPath = path.join(process.cwd(), 'public', 'data', 'news.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(finalNews, null, 2), 'utf-8');
  console.log(`Saved ${finalNews.length} news items.`);
}

run();
