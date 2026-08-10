const capabilities = [
  {
    id: "memory",
    index: "01",
    title: "Context that survives the chat.",
    description:
      "Forge keeps decisions, lessons, and project state in the repository—so Claude, Codex, Cursor, and the next agent all inherit the same working memory.",
    status: "3 records recalled",
    rows: [
      ["decision", "Use SQLite for local-first state", "94%"],
      ["lesson", "Run schema checks before generation", "88%"],
      ["preference", "Keep the CLI dependency-free", "82%"],
    ],
  },
  {
    id: "foresight",
    index: "02",
    title: "See the blast radius first.",
    description:
      "Before a meaningful edit, Forge maps likely downstream effects and asks the agent to account for tests, interfaces, documentation, and release surfaces.",
    status: "4 surfaces mapped",
    rows: [
      ["source", "src/config.js", "changed"],
      ["downstream", "generated tool configs", "review"],
      ["verification", "doctor + docs checks", "required"],
    ],
  },
  {
    id: "guardrails",
    index: "03",
    title: "Slow down the irreversible move.",
    description:
      "Pre-action gates catch destructive commands, missing evidence, and high-cost choices while there is still time to change course—not after the damage is done.",
    status: "gate passed in 118 ms",
    rows: [
      ["scope", "working tree only", "verified"],
      ["risk", "no destructive operation", "clear"],
      ["proof", "tests + docs queued", "ready"],
    ],
  },
];

const installs = [
  {
    id: "plugin",
    command:
      "/plugin marketplace add CodeWithJuber/forgekit\n/plugin install forgekit",
    note: "Recommended · ambient guards on every prompt",
  },
  {
    id: "npm",
    command: "npm install -g @codewithjuber/forgekit\nforge init",
    note: "Emits every tool’s native config from one source",
  },
  {
    id: "github",
    command: "npm install -g github:CodeWithJuber/forgekit\nforge init",
    note: "Install directly from the public repository",
  },
];

const capabilityTabs = [...document.querySelectorAll(".capability-tabs [role='tab']")];
const capabilityPanel = document.querySelector(".capability-panel");

function selectCapability(index, { focus = false } = {}) {
  const data = capabilities[index];
  if (!data || !capabilityPanel) return;
  capabilityTabs.forEach((tab, tabIndex) => {
    tab.setAttribute("aria-selected", String(tabIndex === index));
    tab.tabIndex = tabIndex === index ? 0 : -1;
  });
  const activeTab = capabilityTabs[index];
  capabilityPanel.setAttribute("aria-labelledby", activeTab.id);
  capabilityPanel.querySelector(".console-label").textContent =
    `ACTIVE CAPABILITY / ${data.index}`;
  capabilityPanel.querySelector("h3").textContent = data.title;
  capabilityPanel.querySelector(".capability-copy p").textContent = data.description;
  capabilityPanel.querySelector(".capability-status").innerHTML =
    `<i></i> ${data.status}`;
  const records = capabilityPanel.querySelector(".memory-records");
  records.innerHTML = `
    <div class="records-head"><span>TYPE</span><span>RECORD</span><span>STATE</span></div>
    ${data.rows
      .map(
        ([type, record, state]) =>
          `<div class="record"><span>${type}</span><strong>${record}</strong><b>${state}</b></div>`,
      )
      .join("")}`;
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    capabilityPanel.animate(
      [
        { opacity: 0.35, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 220, easing: "ease-out" },
    );
  }
  if (focus) activeTab.focus();
}

capabilityTabs.forEach((tab, index) => {
  tab.tabIndex = index === 0 ? 0 : -1;
  tab.addEventListener("click", () => selectCapability(index));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? capabilityTabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + capabilityTabs.length) %
            capabilityTabs.length;
    selectCapability(next, { focus: true });
  });
});

const installTabs = [...document.querySelectorAll(".install-tabs [role='tab']")];
const installPanel = document.querySelector(".terminal-panel");
const copyButton = installPanel?.querySelector(".terminal-bar button");
let activeInstall = 0;

function selectInstall(index, { focus = false } = {}) {
  const data = installs[index];
  if (!data || !installPanel) return;
  activeInstall = index;
  installTabs.forEach((tab, tabIndex) => {
    tab.setAttribute("aria-selected", String(tabIndex === index));
    tab.tabIndex = tabIndex === index ? 0 : -1;
  });
  const activeTab = installTabs[index];
  installPanel.setAttribute("aria-labelledby", activeTab.id);
  installPanel.querySelector("code").innerHTML = data.command
    .split("\n")
    .map((line) => `<span><i aria-hidden="true">$</i> ${line}\n</span>`)
    .join("");
  installPanel.querySelector(":scope > p").innerHTML = `<i></i> ${data.note}`;
  if (copyButton) copyButton.lastChild.textContent = "Copy";
  if (focus) activeTab.focus();
}

installTabs.forEach((tab, index) => {
  tab.tabIndex = index === 0 ? 0 : -1;
  tab.addEventListener("click", () => selectInstall(index));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? installTabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + installTabs.length) %
            installTabs.length;
    selectInstall(next, { focus: true });
  });
});

copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(installs[activeInstall].command);
    copyButton.lastChild.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.lastChild.textContent = "Copy";
    }, 1800);
  } catch {
    copyButton.lastChild.textContent = "Select command";
    installPanel.querySelector("code").parentElement.focus();
  }
});

const progress = document.querySelector(".scroll-progress");
let progressFrame = 0;
function updateProgress() {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${scrollable > 0 ? window.scrollY / scrollable : 0})`;
  progressFrame = 0;
}
window.addEventListener(
  "scroll",
  () => {
    if (!progressFrame) progressFrame = window.requestAnimationFrame(updateProgress);
  },
  { passive: true },
);
updateProgress();
