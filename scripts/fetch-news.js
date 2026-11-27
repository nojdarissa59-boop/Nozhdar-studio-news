import fs from "node:fs/promises";
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({
  timeout: 20000,
  headers: {
    "User-Agent": "NOZHDAR-NewsBot/1.0 (+https://nozhdar07studio.com)"
  }
});

const config = JSON.parse(
  await fs.readFile(new URL("./sources.json", import.meta.url), "utf8")
);
const regions = config.regions;
const sources = config.sources;

const MAX_PER_SOURCE = 8;
const MAX_ARTICLE_CHARS = 9000;
const MAX_TRANSLATE_CONTENT_CHARS = 2500;
const TRANSLATE_BATCH_SIZE = 5;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GOOGLE_RSS = "https://news.google.com/rss/search?q=";

const langTargets = [
  "ku", "it", "en", "bad", "km", "ar", "ma", "tn",
  "dz", "tr", "fa", "sq", "ur", "hi", "bn", "ps"
];

function decodeEntities(str = "") {
  return String(str)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function clean(s = "") {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function host(domain) {
  return String(domain || "").split("/")[0].replace(/^www\./, "");
}

function queryFor(source) {
  const q = source.query || `site:${host(source.domain)} ${source.regionName}`;
  return `${q} when:7d`;
}

function googleFeed(q) {
  return `${GOOGLE_RSS}${encodeURIComponent(q)}&hl=it&gl=IT&ceid=IT:it`;
}

function dateISO(v) {
  const d = new Date(v || Date.now());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function fallbackTranslations(record) {
  const titleObj = {};
  const summaryObj = {};
  const contentObj = {};
  for (const lang of langTargets) {
    titleObj[lang] = record.title;
    summaryObj[lang] = record.summary;
    contentObj[lang] = record.content;
  }
  return {
    title: titleObj,
    summary: summaryObj,
    content: contentObj
  };
}

function normalizeTranslatedItem(rawItem, fallbackRecord) {
  const fb = fallbackTranslations(fallbackRecord);
  if (!rawItem || typeof rawItem !== "object") return fb;

  const titleObj = { ...fb.title };
  const summaryObj = { ...fb.summary };
  const contentObj = { ...fb.content };

  for (const lang of langTargets) {
    const tVal = rawItem.title?.[lang];
    const sVal = rawItem.summary?.[lang];
    const cVal = rawItem.content?.[lang];

    if (typeof tVal === "string" && tVal.trim()) titleObj[lang] = clean(tVal);
    if (typeof sVal === "string" && sVal.trim()) summaryObj[lang] = clean(sVal);
    if (typeof cVal === "string" && cVal.trim()) contentObj[lang] = clean(cVal);
  }

  return {
    title: titleObj,
    summary: summaryObj,
    content: contentObj
  };
}

async function translateBatch(records) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || records.length === 0) {
    return records.map(fallbackTranslations);
  }

  const trimmedInput = records.map((r, index) => ({
    index,
    title: r.title,
    summary: r.summary,
    content: String(r.content || "").slice(0, MAX_TRANSLATE_CONTENT_CHARS)
  }));

  const prompt = [
    `Translate the following Italian news items into these target languages: ${langTargets.join(", ")}.`,
    "Preserve names, numbers, dates, facts, quotes, and meaning. Do not add new facts.",
    "If a language is not confidently translatable, keep the original Italian text for that language.",
    "Return ONLY valid JSON: an array of objects in the exact same order.",
    "Each object must have: index (number), title ({ [lang]: string }), summary ({ [lang]: string }), content ({ [lang]: string }).",
    "INPUT:",
    JSON.stringify(trimmedInput)
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
  }

  if (!Array.isArray(parsed)) {
    return records.map(fallbackTranslations);
  }

  return records.map((rec, idx) => {
    const matched =
      parsed.find((item) => item && item.index === idx) || parsed[idx] || null;
    return normalizeTranslatedItem(matched, rec);
  });
}

const collected = [];
const seen = new Set();

for (const source of sources) {
  try {
    const feed = await parser.parseURL(googleFeed(queryFor(source)));
    for (const item of (feed.items || []).slice(0, MAX_PER_SOURCE)) {
      const title = clean(item.title);
      const link = String(item.link || "").trim();
      if (!title || !link) continue;

      const dedupKey = title.toLowerCase().slice(0, 150);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      let content = clean(item.contentSnippet || item.content || item.summary || "");
      let image = "";

      try {
        const article = await extract(link, {
          headers: { "User-Agent": "Mozilla/5.0 NOZHDAR-NewsBot" }
        });
        if (article) {
          const extractedText = clean(article.content || article.description || "");
          if (extractedText) {
            content = extractedText.slice(0, MAX_ARTICLE_CHARS);
          }
          image = String(article.image || article.images?.[0] || "").trim();
        }
      } catch {
        // Fallback to RSS fields if extraction fails
      }

      if (!content) {
        content = clean(item.contentSnippet || title);
      }

      const summary = clean(item.contentSnippet || content).slice(0, 420);
      const publishedAt = dateISO(item.isoDate || item.pubDate);

      collected.push({
        id: `${source.region}-${Buffer.from(dedupKey).toString("base64url").slice(0, 18)}`,
        region: source.region,
        regionName: source.regionName,
        category: source.region === "italia-immigrazione" ? "immigration-law" : "local",
        section: source.region === "italia-immigrazione" ? "italia-immigrazione" : "regional",
        source: source.name,
        sourceDomain: source.domain,
        sourceType: source.type,
        official:
          source.type === "official" ||
          (source.type === "tv" && String(source.domain).includes("rainews.it")),
        sourceRecord: { title, summary, content },
        image,
        link,
        date: publishedAt,
        pubDate: publishedAt
      });
    }
  } catch (error) {
    console.warn(`Source skipped: ${source.name} (${source.domain}): ${error.message}`);
  }
}

const output = [];
for (let i = 0; i < collected.length; i += TRANSLATE_BATCH_SIZE) {
  const chunk = collected.slice(i, i + TRANSLATE_BATCH_SIZE);
  let translatedChunk;

  try {
    translatedChunk = await translateBatch(chunk.map((c) => c.sourceRecord));
  } catch (error) {
    console.warn(`Translation batch skipped (${error.message}); using original text fallback.`);
    translatedChunk = chunk.map((c) => fallbackTranslations(c.sourceRecord));
  }

  chunk.forEach((entry, idx) => {
    const tr = translatedChunk[idx] || fallbackTranslations(entry.sourceRecord);
    output.push({
      id: entry.id,
      region: entry.region,
      regionName: entry.regionName,
      category: entry.category,
      section: entry.section,
      source: entry.source,
      sourceDomain: entry.sourceDomain,
      sourceType: entry.sourceType,
      official: entry.official,
      title: tr.title,
      summary: tr.summary,
      content: tr.content,
      image: entry.image,
      link: entry.link,
      date: entry.date,
      pubDate: entry.pubDate
    });
  });
}

output.sort((a, b) => new Date(b.date) - new Date(a.date));

await fs.mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await fs.writeFile(
  new URL("../public/data/news.json", import.meta.url),
  JSON.stringify({ updatedAt: new Date().toISOString(), items: output }, null, 2)
);
await fs.writeFile(
  new URL("../public/data/regions.json", import.meta.url),
  JSON.stringify(regions, null, 2)
);

console.log(`Saved ${output.length} stories from ${sources.length} configured regional sources.`);
