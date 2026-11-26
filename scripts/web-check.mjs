// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * M5 browser check of the web view (A5.4), against a real `wrangler dev`
 * board started by the e2e harness. Not part of `npm run test:e2e`; CI runs it
 * after the e2e suite (B39).
 *
 *   BROWSER_CHANNEL=chrome node scripts/web-check.mjs [out-dir]
 *
 * Uses `playwright-core` (an exact-pinned devDependency, installed by `npm ci`
 * from the lock file; it has no install script and downloads no browser) with
 * an installed browser named by BROWSER_CHANNEL (default `chrome`, the
 * installed Google Chrome; security review, decided by orchestrator, F).
 * Screenshots go to out-dir (default
 * .web-check/, gitignored), as M5-web.png (topic view after posting) and
 * M5-web-tasks.png, M5-web-who.png, M5-web-audit.png, and (G5) G5-admin-clear.png and
 * G5-admin.png (the Admin tab healthy, then with flagged agents).
 *
 * Steps (issue #47): the page signs in by pairing code, with no token field and
 * nothing in web storage: it shows a code and the command to run, the person
 * approves it over `/api` as `bbs web-login` does, and the session arrives as
 * an HttpOnly, SameSite=Strict cookie the page cannot read; a person signs out
 * and the page asks for a new code. The human signs in, opens a
 * topic holding an agent's hostile message (rendered as text, no dialog, no
 * <img>), posts from the post box (stored as human via web), and visits the
 * task board, who is online, and the audit view with a filter. Any console
 * error (a Content-Security-Policy violation included) fails the check.
 *
 * G5, the Admin tab: shown only to the human admin (a second person without
 * admin does not see it); "All clear" on a healthy board; add a user from the
 * form (the token shown once in a panel, copied or selected, never in storage
 * or the address, gone after dismiss); one read per 30 s, not per 5 s
 * refresh; an agent with three failed rings and a kicked agent flagged in
 * "Needs you"; coordinator grant and reinstate through the in-page confirm
 * step (no dialog). The board runs with a 1.5 s Lobby window and mute so the
 * kick fits in the check.
 *
 * Issue #55, the connector consent page (`/oauth/authorize`), in a fresh browser
 * context against a client document served from a local port (the e2e harness's
 * test-only allowance for plain http clients): an arrival that is not signed in
 * pairs, then shows consent as text (client, redirect host, localhost warning,
 * focus on the heading, nothing in storage, the query still in the address, Enter
 * in the handle field decides nothing); approve with a new handle lands on the
 * client's address with `code`, `state` and `iss`; deny lands on
 * `error=access_denied` with both buttons disabled while the call is in flight
 * and one call only; a handle differing only by case is refused and the form stays
 * usable; an invalid client id shows an error and never navigates; a person
 * without admin is told so. Screenshot: oauth-consent.png.
 *
 * Issue #54, passkeys, in a fresh browser context with Chrome's virtual authenticator
 * (the DevTools WebAuthn domain, so no real device is needed): a pairing session adds a
 * passkey; a new sign-in with it, no CLI involved, makes a session that is not offered
 * Add a passkey; a second pairing session adds another, and removing the first asks in
 * the page; the last has no remove button.
 *
 * Issue #54, approvals, the board restarted on the same state with BBS_REQUIRE_APPROVAL=1 (the order
 * the deploy docs give: register a device-bound passkey first). A virtual authenticator that is not
 * backup-eligible is the approver, a backup-eligible one holds a synced passkey. The pairing page
 * shows the approval panel with the match code the CLI's call returned and approving signs the
 * browser in; `/approve#id` approves and the fragment is gone from the address; the consent page's
 * approve goes through the panel and reaches the client's address; removing an approver passkey from
 * the Passkeys tab goes through the panel; a browser without passkeys says so; and a backup-eligible
 * passkey is refused by the board, with its message shown as text.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { api, makeRunDir, ROOT, sleep, startWrangler } from "../test/e2e/harness.ts";
import { ScriptedAdapter } from "../test/e2e/scripted-adapter.ts";

const outDir = resolve(process.argv[2] ?? join(ROOT, ".web-check"));
const HOSTILE = `<img src=x onerror="alert('xss')"> & <script>alert(2)</script>`;
const asCli = { "x-bbs-client": "cli" };


function check(cond, what) {
  if (!cond) throw new Error(`check failed: ${what}`);
  console.log(`ok: ${what}`);
}

