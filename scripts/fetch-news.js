import fs from "node:fs/promises";
import Parser from "rss-parser";
import { extract } from "@extractus/article-extractor";

const parser = new Parser({timeout:20000, headers:{"User-Agent":"NOZHDAR-NewsBot/1.0 (+https://nozhdar07studio.com)"}});
const config = JSON.parse(await fs.readFile(new URL("./sources.json", import.meta.url),"utf8"));
const regions = config.regions;
const sources = config.sources;
const MAX_PER_SOURCE = 8;
const MAX_ARTICLE_CHARS = 9000;
const GOOGLE_RSS = "https://news.google.com/rss/search?q=";
const langTargets = ["ku","it","en","bad","km","ar","ma","tn","dz","tr","fa","sq","ur","hi","bn","ps"];

function clean(s=""){return String(s).replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();}
function host(domain){return domain.split("/")[0].replace(/^www\./,"");}
function queryFor(source){const q=source.query || `site:${host(source.domain)} ${source.regionName}`;return `${q} when:7d`;}
function googleFeed(q){return GOOGLE_RSS+encodeURIComponent(q)+"&hl=it&gl=IT&ceid=IT:it";}
function dateISO(v){const d=new Date(v||Date.now());return isNaN(d)?new Date().toISOString():d.toISOString();}
async function translateBatch(texts){
 const key=process.env.GEMINI_API_KEY;
 if(!key)return null;
 const prompt=`Translate the following Italian news fields into these languages: ${langTargets.join(", ")}. Preserve names, numbers, facts, quotes and meaning. Return ONLY valid JSON: an array with one object per input, each object having all language codes as keys. Do not add facts. If a language is not confidently translatable, use the Italian original. INPUT:\n${JSON.stringify(texts)}`;
 const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:"application/json"}})});
 if(!response.ok)throw new Error(`Gemini translation failed: ${response.status}`);
 const data=await response.json();const raw=data.candidates?.[0]?.content?.parts?.[0]?.text||"[]";
 try{return JSON.parse(raw)}catch{return null}
}
const output=[];const seen=new Set();
for(const source of sources){
 try{
  const feed=await parser.parseURL(googleFeed(queryFor(source)));
  for(const item of (feed.items||[]).slice(0,MAX_PER_SOURCE)){
   const title=clean(item.title);const link=item.link||"";
   if(!title||!link)continue;
   const key=title.toLowerCase().slice(0,150);if(seen.has(key))continue;seen.add(key);
   let content=clean(item.contentSnippet||item.content||item.summary||"");
   let image="";
   try{
    const article=await extract(link,{headers:{"User-Agent":"Mozilla/5.0 NOZHDAR-NewsBot"}});
    if(article){
      content=clean(article.content||article.description||content).slice(0,MAX_ARTICLE_CHARS);
      image=article.image||article.images?.[0]||"";
    }
   }catch{}
   if(!content)content=clean(item.contentSnippet||"");
   const sourceRecord={title,summary:clean(item.contentSnippet||content).slice(0,420),content};
   const translated=await translateBatch([sourceRecord]).catch(()=>null);
   const tr=translated?.[0]||null;
   output.push({
    id:`${source.region}-${Buffer.from(key).toString("base64url").slice(0,18)}`,
    region:source.region,regionName:source.regionName,category:source.region==="italia-immigrazione"?"immigration-law":"local",section:source.region==="italia-immigrazione"?"italia-immigrazione":"regional",
    source:source.name,sourceDomain:source.domain,sourceType:source.type,
    official:source.type==="official" || (source.type==="tv" && source.domain.includes("rainews.it")),
    title:tr?.title||{it:title,en:title,ku:title},
    summary:tr?.summary||{it:sourceRecord.summary,en:sourceRecord.summary,ku:sourceRecord.summary},
    content:tr?.content||{it:content,en:content,ku:content},
    image,link,date:dateISO(item.isoDate||item.pubDate),pubDate:dateISO(item.isoDate||item.pubDate)
   });
  }
 }catch(error){console.warn(`Source skipped: ${source.name} (${source.domain}): ${error.message}`)}
}
output.sort((a,b)=>new Date(b.date)-new Date(a.date));
await fs.mkdir(new URL("../public/data/",import.meta.url),{recursive:true});
await fs.writeFile(new URL("../public/data/news.json",import.meta.url),JSON.stringify({updatedAt:new Date().toISOString(),items:output},null,2));
await fs.writeFile(new URL("../public/data/regions.json",import.meta.url),JSON.stringify(regions,null,2));
console.log(`Saved ${output.length} stories from ${sources.length} configured regional sources.`);
