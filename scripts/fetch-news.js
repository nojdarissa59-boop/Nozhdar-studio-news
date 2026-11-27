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
const regions = config.regions || [];
const sources = config.sources || [];
const NEWS_FILE = new URL("../public/data/news.json", import.meta.url);

let previousItems = [];
try {
  const previousData = JSON.parse(await fs.readFile(NEWS_FILE, "utf8"));
  previousItems = Array.isArray(previousData.items) ? previousData.items : [];
} catch {
  previousItems = [];
}
const previousById = new Map(previousItems.map((item) => [item.id, item]));

const MAX_PER_SOURCE = Number(process.env.MAX_PER_SOURCE || 8);
const MAX_ARTICLE_CHARS = 9000;
const MAX_TRANSLATE_CONTENT_CHARS = 2500;
const AZURE_BATCH_ITEMS = 80;
const AZURE_BATCH_CHARS = 42000;
const GEMINI_BATCH_SIZE = 15;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GOOGLE_RSS = "https://news.google.com/rss/search?q=";

const LANG_TARGETS = [
  "ku", "it", "en", "bad", "km", "ar", "ma", "tn",
  "dz", "tr", "fa", "sq", "ur", "hi", "bn", "ps"
];

const AZURE_LANGUAGES = {
  ku: "ku",
  it: "it",
  en: "en",
  km: "kmr",
  ar: "ar",
  ma: "ar",
  tn: "ar",
  dz: "ar",
  tr: "tr",
  fa: "fa",
  sq: "sq",
  ur: "ur",
  hi: "hi",
  bn: "bn",
  ps: "ps"
};

