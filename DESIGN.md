# Minimi Chat design

## How it works

Node saves original messages, shortlist versions, and dated source passages in SQLite. Each browser session has its own history. The server resolves dates and positions such as “my first question” directly. It reserves space for recent exchanges, then looks for older matches by keyword and, when word matches are weak, by meaning using a small local model. Answers link to original messages. Deleting a chat removes its saved records, search entries, and incoming citations.

Groq decides whether to answer, clarify, or use web search. For a saved shortlist, Node schedules the requested checks for each item. Tavily searches run in parallel. A single batch can read up to five vendor pricing pages. The model sees one web search capability. A turn allows up to 12 queries, two search rounds, and three model calls.

The server checks that citations point to retrieved material and that price amounts appear in their passages. Comparisons require matching plan, currency, billing unit and terms, region, and seat rules. Release claims need a quoted date in the requested window. Missing evidence stays visible in the answer. Successful findings survive a failed lookup.

## Why I built it this way

A question about what changed needs both the earlier discussion and current evidence. Keeping the original messages and passages lets the user see where each claim came from. The server handles dates and price comparisons with explicit rules. The model handles wording and decides which evidence is relevant. SQLite gives the reviewer persistent history with a local Node install and two API keys.

## What I considered and rejected

Sending the full history each turn would spend more of the model’s quota. Relying on summaries alone could lose an exact question or billing term. Keyword search is fast for product names, and the local model helps when the user paraphrases. A hosted memory service would add setup and still leave date and citation rules to the app. An Agents SDK would add another layer to a turn with one tool and a small number of steps.

## What I’d do with another week

I’d build a set of complete test conversations with the expected earlier message and the source needed to support each answer. I’d measure correct recall, wrong matches, supported claims, and reply time. The 120-turn recall check passed. In a live five-CRM check, Tavily completed ten searches before Groq reached its rate limit on the final answer. I’d use those cases to reduce the total model tokens per turn and let a retry reuse the search results. I’d also measure recall while very old chats are still being prepared for search and track vendor pages that repeatedly omit comparable prices.
