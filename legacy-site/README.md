# end-gfw.com legacy site on Cloudflare Workers (branch `v1`)

Replaces the Express server (`src/proxy.js`) that ran in the end-gfw-web container on
the main server. Same URLs and responses.

- **Static pages**: read from `main:public/temp` on GitHub at request time (edge cache
  5 min), so editing the site on `main` still goes live without a deploy.
- **GitHub data routes** (no secrets): `/news-data`, `/tweet`, `/vpn-data`, `/ee-data`,
  `/github`, `/youtube`, `/obfs4`, `/wiki`, `/nitter`, `/searchx`, `/pdf`,
  `/download-app/*`, `/download-pdf/*`, `/news-resource/*`, `/resource/*`.
- **Server-rendered pages**: `/tweet-page`, `/tweet-page-7`, `/news-page`,
  `/search-tweet-page` use the same Handlebars views (`src/views`), precompiled by
  `npm run build` (Workers cannot compile templates at run time).
- **Mirror registry**: `/node` (a node registers its own IPv4; TCP check) and `/host`,
  stored in KV `end-gfw-legacy-mirrors`; hourly Cron Trigger drops mirrors that are not
  reachable from China and adds the node from cn-news `end-gfw-together-ss`.
- **Routes needing secrets or MongoDB** go to the Lambda `end-gfw-legacy-api`
  (`legacy-site/lambda/`, settings from Parameter Store `/end-gfw/web/*`):
  `/ss-key`, `/ss-key1`, `/renew-plan`, `/renew-email`, `/apple-account`,
  `/ip-check`, `/url-check/*`, `/search-tweet`, `/event`.
- Not carried over: the tweet-queue API (`/api/add-url`, `/api/urls`, …) that used the
  server's sqlite file.

Deploy: push to `v1` (GitHub Actions, repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`), or `npm run deploy` here after `wrangler login`.

Lambda deploy: `cd lambda && npm install --omit=dev && zip -qr ../../legacy-api.zip .`,
upload to `s3://xrayr-next-deploy-586861818619/end-gfw-legacy-api/` and
`aws lambda update-function-code --function-name end-gfw-legacy-api ...`.

Switching end-gfw.com: add to `wrangler.toml`

    [[routes]]
    pattern = "end-gfw.com/*"
    zone_name = "end-gfw.com"

and deploy. The route takes over from the Cloudflare Tunnel without touching DNS;
removing it again sends traffic back to the tunnel (rollback).
