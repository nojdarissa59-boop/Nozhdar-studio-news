const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml, */*'
  }
});

const FEEDS = [
  {
    name: 'Alto Adige / Südtirol',
    urls: [
      'https://www.altoadige.it/rss',
      'https://www.rainews.it/tgr/tagesschau/rss.xml',
      'https://www.rainews.it/tgr/bolzano/rss.xml'
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
  'rinnovo'
];

async function translateText(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  const cleanText = (text || '').replace(/\s+/g, ' ').trim();
  if (!apiKey || !cleanText) return { ku: cleanText, it: cleanText };

  const prompt = `Translate this Italian news text into natural Kurdish Sorani (ku). Return ONLY the Kurdish translation with no extra explanation:\n\n"${cleanText}"`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    if (!res.ok) {
      console.error(`Gemini HTTP error ${res.status}`);
      return { ku: cleanText, it: cleanText };
    }

    const data = await res.json();
    const kuTranslation =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || cleanText;

    return { ku: kuTranslation, it: cleanText };
  } catch (err) {
    console.error('Translation error:', err.message);
    return { ku: cleanText, it: cleanText };
  }
}

async function fetchFirstWorkingFeed(urls, sourceName) {
  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
        console.log(`Fetched ${feed.items.length} items from ${sourceName} (${url})`);
        return feed.items;
      }
    } catch (error) {
      console.error(`Failed URL ${url} for ${sourceName}: ${error.message}`);
    }
  }
  return [];
}

async function run() {
  const allNews = [];

  for (const feedSource of FEEDS) {
    const items = await fetchFirstWorkingFeed(feedSource.urls, feedSource.name);
    const candidates = items.slice(0, 15);

    let addedForSource = 0;

    for (const item of candidates) {
      if (addedForSource >= 6) break;

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
      const translatedSummary = await translateText(rawSummary.slice(0, 260));

      allNews.push({
        id: item.guid || item.link || `${category}-${Date.now()}-${allNews.length}`,
        category,
        source: feedSource.name,
        link: item.link || '',
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        title: translatedTitle,
        summary: translatedSummary
      });

      addedForSource++;
    }
  }

  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const outputPath = path.join(process.cwd(), 'public', 'data', 'news.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(allNews, null, 2), 'utf-8');
  console.log(`Saved ${allNews.length} news items to public/data/news.json.`);
}

run();
