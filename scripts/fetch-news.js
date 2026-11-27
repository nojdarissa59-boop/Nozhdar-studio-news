
import fs from "node:fs/promises";
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({
  timeout: 20000,
  headers: {
    "User-Agent": "NOZHDAR-NewsBot/1.0"
  }
});

const config = JSON.parse(
  await fs.readFile(new URL("./sources.json", import.meta.url), "utf8")
);

const sources = config.sources || [];
const regions = config.regions || [];
const NEWS_FILE = new URL("../public/data/news.json", import.meta.url);
const REGIONS_FILE = new URL("../public/data/regions.json", import.meta.url);

const MAX_PER_SOURCE = Math.max(
  1,
  Number(process.env.MAX_PER_SOURCE || 8)
);

const MAX_ARTICLE_CHARS = 9000;
const MAX_TRANSLATE_CONTENT_CHARS = 2500;
const GEMINI_CONTENT_CHARS = 1800;
const GEMINI_BATCH_SIZE = Math.max(
  1,
  Number(process.env.GEMINI_BATCH_SIZE || 5)
);

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

const GOOGLE_RSS = "https://news.google.com/rss/search?q=";

const LANG_TARGETS = [
  "ku", "it", "en", "bad", "km", "ar", "ma", "tn",
  "dz", "tr", "fa", "sq", "ur", "hi", "bn", "ps"
];

// Gemini is used ONLY for Badini.
// Azure handles the other configured languages.
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

