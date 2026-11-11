# Minimi Chat

A chat assistant that can find an earlier conversation, check the web, and explain what has changed. It keeps chats and their sources in a local SQLite database.

## Run locally

Use Node.js 24.14 or newer. Install the project dependencies.

```sh
npm install
```

Copy `.env.example` to `.env` and add keys from [Groq](https://console.groq.com/keys) and [Tavily](https://app.tavily.com/). The default Groq model is `openai/gpt-oss-120b`. Long comparisons can reach Groq’s free rate limit while the app is preparing the final answer. If that happens, the app shows the sources it found so far.

```sh
npm run dev
```

Open the localhost address printed in the terminal. The app builds its Tailwind CSS at startup. If you change the styles while the server is running, run `npm run build:css` and refresh the browser.

Search by meaning runs on your computer. On first use the app downloads a public model of about 34 MB to `data/models`. This needs no API key. Date, position, and keyword lookups are available while the model downloads or if the download fails.

## Try a follow-up

1. Ask the assistant to compare the current monthly prices of two services for a specific region and plan. Ask it to make a shortlist.
2. Start a new chat in the same browser. Ask what you asked today or ask whether the earlier prices still hold.
3. Open a numbered citation to see the saved passage or earlier message. Restart the app and reopen the chat to check that it persists.

The database defaults to `data/minimi.sqlite`. The browser session cookie keeps chat histories separate. Use the same localhost address and browser to access your earlier chats. Hover over a chat in the sidebar to delete it and remove it from recall. The delete button is also available by keyboard and on touch screens. See [DESIGN.md](DESIGN.md) for the architecture and limits.
