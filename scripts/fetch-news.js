import fs from "node:fs/promises";
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "NOZHDAR-NewsBot/1.0 (+https://nozhdar07studio.com)" }
});
const config = JSON.parse(await fs.readFile(new URL("./sources.json", import.meta.url), "utf8"));
const regions = config.regions;
const sources = config.sources;
const MAX_PER_SOURCE = 8;
const MAX_SOURCE_TEXT_CHARS = 2400;
const GOOGLE_RSS = "https://news.google.com/rss/search?q=";
const LANGUAGES = ["bad","ku","km","en","it","ar","ma","tn","dz","tr","fa","sq","ur","hi","bn","ps"];
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

function clean(s = "") {
  return String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function host(domain) { return domain.split("/")[0].replace(/^www\./, ""); }
function queryFor(source) {
  const q = source.query || `site:${host(source.domain)} ${source.regionName}`;
  return `${q} when:7d`;
}
function googleFeed(q) {
  return GOOGLE_RSS + encodeURIComponent(q) + "&hl=it&gl=IT&ceid=IT:it";
}
function dateISO(v) {
  const d = new Date(v || Date.now());
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}
function originalMap(value) {
  return Object.fromEntries(LANGUAGES.map(code => [code, value]));
}
function normalizeTranslations(value, original) {
  if (!value || typeof value !== "object") return originalMap(original);
  return Object.fromEntries(LANGUAGES.map(code => {
    const translated = typeof value[code] === "string" ? value[code].trim() : "";
    return [code, translated || original];
  }));
}

async function fetchMetaImage(pageUrl) {
  if (!pageUrl) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 120000);
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
    ];
    for (const re of patterns) {
      const match = html.match(re);
      if (match?.[1]) {
        const candidate = match[1].trim();
        if (/^https?:\/\//i.test(candidate)) return candidate;
        try {
          return new URL(candidate, res.url || pageUrl).toString();
        } catch {}
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function translateFields(fields) {
  const key = process.env.GEMINI_API_KEY;
  const fallback = {
    title: originalMap(fields.title),
    summary: originalMap(fields.summary),
    content: originalMap(fields.content)
  };
  if (!key) return fallback;

  const languageNames = {
    bad: "Badini Kurdish", ku: "Sorani Kurdish", km: "Kurmanji Kurdish",
    en: "English", it: "Italian", ar: "Arabic", ma: "Moroccan Arabic (Darija)",
    tn: "Tunisian Arabic", dz: "Algerian Arabic", tr: "Turkish", fa: "Persian",
    sq: "Albanian", ur: "Urdu", hi: "Hindi", bn: "Bengali", ps: "Pashto"
  };
  const schema = Object.fromEntries(["title","summary","content"].map(field => [
    field, Object.fromEntries(LANGUAGES.map(code => [code, "translated string"]))
  ]));
  const prompt = [
    "You are a professional news journalist and translator.",
    "Translate and format each field into every target language based ONLY on the provided source fields.",
    "For summary, write a clear, informative 2-3 sentence summary from the article text rather than repeating the headline verbatim.",
    "For content, write a clear, well-structured explanation covering the key details and context present in the source text.",
    "For it, return clear natural Italian; for ku use Sorani Kurdish in Arabic script; for bad use Badini Kurdish in Arabic script; for km use Kurmanji Kurdish in Latin script.",
    "For ma, tn, dz use the natural local Arabic dialect in Arabic script. Use the correct writing system for every other language.",
    "Preserve all names, places, dates, numbers, legal terms, quotes and factual meaning. Do not invent facts beyond the source text.",
    "Return ONLY valid JSON, no markdown. The JSON must have exactly the keys title, summary, content; each value must be an object with every language code.",
    `Target languages: ${JSON.stringify(languageNames)}.`,
    `Required shape: ${JSON.stringify(schema)}.`,
    `Source fields: ${JSON.stringify(fields)}`
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
        })
      }
    );
    if (!response.ok) throw new Error(`Gemini translation failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonText);
    return {
      title: normalizeTranslations(parsed.title, fields.title),
      summary: normalizeTranslations(parsed.summary, fields.summary),
      content: normalizeTranslations(parsed.content, fields.content)
    };
  } catch (error) {
    console.warn(`Translation fallback: ${error.message}`);
    return fallback;
  }
}

const output = [];
const seen = new Set();
for (const source of sources) {
  try {
    const feed = await parser.parseURL(googleFeed(queryFor(source)));
    for (const item of (feed.items || []).slice(0, MAX_PER_SOURCE)) {
      const title = clean(item.title);
      const link = item.link || "";
      if (!title || !link) continue;
      const dedupeKey = title.toLowerCase().slice(0, 150);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

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
          if (extractedText.length > bodyText.length) {
            bodyText = extractedText;
          }
          image = article.image || article.images?.[0] || image;
        }
      } catch {}

      if (!image) {
        image = await fetchMetaImage(resolvedUrl);
      }
      if (!bodyText) bodyText = title;

      const fields = {
        title,
        summary: bodyText.slice(0, 550),
        content: bodyText.slice(0, MAX_SOURCE_TEXT_CHARS)
      };
      const translated = await translateFields(fields);
      output.push({
        id: `${source.region}-${Buffer.from(dedupeKey).toString("base64url").slice(0, 18)}`,
        region: source.region,
        regionName: source.regionName,
        category: source.region === "italia-immigrazione" ? "immigration-law" : "local",
        section: source.region === "italia-immigrazione" ? "italia-immigrazione" : "regional",
        source: source.name,
        sourceDomain: source.domain,
        sourceType: source.type,
        official: source.type === "official" || (source.type === "tv" && source.domain.includes("rainews.it")),
        title: translated.title,
        summary: translated.summary,
        content: translated.content,
        image,
        link: resolvedUrl,
        date: dateISO(item.isoDate || item.pubDate),
        pubDate: dateISO(item.isoDate || item.pubDate)
      });
    }
  } catch (error) {
    console.warn(`Source skipped: ${source.name} (${source.domain}): ${error.message}`);
  }
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
console.log(`Saved ${output.length} stories from ${sources.length} configured sources.`);
