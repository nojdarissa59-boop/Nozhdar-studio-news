
import fs from "node:fs/promises";
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({
  timeout: 12000,
  headers: {
    "User-Agent": "NOZHDAR-NewsBot/1.0"
  }
});

const config = JSON.parse(
  await fs.readFile(new URL("./sources.json", import.meta.url), "utf8")
);

const regions = config.regions || [];
const sources = config.sources || [];

const MAX_PER_SOURCE = 4;
const MAX_TOTAL_STORIES = 180;
const MAX_ARTICLE_CHARS = 6000;
const MAX_TRANSLATE_CONTENT_CHARS = 500;
const TRANSLATE_BATCH_SIZE = 3;
const MAX_TRANSLATION_CALLS = 4;
const SOURCE_CONCURRENCY = 6;
const EXTRACT_CONCURRENCY = 6;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

const GOOGLE_RSS =
  "https://news.google.com/rss/search?q=";

const langTargets = [
  "ku", "it", "en", "bad", "km", "ar",
  "ma", "tn", "dz", "tr", "fa", "sq",
  "ur", "hi", "bn", "ps"
];

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function clean(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function host(domain) {
  return String(domain || "")
    .split("/")[0]
    .replace(/^www\./, "");
}

function queryFor(source) {
  const query =
    source.query ||
    `site:${host(source.domain)} ${source.regionName}`;

  return `${query} when:7d`;
}

function googleFeed(query) {
  return (
    GOOGLE_RSS +
    encodeURIComponent(query) +
    "&hl=it&gl=IT&ceid=IT:it"
  );
}

function dateISO(value) {
  const date = new Date(value || Date.now());

  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function getLanguageValue(object, language) {
  return typeof object?.[language] === "string"
    ? object[language]
    : "";
}

function fallbackTranslations(record) {
  const title = {};
  const summary = {};
  const content = {};

  for (const language of langTargets) {
    title[language] = record.title;
    summary[language] = record.summary;
    content[language] = record.content;
  }

  return { title, summary, content };
}

function isTranslated(item) {
  if (!item?.title || !item?.summary || !item?.content) {
    return false;
  }

  const original = getLanguageValue(item.title, "it");
  if (!original) return false;

  const coreLanguages = ["ku", "bad", "en"];

  return coreLanguages.every((language) => {
    const title = getLanguageValue(item.title, language);
    const summary = getLanguageValue(item.summary, language);

    return (
      (title && title !== original) ||
      (summary &&
        summary !== getLanguageValue(item.summary, "it"))
    );
  });
}

function normalizeTranslatedItem(raw, record) {
  const fallback = fallbackTranslations(record);

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const result = {
    title: { ...fallback.title },
    summary: { ...fallback.summary },
    content: { ...fallback.content }
  };

  for (const language of langTargets) {
    for (const field of ["title", "summary", "content"]) {
      const value = raw[field]?.[language];

      if (typeof value === "string" && value.trim()) {
        result[field][language] = clean(value);
      }
    }
  }

  return result;
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;

        if (index >= items.length) return;

        try {
          results[index] = await callback(items[index], index);
        } catch (error) {
          console.warn(
            `Task failed: ${error.message}`
          );
          results[index] = null;
        }
      }
    }
  );

  await Promise.all(workers);

  return results;
}

