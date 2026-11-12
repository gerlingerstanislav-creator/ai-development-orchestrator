# QA tool handbook (read only the sections relevant to the task)

This file documents executable commands. It is not another task or a source of requirements.
The current approved task and its acceptance criteria take priority. The Runner verifies
evidence against execution receipts and actual browser assertions.

## Case evidence and command receipts

Wrap a real command for a required test-case with its exact case ID:

```sh
node /opt/codex-runner/qa-exec.mjs case CASE_ID -- node --test
```

Additional checks use a stable check ID and must return that identifier
as `checks[].evidenceId`:

```sh
node /opt/codex-runner/qa-exec.mjs check npm-test -- npm test
```

A failed command is NOT automatically a product defect: distinguish assertion failures
from missing dependencies, tool outages and configuration failures. Report exact commands
and outcomes. Do not claim a test passed without an execution receipt. For checks
not performed use `not_run` and empty command/evidenceId.

## Browser / visual checks (only when the browser is available)

The browser runs in a separate isolated Chromium service, not inside the QA sandbox.
Start it and check the returned `path`; for standalone pages pass their actual filename:

```sh
node /opt/codex-runner/browser-client.mjs start
node /opt/codex-runner/browser-client.mjs start /example.html
node /opt/codex-runner/browser-client.mjs goto /example.html
node /opt/codex-runner/browser-client.mjs viewport 390 844
node /opt/codex-runner/browser-client.mjs inspect '.line'  # discover real DOM and computed geometry/colors
node /opt/codex-runner/browser-client.mjs assert --case CASE_ID 'document.querySelectorAll(".item").length===8'
node /opt/codex-runner/browser-client.mjs assert --check visual-smoke 'document.readyState==="complete"'
node /opt/codex-runner/browser-client.mjs screenshot
```

Also supported: `click CSS_SELECTOR`, `fill CSS_SELECTOR VALUE`, `count CSS_SELECTOR`,
`text CSS_SELECTOR` and `restart`. After dependencies or a build changed the served
page, run `restart` and `start` again. Screenshots alone do not establish acceptance;
each visual case needs a browser assertion with the exact case ID. Use representative
mobile/desktop viewport sizes when responsiveness is a requirement. Do not invent
required geometry, mockups or breakpoints that the specification never specified.
If the browser service cannot start after one reasonable retry, report exactly which
visual checks remain blocked and what error occurred.

## Project-specific test commands (choose only a relevant section)

Node: if `package.json` declares tests, use the existing script; if lock file is
present install with `npm ci` when needed. If no test script exists, use a small
task-specific `node --test` assertion or an isolated HTTP/API check. Bare HTML projects
need not have node_modules.

Python: use `python3 -m pytest` for existing tests. If dependencies are needed,
create a local `python3 -m venv .venv` and install into it from allowed PyPI.
Only download from the approved npm/PyPI registries. No global packages.

Integration: replace unavailable external services and paid APIs with local test
doubles. Use a controllable clock for scheduled jobs, rather than waiting for
real-world delays. Do not require implementations from unrelated unfinished tasks.

## Network and isolation

No Docker socket, production secrets, GitHub write access or arbitrary internet
access is available. Local HTTP test servers on 127.0.0.1 are permitted. In this
Codex sandbox, loopback Node clients require explicit proxy bypass:

```sh
env NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 npm test
```

End local servers after a test. Network installation failures are environment
blockers, not application defects. A Codex CLI failure is not proof that the
browser, test or other tool is absent.
