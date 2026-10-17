import * as NodeFS from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * The sandbox journey in the hosted web client, which should feel like T3
 * with every thread in its own sandbox: add a repository as a project, send a
 * thread's first message (the thread lists at once and shows its sandbox
 * being set up, then Claude answers through the egress proxy), start a
 * second thread in its own sandbox, let a sandbox sleep and reopen its
 * thread, and delete a thread with its sandbox. Along the way: a repository
 * the control plane can't read, and a browser that has never seen the
 * project or its sandboxes.
 */

const MOCK_URL = process.env.MOCK_URL ?? "http://127.0.0.1:8790";
const REPO = process.env.SANDBOX_REPO ?? "acme/demo";
const REPO_NAME = REPO.split("/")[1]!;
const BOOT_TIMEOUT = 5 * 60_000;
const REPLY_TIMEOUT = 3 * 60_000;
const MOCK_REPLY = "Hello from the mock AI Gateway.";
const PROMPT = "Say hello from the sandbox.";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  model?: string;
  stream?: boolean;
}

interface Sandbox {
  threadId: string;
  repo: string;
  status: string;
  environmentId: string | null;
  pendingThread: { threadId: string } | null;
}

const environmentOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split("/")[1] ?? "");

/** The gateway token the Worker should add, when the local placeholder secrets are in use. */
const devVarsPath = new URL("../.dev.vars", import.meta.url);
const gatewayToken = NodeFS.existsSync(devVarsPath)
  ? /^AI_GATEWAY_TOKEN=(.*)$/m.exec(NodeFS.readFileSync(devVarsPath, "utf8"))?.[1]
  : undefined;

test.describe.configure({ mode: "serial" });

let page: Page;
let mockAvailable = false;
/** Sandboxes that existed before this run, which teardown leaves alone. */
let existingSandboxes = new Set<string>();
let projectExisted = false;
let firstThreadUrl = "";
let secondThreadUrl = "";

const sandboxes = async (): Promise<Sandbox[]> =>
  (await (await page.request.get("/api/sandboxes")).json()).sandboxes;

const projects = async (): Promise<string[]> =>
  (await (await page.request.get("/api/sandboxes")).json()).projects.map(
    (project: { repo: string }) => project.repo.toLowerCase(),
  );

const sandboxesSince = async (before: ReadonlySet<string>): Promise<Sandbox[]> =>
  (await sandboxes()).filter((sandbox) => !before.has(sandbox.threadId));

const sandboxIds = async () => new Set((await sandboxes()).map((sandbox) => sandbox.threadId));

const composer = () => page.getByTestId("composer-editor");
const assistantMessages = () =>
  page.locator('[data-timeline-row-kind="message"][data-message-role="assistant"]');
/**
 * Sidebar thread rows, named "<title>, …, <project>", without drafts. The project reads
 * "acme/demo" while several sandboxes of the repo group together, else "demo".
 */
const threadRows = (on: Page = page) =>
  on.getByRole("navigation", { name: "Threads" }).getByRole("button", {
    name: new RegExp(`^(?!.*, Unsent draft, ).*, (?:[\\w.-]+/)?${REPO_NAME}$`),
  });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  existingSandboxes = await sandboxIds();
  projectExisted = (await projects()).includes(REPO.toLowerCase());
  mockAvailable = await fetch(`${MOCK_URL}/__refs`).then(
    (response) => response.ok,
    () => false,
  );
});

test.afterAll(async () => {
  if (process.env.KEEP !== "1") {
    for (const { threadId, status } of await sandboxes()) {
      if (existingSandboxes.has(threadId) || status === "unstarted") continue;
      await page.request.delete(`/api/sandboxes/${threadId}`);
    }
    // Removing the project removes its unstarted sandbox too.
    if (!projectExisted) await page.request.delete(`/api/sandboxes/projects/${REPO}`);
  }
  await page.close();
});

/**
 * Whether this browser has cached the thread's messages, which it writes about
 * half a second after opening the thread and then at most every 10 seconds.
 */
const threadCached = (threadUrl: string) => {
  const [environmentId, threadId] = new URL(threadUrl).pathname
    .split("/")
    .slice(1)
    .map(decodeURIComponent);
  return page.evaluate(
    ({ key, reply }) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("t3code:connection-runtime");
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const read = open.result.transaction("thread").objectStore("thread").get(key);
          read.onerror = () => resolve(false);
          read.onsuccess = () => {
            open.result.close();
            resolve(typeof read.result === "string" && read.result.includes(reply));
          };
        };
      }),
    { key: `${environmentId}:${threadId}`, reply: mockAvailable ? MOCK_REPLY : "" },
  );
};

