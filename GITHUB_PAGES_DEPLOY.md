# GitHub Pages one-click deployment

This repository is configured for automatic deployment with GitHub Actions.

## What is already done

- Added workflow: .github/workflows/deploy-pages.yml
- Added .nojekyll so static files are served directly
- Added build script: scripts/build_pages.py
- Deployment triggers on every push to main
- Manual deploy button is available in Actions (workflow_dispatch)

## Built-in cache busting

- During deployment, scripts/build_pages.py builds a .site folder.
- The build rewrites all local .css and .js references in HTML to include a content hash query string.
- Example output style: css/style.css?v=9f0ac2b31a
- Result: browser always fetches new assets after changes, so no manual version bump is needed.

## One-time setup in GitHub

1. Open repository Settings.
2. Go to Pages.
3. Under Build and deployment, set Source to GitHub Actions.
4. Save.

## One-click release flow

1. Commit and push to main.
2. GitHub Actions builds and deploys automatically.
3. Open the site URL from Actions or Settings -> Pages.

## Default site URL

https://amyli999.github.io/MO-QA-Weekly-DDS/

## Custom domain binding (dds.xxx.com)

Use either method below.

### Method A: Repository variable (recommended)

1. Open Settings -> Secrets and variables -> Actions -> Variables.
2. Add variable name: PAGES_CUSTOM_DOMAIN
3. Set value to your domain, for example: dds.xxx.com
4. Save and push once to main.

The workflow writes CNAME automatically during deploy.

### Method B: Commit a CNAME file

1. Copy CNAME.example to CNAME.
2. Replace content with your real domain (single line).
3. Commit and push.

## DNS settings required at your domain provider

For subdomain dds.xxx.com:

- Add CNAME record:
	- Host/Name: dds
	- Target/Value: amyli999.github.io

Then wait for DNS propagation.

## HTTPS

After DNS is correct, enable Enforce HTTPS in GitHub Pages settings.

## Project note

If strict origin checks are enabled in backend services later, add the final Pages/custom domain to backend allowlists.
