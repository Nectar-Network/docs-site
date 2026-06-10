# Nectar Network Documentation

Public docs for [Nectar Network](https://nectarnetwork.fun) — a pooled liquidation protocol for Soroban DeFi on Stellar.

Production site: **https://docs.nectarnetwork.fun**
Protocol repo: **https://github.com/Nectar-Network/nectar-poc**

## Local development

```bash
npm install
npm start
```

Opens `http://localhost:3000`. Hot reload on doc edits.

## Build

```bash
npm run build      # static site → ./build
npm run serve      # serve the built site locally
```

## Deploy

The site is built for Vercel:

```bash
vercel --prod
```

Map the custom domain `docs.nectarnetwork.fun` in the Vercel dashboard, then add a CNAME record in your DNS:

```
docs   CNAME   cname.vercel-dns.com
```

Alternatively, deploy to GitHub Pages:

```bash
GIT_USER=<your-github-username> npm run deploy
```

## Structure

- `docs/` — all Markdown content (this is where you edit)
- `sidebars.ts` — sidebar configuration
- `docusaurus.config.ts` — site metadata, navbar, footer
- `src/css/custom.css` — theme overrides
- `src/pages/index.tsx` — landing page

## Contributing

Open a PR. Style guide:

- Terse, developer-focused. No marketing voice.
- Code blocks must be runnable, not pseudocode.
- Use Docusaurus admonitions (`:::tip`, `:::warning`, `:::danger`) for callouts.
- No emojis in headings.

## License

MIT.
