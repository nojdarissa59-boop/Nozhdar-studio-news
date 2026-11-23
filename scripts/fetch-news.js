const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const parser = new Parser();

const FEEDS = [
  {
    name: 'Alto Adige / Südtirol',
    url: 'https://www.altoadige.it/rss',
    defaultCategory: 'alto-adige'
  },
  {
    name: 'ANSA Cronaca / Italia',
    url: 'https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml',
    defaultCategory: 'italia'
  }
];

const IMMIGRATION_KEYWORDS = [
  'permesso di soggiorno', 'immigrazione', 'rifugiati', 'asilo',
  'questura', 'cittadinanza', 'decreto flussi', 'stranieri', 'migranti'
];

async function translateText(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !text) return { ku: text, it: text };

  const prompt = `Translate this Italian news text into Kurdish Sorani (ku). Return ONLY the Kurdish translation without extra notes:\n\n"${text}"`;

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
    const data = await res.json();
    const kuTranslation =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || text;
    return { ku: kuTranslation, it: text };
  } catch (err) {
    console.error('Translation error:', err);
    return { ku: text, it: text };
  }
}

async function run() {
  const allNews = [];

  for (const feedSource of FEEDS) {
    try {
      const feed = await parser.parseURL(feedSource.url);
      const latestItems = feed.items.slice(0, 10);

      for (const item of latestItems) {
        const title = item.title || '';
        const summary = item.contentSnippet || item.content || '';
        const combinedText = `${title} ${summary}`.toLowerCase();

        const isImmigration = IMMIGRATION_KEYWORDS.some((kw) =>
          combinedText.includes(kw)
        );

        if (feedSource.defaultCategory === 'italia' && !isImmigration) {
          continue;
        }

        const category = isImmigration ? 'refugees' : 'alto-adige';
        const translatedTitle = await translateText(title);
        const translatedSummary = await translateText(summary.slice(0, 250));

        allNews.push({
          id: item.guid || item.link,
          category,
          source: feedSource.name,
          link: item.link,
          pubDate: item.pubDate || new Date().toISOString(),
          title: translatedTitle,
          summary: translatedSummary
        });
      }
    } catch (error) {
      console.error(`Error fetching ${feedSource.name}:`, error.message);
    }
  }

  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const outputPath = path.join(process.cwd(), 'public', 'data', 'news.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(allNews, null, 2), 'utf-8');
  console.log(`Saved ${allNews.length} news items.`);
}

run();
