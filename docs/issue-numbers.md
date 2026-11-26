<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Pre-publication issue numbers

This project was developed in a private repository before publication. Code comments and
documents refer to that repository's tracker: `issue #N` with N up to 116, and labels such
as `B26` (a backlog item), `M6a` (a milestone) or `G4` (a post-v1 change). Those numbers
are not this repository's issue numbers. The table below maps the pre-publication issues
that are still open to their issues here; every number not listed is closed history.

<!-- mapping rows are added below by the maintainer -->
| Pre-publication number | This repository | Title |
| ---------------------- | --------------- | ----- |
| 21 | #1 | B1: Decide whether a coordinator may set another user's subscription level |
| 23 | #2 | B14: Deployment checks for the audit export and cold storage (Google and R2) |
| 25 | #3 | B16: CLI gaps against the CLI conventions (exit codes, dry run, session flag) |
| 26 | #4 | B21: Recheck the deprecated MCP `Server` class on each SDK upgrade |
| 29 | #5 | B41: Add a retired status for retired human admins |
| 34 | #6 | B53: Add admin_topic_purge to delete a cold topic for good |
| 35 | #7 | B54: Tune the archive scan's audit rows and cold-due query |
| 36 | #8 | B58: Check whether a Codex subagent starts its own adapter with the same token |
| 37 | #9 | B59: Check the G4 inbox ring with the real adapter in VS Code and the desktop app |
| 48 | #10 | Possible: several boards in one deployment, one per hostname |
| 53 | #11 | Possible: encrypted boards the host cannot read (optional, per board) |
| 63 | #12 | Possible: a per-topic note on each member, for what an agent can do in that project |
| 70 | #13 | Scoped, shorter-lived handles for sub-agents (idea from Kody profiles) |
| 72 | #14 | Show which sessions are waiting on a person, and why |
| 85 | #15 | ChatGPT connector cannot pass the session ID returned by bbs_join |
| 89 | #16 | Passkeys tab: an 'Add a security key' action that asks for a hardware key |
| 91 | #17 | Gate admin_* actions behind a passkey approval |
| 92 | #18 | A Decline button on the approving panel |
| 93 | #19 | List pending approval requests in the web view |
| 94 | #20 | Wake-on-demand: a wake that starts a session when none is running |
| 95 | #21 | Define the coordinator as an agent type |
| 99 | #22 | A topic is a workstream; give each one a standing |
| 101 | #23 | Instructing work by voice: options and authority |
| 106 | #24 | Web view: show mentions of the person in topics they have not joined |
| 111 | #25 | Inbox: an unread wake item beyond the subscription cap is not rung again |
| 114 | #26 | Retiring a session handle by hand leaves its adapter socket open |
| 115 | #27 | A session handle's calls update its parent's last seen |
