
import fs from "node:fs/promises";
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "NOZHDAR-NewsBot/1.0 (+https://nozhdar07studio.com)" }
});

const config = JSON.parse(
  await fs.readFile(new URL("./sources.json", import.meta.url), "utf8")
);
const sources = config.sources || [];
const regions = config.regions || [];
const DATA_DIR = new URL("../public/data/", import.meta.url);
const NEWS_FILE = new URL("../public/data/news.json", import.meta.url);
const MAX_PER_SOURCE = Math.max(1, Math.min(8, Number(process.env.MAX_ITEMS_PER_FEED || 6)));
const MAX_SOURCE_TEXT_CHARS = 2400;
const GOOGLE_RSS = "https://news.google.com/rss/search?q=";
const LANGUAGES = ["bad","ku","km","en","it","ar","ma","tn","dz","tr","fa","sq","ur","hi","bn","ps"];
const MODE = (process.env.NEWS_MODE || "fetch").toLowerCase();

function clean(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function host(domain = "") {
  return domain.split("/")[0].replace(/^www\./, "");
}

function queryFor(source) {
  const query = source.query || `site:${host(source.domain)} ${source.regionName}`;
  return `${query} when:7d`;
}

function googleFeed(query) {
  return GOOGLE_RSS + encodeURIComponent(query) + "&hl=it&gl=IT&ceid=IT:it";
}

function dateISO(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function originalMap(value) {
  return Object.fromEntries(LANGUAGES.map(code => [code, value]));
}

function makeOriginalFields(title, summary, content) {
  return {
    title: originalMap(title),
    summary: originalMap(summary),
    content: originalMap(content)
  };
}

function stableKey(item) {
  return String(item.link || item.id || item.title?.it || item.title?.ku || "")
    .trim()
    .toLowerCase();
}

async function readExistingNews() {
  try {
    const data = JSON.parse(await fs.readFile(NEWS_FILE, "utf8"));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

async function fetchMetaImage(pageUrl) {
  if (!pageUrl) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) return "";
    const html = (await response.text()).slice(0, 120000);
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      try {
        return new URL(match[1].trim(), response.url || pageUrl).toString();
      } catch {
        // Ignore malformed image URLs and try the next metadata field.
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMode() {
  const existing = await readExistingNews();
  const byKey = new Map(existing.map(item => [stableKey(item), item]).filter(([key]) => key));
  let fetchedCount = 0;

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(googleFeed(queryFor(source)));

      for (const item of (feed.items || []).slice(0, MAX_PER_SOURCE)) {
        const title = clean(item.title);
        const link = item.link || "";
        if (!title || !link) continue;

        let bodyText = clean(item.contentSnippet || item.content || item.summary || "");
        let image = item.enclosure?.url || "";
        let resolvedUrl = link;

        try {
          const article = await extract(link, {
            headers: { "User-Agent": "Mozilla/5.0 NOZHDAR-NewsBot" }
          });
          if (article) {
            resolvedUrl = article.url || link;
            const extractedText = clean(article.content || article.description || "");
            if (extractedText.length > bodyText.length) bodyText = extractedText;
            image = article.image || article.images?.[0] || image;
          }
        } catch {
          // RSS title/summary remain usable if the publisher blocks extraction.
        }

        if (!image) image = await fetchMetaImage(resolvedUrl);
        if (!bodyText) bodyText = title;

        const summary = bodyText.slice(0, 550);
        const content = bodyText.slice(0, MAX_SOURCE_TEXT_CHARS);
        const key = link.toLowerCase();
        const previous = byKey.get(key);

        if (previous) {
          // Keep existing translations and metadata; only fill missing source details.
          byKey.set(key, {
            ...previous,
            image: previous.image || image,
            link: previous.link || resolvedUrl,
            summary: previous.summary || originalMap(summary),
            content: previous.content || originalMap(content),
            date: previous.date || dateISO(item.isoDate || item.pubDate),
            pubDate: previous.pubDate || dateISO(item.isoDate || item.pubDate)
          });
          continue;
        }

        const dedupeTitle = title.toLowerCase().slice(0, 150);
        const duplicate = [...byKey.values()].some(existingItem => {
          const existingTitle = existingItem.title?.it || existingItem.title?.ku ||
            existingItem.title?.en || "";
          return existingTitle.toLowerCase().slice(0, 150) === dedupeTitle;
        });
        if (duplicate) continue;

        const date = dateISO(item.isoDate || item.pubDate);
        const id = `${source.region}-${Buffer.from(dedupeTitle).toString("base64url").slice(0, 18)}`;

        byKey.set(key, {
          id,
          region: source.region,
          regionName: source.regionName,
          category: source.region === "italia-immigrazione" ? "immigration-law" : "local",
          section: source.region === "italia-immigrazione" ? "italia-immigrazione" : "regional",
          source: source.name,
          sourceDomain: source.domain,
          sourceType: source.type,
          official: source.type === "official" ||
            (source.type === "tv" && String(source.domain).includes("rainews.it")),
          ...makeOriginalFields(title, summary, content),
          translationStatus: "original-only",
          image,
          link: resolvedUrl,
          date,
          pubDate: date
        });
        fetchedCount++;
      }
    } catch (error) {
      console.warn(`Source skipped: ${source.name} (${source.domain}): ${error.message}`);
    }
  }

  const items = [...byKey.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    NEWS_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2)
  );
  await fs.writeFile(
    new URL("../public/data/regions.json", import.meta.url),
    JSON.stringify(regions, null, 2)
  );

  console.log(`Fetch complete: ${fetchedCount} new stories; ${items.length} stories retained.`);
}

function isQuotaError(error) {
  const message = String(error?.message || error);
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i.test(message);
}

function normalizeTranslations(value, original) {
  if (!value || typeof value !== "object") return originalMap(original);
  return Object.fromEntries(LANGUAGES.map(code => {
    const translated = typeof value[code] === "string" ? value[code].trim() : "";
    return [code, translated || original];
  }));
}

async function translateOne(fields) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing.");

  const models = (process.env.GEMINI_MODELS || "gemini-2.5-flash")
    .split(",").map(value => value.trim()).filter(Boolean);

  const languageNames = {
    bad: "Badini Kurdish", ku: "Sorani Kurdish", km: "Kurmanji Kurdish",
    en: "English", it: "Italian", ar: "Arabic", ma: "Moroccan Arabic (Darija)",
    tn: "Tunisian Arabic", dz: "Algerian Arabic", tr: "Turkish", fa: "Persian",
    sq: "Albanian", ur: "Urdu", hi: "Hindi", bn: "Bengali", ps: "Pashto"
  };

  const schema = Object.fromEntries(["title", "summary", "content"].map(field => [
    field, Object.fromEntries(LANGUAGES.map(code => [code, "translated string"]))
  ]));

  const prompt = [
    "You are a professional news journalist and translator.",
    "Translate the supplied fields into every target language using only the supplied facts.",
    "Write an informative 2-3 sentence summary. Paraphrase; do not reproduce long passages.",
    "Do not invent details. Preserve names, places, dates, numbers, legal terms and factual meaning.",
    "For ku use Sorani Kurdish in Arabic script; for bad use Badini Kurdish in Arabic script; for km use Kurmanji Kurdish in Latin script.",
    "Return only valid JSON with exactly the keys title, summary, content. Each value must contain every language code.",
    `Target languages: ${JSON.stringify(languageNames)}.`,
    `Required shape: ${JSON.stringify(schema)}.`,
    `Source fields: ${JSON.stringify(fields)}`
  ].join("\n");

  let lastError;
  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
          })
        }
      );

      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`${model}: HTTP ${response.status} ${detail}`);
        if (response.status === 429 || isQuotaError(detail)) throw Object.assign(error, { quota: true });
        lastError = error;
        console.warn(`Translation model failed; trying next model: ${error.message}`);
        continue;
      }

      const data = await response.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));

      return {
        title: normalizeTranslations(parsed.title, fields.title),
        summary: normalizeTranslations(parsed.summary, fields.summary),
        content: normalizeTranslations(parsed.content, fields.content)
      };
    } catch (error) {
      if (error.quota || isQuotaError(error)) throw error;
      lastError = error;
      console.warn(`Translation model failed; trying next model: ${error.message}`);
    }
  }

  throw lastError || new Error("All configured translation models failed.");
}