function decodeEntities(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

function clean(value = "") {
  return decodeEntities(
    String(value).replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function host(domain = "") {
  return String(domain)
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

function originalLanguageMap(value) {
  return Object.fromEntries(
    LANG_TARGETS.map(language => [language, value])
  );
}

function emptyTranslations(record) {
  return {
    title: originalLanguageMap(record.title),
    summary: originalLanguageMap(record.summary),
    content: originalLanguageMap(record.content)
  };
}

// Supports old news.json files that did not save sourceRecord.
function getOriginalRecord(item) {
  if (
    item.sourceRecord &&
    item.sourceRecord.title &&
    item.sourceRecord.summary &&
    item.sourceRecord.content
  ) {
    return item.sourceRecord;
  }

  const getOriginal = (field) => {
    const value = item[field];

    if (typeof value === "string") return value;

    if (value && typeof value.it === "string") {
      return value.it;
    }

    if (value && typeof value.en === "string") {
      return value.en;
    }

    if (value && typeof value.ku === "string") {
      return value.ku;
    }

    return "";
  };

  const title = getOriginal("title");
  const summary = getOriginal("summary") || title;
  const content = getOriginal("content") || summary;

  if (!title && !summary && !content) return null;

  return {
    title,
    summary,
    content: content.slice(0, MAX_TRANSLATE_CONTENT_CHARS)
  };
}

function hasBadiniTranslation(item) {
  if (item.translationStatus?.badini === true) {
    return true;
  }

  const original = getOriginalRecord(item);
  if (!original) return false;

  const badiniTitle = item.title?.bad;

  return (
    typeof badiniTitle === "string" &&
    badiniTitle.trim() !== "" &&
    badiniTitle.trim() !== original.title.trim()
  );
}

function parseModelJson(raw) {
  const text = String(raw || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);

    if (match) return JSON.parse(match[0]);

    throw new Error("Gemini returned invalid JSON.");
  }
}

function isQuotaError(error) {
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(
    String(error?.message || error)
  );
}

function retryDelayMs(message) {
  const match = String(message || "").match(
    /retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i
  );

  if (!match) return null;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  const total =
    ((hours * 60 + minutes) * 60 + seconds) * 1000;

  return total > 0 ? total : null;
}

let previousData = {
  items: [],
  updatedAt: null,
  badiniQuotaResetAt: null
};

try {
  previousData = JSON.parse(
    await fs.readFile(NEWS_FILE, "utf8")
  );
} catch {
  console.log("No previous news.json found. Starting fresh.");
}

const previousItems = Array.isArray(previousData.items)
  ? previousData.items
  : [];

const previousById = new Map(
  previousItems.map(item => [item.id, item])
);

const previousByLink = new Map(
  previousItems
    .filter(item => item.link)
    .map(item => [item.link, item])
);

// Save data regularly so successful translations are not lost.
async function saveNews(items, extra = {}) {
  await fs.mkdir(
    new URL("../public/data/", import.meta.url),
    { recursive: true }
  );

  await fs.writeFile(
    NEWS_FILE,
    JSON.stringify(
      {
        ...previousData,
        ...extra,
        updatedAt: new Date().toISOString(),
        items
      },
      null,
      2
    )
  );

  previousData.items = items;
  previousData = {
    ...previousData,
    ...extra,
    updatedAt: new Date().toISOString()
  };
}

// ------------------------------
// 1. FETCH ALL NEWS
// ------------------------------

const collected = [];
const seenLinks = new Set();
const seenTitles = new Set();

for (const source of sources) {
  try {
    console.log(`Fetching: ${source.name}`);

    const feed = await parser.parseURL(
      googleFeed(queryFor(source))
    );

    for (
      const item of (feed.items || []).slice(0, MAX_PER_SOURCE)
    ) {
      const title = clean(item.title);
      const link = String(item.link || "").trim();

      if (!title || !link) continue;

      const titleKey = title.toLowerCase().slice(0, 150);
      const linkKey = link.toLowerCase();

      if (
        seenLinks.has(linkKey) ||
        seenTitles.has(titleKey)
      ) {
        continue;
      }

      seenLinks.add(linkKey);
      seenTitles.add(titleKey);

      let content = clean(
        item.contentSnippet ||
        item.content ||
        item.summary ||
        ""
      );

      let image = String(
        item.enclosure?.url || ""
      ).trim();

      let resolvedLink = link;

      try {
        const article = await extract(link, {
          headers: {
            "User-Agent": "Mozilla/5.0 NOZHDAR-NewsBot"
          }
        });

        if (article) {
          resolvedLink = article.url || link;

          const extracted = clean(
            article.content ||
            article.description ||
            ""
          );

          if (extracted) {
            content = extracted.slice(0, MAX_ARTICLE_CHARS);
          }

          image = String(
            article.image ||
            article.images?.[0] ||
            image
          ).trim();
        }
      } catch {
        // Keep RSS content if article extraction fails.
      }

      if (!content) content = title;

      const summary = clean(
        item.contentSnippet || content
      ).slice(0, 420);

      const publishedAt = dateISO(
        item.isoDate || item.pubDate
      );

      const special =
        source.region === "italia-immigrazione";

      const id =
        `${source.region}-` +
        Buffer.from(titleKey)
          .toString("base64url")
          .slice(0, 18);

      collected.push({
        id,
        region: source.region,
        regionName: source.regionName,
        category: special
          ? "immigration-law"
          : "local",
        section: special
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
        sourceRecord: {
          title,
          summary,
          content: content.slice(
            0,
            MAX_TRANSLATE_CONTENT_CHARS
          )
        },
        image,
        link: resolvedLink,
        date: publishedAt,
        pubDate: publishedAt
      });
    }
  } catch (error) {
    console.warn(
      `Source skipped: ${source.name}: ${error.message}`
    );
  }
}

// ------------------------------
// 2. MERGE OLD AND NEW NEWS
// ------------------------------

const outputMap = new Map();

for (const entry of collected) {
  const previous =
    previousById.get(entry.id) ||
    previousByLink.get(entry.link);

  const original = entry.sourceRecord;
  const base = emptyTranslations(original);

  const copyLanguageMap = (field) => {
    const map = { ...base[field] };

    for (const language of LANG_TARGETS) {
      const oldValue = previous?.[field]?.[language];

      if (
        typeof oldValue === "string" &&
        oldValue.trim()
      ) {
        map[language] = oldValue;
      }
    }

    return map;
  };

  const item = {
    ...entry,
    title: copyLanguageMap("title"),
    summary: copyLanguageMap("summary"),
    content: copyLanguageMap("content"),
    image: entry.image || previous?.image || "",
    sourceRecord: original,
    translationStatus: {
      azure: {
        ...(previous?.translationStatus?.azure || {})
      },
      badini: hasBadiniTranslation(previous || {})
    }
  };

  outputMap.set(item.id, item);
}

// Keep old stories even if a source temporarily removes them.
// Do not delete pending Badini translations.
const fetchedIds = new Set(
  [...outputMap.values()].map(item => item.id)
);

const sevenDaysAgo =
  Date.now() - 7 * 24 * 60 * 60 * 1000;

for (const oldItem of previousItems) {
  if (fetchedIds.has(oldItem.id)) continue;

  const oldDate = new Date(
    oldItem.date || oldItem.pubDate || 0
  ).getTime();

  const original = getOriginalRecord(oldItem);

  const isPendingBadini =
    original && !hasBadiniTranslation(oldItem);

  if (
    (!Number.isFinite(oldDate) || oldDate < sevenDaysAgo) &&
    !isPendingBadini
  ) {
    continue;
  }

  const migrated = {
    ...oldItem,
    sourceRecord: original || oldItem.sourceRecord || null,
    translationStatus: {
      azure: {
        ...(oldItem.translationStatus?.azure || {})
      },
      badini: hasBadiniTranslation(oldItem)
    }
  };

  outputMap.set(migrated.id, migrated);
}

const output = [...outputMap.values()];

output.sort(
  (a, b) => new Date(b.date) - new Date(a.date)
);

console.log(`Collected and retained ${output.length} stories.`);

// Save the original news before starting translation.
await saveNews(output);

// ------------------------------
// 3. MICROSOFT AZURE TRANSLATION
// ------------------------------

async function azureTranslateBatch(texts, targetCode) {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;

  if (!key || !region) {
    throw new Error(
      "Azure Translator key or region is missing."
    );
  }

  const endpoint =
    process.env.AZURE_TRANSLATOR_ENDPOINT ||
    "https://api.cognitive.microsofttranslator.com";

  const url = new URL(
    `${endpoint.replace(/\/$/, "")}/translate`
  );

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
    body: JSON.stringify(
      texts.map(Text => ({ Text }))
    )
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Azure ${response.status}: ${details.slice(0, 500)}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("Azure returned an incomplete translation batch.");
  }

  return data.map((item, index) => {
    const translated = clean(
      item?.translations?.[0]?.text || ""
    );

    if (!translated) {
      throw new Error("Azure returned an empty translation.");
    }

    return translated;
  });
}

async function translateWithAzure(items, languageKey) {
  const targetCode = AZURE_LANGUAGES[languageKey];

  if (!targetCode) return;

  const slots = [];

  for (const item of items) {
    for (const field of ["title", "summary", "content"]) {
      slots.push({
        item,
        field,
        text: item.sourceRecord[field]
      });
    }
  }

  // Azure accepts batches of text objects.
  const BATCH_SIZE = 80;

  for (
    let start = 0;
    start < slots.length;
    start += BATCH_SIZE
  ) {
    const batch = slots.slice(
      start,
      start + BATCH_SIZE
    );

    const translated = await azureTranslateBatch(
      batch.map(slot => slot.text),
      targetCode
    );

    for (let i = 0; i < batch.length; i++) {
      batch[i].item[batch[i].field][languageKey] =
        translated[i];
    }
  }
}

for (const languageKey of Object.keys(AZURE_LANGUAGES)) {
  const pending = output.filter(item =>
    item.sourceRecord &&
    item.translationStatus?.azure?.[languageKey] !== true
  );

  if (!pending.length) continue;

  try {
    console.log(
      `Azure ${languageKey}: ${pending.length} stories pending.`
    );

    await translateWithAzure(pending, languageKey);

    for (const item of pending) {
      item.translationStatus.azure[languageKey] = true;
    }

    await saveNews(output);

    console.log(`Azure completed: ${languageKey}`);
  } catch (error) {
    console.warn(
      `Azure ${languageKey} failed: ${error.message}`
    );
  }
}

// ------------------------------
// 4. GEMINI BADINI TRANSLATION
// ------------------------------

async function translateBadiniBatch(items) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const input = items.map((item, index) => ({
    index,
    title: item.sourceRecord.title,
    summary: item.sourceRecord.summary,
    content: item.sourceRecord.content.slice(
      0,
      GEMINI_CONTENT_CHARS
    )
  }));

  const prompt = [
    "You are a professional Badini Kurdish news translator.",
    "Translate every supplied news item from Italian into Badini Kurdish.",
    "Use natural Badini dialect spoken in Duhok and the Badinan region.",
    "Write in Kurdish Arabic-based script.",
    "Do NOT use Sorani dialect.",
    "Do NOT use standard Kurmanji Latin script.",
    "Keep the original meaning and all factual details.",
    "Preserve names, places, dates, numbers and legal terminology.",
    "Never invent facts or add information.",
    "Return ONLY valid JSON.",
    "Return one object for every input item.",
    "Each object must contain index, title, summary and content.",
    "All four fields must be strings.",
    "INPUT:",
    JSON.stringify(input)
  ].join("\n");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
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
    const details = await response.text();

    throw new Error(
      `Gemini API ${response.status}: ${details.slice(0, 900)}`
    );
  }

  const data = await response.json();

  const raw =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "";

  const parsed = parseModelJson(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini response is not an array.");
  }

  const translatedByIndex = new Map(
    parsed.map(item => [Number(item.index), item])
  );

  for (let index = 0; index < items.length; index++) {
    const translated = translatedByIndex.get(index);

    if (
      !translated ||
      typeof translated.title !== "string" ||
      !translated.title.trim() ||
      typeof translated.summary !== "string" ||
      !translated.summary.trim() ||
      typeof translated.content !== "string" ||
      !translated.content.trim()
    ) {
      throw new Error(
        `Gemini did not translate all fields for item ${index + 1}.`
      );
    }

    items[index].title.bad = clean(translated.title);
    items[index].summary.bad = clean(translated.summary);
    items[index].content.bad = clean(translated.content);
  }
}

