---
name: home-new
description: Builds and updates the Xyrra dark marketing homepage and /aiperformance, /ai_stocks, /ai_crypto, and /ai_portfolios. Use when editing the homepage, the AI performance page, the AI Stocks page, the AI Crypto page, the AI Portfolios page, their header or footer, or when a Performance link should open the dashboard view.
---

# Home new

The dark marketing site lives in the `xyrra` repo.

## Pages

- `/` is the landing page (`index.html`, `src/new-home.css`). `/new_home` and `/new_home/` redirect to `/`.
- `/aiperformance/` is the public AI dashboard (`aiperformance/index.html`, `src/ai-performance.css`). Register new pages in `vite.config.ts` as a Rollup input and a clean-path rewrite.
- `/ai_stocks/` is the public AI Stocks view (`ai_stocks/index.html`, `src/ai-stocks.css`, `src/ai-stocks.ts`).
- `/ai_crypto/` is the public AI Crypto view (`ai_crypto/index.html`, `src/ai-stocks.css`, `src/ai-crypto.ts`).
- `/ai_portfolios/` is the public AI Portfolios view (`ai_portfolios/index.html`, `src/ai-portfolios.css`, `src/ai-portfolios.ts`).
- `/pricing/` is the Xyrra Pro pricing page (`pricing/index.html`, `src/pricing.css`). It has no performance chart.
- `/how-xyrra-ai-works/` explains the app flow (`how-xyrra-ai-works/index.html`, `src/how-xyrra-ai-works.css`): dashboard, AI Stocks, AI Crypto, AI Portfolios, then insight alerts. Example phone screens switch in the page. Live links open `/aiperformance/`, `/ai_stocks/`, `/ai_crypto/`, and `/ai_portfolios/`.

## Header and footer

Keep the same header and footer on these pages:

- Dark bar, wordmark at `/images/new/xyrra-wordmark.png`, Sign In and Get Started linking to `/login/`.
- Nav: Performance → `/aiperformance/`. AI Stocks → `/ai_stocks/`. AI Cryptos → `/ai_crypto/`. AI Portfolios → `/ai_portfolios/`. How it Works → `/how-xyrra-ai-works/`. Features → `/#features`. Pricing → `/pricing/`. About stays `/about-xyrra/`. The brand links home to `/`.
- Footer links: AI Strategies, Contact, Privacy, Terms, Disclaimer, plus a vertical list for Xyrra PC, Xyrra Agent, Why AI Demands a New Kind of Machine, Features, and FAQ, plus the copyright year. A cookie notice overlays the bottom of the screen and explains browser cookies. Accept cookies or Deny cookies stores `accepted` or `denied` in `xyrra-cookie-consent` and hides the notice.

## AI Stocks data

`/ai_stocks/` follows the app AI Stocks screens in `marketsflow-flutter-app` `stockr_trading/`. Clicking AI Stocks opens the Live Insights tab. The same page has Performance and Historical AI tabs, matching the app’s Live, Performance, and Historical screens. Live loads `GET /api/website/ai-stocks`. Performance ranks open trades with `last-24-hours`, `last-7-days`, and `last-30-days`. Historical AI loads closed trades from `GET /api/website/ai-stocks/history`.

## AI Crypto data

`/ai_crypto/` follows the app AI Crypto screens in `marketsflow-flutter-app` `trading/`. Clicking AI Crypto opens the Live tab. The same page has Performance and Historical tabs. Live loads open positions from `GET /api/website/ai-crypto?live=1` and falls back to today’s closed trades when nothing is open. Performance ranks live and closed insights for 24H, 7D, and 30D, using `last-24-hours` for the 24H symbol map. Historical loads closed trades from `GET /api/website/ai-crypto/history`.

## AI Portfolios data

`/ai_portfolios/` follows the app AI Portfolios screen in `marketsflow-flutter-app` `ai_generated_screen.dart`. It opens on Best Performing and has Trending, AI Recommended, and Lower Risk filters. The list loads `GET /api/website/ai-portfolios`. Trending adds `category=most_trending`. Lower Risk sorts `worst_performing`. Favourites and View Details go to `/login/`.

## Dashboard data

`/aiperformance/` follows the app dashboard in `marketsflow-flutter-app` `ai_dashboard_screen.dart`: week insight, top stock performers, top crypto performers, then 24H / 7D / 30D cards for stocks, crypto, and investing. Stock and crypto figures come from the public snapshot on `/`. Investing uses the best AI portfolio returns from `dashboard-performance`: 24H, 7D, and 30D, with the 7D value change calculated as $1,000 grown by that percent.
