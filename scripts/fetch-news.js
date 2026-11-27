
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
let badiniRequestTimestamps = [];
let badiniQuotaResetAt = null;
let myMemoryUsageDate = "";
let myMemoryCharsUsed = 0;

try {
  const previousData = JSON.parse(await fs.readFile(NEWS_FILE, "utf8"));
  previousItems = Array.isArray(previousData.items) ? previousData.items : [];
  badiniRequestTimestamps = Array.isArray(previousData.badiniRequestTimestamps)
    ? previousData.badiniRequestTimestamps.filter((value) => Number.isFinite(Number(value))).map(Number)
    : [];
  badiniQuotaResetAt = typeof previousData.badiniQuotaResetAt === "string"
    ? previousData.badiniQuotaResetAt
    : null;
  myMemoryUsageDate = typeof previousData.myMemoryUsageDate === "string" ? previousData.myMemoryUsageDate : "";
  myMemoryCharsUsed = Number(previousData.myMemoryCharsUsed || 0);
} catch {
  previousItems = [];
}

// Recover the Italian source text from older saved translation maps when possible.
for (const item of previousItems) {
  if (!item.sourceRecord) {
    const pickItalian = (field) => {
      const value = item?.[field];
      if (typeof value === "string") return value;
      if (value && typeof value.it === "string" && value.it.trim()) return value.it;
      return "";
    };
    const title = pickItalian("title");
    const summary = pickItalian("summary");
    const content = pickItalian("content");
    if (title || summary || content) {
      item.sourceRecord = {
        title: title || summary || content,
        summary: summary || title,
        content: content || summary || title
      };
    }
  }
}

const previousById = new Map(previousItems.map((item) => [item.id, item]));

const MAX_PER_SOURCE = Number(process.env.MAX_PER_SOURCE || 8);
const MAX_ARTICLE_CHARS = 9000;
const MAX_TRANSLATE_CONTENT_CHARS = 2500;
const GEMINI_BATCH_SIZE = Number(process.env.GEMINI_BATCH_SIZE || 5);
const GEMINI_MAX_REQUESTS_24H = Number(process.env.GEMINI_MAX_REQUESTS_24H || 18);
const GEMINI_CONTENT_CHARS = 1800;
const GEMINI_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MYMEMORY_DAILY_LIMIT = process.env.MYMEMORY_EMAIL ? 50000 : 5000;
const MYMEMORY_MAX_BYTES = 450;

