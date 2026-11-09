# Faculty Leave & Travel Calendar – Cloudflare Worker

Structure: public/index.html (the site), src/worker.js (API), wrangler.toml (config).
Viewer page: https://YOUR-SITE/#viewer   |   Admin page: https://YOUR-SITE/#admin

## Deploy (Wrangler)
1. npm i -g wrangler && wrangler login
2. wrangler kv namespace create REQUESTS      -> copy the id into wrangler.toml
3. wrangler deploy
4. Set the password:  wrangler secret put ADMIN_PASSWORD

## Or in the dashboard
Workers & Pages -> faculty-calendar -> Settings -> Variables and Secrets -> Add
Type: Secret, Name: ADMIN_PASSWORD, Value: your password -> Deploy.
(Edit the same way anytime. Cloudflare hides a secret's value after saving, so keep a copy in your password manager.)
Do NOT add ADMIN_PASSWORD under [vars] in wrangler.toml.
