import * as NodeFS from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * The full sandbox-thread journey in the hosted web client: start a sandbox
 * from a repository, chat with Claude through the egress proxy, start a second
 * thread (which the toggle sends to a new sandbox), let a sandbox sleep and
 * reopen its thread, and delete a thread with its sandbox. Along the way: a
 * repository that does not clone, cancelling a sandbox's setup, and a browser
 * that has never seen a sandbox.
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
  status: string;
  environmentId: string | null;
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
let firstThreadUrl = "";
let secondThreadUrl = "";

const sandboxes = async (): Promise<Sandbox[]> =>
  (await (await page.request.get("/api/sandboxes")).json()).sandboxes;

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
  mockAvailable = await fetch(`${MOCK_URL}/__refs`).then(
    (response) => response.ok,
    () => false,
  );
});

test.afterAll(async () => {
  if (process.env.KEEP !== "1") {
    for (const { threadId } of await sandboxes()) {
      if (!existingSandboxes.has(threadId)) await page.request.delete(`/api/sandboxes/${threadId}`);
    }
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

const sendPrompt = async () => {
  await composer().click();
  await page.keyboard.type(PROMPT);
  await page.getByRole("button", { name: "Submit message" }).click();
  await expect(page.locator('[data-message-role="user"]').last()).toContainText(PROMPT);
  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/, {
    timeout: REPLY_TIMEOUT,
  });
};

test("a sandbox started from a repository runs Claude through the egress proxy", async () => {
  const before = await sandboxIds();
  await page.goto("/sandbox");
  await page.getByLabel("GitHub repository").fill(REPO);
  await page.getByRole("button", { name: "Start sandbox" }).click();
  await expect(page.getByText(`Cloning ${REPO}`)).toBeVisible();

  // A normal draft in the sandbox's project, which the sandbox holds no thread for yet.
  await expect(page).toHaveURL(/\/draft\//, { timeout: BOOT_TIMEOUT });
  await expect(composer()).toBeVisible();
  const [sandbox] = await sandboxesSince(before);
  expect(sandbox?.status).toBe("running");

  if (mockAvailable) await fetch(`${MOCK_URL}/__recorded`, { method: "DELETE" });
  await sendPrompt();
  await expect(page).toHaveURL(/\/(?!draft\/)[^/]+\/[^/]+$/);
  firstThreadUrl = page.url();
  expect(environmentOf(firstThreadUrl)).toBe(sandbox?.environmentId);

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

test("a repository that does not clone reports it, and its sandbox is removed", async () => {
  const before = await sandboxIds();
  await page.goto("/sandbox");
  await page.getByLabel("GitHub repository").fill(`${REPO.split("/")[0]}/t3-no-such-repo`);
  await page.getByRole("button", { name: "Start sandbox" }).click();
  await expect(page.getByRole("alert")).toContainText("The sandbox did not start", {
    timeout: BOOT_TIMEOUT,
  });
  await expect.poll(async () => (await sandboxesSince(before)).length).toBe(0);
  await expect(page.getByRole("button", { name: "Start sandbox" })).toBeEnabled();
});

test("a new thread from an occupied sandbox sets up its own sandbox, then sends", async () => {
  const before = await sandboxIds();
  await page
    .getByRole("button", { name: /^New thread/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/draft\//);
  // A sandbox holds one thread, so the toggle is locked on.
  await expect(page.getByText("Sandbox", { exact: true })).toBeVisible();

  await composer().click();
  await page.keyboard.type(PROMPT);
  await page.getByRole("button", { name: "Submit message" }).click();
  await expect(page.getByText(`Setting up a sandbox for ${REPO}`)).toBeVisible();

  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/, {
    timeout: BOOT_TIMEOUT,
  });
  await expect(page).toHaveURL(/\/(?!draft\/)[^/]+\/[^/]+$/);
  secondThreadUrl = page.url();
  const added = await sandboxesSince(before);
  expect(added).toHaveLength(1);
  expect(environmentOf(secondThreadUrl)).toBe(added[0]?.environmentId);
  expect(environmentOf(secondThreadUrl)).not.toBe(environmentOf(firstThreadUrl));
  await expect(threadRows()).toHaveCount(2);
});

test("cancelling a sandbox's setup deletes it and keeps the message", async () => {
  const before = await sandboxIds();
  await page.goto(secondThreadUrl);
  await page
    .getByRole("button", { name: /^New thread/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/draft\//);
  const draftUrl = page.url();
  await composer().click();
  await page.keyboard.type(PROMPT);
  await page.getByRole("button", { name: "Submit message" }).click();
  await expect(page.getByText(`Setting up a sandbox for ${REPO}`)).toBeVisible();
  await expect.poll(async () => (await sandboxesSince(before)).length).toBe(1);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText(`Setting up a sandbox for ${REPO}`)).toBeHidden();
  await expect(composer()).toContainText(PROMPT);
  expect(page.url()).toBe(draftUrl);
  await expect.poll(async () => (await sandboxesSince(before)).length).toBe(0);
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
