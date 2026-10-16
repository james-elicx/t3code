import { existsSync, readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * The full sandbox-thread journey in the hosted web client: start a thread,
 * which boots its own sandbox, chat with Claude through the egress proxy,
 * start a second thread, reload, and delete a sandbox.
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

/** The gateway token the Worker should add, when the local placeholder secrets are in use. */
const devVarsPath = new URL("../.dev.vars", import.meta.url);
const gatewayToken = existsSync(devVarsPath)
  ? /^AI_GATEWAY_TOKEN=(.*)$/m.exec(readFileSync(devVarsPath, "utf8"))?.[1]
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
 * Sidebar thread rows, named "<title>, …, <project>". The project reads
 * "acme/demo" while several sandboxes of the repo group together, else "demo".
 */
const threadRows = () =>
  page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("button", { name: new RegExp(`, (?:[\\w.-]+/)?${REPO_NAME}$`) });

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

test("a new sandbox thread runs Claude through the egress proxy", async () => {
  const before = await sandboxIds();
  await page.goto("/");
  await page.getByLabel("GitHub repository").fill(REPO);
  await page.getByRole("button", { name: "Start sandbox thread" }).click();
  await expect(page.getByText(`Cloning ${REPO}`)).toBeVisible();

  await expect(composer()).toBeVisible({ timeout: BOOT_TIMEOUT });
  firstThreadUrl = page.url();
  const [sandbox] = await sandboxesSince(before);
  expect(sandbox?.status).toBe("running");
  // The sandbox's one project is its checkout of the repository.
  await expect(page.getByText(REPO_NAME, { exact: true }).first()).toBeVisible();

  if (mockAvailable) await fetch(`${MOCK_URL}/__recorded`, { method: "DELETE" });
  await composer().click();
  await page.keyboard.type(PROMPT);
  await page.getByRole("button", { name: "Submit message" }).click();

  await expect(page.locator('[data-message-role="user"]').last()).toContainText(PROMPT);
  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/, {
    timeout: REPLY_TIMEOUT,
  });

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

test("a new thread in a sandbox project starts another sandbox", async () => {
  const before = await sandboxIds();
  await page
    .getByRole("button", { name: /^New thread/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/sandbox\?.*launch=/);
  await expect(page.getByText(`Cloning ${REPO}`)).toBeVisible();

  await expect(composer()).toBeVisible({ timeout: BOOT_TIMEOUT });
  secondThreadUrl = page.url();
  expect(secondThreadUrl).not.toBe(firstThreadUrl);
  const added = await sandboxesSince(before);
  expect(added).toHaveLength(1);
  const [, firstEnvironment] = new URL(firstThreadUrl).pathname.split("/");
  const [, secondEnvironment] = new URL(secondThreadUrl).pathname.split("/");
  expect(secondEnvironment).not.toBe(firstEnvironment);
  await expect(threadRows()).toHaveCount(2);
});

test("both sandbox threads survive a reload", async () => {
  await page.goto(firstThreadUrl);
  await expect(composer()).toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect(assistantMessages().last()).toContainText(mockAvailable ? MOCK_REPLY : /\S/);
  await expect(threadRows()).toHaveCount(2);
});

test("deleting a sandbox removes its thread", async () => {
  await page.goto(secondThreadUrl);
  await expect(composer()).toBeVisible({ timeout: BOOT_TIMEOUT });
  const [, environmentId] = new URL(secondThreadUrl).pathname.split("/");
  const sandbox = (await sandboxes()).find(
    (candidate) => candidate.environmentId === decodeURIComponent(environmentId!),
  );
  expect(sandbox).toBeDefined();

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette").locator("input").first().fill("delete sandbox");
  await page.getByText("Delete this thread's sandbox").click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByRole("button", { name: "Start sandbox thread" })).toBeVisible();
  await expect
    .poll(async () => (await sandboxes()).some((entry) => entry.threadId === sandbox!.threadId))
    .toBe(false);
  await expect(threadRows()).toHaveCount(1);
});
