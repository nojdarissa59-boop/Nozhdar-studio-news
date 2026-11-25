# NOZHDAR STUDIO — Regional News

## Included
- Mobile-first news page with a region selector for all 20 Italian regions.
- Three configured local publishers/broadcasters per region (60 configured source domains).
- Separate source filters within each selected region.
- Article cards with image, title, summary, expandable article text and original publisher link.
- GitHub Actions workflow that checks Google News RSS results for each configured publisher every 6 hours.
- Optional Gemini translation into the 16 languages shown in the language selector.

## Install
1. Upload the project files to the root of your GitHub repository, preserving the folder structure.
2. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
3. Add `GEMINI_API_KEY` if you want automatic article translation. Without it, articles remain in their original language; the language selector still changes the interface labels where translations are included.
4. Open **Actions → Auto Fetch & Translate News → Run workflow**.
5. In Netlify, set the publish directory to the repository root (`.`). No build command is required.

## Important implementation notes
- The 60 publishers are configured as source-specific Google News RSS searches (`site:domain`) to avoid assuming that every publisher exposes a stable public RSS endpoint.
- Search results and article extraction depend on publisher access, robots rules, paywalls, and Google News indexing. Some sources may return no stories at a given run.
- Article extraction is best-effort. If a publisher blocks extraction or its article is paywalled, the RSS summary is shown instead.
- The `OFFICIAL` marker is currently applied only to the regional RAI TGR sources. It is not a general fact-check label.
- The article's original publisher link is always retained. Republishing full copyrighted article text may require permission; this implementation displays extracted text only when accessible and should be configured to show excerpts if you do not have reuse rights.
- The list of publishers is an initial curated configuration, not a guarantee that every domain has a working feed or that every region has equal story volume. Review the sources in `scripts/sources.json`.


## Dedicated Italy immigration and new-laws section

The region selector includes a separate **Italy — Immigration & New Laws** section, independent of the 20 regional feeds:

- **Ministero dell’Interno** (`interno.gov.it`) — official immigration, asylum and residence-permit updates.
- **ASGI** (`asgi.it`) — specialist legal analysis on immigration and asylum rights.
- **Gazzetta Ufficiale** (`gazzettaufficiale.it`) — official publication of laws and decrees.

The fetcher searches these sources separately and labels their stories `immigration-law`. Stories are not mixed into regional news. The feed searches the most recent seven days; the displayed publication date comes from the source item. This is a news-monitoring feed, not legal advice.