const draftHero = () => page.getByText(new RegExp(`What should we build in .*${REPO_NAME}\\?`));
const setupCard = () => page.getByText("Setting up sandbox…");

/**
 * Sends the draft's first message and waits for Claude's reply in its new
 * sandbox. The thread lists at once, with the message and its sandbox's setup,
 * as a thread on any machine shows its worktree being made.
 */
const startThread = async ({ setup }: { setup: boolean }) => {
  const before = new Set(
    (await sandboxes())
      .filter((entry) => entry.status !== "unstarted")
      .map((entry) => entry.environmentId),
  );
  await expect(page).toHaveURL(/\/draft\//);
  await composer().click();
  await page.keyboard.type(PROMPT);
  await page.getByRole("button", { name: "Submit message" }).click();

  await expect(page.locator('[data-message-role="user"]').last()).toContainText(PROMPT, {
    timeout: 5000,
  });
  if (setup) {
    await expect(setupCard()).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel("Worktree setup")).toContainText("Clone repository and start T3");
  }
  await expect(threadRows().filter({ hasText: PROMPT })).not.toHaveCount(0);

  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/, {
    timeout: BOOT_TIMEOUT,
  });
  await expect(setupCard()).toBeHidden();
  await expect(page).toHaveURL(/\/(?!draft\/)[^/]+\/[^/]+$/);
  // The thread runs in a sandbox that was not running before its first message.
  const environmentId = environmentOf(page.url());
  expect(before.has(environmentId)).toBe(false);
  expect((await sandboxes()).find((entry) => entry.environmentId === environmentId)?.status).toBe(
    "running",
  );
  return page.url();
};

/**
 * Before any sandbox has run, nothing knows which models a sandbox offers, so
 * the first draft boots its sandbox to find out; the message waits for it,
 * as it would for any machine still connecting.
 */
const bootFirstSandboxEver = async () => {
  const shared = await page.request.get("/api/sandboxes/server-config");
  if (shared.status() !== 404) return false;
  const booting = page.getByText("Setting up a sandbox…");
  await expect(booting).toBeVisible();
  await expect(booting).toBeHidden({ timeout: BOOT_TIMEOUT });
  // Shared by this browser, for every other one.
  await expect
    .poll(async () => (await page.request.get("/api/sandboxes/server-config")).status())
    .toBe(200);
  return true;
};

test("a repository the control plane can't read is refused before any thread", async () => {
  await page.goto("/sandbox");
  await page.getByLabel("GitHub repository").fill(`${REPO.split("/")[0]}/t3-no-such-repo`);
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("alert")).toContainText("No GitHub repository");
  expect((await sandboxes()).filter((entry) => entry.repo.endsWith("/t3-no-such-repo"))).toEqual(
    [],
  );
});