// All stories without a completed Badini translation.
const pendingBadini = output.filter(item =>
  item.sourceRecord &&
  !hasBadiniTranslation(item)
);

let badiniTranslated = 0;
let badiniStoppedByQuota = false;

const savedResetTime = previousData.badiniQuotaResetAt
  ? new Date(previousData.badiniQuotaResetAt).getTime()
  : 0;

if (savedResetTime > Date.now()) {
  console.log(
    `Gemini is paused until ${new Date(savedResetTime).toISOString()}`
  );
} else {
  for (
    let start = 0;
    start < pendingBadini.length;
    start += GEMINI_BATCH_SIZE
  ) {
    const batch = pendingBadini.slice(
      start,
      start + GEMINI_BATCH_SIZE
    );

    try {
      console.log(
        `Gemini Badini: ${start + 1}-${start + batch.length} ` +
        `of ${pendingBadini.length}`
      );

      await translateBadiniBatch(batch);

      for (const item of batch) {
        item.translationStatus.badini = true;
      }

      badiniTranslated += batch.length;

      // Save after EVERY successful batch.
      await saveNews(output, {
        badiniQuotaResetAt: null
      });

      console.log(
        `Badini completed: ${badiniTranslated}/${pendingBadini.length}`
      );
    } catch (error) {
      console.warn(
        `Badini batch failed: ${error.message}`
      );

      if (isQuotaError(error)) {
        const delay =
          retryDelayMs(error.message) ||
          6 * 60 * 60 * 1000;

        const resetAt = new Date(
          Date.now() + delay
        ).toISOString();

        await saveNews(output, {
          badiniQuotaResetAt: resetAt
        });

        console.warn(
          `Gemini quota reached. Pending stories are saved. ` +
          `Retry after ${resetAt}.`
        );

        badiniStoppedByQuota = true;
        break;
      }

      // If one batch fails, stop here.
      // The failed and remaining stories stay pending for the next run.
      break;
    }
  }
}

// ------------------------------
// 5. FINAL SAVE
// ------------------------------

output.sort(
  (a, b) => new Date(b.date) - new Date(a.date)
);

await saveNews(output);

await fs.writeFile(
  REGIONS_FILE,
  JSON.stringify(regions, null, 2)
);

const remainingBadini = output.filter(item =>
  item.sourceRecord &&
  !hasBadiniTranslation(item)
).length;

console.log("----------------------------------");
console.log("NOZHDAR NEWS UPDATE COMPLETED");
console.log(`Total saved stories: ${output.length}`);
console.log(`Badini translated this run: ${badiniTranslated}`);
console.log(`Badini still pending: ${remainingBadini}`);
console.log(`Stopped by Gemini quota: ${badiniStoppedByQuota}`);
console.log("----------------------------------");
