# Regression Dashboard

Local, static dashboard for release-wise regression results — which journeys passed, which are blocked or at risk, and who owns them. No build step, no backend.

## Running it

Browsers block `fetch()` of local JSON files opened via `file://`. Serve the folder instead (one command, already on macOS):

```bash
cd /Users/manishrai/Expermient_project/RegressionDashboard
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Updating results

Edit [data/regression.json](data/regression.json). Each release is an object with an `id`, `name`, `date`, and a `journeys` array. Each journey has:

```json
{
  "name": "Insurance Verification",
  "status": "At Risk",
  "owner": "Arjun Mehta",
  "notes": "Short reason, shown in the table and the email summary.",
  "scenarios": { "total": 28, "passed": 24, "failed": 2, "blocked": 0, "skipped": 2 }
}
```

`status` must be one of: `Pass`, `Fail`, `Blocked`, `At Risk` — this drives the badge and row sort order. `scenarios` is the underlying test-case breakdown for that journey; it drives the scenario pass %, the mini bar in the table, and the per-journey trend chart. The two can disagree on purpose — e.g. a journey can be mostly-passing scenario-wise but still marked `At Risk` because of one flaky environment issue.

To add a new release, add a new object to the `releases` array, using the **same journey names** as previous releases for any journey you want trend history on — it'll show up in the release dropdown and the trend charts automatically, sorted by date.

## What you get on the dashboard

- **Stat cards**: journey counts by status, journey-level pass rate, and scenario-level pass rate for the selected release.
- **Release trend chart**: scenario pass rate across all releases, so you can see if regression health is improving or slipping.
- **Journey table**: status badge + a scenario mini-bar (pass/fail/blocked/skipped) per journey.
- **Journey detail** (click any row): full scenario breakdown and that journey's pass-rate trend across past releases — useful for showing "this journey has been degrading for two releases" rather than just "it failed this time."

### Growth path
- **Now:** hand-edit `regression.json` after each regression cycle.
- **Next:** write a small script that exports from Zephyr/Jira/TestRail into this same JSON shape.
- **Later:** have the CI regression suite write `regression.json` directly after each run.

None of the dashboard or email code needs to change for those steps — they all just produce the same JSON shape.

## Sharing with leadership

Click **Generate Leadership Summary** on the dashboard. It renders an email-safe static HTML table (release stats + per-journey status, color-coded) for the currently selected release. Click **Copy for Email**, then paste directly into Outlook/Gmail — the table and colors carry over because it's plain HTML/inline styles, not the dashboard's JS/CSS (which email clients strip).

If you want leadership to also be able to click into the live dashboard, host this folder somewhere reachable (internal static hosting, or even just run the `http.server` command on a machine they can reach) and include that link in the email alongside the summary table.