const run = makeRunDir("owner", { BBS_LOBBY_WINDOW_MS: "1500", BBS_LOBBY_MUTE_MS: "1500", BBS_TEST_OAUTH_LOOPBACK_CLIENTS: "1" });
const REDIRECT = "http://127.0.0.1:53682/callback";
let clientBase = "";
const clientServer = createServer((req, res) => {
  if (req.url === "/client.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ client_id: `${clientBase}/client.json`, client_name: "Browser Check Client", redirect_uris: ["http://127.0.0.1/callback"] }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => clientServer.listen(0, "127.0.0.1", r));
clientBase = `http://127.0.0.1:${clientServer.address().port}`;
const server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
let browser;
let approvalServer;
try {
  const human = run.humanToken;
  const call = async (token, tool, args, headers = {}) => {
    const r = await api(server.url, token, tool, args, headers);
    if (r.status !== 200) throw new Error(`${tool}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.value;
  };
  // Board content: two agents, a topic with a hostile message, tasks in several states.
  const alice = (await call(human, "bbs_admin_user_add", { handle: "alice", harness: "claude-code" }, asCli)).token;
  const bob = (await call(human, "bbs_admin_user_add", { handle: "bob", harness: "claude-code" }, asCli)).token;
  await call(alice, "bbs_join", { role: "builder", machine: "workstation-1", os: "Linux", model: "claude-opus-5-5" });
  await call(bob, "bbs_join", { role: "reviewer" });
  await call(alice, "bbs_topic_create", { name: "plans", description: "Release planning" });
  // The person follows #plans, so it shows an unread count until opened.
  await call(human, "bbs_subscribe", { topic: "plans", level: "digest" }, asCli);
  await call(bob, "bbs_subscribe", { topic: "plans", level: "wake" });
  await call(alice, "bbs_post", { topic: "plans", body: "Draft notes are up for review." });
  await call(bob, "bbs_post", { topic: "plans", body: HOSTILE });
  const t1 = (await call(alice, "bbs_task_create", { topic: "plans", title: "Write the release notes" })).task.id;
  const t2 = (await call(alice, "bbs_task_create", { topic: "plans", title: "Review the release notes" })).task.id;
  await call(alice, "bbs_task_create", { topic: "plans", title: "Tag the release" });
  await call(alice, "bbs_task_claim", { task: t1 });
  await call(alice, "bbs_task_update", { task: t1, state: "in_progress" });
  await call(alice, "bbs_task_assign", { task: t2, assignee: "bob" });
  await call(bob, "bbs_task_block", { task: t2, blocked_by: [t1] });

  // G5: a person without admin (dave, the agent kicked later, is added in the Admin step).
  const pat = (await call(human, "bbs_admin_user_add", { handle: "pat", kind: "human" }, asCli)).token;

  const channel = process.env.BROWSER_CHANNEL || "chrome";
  browser = await chromium.launch({ headless: true, channel });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const dialogs = [];
  const consoleErrors = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  /** Sign the page in by pairing: read the code it shows, approve it over /api as the CLI would, wait for the page. */
  const pairIn = async (token, p = page, done = "#me:not([hidden])") => {
    await p.waitForSelector("#sign-in:not([hidden])");
    await p.waitForFunction(() => (document.getElementById("pair-code")?.textContent ?? "") !== "");
    const code = (await p.textContent("#pair-code")).trim();
    check(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), `a pairing code is shown (${code})`);
    check((await p.textContent("#pair-command")).trim() === `bbs web-login ${code}`, "the command to run is shown");
    check(/expires in \d+:\d\d/.test(await p.textContent("#pair-status")), "a countdown is shown as text");
    await call(token, "bbs_web_pairing_approve", { code }, asCli);
    await p.waitForSelector(done, { timeout: 15_000 });
    return code;
  };

  await page.goto(server.url + "/");
  await page.waitForSelector("#sign-in:not([hidden])");
  check((await page.$$("#sign-in input, #sign-in form")).length === 0, "no token field or form in the sign-in panel");

  // An agent cannot approve a pairing.
  await page.waitForFunction(() => (document.getElementById("pair-code")?.textContent ?? "") !== "");
  const agentCode = (await page.textContent("#pair-code")).trim();
  const agentTry = await api(server.url, alice, "bbs_web_pairing_approve", { code: agentCode });
  check(agentTry.status === 403, "an agent cannot approve a pairing");

  // The human approves from the CLI, and the page signs in.
  await pairIn(human);
  check((await page.textContent("#me-label")).includes("Signed in as owner (human, admin)"), "human signed in");
  check((await page.evaluate(() => sessionStorage.length + localStorage.length)) === 0, "nothing in sessionStorage or localStorage");
  check((await page.evaluate(() => document.cookie)) === "", "the session cookie is invisible to the page (HttpOnly)");
  const cookies = (await page.context().cookies()).filter((c) => c.name === "bbs-session");
  check(cookies.length === 1 && cookies[0].httpOnly && cookies[0].sameSite === "Strict" && cookies[0].path === "/", "cookie is HttpOnly, SameSite=Strict, Path=/");
  check(cookies[0].expires - Date.now() / 1000 > 29 * 86400, "cookie lasts about 30 days");

  // The topic list shows #plans unread; opening it clears the count (review M1).
  await page.waitForSelector(".topic-list a");
  check((await page.textContent(".topic-list")).includes("2 unread"), "unread count shown before opening");
  // The topic, with the hostile message shown as text.
  await page.goto(server.url + "/#topic/plans");
  await page.waitForSelector("#messages .message");
  await page.waitForFunction(() => !document.querySelector(".topic-list")?.textContent?.includes("unread"));
  check(true, "unread count cleared after opening the topic");
  const marks = await call(human, "bbs_audit", { action: "topic_mark_read", limit: 10 }, asCli);
  check(marks.events.length === 1, "one read-mark call for the opened topic");
  const bodies = await page.$$eval("#messages .body", (els) => els.map((e) => e.textContent));
  check(bodies.includes(HOSTILE), "hostile message rendered as its literal text");
  check((await page.$$("#messages img, #messages script")).length === 0, "no element created from message text");

  // Post from the post box.
  await page.fill("#post-body", "Approved for Friday. — posted from the web view");
  await page.click("#post-form button[type=submit]");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#messages .body")].some((e) => e.textContent?.includes("posted from the web view")),
  );
  const read = await call(human, "bbs_read", { topic: "plans", tail: true, limit: 1 }, asCli);
  const last = read.messages[0];
  check(last.kind === "human" && last.via === "web" && last.author === "owner", "web post stored as human via web");
  const mine = await page.$$eval("#messages .message", (els) => els.at(-1)?.querySelector(".meta")?.textContent ?? "");
  check(mine.includes("human") && mine.includes("via web"), "web post shows the human badge and via web");
  await page.screenshot({ path: join(outDir, "M5-web.png"), fullPage: true });

  // Task board: columns by state, labeled in words.
  await page.goto(server.url + "/#tasks");
  await page.waitForSelector(".task-board .task");
  const headings = await page.$$eval(".task-board h3", (els) => els.map((e) => e.textContent));
  check(headings.length === 7 && headings.some((t) => t.includes("In progress (1)")) && headings.some((t) => t.includes("Blocked (1)")), "task board columns by state");
  check((await page.textContent(".column-blocked")).includes(`blocked by #${t1} (in progress)`), "blocked task names its blocker");
  await page.screenshot({ path: join(outDir, "M5-web-tasks.png"), fullPage: true });

  // Who is online.
  await page.goto(server.url + "/#who");
  await page.waitForSelector("table.who tbody tr");
  const whoText = await page.textContent("table.who");
  check(whoText.includes("alice") && whoText.includes("idle") && whoText.includes("last seen") && !whoText.includes("offline"), "who is online: agents by session state, people by last seen");
  // Times arrive as ISO text and are shown formatted for the reader, never as "Invalid Date" or NaN.
  check(whoText.includes("workstation-1, Linux") && whoText.includes("claude-code, claude-opus-5-5"), "who: a session's machine, os, harness and model are shown as text");
  check(whoText.includes("cannot be rung"), "who: a session with no adapter is shown as text as one that cannot be rung");
  check(!/Invalid Date|NaN/.test(whoText), "who: last seen times are formatted from ISO text");
  await page.screenshot({ path: join(outDir, "M5-web-who.png"), fullPage: true });

  // Audit view with a filter.
  await page.goto(server.url + "/#audit");
  await page.waitForSelector("#audit table, #audit .empty");
  await page.fill("#audit-form input[name=actor]", "alice");
  await page.fill("#audit-form input[name=topic]", "plans");
  await page.click("#audit-form button[type=submit]");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("#audit tbody tr")];
    return rows.length > 0 && rows.every((r) => r.children[2]?.textContent?.startsWith("alice"));
  });
  check(true, "audit filter by actor and topic");
  check(!/Invalid Date|NaN/.test(await page.textContent("#audit")), "audit: times are formatted from ISO text");
  await page.screenshot({ path: join(outDir, "M5-web-audit.png"), fullPage: true });

  // G5: the Admin tab.
  check(await page.isVisible("#nav-admin"), "Admin tab shown to the human admin");
  const adminReads = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/bbs_admin_status")) adminReads.push(Date.now());
  });
  const dave = (await call(human, "bbs_admin_user_add", { handle: "dave", harness: "claude-code" }, asCli)).token;
  /** Walk dave through warn, mute (lifted by the alarm) and kick; returns the last refusal's message. */
  const kickDave = async () => {
    await call(dave, "bbs_join", { role: "flooder" });
    const floodLobby = async () => {
      for (let i = 0; i < 20; i++) {
        const r = await api(server.url, dave, "bbs_post", { topic: "Lobby", body: `flood ${i}` });
        if (r.status !== 200) return r.body?.error?.message ?? "";
      }
      throw new Error("Lobby flood never refused");
    };
    await floodLobby();
    await sleep(1700);
    await floodLobby();
    for (let i = 0; i < 100; i++) {
      const who = await call(human, "bbs_who", {}, asCli);
      if (who.users.find((u) => u.handle === "dave")?.status === "active") break;
      await sleep(200);
    }
    await sleep(1700);
    return floodLobby();
  };
  await page.goto(server.url + "/#admin");
  await page.waitForSelector("#admin-needs .all-clear");
  check((await page.textContent("#admin-needs")).includes("All clear: nothing needs you."), "healthy board: All clear");
  const cardOrder = await page.$$eval("#admin-users li.card", (els) => els.map((e) => e.getAttribute("data-handle")));
  check(JSON.stringify(cardOrder) === JSON.stringify(["alice", "bob", "dave", "owner", "pat"]), `one card per user in handle order (${cardOrder.join(",")})`);
  check((await page.$$("#admin-users .card.flagged, #admin-users .badge")).length === 0, "healthy cards carry no indicator (dark cockpit)");
  await page.screenshot({ path: join(outDir, "G5-admin-clear.png"), fullPage: true });

  // Add a user from the form: the token is shown once, copied or selected, and gone after dismiss.
  await page.fill("#user-add-form input[name=handle]", "carol");
  await page.fill("#user-add-form input[name=harness]", "codex");
  await page.click("#user-add-form button[type=submit]");
  await page.waitForSelector("#token-panel:not([hidden])");
  const shown = await page.inputValue("#token-value");
  check(shown.startsWith("bbs_") && (await page.textContent("#token-panel")).includes("Shown once."), "new token shown once with the note");
  const carol = await api(server.url, shown, "bbs_whoami", {});
  check(carol.status === 200 && carol.body.value.handle === "carol", "the shown token is carol's");
  check((await page.evaluate(() => sessionStorage.length)) === 0, "token not in sessionStorage");
  check((await page.evaluate(() => localStorage.length)) === 0 && !page.url().includes(shown), "token not in localStorage or the address");
  await page.click("#token-copy");
  await page.waitForFunction(() => (document.getElementById("token-copy-status")?.textContent ?? "") !== "");
  const copyStatus = await page.textContent("#token-copy-status");
  check(copyStatus === "Copied." || copyStatus.startsWith("Selected"), `copy button copies or selects (${copyStatus})`);
  await page.click("#token-dismiss");
  check((await page.isHidden("#token-panel")) && (await page.inputValue("#token-value")) === "", "dismiss hides the panel and clears the token");
  const html = await page.content();
  check(!html.includes(shown), "token gone from the page after dismiss");

  // Flags: bob's rings fail three times; dave is kicked again.
  const bobSession = (await call(bob, "bbs_join", {})).session;
  const sock = await ScriptedAdapter.connect(server.url, bob);
  sock.hello(bobSession);
  await sleep(300);
  for (let i = 0; i < 3; i++) sock.send({ type: "ring_result", id: `d_check${i}`, result: "failed" });
  await sleep(300);
  check((await kickDave()).includes("removed from the board"), "dave kicked");
  // A reload reads at once (the cookie signs in, then the Admin tab).
  await page.reload();
  await page.waitForSelector("#admin-needs .flags");
  const flags = await page.$$eval("#admin-needs li", (els) => els.map((e) => e.textContent ?? ""));
  check(flags.length === 2 && flags[0].includes("✕ kicked dave") && flags[1].includes("↯ rings failing bob"), "Needs you lists the kicked agent, then the failing rings");
  check(flags.every((f) => f.includes("What to do:")), "every flagged item says what to do");
  check((await page.$$eval("#admin-users li.card.flagged", (els) => els.map((e) => e.getAttribute("data-handle")))).join(",") === "bob,dave", "flagged cards marked in place, order unchanged");
  await page.screenshot({ path: join(outDir, "G5-admin.png"), fullPage: true });

  // Coordinator grant through the in-page confirm step.
  await page.click('#admin-users li[data-handle="alice"] button[data-admin-action="grant"]');
  await page.waitForSelector('#admin-users li[data-handle="alice"] .confirm');
  check((await page.textContent('#admin-users li[data-handle="alice"] .confirm')).includes("Make alice a coordinator?"), "confirm step shown in the page");
  await page.click('#admin-users li[data-handle="alice"] button[data-admin-action="confirm"]');
  await page.waitForSelector('#admin-users li[data-handle="alice"] button[data-admin-action="remove"]');
  const whoNow = await call(human, "bbs_who", {}, asCli);
  check(whoNow.users.find((u) => u.handle === "alice")?.coordinator === true, "alice is a coordinator");

  // Reinstate dave from Needs you: confirm, then the new token in the panel.
  await page.click('#admin-needs button[data-admin-action="reinstate"][data-handle="dave"]');
  await page.click('#admin-needs button[data-admin-action="confirm"][data-handle="dave"]');
  await page.waitForSelector("#token-panel:not([hidden])");
  check((await page.textContent("#token-title")).includes("dave reinstated"), "reinstate shows the new token once");
  const dave3 = await page.inputValue("#token-value");
  check((await api(server.url, dave3, "bbs_whoami", {})).status === 200, "the reinstated token works");
  await page.click("#token-dismiss");
  await page.waitForFunction(() => !(document.getElementById("admin-needs")?.textContent ?? "").includes("kicked dave"));
  check(true, "dave no longer flagged after reinstate");
  sock.close();

  // Polling: one read per 30 s while visible, not one per 5 s refresh.
  const mark = adminReads.length;
  await sleep(8_000);
  check(adminReads.length === mark, `no extra admin reads within 8 s (${adminReads.length - mark})`);
  const deadline = Date.now() + 30_000;
  while (adminReads.length === mark && Date.now() < deadline) await sleep(500);
  check(adminReads.length === mark + 1, "re-read within 30 s");

  // Signing out ends the session and asks for a new code; a person without admin signs in the same way and never sees the tab.
  await page.click("#sign-out");
  await page.waitForSelector("#sign-in:not([hidden])");
  check((await page.context().cookies()).filter((c) => c.name === "bbs-session").length === 0, "sign-out clears the cookie");
  await pairIn(pat);
  check(await page.isHidden("#nav-admin"), "Admin tab hidden for a person without admin");
  await page.goto(server.url + "/#admin");
  await sleep(500);
  check(await page.isHidden("#view-admin"), "#admin shows no Admin view to a person without admin");


  // Issue #54: passkeys, in a fresh browser context with Chrome's virtual authenticator (the
  // DevTools WebAuthn domain): sign in by pairing, add a passkey, sign out, sign in with the passkey
  // (a session that may not add another), then pair again and add a second one and remove the first
  // through the in-page confirmation, until only the last is left, which shows the CLI command.
  {
    // A relying party id must be a domain: Chrome refuses an address like 127.0.0.1, so this block uses localhost.
    const localUrl = server.url.replace("127.0.0.1", "localhost");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const p = await ctx.newPage();
    const passkeyErrors = [];
    p.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    p.on("console", (m) => {
      if (m.type() === "error") passkeyErrors.push(m.text());
    });
    p.on("pageerror", (e) => passkeyErrors.push(String(e)));
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("WebAuthn.enable");
    const addAuthenticator = async () =>
      (
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
        })
      ).authenticatorId;
    const firstAuthenticator = await addAuthenticator();
    const addPasskey = async (label) => {
      await p.fill("#passkey-add-form input[name=label]", label);
      await p.click("#passkey-add-form button[type=submit]");
      try {
        await p.waitForFunction((l) => document.getElementById("passkey-list")?.textContent?.includes(l), label, { timeout: 15_000 });
      } catch (err) {
        throw new Error(`adding "${label}" did not show: ${await p.textContent("#passkey-status")} (${passkeyErrors.join(" | ")})`, { cause: err });
      }
    };
    await p.goto(localUrl + "/");
    await p.waitForSelector("#sign-in:not([hidden])");
    check(await p.isVisible("#passkey-signin-button"), "passkeys: the sign-in button shows when the browser has PublicKeyCredential");
    check((await p.$$("#sign-in input, #sign-in form")).length === 0, "passkeys: still no token field or form in the sign-in panel");
    await pairIn(human, p);
    await p.goto(localUrl + "/#passkeys");
    await p.waitForSelector("#passkey-add-form:not([hidden])");
    check((await p.textContent("#passkey-list")).includes("No passkeys yet."), "passkeys: none yet, and Add a passkey is offered in a pairing session");
    await addPasskey("Check key");
    const listed = await p.textContent("#passkey-list");
    check(/synced between devices|device-bound/.test(listed) && listed.includes("Last used never"), "passkeys: the list says in words whether the passkey syncs, and that it was never used");
    check((await p.textContent("#passkey-list")).includes("bbs passkey remove") && (await p.$$("#passkey-list button")).length === 0, "passkeys: the only passkey has no remove button, only the CLI command");
    check((await p.evaluate(() => sessionStorage.length + localStorage.length)) === 0, "passkeys: nothing in web storage");

    await p.click("#sign-out");
    await p.waitForSelector("#sign-in:not([hidden])");
    await p.click("#passkey-signin-button");
    await p.waitForSelector("#me:not([hidden])", { timeout: 15_000 });
    check((await p.textContent("#me-label")).includes("Signed in as owner"), "passkeys: signed in with the passkey, no CLI involved");
    await p.goto(localUrl + "/#passkeys");
    await p.waitForFunction(() => document.getElementById("passkey-list")?.textContent?.includes("Last used"));
    await p.waitForFunction(() => document.getElementById("passkey-note")?.textContent?.includes("pairing code"));
    check(await p.isHidden("#passkey-add-form"), "passkeys: a passkey session is not offered Add a passkey");
    check((await p.textContent("#passkey-note")).includes("pairing code"), "passkeys: a one-line note says to sign in with a pairing code first");
    check(!(await p.textContent("#passkey-list")).includes("Last used never"), "passkeys: the sign-in set the last-used time");
    const sessions = await call(human, "bbs_web_sessions", {}, asCli);
    check(sessions.sessions.length >= 1, "passkeys: the passkey sign-in made its own web session");

    // A second passkey needs a pairing session and an authenticator that does not hold the first.
    await p.click("#sign-out");
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: firstAuthenticator });
    await addAuthenticator();
    await pairIn(human, p);
    await p.goto(localUrl + "/#passkeys");
    await p.waitForSelector("#passkey-add-form:not([hidden])");
    await addPasskey("Second key");
    check((await p.$$("#passkey-list li")).length === 2, "passkeys: two passkeys listed");
    await p.click('#passkey-list li:has-text("Check key") button[data-passkey-action=remove]');
    check((await p.textContent("#passkey-list")).includes('Remove the passkey "Check key"?'), "passkeys: removal asks in the page, not in a dialog");
    await p.click("#passkey-list button[data-passkey-action=cancel]");
    check((await p.$$("#passkey-list li")).length === 2, "passkeys: cancel keeps both");
    await p.click('#passkey-list li:has-text("Check key") button[data-passkey-action=remove]');
    await p.click("#passkey-list button[data-passkey-action=confirm]");
    await p.waitForFunction(() => !document.getElementById("passkey-list")?.textContent?.includes("Check key"));
    check((await p.$$("#passkey-list li")).length === 1 && (await p.$$("#passkey-list button")).length === 0, "passkeys: the removed one is gone and the last has no button");
    const remaining = await call(human, "bbs_passkeys", {}, asCli);
    check(remaining.passkeys.length === 1 && remaining.passkeys[0].label === "Second key", "passkeys: the board agrees");
    check(passkeyErrors.every((e) => /Failed to load resource/.test(e)), `passkeys: no console errors besides refused calls (${passkeyErrors.join(" | ")})`);

    // The consent page offers the same passkey sign-in: a signed-out browser holding the passkey opens
    // it, signs in there, and reaches the consent panel with the query still in the address.
    await ctx.clearCookies();
    const consentUrl = `${localUrl}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: `${clientBase}/client.json`,
      redirect_uri: REDIRECT,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: `${localUrl}/mcp`,
      state: "passkey-consent-state",
    })}`;
    await p.goto(consentUrl);
    await p.waitForSelector("#sign-in:not([hidden])");
    check(await p.isVisible("#passkey-signin-button"), "consent passkey: the sign-in button shows on the consent page");
    check((await p.$$("#sign-in input, #sign-in form")).length === 0, "consent passkey: no token field or form in the sign-in panel");
    await p.click("#passkey-signin-button");
    try {
      await p.waitForSelector("#consent:not([hidden])", { timeout: 15_000 });
    } catch (err) {
      throw new Error(`consent passkey: no consent panel after the passkey (${p.url()} / ${(await p.textContent("body")).replace(/\s+/g, " ").slice(0, 400)})`, { cause: err });
    }
    check(p.url() === consentUrl, "consent passkey: the query is still in the address after signing in");
    check((await p.textContent("#client-name")) === "Browser Check Client", "consent passkey: the client is shown after a passkey sign-in");
    check((await p.evaluate(() => sessionStorage.length + localStorage.length)) === 0, "consent passkey: nothing in web storage");
    check(passkeyErrors.every((e) => /Failed to load resource/.test(e)), `consent passkey: no console errors besides refused calls (${passkeyErrors.join(" | ")})`);
    await ctx.close();
  }

  // Issue #55: the connector consent page, in fresh browser contexts (no session cookie yet).
  const authorizeUrl = (over = {}) => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: `${clientBase}/client.json`,
      redirect_uri: REDIRECT,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: `${server.url}/mcp`,
      state: "web-check-state",
      ...over,
    });
    return `${server.url}/oauth/authorize?${q}`;
  };
  const oauthErrors = [];
  const newOauthPage = async () => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const p = await ctx.newPage();
    p.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    p.on("console", (m) => {
      if (m.type() === "error") oauthErrors.push(m.text());
    });
    p.on("pageerror", (e) => oauthErrors.push(String(e)));
    const hits = [];
    await p.route("http://127.0.0.1:53682/**", (route) => {
      hits.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/plain", body: "the client" });
    });
    return { ctx, p, hits };
  };
  const consentCalls = (p) => {
    const calls = { request: 0, decide: 0 };
    p.on("request", (r) => {
      if (r.url().endsWith("/api/web/oauth/request")) calls.request++;
      if (r.url().endsWith("/api/web/oauth/decide")) calls.decide++;
    });
    return calls;
  };

  await call(human, "bbs_admin_user_add", { handle: "Taken-Agent", harness: "claude-code" }, asCli);
  const o = await newOauthPage();
  const calls = consentCalls(o.p);
  const startUrl = authorizeUrl();
  await o.p.goto(startUrl);
  await pairIn(human, o.p, "#consent:not([hidden])");
  check(o.p.url() === startUrl, "consent: the query is still in the address after signing in");
  check((await o.p.textContent("#client-name")) === "Browser Check Client" && (await o.p.textContent("#client-host")) === new URL(clientBase).host, `consent: the client's name and host are shown as text (${await o.p.textContent("#client-name")} / ${await o.p.textContent("#client-host")})`);
  check((await o.p.textContent("#redirect-host")) === "127.0.0.1:53682", "consent: the host the person is sent back to is shown");
  check((await o.p.textContent("#client-auth")).startsWith("none:"), `consent: how the client authenticates is shown as text (${await o.p.textContent("#client-auth")})`);
  check(await o.p.isVisible("#localhost-warning"), "consent: a localhost redirect carries the warning");
  check((await o.p.textContent("#consent")).includes("never gets your own authority") && (await o.p.textContent("#consent")).includes("bbs oauth revoke"), "consent: what approving allows and how to end it are stated");
  check((await o.p.evaluate(() => document.activeElement?.id)) === "consent-title", "consent: focus is on the heading, not on a button");
  check((await o.p.inputValue("#handle")) !== "", "consent: the handle is prefilled with a suggestion");
  check((await o.p.$$("#consent form")).length === 0 && (await o.p.isEnabled("#approve")) && (await o.p.isEnabled("#deny")), "consent: no form, both buttons usable");
  check(/expires in \d+:\d\d/.test(await o.p.textContent("#countdown")), "consent: a countdown is shown as text");
  check((await o.p.evaluate(() => sessionStorage.length + localStorage.length)) === 0 && (await o.p.evaluate(() => document.cookie)) === "", "consent: nothing in web storage, no readable cookie");
  await o.p.screenshot({ path: join(outDir, "oauth-consent.png"), fullPage: true });
  await o.p.focus("#handle");
  await o.p.keyboard.press("Enter");
  await sleep(500);
  check(o.hits.length === 0 && o.p.url() === startUrl && (await o.p.isVisible("#consent")), "consent: Enter in the handle field decides nothing");

  // A handle that differs only by case from an existing agent is refused, and the form stays usable.
  await o.p.fill("#handle", "taken-agent");
  await o.p.click("#approve");
  await o.p.waitForSelector("#decide-error:not([hidden])");
  check(o.hits.length === 0 && (await o.p.isEnabled("#approve")) && (await o.p.isEnabled("#deny")), "consent: a refused handle leaves the form usable and goes nowhere");
  check((await o.p.textContent("#decide-error")).includes("Pick another handle"), "consent: the refusal is shown as text");
  // Picking an existing agent from the list says plainly what that means.
  await o.p.selectOption("#agents", "Taken-Agent");
  check((await o.p.inputValue("#handle")) === "Taken-Agent" && (await o.p.textContent("#handle-note")).includes("act as Taken-Agent"), "consent: picking an existing agent fills the handle and says what it means");

  // Approve with a new handle: the browser lands on the client's address with code, state and iss.
  await o.p.fill("#handle", "oauth-web");
  await o.p.click("#approve");
  await o.p.waitForURL(`${REDIRECT}?**`);
  const landed = new URL(o.p.url());
  check(`${landed.origin}${landed.pathname}` === REDIRECT && (landed.searchParams.get("code") ?? "") !== "" && landed.searchParams.get("state") === "web-check-state" && landed.searchParams.get("iss") === server.url, "approve: the browser lands on the client's address with code, state and iss");
  const grants = await call(human, "bbs_oauth_grants", {}, asCli);
  check(grants.grants.some((g) => g.handle === "oauth-web"), "approve: the board holds the grant for the new handle");
  check(calls.request === 1, `approve: one request call (${calls.request})`);
  await o.ctx.close();

  // Deny: error=access_denied, both buttons disabled while the call is in flight, one call only.
  const d = await newOauthPage();
  const dcalls = consentCalls(d.p);
  await d.p.goto(authorizeUrl({ state: "deny-state" }));
  await pairIn(human, d.p, "#consent:not([hidden])");
  await d.p.route("**/api/web/oauth/decide", async (route) => {
    await sleep(800);
    await route.continue();
  });
  await d.p.click("#deny");
  check((await d.p.isDisabled("#approve")) && (await d.p.isDisabled("#deny")), "deny: both buttons are disabled while the call is in flight");
  await d.p.click("#deny", { force: true, timeout: 1000 }).catch(() => {});
  await d.p.waitForURL(`${REDIRECT}?**`);
  const denied = new URL(d.p.url()).searchParams;
  check(denied.get("error") === "access_denied" && denied.get("state") === "deny-state" && !denied.has("code"), "deny: the browser lands on the client's address with error=access_denied");
  check(dcalls.decide === 1, `deny: one decide call (${dcalls.decide})`);
  await d.ctx.close();

  // An invalid client id is shown as an error and never navigates.
  const bad = await newOauthPage();
  await bad.p.goto(authorizeUrl({ client_id: `${clientBase}/missing.json` }));
  await pairIn(human, bad.p, "#finished:not([hidden])");
  const badText = await bad.p.textContent("#finished");
  check(badText.includes("cannot be approved") && badText.includes("nothing was sent to the client"), "invalid client: an error is shown as text");
  check(bad.hits.length === 0 && bad.p.url().startsWith(`${server.url}/oauth/authorize`) && (await bad.p.isHidden("#consent")), "invalid client: no navigation, no consent screen");
  await bad.ctx.close();

  // A person without admin is told so.
  const pw = await newOauthPage();
  await pw.p.goto(authorizeUrl());
  await pairIn(pat, pw.p, "#finished:not([hidden])");
  check((await pw.p.textContent("#finished")).includes("administrator") && pw.hits.length === 0, "non-admin: told that only the administrator can approve, no navigation");
  await pw.ctx.close();

  check(oauthErrors.every((e) => /Failed to load resource/.test(e)) , `consent: no console errors besides refused calls (${oauthErrors.join(" | ")})`);

  // Refreshes (and the person's own post, which is never unread) moved the mark no further.
  const marksAfter = await call(human, "bbs_audit", { action: "topic_mark_read", limit: 10 }, asCli);
  check(marksAfter.events.length === 1, `no further read-mark calls (${marksAfter.events.length})`);
  check(dialogs.length === 0, `no dialog opened (${dialogs.length})`);
  check(consoleErrors.length === 0, `no console errors (${consoleErrors.join(" | ")})`);

  // Issue #54: approving with a passkey. Phase one, with approval still off: a pairing session registers a
  // synced passkey and a device-bound one. Phase two: the same state, restarted with approval required.
  {
    const localUrl = server.url.replace("127.0.0.1", "localhost");
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const p = await ctx.newPage();
    const approvalErrors = [];
    p.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    p.on("console", (m) => {
      if (m.type() === "error") approvalErrors.push(m.text());
    });
    p.on("pageerror", (e) => approvalErrors.push(String(e)));
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("WebAuthn.enable");
    // Chrome allows one internal authenticator, so the device-bound approver is a USB security key.
    const addAuthenticator = async (synced) =>
      (
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: synced ? "internal" : "usb",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
            defaultBackupEligibility: synced,
            defaultBackupState: synced,
          },
        })
      ).authenticatorId;
    const addPasskey = async (label) => {
      await p.fill("#passkey-add-form input[name=label]", label);
      await p.click("#passkey-add-form button[type=submit]");
      try {
        await p.waitForFunction((l) => document.getElementById("passkey-list")?.textContent?.includes(l), label, { timeout: 15_000 });
      } catch (err) {
        throw new Error(`approval: adding "${label}" did not show: ${await p.textContent("#passkey-status")} (${approvalErrors.join(" | ")})`, { cause: err });
      }
    };
    // Registering with a second authenticator present fails (the first one's credential is excluded), so
    // the synced passkey's credential is saved and put back into a new synced authenticator at the end.
    const syncedAuthenticator = await addAuthenticator(true);
    await p.goto(localUrl + "/");
    await pairIn(human, p);
    await p.goto(localUrl + "/#passkeys");
    await p.waitForSelector("#passkey-add-form:not([hidden])");
    await addPasskey("Synced key");
    const syncedCredentials = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: syncedAuthenticator })).credentials;
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: syncedAuthenticator });
    const approverAuthenticator = await addAuthenticator(false);
    await addPasskey("Approver key");
    const before = await call(human, "bbs_passkeys", {}, asCli);
    const byLabel = (list, label) => list.passkeys.find((k) => k.label === label);
    check(byLabel(before, "Synced key")?.synced === true && byLabel(before, "Approver key")?.synced === false, "approval: a synced and a device-bound passkey are registered");
    check(before.approval?.required === false, "approval: off on the first boot");

    // Restart on the same state with approval required.
    const approvalEnv = join(run.dir, "dev-approval.vars");
    writeFileSync(approvalEnv, `${readFileSync(run.envFile, "utf8")}BBS_REQUIRE_APPROVAL=1\n`, { mode: 0o600 });
    await server.stop();
    approvalServer = await startWrangler({ stateDir: run.stateDir, envFile: approvalEnv, logFile: join(run.dir, "wrangler-approval.log") });
    const base = approvalServer.url;
    const local = base.replace("127.0.0.1", "localhost");
    const callA = (tool, args) => call2(base, tool, args);
    const call2 = async (url, tool, args) => {
      const r = await api(url, human, tool, args, asCli);
      if (r.status !== 200) throw new Error(`${tool}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.value;
    };
    const pairStart = async () =>
      (await (await fetch(`${base}/api/web/pair/start`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin }, body: "{}" })).json()).value;
    const approvalText = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, " ");

    // The Passkeys tab says whether each passkey can approve, and how many do.
    await p.goto(local + "/#passkeys");
    await p.waitForFunction(() => (document.getElementById("passkey-approval")?.textContent ?? "") !== "");
    const listA = await callA("bbs_passkeys", {});
    check(listA.approval.required === true && listA.approval.approvers >= 1, `approval: the board requires approval, with ${listA.approval.approvers} approver(s)`);
    const line = await approvalText(p, "#passkey-approval");
    check(line.includes("This board requires approval by passkey.") && line.includes(`${listA.approval.approvers} passkey`), `approval: the Passkeys tab says so in one line (${line})`);
    const list = await approvalText(p, "#passkey-list");
    check(list.includes("can approve") && list.includes("cannot approve: synced between devices"), "approval: each passkey says in words whether it can approve");
    check(byLabel(listA, "Second key")?.can_approve === true, "approval: the earlier device-bound passkey can approve");

    // The pairing page: the approval panel appears under the code, with the match code the CLI's call returned.
    await ctx.clearCookies();
    await p.goto(local + "/");
    await p.waitForSelector("#sign-in:not([hidden])");
    await p.waitForFunction(() => (document.getElementById("pair-code")?.textContent ?? "") !== "");
    const pairCode = (await p.textContent("#pair-code")).trim();
    const asked = await api(base, human, "bbs_web_pairing_approve", { code: pairCode }, asCli);
    check(asked.status === 200 && asked.body.value.status === "approval_required", "approval pairing: the CLI's approve asks for an approval");
    try {
      await p.waitForSelector("#pair-approval .approval-code", { timeout: 15_000 });
    } catch (err) {
      throw new Error(`approval pairing: no panel (${(await p.textContent("#sign-in")).replace(/\s+/g, " ").slice(0, 400)})`, { cause: err });
    }
    check((await p.textContent("#pair-approval .approval-code")) === asked.body.value.match_code, "approval pairing: the panel shows the match code the CLI got");
    const sentence = await approvalText(p, "#pair-approval .approval-what");
    check(sentence.startsWith("Sign in the browser labeled") && sentence.includes("as owner"), `approval pairing: it says what is approved (${sentence})`);
    check((await approvalText(p, "#pair-approval")).includes("Check that this code matches the one shown where you made the request") && /Expires in \d+ minutes?/.test(await approvalText(p, "#pair-approval")), "approval pairing: the check line and the time left are shown as text");
    check((await p.$$("#pair-approval input, #pair-approval form")).length === 0, "approval pairing: no field or form in the panel");
    await p.click("#pair-approval button");
    await p.waitForSelector("#me:not([hidden])", { timeout: 15_000 });
    check((await p.textContent("#me-label")).includes("Signed in as owner"), "approval pairing: approving with the key signs the browser in");
    check((await p.evaluate(() => sessionStorage.length + localStorage.length)) === 0, "approval pairing: nothing in web storage");

    // The standalone page: the fragment is gone from the address once it loads; approving says so.
    const second = await pairStart();
    const askedB = await api(base, human, "bbs_web_pairing_approve", { code: second.code }, asCli);
    const linkId = askedB.body.value.approval;
    const link = askedB.body.value.url.replace("127.0.0.1", "localhost");
    check(link.endsWith(`/approve#${linkId}`), "approval page: the CLI's answer carries the /approve link");
    await p.goto(link);
    await p.waitForSelector(".approval-code");
    check(!p.url().includes("#") && !p.url().includes(linkId), `approval page: the fragment is gone from the address (${p.url()})`);
    check((await p.textContent(".approval-code")) === askedB.body.value.match_code, "approval page: the match code matches the CLI's");
    check((await p.evaluate(() => document.activeElement?.id)) === "approve-title", "approval page: focus is on the heading, not the button");
    await p.click(".approval button");
    await p.waitForFunction(() => document.getElementById("approve-result")?.textContent?.includes("Approved. You can close this page."), null, { timeout: 15_000 });
    check((await p.textContent("#approve")).includes("is being signed in"), "approval page: a pairing says which browser is being signed in");
    check((await call2(base, "bbs_approval_status", { approval: linkId })).status === "approved", "approval page: the board agrees it is approved");
    await p.goto("about:blank");
    await p.goto(link);
    await p.waitForFunction(() => document.querySelector(".approval-state")?.textContent?.includes("already decided"));
    check((await p.$$(".approval button")).length === 0 || (await p.isHidden(".approval button")), "approval page: a decided request cannot be approved again");

    // A malformed fragment is taken out of the address and reads as an unknown request, with no error.
    const bad = await ctx.newPage();
    const badErrors = [];
    bad.on("pageerror", (e) => badErrors.push(String(e)));
    await bad.goto(link.split("#")[0] + "#%");
    await bad.waitForFunction(() => document.getElementById("approve-result")?.textContent?.includes("does not exist"));
    check(!bad.url().includes("#") && badErrors.length === 0, `approval page: a malformed fragment (#%) is removed from the address and shows the unknown state (${badErrors.join(" | ")})`);
    check((await bad.$$(".approval button")).length === 0, "approval page: a malformed fragment offers no button");
    await bad.close();

    // A browser without passkeys says so as text, and offers no button.
    const third = await pairStart();
    const askedC = await api(base, human, "bbs_web_pairing_approve", { code: third.code }, asCli);
    const bare = await ctx.newPage();
    await bare.addInitScript(() => {
      delete window.PublicKeyCredential;
    });
    await bare.goto(askedC.body.value.url.replace("127.0.0.1", "localhost"));
    await bare.waitForFunction(() => document.querySelector(".approval-state")?.textContent?.includes("cannot use passkeys"));
    check(await bare.isHidden(".approval button"), "approval page: a browser without passkeys sees the request, says so, and has no button");
    await bare.close();

    // The consent page: approve goes through the panel and reaches the client's address.
    await p.route("http://127.0.0.1:53682/**", (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "the client" }));
    const consent = `${local}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: `${clientBase}/client.json`,
      redirect_uri: REDIRECT,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: `${local}/mcp`,
      state: "approval-consent-state",
    })}`;
    await p.goto(consent);
    await p.waitForSelector("#consent:not([hidden])");
    await p.fill("#handle", "approver-agent");
    const decided = p.waitForResponse((r) => r.url().endsWith("/api/web/oauth/decide"));
    await p.click("#approve");
    const decideBody = await (await decided).json();
    await p.waitForSelector("#consent-approval .approval-code", { timeout: 15_000 });
    check(decideBody.value.status === "approval_required" && decideBody.value.url === undefined, "approval consent: the decide answer carries no standalone link");
    // The standalone page, given a connector's approval anyway, sends the person to the consent page and has no button.
    const stand = await ctx.newPage();
    await stand.goto(`${p.url().split("/oauth")[0]}/approve#${decideBody.value.approval}`);
    await stand.waitForFunction(() => document.querySelector(".approval-state")?.textContent?.includes("consent page"));
    check((await stand.textContent(".approval-state")).includes("Approve this on the connector's consent page.") && (await stand.isHidden(".approval button")), "approval page: a connector's approval is left to the consent page, with no button");
    await stand.close();
    check(await p.isHidden("#approve") && await p.isHidden("#deny"), "approval consent: the panel takes the place of the buttons");
    const consentSentence = await approvalText(p, "#consent-approval .approval-what");
    check(consentSentence.includes("Browser Check Client") && consentSentence.includes("approver-agent") && consentSentence.includes("127.0.0.1:53682"), `approval consent: it names the client, the agent and where it returns (${consentSentence})`);
    check((await call2(base, "bbs_oauth_grants", {})).grants.every((g) => g.handle !== "approver-agent"), "approval consent: nothing is granted before the key signs");
    await p.click("#consent-approval button");
    await p.waitForURL(`${REDIRECT}?**`, { timeout: 15_000 });
    const back = new URL(p.url());
    check((back.searchParams.get("code") ?? "") !== "" && back.searchParams.get("state") === "approval-consent-state", "approval consent: the browser lands on the client's address with code and state");
    check((await call2(base, "bbs_oauth_grants", {})).grants.some((g) => g.handle === "approver-agent"), "approval consent: the board holds the grant after the key signed");

    // The Passkeys tab: removing an approver passkey goes through the panel.
    await p.goto(local + "/#passkeys");
    await p.waitForSelector('#passkey-list li:has-text("Second key") button[data-passkey-action=remove]');
    await p.click('#passkey-list li:has-text("Second key") button[data-passkey-action=remove]');
    await p.click("#passkey-list button[data-passkey-action=confirm]");
    await p.waitForSelector("#passkey-approval-panel .approval-code", { timeout: 15_000 });
    const removeSentence = await approvalText(p, "#passkey-approval-panel .approval-what");
    check(removeSentence.includes('Remove the passkey "Second key"'), `approval removal: the panel says what is removed (${removeSentence})`);
    check(byLabel(await callA("bbs_passkeys", {}), "Second key") !== undefined, "approval removal: nothing is removed before the key signs");
    await p.click("#passkey-approval-panel button");
    await p.waitForFunction(() => !document.getElementById("passkey-list")?.textContent?.includes("Second key"), null, { timeout: 15_000 });
    check(byLabel(await callA("bbs_passkeys", {}), "Second key") === undefined, "approval removal: the passkey is gone after the key signed");

    // A synced (backup-eligible) passkey is refused by the board. The page is made to offer every passkey so the
    // browser signs with the synced one; the refusal message comes from the board and is shown as text.
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: approverAuthenticator });
    const syncedAgain = await addAuthenticator(true);
    for (const credential of syncedCredentials) await cdp.send("WebAuthn.addCredential", { authenticatorId: syncedAgain, credential });
    const fourth = await pairStart();
    const askedD = await api(base, human, "bbs_web_pairing_approve", { code: fourth.code }, asCli);
    await p.route("**/api/web/approval/start", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.value.publicKey.allowCredentials = [];
      await route.fulfill({ response: res, json: body });
    });
    await p.goto(askedD.body.value.url.replace("127.0.0.1", "localhost"));
    await p.waitForSelector(".approval button");
    await p.click(".approval button");
    await p.waitForFunction(() => document.querySelector(".approval-state")?.textContent?.startsWith("Refused:"), null, { timeout: 15_000 });
    const refused = await approvalText(p, ".approval-state");
    check(refused.includes("Nothing was approved.") && refused.length > "Refused: Nothing was approved.".length + 10, `approval refused: the board's message is shown as text (${refused})`);
    check((await call2(base, "bbs_approval_status", { approval: askedD.body.value.approval })).status === "pending", "approval refused: the request is still pending");
    check((await p.$$(".approval input, .approval form")).length === 0, "approval refused: no field or form in the panel");
    check(approvalErrors.every((e) => /Failed to load resource/.test(e)), `approval: no console errors besides refused calls (${approvalErrors.join(" | ")})`);
    await ctx.close();
  }
  console.log(`screenshots in ${outDir.startsWith(ROOT) ? outDir.slice(ROOT.length + 1) : "the given directory"}`);
} finally {
  await browser?.close();
  await approvalServer?.stop();
  if (!approvalServer) await server.stop();
  clientServer.closeAllConnections();
  clientServer.close();
  run.cleanup();
}
