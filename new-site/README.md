# v2.end-gfw.com

Cloudflare Worker + static pages. No server, no secrets in the Worker.

- `pages/*.html` + `partials/` → `npm run build` → `public/*.html` (built files are committed)
- `public/assets/` CSS/JS, `public/images/` app icons, `public/_headers` security headers (CSP)
- `src/worker.js`: `/api/*` and `/pay/*` go to xrayr-next through its public
  subscription domains (`XN_BASES` in `wrangler.toml`); news, tweets and the app
  list come from public JSON on GitHub; `/download-app/*`, `/download-pdf/*`,
  `/news-resource/*` stream GitHub files with edge caching

## Deploy

    cd new-site && npm install && npm run deploy        # needs `wrangler login` or CLOUDFLARE_API_TOKEN

or push to the `v2` branch with the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repository
secrets set (`.github/workflows/new-site.yml`). The end-gfw.com zone must be in the
same Cloudflare account; `v2.end-gfw.com` is attached as a Worker custom domain.

## xrayr-next side

- `SITE_ORIGINS=https://v2.end-gfw.com` lets checkout return buyers to this site
- once live, `SITE_URL` / `PAY_CANCEL_URL` can point here

## Local

    npm run dev   # http://127.0.0.1:8787