async function translateMode() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn("GEMINI_API_KEY is missing; skipping translation. Fetched stories remain saved.");
    return;
  }

  const data = JSON.parse(await fs.readFile(NEWS_FILE, "utf8"));
  const items = Array.isArray(data.items) ? data.items : [];
  const limit = Math.max(0, Number(process.env.MAX_NEW_TRANSLATIONS || 9));
  let translatedCount = 0;

  for (const item of items) {
    if (translatedCount >= limit) break;
    if (item.translationStatus === "translated") continue;

    const originalTitle = item.title?.it || item.title?.en || item.title?.ku ||
      (typeof item.title === "string" ? item.title : "");
    const originalSummary = item.summary?.it || item.summary?.en || item.summary?.ku ||
      (typeof item.summary === "string" ? item.summary : originalTitle);
    const originalContent = item.content?.it || item.content?.en || item.content?.ku ||
      (typeof item.content === "string" ? item.content : originalSummary);

    try {
      const translated = await translateOne({
        title: originalTitle,
        summary: originalSummary,
        content: originalContent
      });
      item.title = translated.title;
      item.summary = translated.summary;
      item.content = translated.content;
      item.translationStatus = "translated";
      translatedCount++;

      // Persist after every successful article so a later quota error cannot lose work.
      await fs.writeFile(
        NEWS_FILE,
        JSON.stringify({ ...data, updatedAt: new Date().toISOString(), items }, null, 2)
      );
    } catch (error) {
      if (isQuotaError(error)) {
        console.warn(`Gemini quota reached. Stopping translation now; saved ${translatedCount} translations.`);
        break;
      }
      console.warn(`Could not translate article "${originalTitle}": ${error.message}`);
    }
  }

  await fs.writeFile(
    NEWS_FILE,
    JSON.stringify({ ...data, updatedAt: new Date().toISOString(), items }, null, 2)
  );
  console.log(`Translation complete: ${translatedCount} new translations (limit ${limit}).`);
}

if (MODE === "fetch") {
  await fetchMode();
} else if (MODE === "translate") {
  await translateMode();
} else {
  throw new Error(`Unknown NEWS_MODE "${MODE}". Use "fetch" or "translate".`);
}
