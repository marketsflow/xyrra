import type { Plugin } from "vite";
import { buildArticleJsonLd } from "../src/article-seo";
import { articleSeo } from "../src/articles/why-ai-demands-a-new-kind-of-machine.seo";

const ARTICLE_PAGE_MARKER = "Why-AI-Demands-a-New-Kind-of-Machine";

/** Injects BlogPosting JSON-LD from article SEO data at build/dev time. */
export function articleSeoPlugin(): Plugin {
  return {
    name: "xyrra-article-seo",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!ctx.filename?.includes(ARTICLE_PAGE_MARKER)) {
          return html;
        }

        const jsonLd = JSON.stringify(buildArticleJsonLd(articleSeo), null, 2).replace(
          /</g,
          "\\u003c"
        );

        const script = `<script type="application/ld+json">\n${jsonLd}\n    </script>`;

        if (html.includes("<!-- ARTICLE_JSON_LD -->")) {
          return html.replace("<!-- ARTICLE_JSON_LD -->", script);
        }

        return html.replace(
          /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
          script
        );
      },
    },
  };
}