const MYMEMORY_LANGUAGES = {
  en: "en",
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

const GOOGLE_RSS = "https://news.google.com/rss/search?q=";

const LANG_TARGETS = [
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

function splitUtf8(text, maxBytes = MYMEMORY_MAX_BYTES) {
  const chunks = [];
  let current = "";

  for (const char of String(text || "")) {
    if (Buffer.byteLength(current + char, "utf8") > maxBytes && current) {
      chunks.push(current);
      current = "";
    }
    current += char;
  }

  if (current) chunks.push(current);
  return chunks;
}

async function myMemoryTranslateText(text, targetCode) {
  const original = String(text || "");
  if (!original.trim()) return original;

  const chunks = splitUtf8(original);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(chunk, "utf8");

    if (myMemoryCharsUsed + bytes > MYMEMORY_DAILY_LIMIT) {
      const error = new Error(
        "MyMemory daily character limit reached; remaining translations stay queued."
      );
      error.code = "MYMEMORY_DAILY_LIMIT";
      throw error;
    }

    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", chunk);
    url.searchParams.set("langpair", `it|${targetCode}`);
    url.searchParams.set("mt", "1");

    if (process.env.MYMEMORY_EMAIL) {
      url.searchParams.set("de", process.env.MYMEMORY_EMAIL);
    }

    const response = await fetch(url, {
      headers: { "User-Agent": "NOZHDAR-NewsBot/1.0" }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || Number(data.responseStatus) !== 200) {
      throw new Error(
        `MyMemory ${response.status || data.responseStatus}: ${data.responseDetails || "translation failed"}`
      );
    }

    const translated = data?.responseData?.translatedText;

    if (typeof translated !== "string" || !translated.trim()) {
      throw new Error("MyMemory returned an empty translation.");
    }

    translatedChunks.push(decodeEntities(translated));
    myMemoryCharsUsed += bytes;

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return translatedChunks.join(" ");
}

async function translateWithMyMemory(item, languageKey) {
  const targetCode = MYMEMORY_LANGUAGES[languageKey];

  if (!targetCode) {
    throw new Error(`No MyMemory language mapping for ${languageKey}`);
  }

  for (const field of ["title", "summary", "content"]) {
    item[field][languageKey] = await myMemoryTranslateText(
      item.sourceRecord[field],
      targetCode
    );
  }

  item.translationStatus.mymemory[languageKey] = true;
}

function isGeminiQuotaError(error) {
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(
    String(error?.message || error)
  );
}

function retryDelayMs(errorMessage) {
  const match = String(errorMessage || "").match(
    /retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i
  );

  if (!match) return null;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000;

  return total > 0 ? total : null;
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

  if (!key) {
    throw new Error("Missing GEMINI_API_KEY GitHub secret.");
  }

  const input = items.map((item, index) => ({
    index: startIndex + index,
    title: item.sourceRecord.title,
    summary: item.sourceRecord.summary,
    content: item.sourceRecord.content.slice(0, GEMINI_CONTENT_CHARS)
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

    if (
      !found ||
      typeof found.title !== "string" || !found.title.trim() ||
      typeof found.summary !== "string" || !found.summary.trim() ||
      typeof found.content !== "string" || !found.content.trim()
    ) {
      throw new Error(
        `Gemini omitted one or more Badini fields for story ${wantedIndex}.`
      );
    }

    items[index].title.bad = clean(found.title);
    items[index].summary.bad = clean(found.summary);
    items[index].content.bad = clean(found.content);
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
      mymemory: {
        ...(previous?.translationStatus?.mymemory || {}),
        it: true
      },
      badini: previous?.translationStatus?.badini === true
    }
  };
});

// Keep already-saved stories even if they are older than seven days
// whenever any translation is still pending.
const fetchedIds = new Set(output.map((item) => item.id));
const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

for (const previous of previousItems) {
  if (fetchedIds.has(previous.id)) continue;

  const previousDate = new Date(
    previous.date || previous.pubDate || 0
  ).getTime();

  const stillPending =
    previous.translationStatus?.badini !== true ||
    Object.keys(MYMEMORY_LANGUAGES).some(
      (lang) => previous.translationStatus?.mymemory?.[lang] !== true
    );

  if (
    (!Number.isFinite(previousDate) || previousDate < sevenDaysAgo) &&
    !stillPending
  ) {
    continue;
  }

  output.push(previous);
}

const translatableItems = output.filter((item) => item.sourceRecord);

// MyMemory handles non-Badini languages without an Azure account or bank card.
const todayUtc = new Date().toISOString().slice(0, 10);

if (myMemoryUsageDate !== todayUtc) {
  myMemoryUsageDate = todayUtc;
  myMemoryCharsUsed = 0;
}

let myMemoryCompleted = 0;
let myMemoryStoppedAtLimit = false;

for (const languageKey of Object.keys(MYMEMORY_LANGUAGES)) {
  const pending = translatableItems.filter(
    (item) => item.translationStatus?.mymemory?.[languageKey] !== true
  );

  for (const item of pending) {
    try {
      await translateWithMyMemory(item, languageKey);
      myMemoryCompleted++;

      // Save after each story so a timeout cannot discard completed work.
      await fs.mkdir(
        new URL("../public/data/", import.meta.url),
        { recursive: true }
      );

      await fs.writeFile(
        NEWS_FILE,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          badiniRequestTimestamps,
          badiniQuotaResetAt,
          myMemoryUsageDate,
          myMemoryCharsUsed,
          items: output
        }, null, 2)
      );
    } catch (error) {
      console.warn(`MyMemory paused for ${languageKey}: ${error.message}`);

      if (error.code === "MYMEMORY_DAILY_LIMIT") {
        myMemoryStoppedAtLimit = true;
      }

      break;
    }
  }

  if (myMemoryStoppedAtLimit) break;
}

// Gemini is used only for Badini.
const pendingBadini = translatableItems.filter(
  (item) => item.translationStatus?.badini !== true && item.sourceRecord
);

let badiniSuccess = 0;
let badiniRequestsThisRun = 0;
const now = Date.now();

let recentBadiniRequests = badiniRequestTimestamps.filter(
  (timestamp) =>
    timestamp > now - GEMINI_REQUEST_WINDOW_MS && timestamp <= now
);

const savedResetTime = badiniQuotaResetAt
  ? new Date(badiniQuotaResetAt).getTime()
  : 0;

if (savedResetTime > now) {
  console.log(
    `Gemini Badini is paused until ${new Date(savedResetTime).toISOString()} after a quota response.`
  );
} else {
  badiniQuotaResetAt = null;

  for (
    let start = 0;
    start < pendingBadini.length;
    start += GEMINI_BATCH_SIZE
  ) {
    if (recentBadiniRequests.length >= GEMINI_MAX_REQUESTS_24H) {
      console.log(
        `Gemini safety limit reached: ${recentBadiniRequests.length}/${GEMINI_MAX_REQUESTS_24H}. Remaining Badini stories stay pending.`
      );
      break;
    }

    const batch = pendingBadini.slice(start, start + GEMINI_BATCH_SIZE);

    recentBadiniRequests.push(Date.now());
    badiniRequestsThisRun++;

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

      if (isGeminiQuotaError(error)) {
        const delay =
          retryDelayMs(error.message) || 12 * 60 * 60 * 1000;

        badiniQuotaResetAt = new Date(Date.now() + delay).toISOString();

        console.warn(
          `Gemini quota reached. Pausing until ${badiniQuotaResetAt}; remaining stories will be retried later.`
        );

        break;
      }
    }
  }
}

output.sort((a, b) => new Date(b.date) - new Date(a.date));

await fs.mkdir(
  new URL("../public/data/", import.meta.url),
  { recursive: true }
);

await fs.writeFile(
  NEWS_FILE,
  JSON.stringify({
    updatedAt: new Date().toISOString(),
    badiniRequestTimestamps: recentBadiniRequests,
    badiniQuotaResetAt,
    myMemoryUsageDate,
    myMemoryCharsUsed,
    items: output
  }, null, 2)
);

await fs.writeFile(
  new URL("../public/data/regions.json", import.meta.url),
  JSON.stringify(regions, null, 2)
);

console.log(
  `Saved ${output.length} stories. MyMemory languages: ${Object.keys(MYMEMORY_LANGUAGES).length}; ` +
  `MyMemory stories translated this run: ${myMemoryCompleted}; daily characters: ${myMemoryCharsUsed}/${MYMEMORY_DAILY_LIMIT}; ` +
  `Badini translated this run: ${badiniSuccess}/${pendingBadini.length} pending; ` +
  `Gemini requests this run: ${badiniRequestsThisRun}; ` +
  `rolling 24h requests: ${recentBadiniRequests.length}/${GEMINI_MAX_REQUESTS_24H}.`
);
