const demos: Record<string, { reply: string; result: string }> = {
  "Build a landing page for my SaaS": {
    reply: "Sure! I’ll design a conversion-focused SaaS landing page with hero, features, and a clear CTA.",
    result: "Landing page created successfully!",
  },
  "Analyze this CSV and find the top trends": {
    reply: "Sure! I’ll profile the CSV, surface the strongest trends, and chart the outliers for you.",
    result: "Analysis complete — trends are ready!",
  },
  "Write a Python bot that tracks my portfolio": {
    reply: "Sure! I’ll write a Python bot that tracks holdings, prices, and daily P&L.",
    result: "Portfolio bot created successfully!",
  },
  "Automate my weekly research report": {
    reply: "Sure! I’ll set up a weekly automation that gathers sources and drafts your research report.",
    result: "Weekly report workflow is live!",
  },
  "Build a dashboard that tracks crypto prices and alerts me": {
    reply: "Sure! I’ll build a real-time crypto dashboard with price charts and custom alerts.",
    result: "Dashboard created successfully!",
  },
};

const fallback = {
  reply: "Sure! I’ll break this down, build it, and deliver a result you can use right away.",
  result: "Task completed successfully!",
};

const promptEl = document.getElementById("xa-demo-prompt");
const replyEl = document.getElementById("xa-demo-reply");
const resultEl = document.getElementById("xa-demo-result");
const barEl = document.getElementById("xa-demo-bar");
const successEl = document.getElementById("xa-demo-success");
const stepsEl = document.getElementById("xa-demo-steps");
const form = document.getElementById("xa-try-form") as HTMLFormElement | null;
const input = document.getElementById("xa-try-input") as HTMLInputElement | null;
const chips = document.querySelectorAll<HTMLButtonElement>(".xa-chips button");

const stepOrder = ["planning", "building", "testing", "done"] as const;
const widths = [18, 48, 78, 100];
let runToken = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyFor(prompt: string) {
  return demos[prompt] ?? fallback;
}

async function runDemo(prompt: string) {
  if (!promptEl || !replyEl || !resultEl || !barEl || !successEl || !stepsEl) return;
  const token = ++runToken;
  const copy = copyFor(prompt);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  promptEl.textContent = prompt;
  replyEl.textContent = copy.reply;
  resultEl.textContent = copy.result;
  successEl.classList.remove("is-visible");
  barEl.style.width = "8%";

  const items = Array.from(stepsEl.querySelectorAll("li"));
  items.forEach((li) => li.classList.remove("is-active", "is-done"));

  chips.forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.prompt === prompt);
  });

  if (reduce) {
    items.forEach((li) => li.classList.add("is-done"));
    barEl.style.width = "100%";
    successEl.classList.add("is-visible");
    return;
  }

  for (let i = 0; i < stepOrder.length; i++) {
    if (token !== runToken) return;
    items.forEach((li, idx) => {
      li.classList.toggle("is-active", idx === i);
      li.classList.toggle("is-done", idx < i);
    });
    barEl.style.width = `${widths[i]}%`;
    await sleep(i === stepOrder.length - 1 ? 280 : 700);
  }

  if (token !== runToken) return;
  items.forEach((li) => {
    li.classList.remove("is-active");
    li.classList.add("is-done");
  });
  successEl.classList.add("is-visible");
}

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const prompt = chip.dataset.prompt?.trim();
    if (!prompt) return;
    if (input) input.value = prompt;
    void runDemo(prompt);
  });
});

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt =
    input?.value.trim() || "Build a dashboard that tracks crypto prices and alerts me";
  void runDemo(prompt);
});

void runDemo("Build a dashboard that tracks crypto prices and alerts me");