async function extractArticle(link) {
  let timer;

  try {
    const article = await Promise.race([
      extract(link, {
        headers: {
          "User-Agent": "Mozilla/5.0 NOZHDAR-NewsBot"
        }
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 9000);
      })
    ]);

    return article || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function translateBatch(records) {
  const key = process.env.GEMINI_API_KEY;

  if (!key || !records.length) {
    return records.map(fallbackTranslations);
  }

  const input = records.map((record, index) => ({
    index,
    title: record.title,
    summary: record.summary,
    content: String(record.content || "").slice(
      0,
      MAX_TRANSLATE_CONTENT_CHARS
    )
  }));

  const prompt = [
    "You are a professional news translator.",
    `Translate every news item into: ${langTargets.join(", ")}.`,
    "ku means Sorani Kurdish.",
    "bad means Badini Kurdish.",
    "km means Kurmanji Kurdish.",
    "it means Italian.",
    "en means English.",
    "ar means Arabic.",
    "Preserve names, places, dates, numbers and facts.",
    "Do not invent information or summarize differently.",
    "Return only valid JSON.",
    "Return an array in the same order.",
    "Each item must contain index, title, summary and content.",
    "Each text field must be an object containing all language codes.",
    "INPUT:",
    JSON.stringify(input)
  ].join("\n");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=` +
    encodeURIComponent(key);

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(45000),
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");

    const error = new Error(
      `Gemini API ${response.status}: ${errorText.slice(0, 500)}`
    );

    error.status = response.status;
    throw error;
  }

  const data = await response.json();

  const rawText =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  let parsed;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini returned invalid JSON.");
  }

  return records.map((record, index) => {
    const item =
      parsed.find((entry) => entry?.index === index) ||
      parsed[index];

    return normalizeTranslatedItem(item, record);
  });
}

// Load previous news to reuse completed translations.
const previousPath = new URL(
  "../public/data/news.json",
  import.meta.url
);

let previousItems = [];

try {
  const previous = JSON.parse(
    await fs.readFile(previousPath, "utf8")
  );

  previousItems = Array.isArray(previous.items)
    ? previous.items
    : [];
} catch {
  previousItems = [];
}

const previousById = new Map(
  previousItems.map((item) => [item.id, item])
);

const seen = new Set();
const collected = [];

// Fetch all RSS sources with limited concurrency.
const sourceResults = await mapLimit(
  sources,
  SOURCE_CONCURRENCY,
  async (source) => {
    try {
      const feed = await parser.parseURL(
        googleFeed(queryFor(source))
      );

      return (feed.items || [])
        .slice(0, MAX_PER_SOURCE)
        .map((item, index) => ({
          source,
          item,
          index
        }));
    } catch (error) {
      console.warn(
        `Source skipped: ${source.name} (${source.domain}): ${error.message}`
      );

      return [];
    }
  }
);

const candidates = sourceResults
  .filter(Boolean)
  .flat()
  .sort((a, b) => {
    return (
      new Date(b.item.isoDate || b.item.pubDate || 0) -
      new Date(a.item.isoDate || a.item.pubDate || 0)
    );
  });

for (const candidate of candidates) {
  const { source, item } = candidate;

  const title = clean(item.title);
  const link = String(item.link || "").trim();

  if (!title || !link) continue;

  const dedupKey = title.toLowerCase().slice(0, 150);

  if (seen.has(dedupKey)) continue;

  seen.add(dedupKey);

  const id =
    `${source.region}-` +
    Buffer.from(dedupKey).toString("base64url").slice(0, 18);

  collected.push({
    id,
    source,
    item,
    title,
    link,
    date: dateISO(item.isoDate || item.pubDate)
  });

  if (collected.length >= MAX_TOTAL_STORIES) break;
}

// Extract article text and images only for the first story
// from each source to avoid excessive requests.
const extracted = await mapLimit(
  collected,
  EXTRACT_CONCURRENCY,
  async (entry, index) => {
    let content = clean(
      entry.item.contentSnippet ||
      entry.item.content ||
      entry.item.summary ||
      ""
    );

    let image = "";

    if (entry.item && entry.item.enclosure?.url) {
      image = entry.item.enclosure.url;
    }

    if (entry.item && entry.item.mediaContent?.$?.url) {
      image = entry.item.mediaContent.$.url;
    }

    if (entry.item && entry.item.mediaThumbnail?.$?.url) {
      image = entry.item.mediaThumbnail.$.url;
    }

    if (entry.item && entry.item["media:content"]?.url) {
      image = entry.item["media:content"].url;
    }

    // Extract only one article per source.
    const firstFromSource =
      index === 0 ||
      collected[index - 1]?.source?.name !== entry.source.name;

    if (firstFromSource) {
      const article = await extractArticle(entry.link);

      if (article) {
        const extractedText = clean(
          article.content || article.description || ""
        );

        if (extractedText) {
          content = extractedText.slice(0, MAX_ARTICLE_CHARS);
        }

        image =
          String(
            article.image ||
            article.images?.[0] ||
            image ||
            ""
          ).trim();
      }
    }

    if (!content) content = entry.title;

    const summary = clean(
      entry.item.contentSnippet || content
    ).slice(0, 420);

    return {
      ...entry,
      content,
      summary,
      image
    };
  }
);

const freshItems = extracted.filter(Boolean);

const outputMap = new Map();
const pending = [];

// Keep translations already completed.
// Retry items that still have only their original language.
for (const entry of freshItems) {
  const source = entry.source;

  const immigration =
    source.region === "italia-immigrazione";

  const old = previousById.get(entry.id);

  const record = {
    title: entry.title,
    summary: entry.summary,
    content: entry.content
  };

  if (old && isTranslated(old)) {
    outputMap.set(entry.id, {
      ...old,
      image: entry.image || old.image || "",
      link: entry.link,
      date: entry.date,
      pubDate: entry.date
    });

    continue;
  }

  pending.push({
    id: entry.id,
    region: source.region,
    regionName: source.regionName,
    category: immigration ? "immigration-law" : "local",
    section: immigration
      ? "italia-immigrazione"
      : "regional",
    source: source.name,
    sourceDomain: source.domain,
    sourceType: source.type,
    official:
      source.type === "official" ||
      (
        source.type === "tv" &&
        String(source.domain).includes("rainews.it")
      ),
    image: entry.image,
    link: entry.link,
    date: entry.date,
    pubDate: entry.date,
    sourceRecord: record
  });
}

// Keep recent previous stories that were not found in this run.
// This also preserves untranslated stories for later attempts.
const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

for (const old of previousItems) {
  if (outputMap.has(old.id)) continue;
  if (pending.some((item) => item.id === old.id)) continue;

  const oldDate = new Date(old.date || old.pubDate || 0).getTime();

  if (!oldDate || oldDate < sevenDaysAgo) continue;

  if (isTranslated(old)) {
    outputMap.set(old.id, old);
  } else {
    pending.push({
      ...old,
      sourceRecord: {
        title: getLanguageValue(old.title, "it"),
        summary: getLanguageValue(old.summary, "it"),
        content: getLanguageValue(old.content, "it")
      }
    });
  }
}

// Translate a limited number of batches per workflow run.
let translationCalls = 0;
let quotaBlocked = false;

pending.sort(
  (a, b) => new Date(b.date) - new Date(a.date)
);

for (
  let i = 0;
  i < pending.length;
  i += TRANSLATE_BATCH_SIZE
) {
  const chunk = pending.slice(
    i,
    i + TRANSLATE_BATCH_SIZE
  );

  let translated;

  if (
    !process.env.GEMINI_API_KEY ||
    translationCalls >= MAX_TRANSLATION_CALLS ||
    quotaBlocked
  ) {
    translated = chunk.map((item) =>
      fallbackTranslations(item.sourceRecord)
    );
  } else {
    try {
      translated = await translateBatch(
        chunk.map((item) => item.sourceRecord)
      );

      translationCalls++;

      await sleep(1200);
    } catch (error) {
      console.warn(
        `Translation failed: ${error.message}`
      );

      if (
        error.status === 429 ||
        String(error.message).includes("429") ||
        String(error.message).includes("RESOURCE_EXHAUSTED")
      ) {
        quotaBlocked = true;

        console.warn(
          "Gemini quota reached. Remaining translations will be retried in a later run."
        );
      }

      translated = chunk.map((item) =>
        fallbackTranslations(item.sourceRecord)
      );
    }
  }

  chunk.forEach((entry, index) => {
    const translation =
      translated[index] ||
      fallbackTranslations(entry.sourceRecord);

    outputMap.set(entry.id, {
      id: entry.id,
      region: entry.region,
      regionName: entry.regionName,
      category: entry.category,
      section: entry.section,
      source: entry.source,
      sourceDomain: entry.sourceDomain,
      sourceType: entry.sourceType,
      official: entry.official,
      title: translation.title,
      summary: translation.summary,
      content: translation.content,
      image: entry.image || "",
      link: entry.link,
      date: entry.date,
      pubDate: entry.pubDate,
      translationStatus:
        isTranslated(translation)
          ? "translated"
          : "pending"
    });
  });
}

// Preserve already translated stories and save the final result.
const output = [...outputMap.values()]
  .sort(
    (a, b) =>
      new Date(b.date || b.pubDate) -
      new Date(a.date || a.pubDate)
  )
  .slice(0, MAX_TOTAL_STORIES);

await fs.mkdir(
  new URL("../public/data/", import.meta.url),
  { recursive: true }
);

await fs.writeFile(
  previousPath,
  JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      items: output
    },
    null,
    2
  )
);

await fs.writeFile(
  new URL("../public/data/regions.json", import.meta.url),
  JSON.stringify(regions, null, 2)
);

const translatedCount = output.filter(isTranslated).length;
const pendingCount = output.length - translatedCount;

console.log(
  `Saved ${output.length} stories from ${sources.length} sources.`
);

console.log(
  `Translated: ${translatedCount} | Pending: ${pendingCount} | Gemini calls: ${translationCalls}`
);
