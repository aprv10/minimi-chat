# Minimi Chat design

## How it works

Node saves original messages, shortlist versions, and dated source passages in SQLite. History belongs to the browser session. The server resolves dates and message positions directly and reserves space for recent exchanges. It finds older exchanges by keyword and uses a small local model to search by meaning when word matches are weak. Recall answers link to original messages. Deletion also removes saved records, search entries, and incoming citations.

Groq can answer from the conversation, ask for clarification, or use web search, its only tool. Node schedules checks for each item on a saved shortlist. Tavily searches run in parallel and can read up to five pricing pages in one batch. Each turn allows 12 queries across two search rounds and up to three model calls.

The server checks citation references and quoted price amounts. Price comparisons require matching plans, currencies, billing terms and units, regions, and seat rules. Release claims need a quoted date in the requested window. The reply shows what it could verify and which checks came up short.

## Why I built it this way

The original chat shows what was said. Dated source passages show what the evidence supported at each check. The server handles dates and comparisons with explicit rules. The model decides what is relevant and explains it in plain language. SQLite gives reviewers persistent history with a local Node install and two API keys.

## What I considered and rejected

Full history would use more model tokens. Summaries alone could lose an exact question or billing term. Keyword search handles names, and the local model helps with paraphrases. A hosted memory service would add setup and leave date and citation rules to the app. I considered an Agents SDK and chose direct Node code because the app coordinates one tool in a few steps.

## What I’d do with another week

- **Serve multiple users.** Add sign-in and move history and evidence to shared PostgreSQL so several Node processes can serve the same accounts. Enforce account ownership for reads, search, and deletion. Save messages immediately and queue search updates so they survive a restart.
- **Keep replies fast and recoverable.** Limit simultaneous work per account and enforce one budget per provider across processes. Budget model tokens for the full turn and send only the passages needed. Cache public pages briefly by URL and region. Save completed lookups so retries can reuse them. A live run completed ten searches before Groq rate-limited the final answer.
- **Improve and measure accuracy.** Require evidence for factual claims and show uncertainty when sources disagree. Test ordinary chat, ambiguous follow-ups, long and cross-chat recall, current facts, and provider failures. Use known messages and source passages to count wrong recalls and unsupported claims. Test concurrent accounts and deletion during search updates. Measure completion rate and the time within which 95% of replies finish.
