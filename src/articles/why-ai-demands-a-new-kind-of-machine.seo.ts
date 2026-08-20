import type { ArticleSeoInput } from "./types";

const CANONICAL_PATH =
  "/article/ai-hardware/Why-AI-Demands-a-New-Kind-of-Machine/";

/** Static SEO payload — replace with CMS/admin data when articles are dynamic. */
export const articleSeo: ArticleSeoInput = {
  slug: "Why-AI-Demands-a-New-Kind-of-Machine",
  category: "AI Hardware",
  categorySlug: "ai-hardware",
  title: "The Next Computing Shift: Why AI Demands a New Kind of Machine",
  alternativeHeadline: "Why AI Demands a New Kind of Machine",
  description:
    "From the internet to streaming, cloud, and AI — every computing era exposes the same truth: software evolves faster than hardware. Discover why AI demands a purpose-built machine.",
  abstract:
    "Every era of computing reaches a breaking point where machines can no longer keep up with software. AI has brought us there again — and the machine, not the model, defines what is possible.",
  articleBodyExcerpt:
    "Every major leap in computing has followed a familiar pattern. A new technological wave emerges — faster, more capable, more transformative — and people rush to adopt it. But beneath the excitement, something else quietly happens: the machines begin to struggle. This is not failure. It is friction. It is what happens when software evolves faster than hardware can keep up. From the internet to streaming, cloud computing, and now artificial intelligence, each era has exposed a simple truth: performance is never just about software — it is about the system as a whole. AI workloads involve massive datasets, continuous inference, and highly parallel computation. They depend on specialized hardware — particularly GPUs — and expose decades-old architectural bottlenecks between memory and compute. Two users can run the same model and experience completely different outcomes. The difference is not the software. It is the machine.",
  publishedAt: "2026-08-20T09:00:00+00:00",
  modifiedAt: "2026-08-20T09:00:00+00:00",
  authorName: "Xyrra Editorial Team",
  authorUrl: "https://xyrra.ai/about-xyrra/",
  section: "AI Hardware",
  tags: [
    "AI hardware",
    "local AI",
    "AI workstation",
    "computing evolution",
    "GPU computing",
    "Xyrra",
  ],
  keywords: [
    "AI hardware",
    "local AI",
    "AI workstation",
    "computing evolution",
    "Xyrra",
    "GPU computing",
    "AI-native machine",
    "local computing",
  ],
  readTimeMinutes: 12,
  wordCount: 1950,
  canonicalPath: CANONICAL_PATH,
  heroImage: {
    url: "https://xyrra.ai/images/articles/ai-hardware/Why-AI-Demands-a-New-Kind-of-Machine/hero.jpg",
    width: 1024,
    height: 682,
    alt: "Timeline of computing from 1980s home computers through streaming and cloud to the Xyrra AI machine — More Internet. More Demands. A New Kind of Machine.",
  },
  breadcrumbs: [
    { name: "Home", path: "/" },
    { name: "Articles", path: "/article/" },
    { name: "AI Hardware", path: "/article/ai-hardware/" },
    { name: "Why AI Demands a New Kind of Machine", path: CANONICAL_PATH },
  ],
  about: [
    "Artificial Intelligence",
    "Computer Hardware",
    "Local AI Computing",
    "GPU Computing",
  ],
  mentions: ["Cloud Computing", "Streaming Media", "Internet", "Xyrra Machine"],
};