test("a repository is a project before any sandbox runs", async () => {
  const before = await sandboxIds();
  await page.goto("/sandbox");
  await page.getByLabel("GitHub repository").fill(REPO);
  await page.getByRole("button", { name: "Add repository" }).click();

  // A normal draft in the new project, before any thread has a sandbox.
  await expect(page).toHaveURL(/\/draft\//);
  await expect(composer()).toBeVisible();
  await expect(draftHero()).toBeVisible();
  expect((await sandboxesSince(before)).map((entry) => entry.pendingThread)).not.toContainEqual(
    expect.anything(),
  );

  // A reload lists it from the control plane, not from this tab.
  await page.reload();
  await expect(draftHero()).toBeVisible();
});

test("a thread's first message starts its sandbox, and Claude answers through the egress proxy", async () => {
  await page.goto("/");
  const bootedFirst = await bootFirstSandboxEver();
  if (mockAvailable) await fetch(`${MOCK_URL}/__recorded`, { method: "DELETE" });
  // The first sandbox ever is already up by now; any other starts with the message.
  firstThreadUrl = await startThread({ setup: !bootedFirst });
  await expect(threadRows()).toHaveCount(1);

  if (!mockAvailable) return;
  // Claude's own request: the Messages API, streamed, rewritten to AI Gateway
  // with the gateway credential added outside the sandbox.
  const recorded: Recorded[] = await (await fetch(`${MOCK_URL}/__recorded`)).json();
  const claudeTurn = recorded.find(
    (request) =>
      request.method === "POST" &&
      /\/anthropic\/v1\/messages(\?|$)/.test(request.path) &&
      request.stream === true &&
      request.model?.startsWith("claude-opus-5-5"),
  );
  expect(claudeTurn, JSON.stringify(recorded.map((request) => request.path))).toBeDefined();
  expect(claudeTurn!.path).toMatch(/^\/gateway\/v1\/[^/]+\/[^/]+\/anthropic\/v1\/messages/);
  expect(claudeTurn!.headers["x-api-key"]).toBeUndefined();
  expect(claudeTurn!.headers["cf-aig-authorization"]).toBe(
    gatewayToken ? `Bearer ${gatewayToken}` : expect.stringMatching(/^Bearer \S+/),
  );
});

test("a new thread in the project starts in a sandbox of its own", async () => {
  await page
    .getByRole("button", { name: /^New thread/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/draft\//);
  secondThreadUrl = await startThread({ setup: true });
  expect(environmentOf(secondThreadUrl)).not.toBe(environmentOf(firstThreadUrl));
  await expect(threadRows()).toHaveCount(2);
});

test("an asleep sandbox wakes when its thread is opened", async () => {
  const sandbox = (await sandboxes()).find(
    (candidate) => candidate.environmentId === environmentOf(firstThreadUrl),
  );
  expect(sandbox).toBeDefined();
  // Opened while running, so this browser caches its messages.
  await page.goto(firstThreadUrl);
  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/);
  await expect.poll(() => threadCached(firstThreadUrl)).toBe(true);
  await page.goto("/");
  const slept = await (await page.request.post(`/api/sandboxes/${sandbox!.threadId}/sleep`)).json();
  expect(slept.status).toBe("asleep");

  await page.goto(firstThreadUrl);
  const waking = page.getByText("Waking the sandbox…");
  await expect(waking).toBeVisible();
  // The transcript reads from the cache while the sandbox comes back.
  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/, {
    timeout: 5000,
  });
  await expect(waking).toBeVisible();
  await expect(waking).toBeHidden({ timeout: BOOT_TIMEOUT });
  await expect
    .poll(async () => (await sandboxes()).find((entry) => entry.threadId === sandbox!.threadId))
    .toMatchObject({ status: "running" });
  await expect(threadRows()).toHaveCount(2);
});

test("a browser that has never seen an asleep sandbox wakes it to list its thread", async ({
  browser,
}) => {
  const sandbox = (await sandboxes()).find(
    (candidate) => candidate.environmentId === environmentOf(firstThreadUrl),
  );
  expect(sandbox).toBeDefined();
  await page.goto("/");
  const slept = await (await page.request.post(`/api/sandboxes/${sandbox!.threadId}/sleep`)).json();
  expect(slept.status).toBe("asleep");

  // No cached thread list and no record of having synced it.
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await fresh.goto("/");
    await expect(threadRows(fresh)).toHaveCount(2, { timeout: BOOT_TIMEOUT });
    await expect
      .poll(async () => (await sandboxes()).find((entry) => entry.threadId === sandbox!.threadId))
      .toMatchObject({ status: "running" });
  } finally {
    await context.close();
  }
});

test("deleting a thread deletes its sandbox", async () => {
  const sandbox = (await sandboxes()).find(
    (candidate) => candidate.environmentId === environmentOf(secondThreadUrl),
  );
  expect(sandbox).toBeDefined();
  await page.goto(secondThreadUrl);
  await expect(composer()).toBeVisible({ timeout: BOOT_TIMEOUT });

  // The open thread's row.
  await threadRows()
    .and(page.locator('[aria-current]:not([aria-current="false"])'))
    .click({ button: "right" });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(Confirm|Delete)$/ })
    .click();

  await expect
    .poll(async () => (await sandboxes()).some((entry) => entry.threadId === sandbox!.threadId))
    .toBe(false);
  await expect(threadRows()).toHaveCount(1);
});

test("removing the project removes it, and its sandboxes, from the control plane", async () => {
  await page.goto("/settings/projects");
  await page.getByRole("button", { name: /^Project scope: / }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`${REPO_NAME}$`) }).click();
  await page.getByRole("button", { name: /^Remove (project|all entries)$/ }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(Confirm|Remove|Delete)$/ })
    .click();

  await expect.poll(projects).not.toContain(REPO.toLowerCase());
  await expect
    .poll(async () => (await sandboxes()).filter((entry) => entry.repo === REPO))
    .toEqual([]);
  await page.goto("/");
  await expect(threadRows()).toHaveCount(0);
});