function decodeEntities(str = "") {
  return String(str)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function clean(value = "") {
  return decodeEntities(String(value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function host(domain = "") {
  return String(domain).split("/")[0].replace(/^www\./, "");
}

function queryFor(source) {
  const q = source.query || `site:${host(source.domain)} ${source.regionName}`;
  return `${q} when:7d`;
}

function googleFeed(q) {
  return `${GOOGLE_RSS}${encodeURIComponent(q)}&hl=it&gl=IT&ceid=IT:it`;
}

function dateISO(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function originalLanguageMap(value) {
  return Object.fromEntries(LANG_TARGETS.map((lang) => [lang, value]));
}

function emptyTranslationRecord(record) {
  return {
    title: originalLanguageMap(record.title),
    summary: originalLanguageMap(record.summary),
    content: originalLanguageMap(record.content)
  };
}

function makeChunks(values, maxItems, maxChars) {
  const chunks = [];
  let current = [];
  let chars = 0;

  for (const value of values) {
    const text = String(value ?? "");
    if (current.length && (current.length >= maxItems || chars + text.length > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function azureTranslateBatch(texts, targetCode) {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;

  if (!key || !region) {
    throw new Error("Missing AZURE_TRANSLATOR_KEY or AZURE_TRANSLATOR_REGION GitHub secret.");
  }

  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT ||
    "https://api.cognitive.microsofttranslator.com";

  const url = new URL(`${endpoint.replace(/\/$/, "")}/translate`);
  url.searchParams.set("api-version", "3.0");
  url.searchParams.set("from", "it");
  url.searchParams.set("to", targetCode);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(texts.map((Text) => ({ Text })))
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Microsoft Translator ${response.status}: ${details.slice(0, 500)}`);
  }

  const data = await response.json();
  return data.map((item, index) =>
    clean(item?.translations?.[0]?.text || texts[index] || "")
  );
}

async function translateWithAzure(items, languageKey) {
  const targetCode = AZURE_LANGUAGES[languageKey];
  if (!targetCode) return;

  const slots = [];

  for (let i = 0; i < items.length; i++) {
    for (const field of ["title", "summary", "content"]) {
      slots.push({
        itemIndex: i,
        field,
        text: items[i].sourceRecord[field]
      });
    }
  }

  const chunks = makeChunks(
    slots.map((slot) => slot.text),
    AZURE_BATCH_ITEMS,
    AZURE_BATCH_CHARS
  );

  let slotOffset = 0;

  for (const chunk of chunks) {
    const translated = await azureTranslateBatch(chunk, targetCode);

    translated.forEach((text, index) => {
      const slot = slots[slotOffset + index];
      items[slot.itemIndex][slot.field][languageKey] = text || slot.text;
    });

    slotOffset += chunk.length;
  }
}

function parseJsonFromModel(rawText) {
  const cleaned = String(rawText || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Gemini returned invalid JSON.");
  }
}

async function translateBadiniBatch(items, startIndex) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY GitHub secret.");

  const input = items.map((item, index) => ({
    index: startIndex + index,
    title: item.sourceRecord.title,
    summary: item.sourceRecord.summary,
    content: item.sourceRecord.content.slice(0, MAX_TRANSLATE_CONTENT_CHARS)
  }));

  const prompt = [
    "Translate these Italian news items into Badini Kurdish only.",
    "Use natural Badini Kurdish in Arabic-based Kurdish script, not Sorani and not Kurmanji.",
    "Preserve all names, places, dates, numbers, legal terms and facts. Do not invent information.",
    "The summary should be concise and informative. Keep the content faithful to the source.",
    "Return ONLY valid JSON: an array with one object per input item.",
    "Each object must contain index (number), title (string), summary (string), content (string).",
    "INPUT:",
    JSON.stringify(input)
  ].join("\n");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`;

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
    const details = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${details.slice(0, 700)}`);
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  const parsed = parseJsonFromModel(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini response was not an array.");
  }

  for (let index = 0; index < items.length; index++) {
    const wantedIndex = startIndex + index;
    const found =
      parsed.find((entry) => Number(entry?.index) === wantedIndex) || parsed[index];

    if (!found) continue;

    if (typeof found.title === "string" && found.title.trim()) {
      items[index].title.bad = clean(found.title);
    }

    if (typeof found.summary === "string" && found.summary.trim()) {
      items[index].summary.bad = clean(found.summary);
    }

    if (typeof found.content === "string" && found.content.trim()) {
      items[index].content.bad = clean(found.content);
    }
  }
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

      const dedupeKey = title.toLowerCase().slice(0, 150);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let content = clean(item.contentSnippet || item.content || item.summary || "");
      let image = String(item.enclosure?.url || "").trim();
      let resolvedLink = link;

      try {
        const article = await extract(link, {
          headers: { "User-Agent": "Mozilla/5.0 NOZHDAR-NewsBot" }
        });

        if (article) {
          resolvedLink = article.url || link;
          const extracted = clean(article.content || article.description || "");

          if (extracted) {
            content = extracted.slice(0, MAX_ARTICLE_CHARS);
          }

          image = String(article.image || article.images?.[0] || image).trim();
        }
      } catch {
        // Keep RSS text if the publisher blocks article extraction.
      }

      if (!content) content = title;

      const summary = clean(item.contentSnippet || content).slice(0, 420);
      const publishedAt = dateISO(item.isoDate || item.pubDate);
      const special = source.region === "italia-immigrazione";

      collected.push({
        id: `${source.region}-${Buffer.from(dedupeKey).toString("base64url").slice(0, 18)}`,
        region: source.region,
        regionName: source.regionName,
        category: special ? "immigration-law" : "local",
        section: special ? "italia-immigrazione" : "regional",
        source: source.name,
        sourceDomain: source.domain,
        sourceType: source.type,
        official: source.type === "official" ||
          (source.type === "tv" && String(source.domain).includes("rainews.it")),
        sourceRecord: {
          title,
          summary,
          content: content.slice(0, MAX_TRANSLATE_CONTENT_CHARS)
        },
        image,
        link: resolvedLink,
        date: publishedAt,
        pubDate: publishedAt
      });
    }
  } catch (error) {
    console.warn(
      `Source skipped: ${source.name} (${source.domain}): ${error.message}`
    );
  }
}

const output = collected.map((entry) => {
  const previous = previousById.get(entry.id);
  const baseTranslations = emptyTranslationRecord(entry.sourceRecord);

  const copyPreviousLanguageMap = (field) => {
    const map = { ...baseTranslations[field] };

    for (const language of LANG_TARGETS) {
      const oldValue = previous?.[field]?.[language];

      if (typeof oldValue === "string" && oldValue.trim()) {
        map[language] = oldValue;
      }
    }

    return map;
  };

  return {
    id: entry.id,
    region: entry.region,
    regionName: entry.regionName,
    category: entry.category,
    section: entry.section,
    source: entry.source,
    sourceDomain: entry.sourceDomain,
    sourceType: entry.sourceType,
    official: entry.official,
    title: copyPreviousLanguageMap("title"),
    summary: copyPreviousLanguageMap("summary"),
    content: copyPreviousLanguageMap("content"),
    image: entry.image || previous?.image || "",
    link: entry.link,
    date: entry.date,
    pubDate: entry.pubDate,
    sourceRecord: entry.sourceRecord,
    translationStatus: {
      azure: { ...(previous?.translationStatus?.azure || {}) },
      badini: previous?.translationStatus?.badini === true
    }
  };
});

// Keep saved stories within the last seven days.
const fetchedIds = new Set(output.map((item) => item.id));
const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

for (const previous of previousItems) {
  if (fetchedIds.has(previous.id)) continue;

  const previousDate = new Date(
    previous.date || previous.pubDate || 0
  ).getTime();

  if (!Number.isFinite(previousDate) || previousDate < sevenDaysAgo) {
    continue;
  }

  output.push(previous);
}

const translatableItems = output.filter((item) => item.sourceRecord);

// Microsoft Translator handles all non-Badini languages.
// Previously translated news is not translated again.
for (const languageKey of Object.keys(AZURE_LANGUAGES)) {
  const pending = translatableItems.filter(
    (item) => item.translationStatus?.azure?.[languageKey] !== true
  );

  if (!pending.length) continue;

  try {
    await translateWithAzure(pending, languageKey);

    for (const item of pending) {
      item.translationStatus.azure[languageKey] = true;
    }

    console.log(
      `Microsoft Translator completed: ${languageKey} (${pending.length} new stories)`
    );
  } catch (error) {
    console.warn(
      `Microsoft translation skipped for ${languageKey}: ${error.message}`
    );
  }
}

// Gemini is used only for Badini.
const pendingBadini = translatableItems.filter(
  (item) => item.translationStatus?.badini !== true
);

let badiniSuccess = 0;

for (let start = 0; start < pendingBadini.length; start += GEMINI_BATCH_SIZE) {
  const batch = pendingBadini.slice(start, start + GEMINI_BATCH_SIZE);

  try {
    await translateBadiniBatch(batch, start);

    for (const item of batch) {
      item.translationStatus.badini = true;
    }

    badiniSuccess += batch.length;

    console.log(
      `Gemini Badini translated: ${Math.min(start + batch.length, pendingBadini.length)}/${pendingBadini.length}`
    );
  } catch (error) {
    console.warn(
      `Badini batch ${start + 1}-${start + batch.length} skipped: ${error.message}`
    );
    // Keep the original Italian text and retry next time.
  }
}

for (const item of output) {
  delete item.sourceRecord;
}

output.sort((a, b) => new Date(b.date) - new Date(a.date));

await fs.mkdir(new URL("../public/data/", import.meta.url), {
  recursive: true
});

await fs.writeFile(
  NEWS_FILE,
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

console.log(
  `Saved ${output.length} stories. Microsoft languages: ${Object.keys(AZURE_LANGUAGES).length}; ` +
  `Badini translated in this run: ${badiniSuccess}/${pendingBadini.length} pending.`
);
