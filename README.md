# Beinleumi local account viewer

A local Docker app that reads First International Bank of Israel (Beinleumi) balances and transactions into a small React dashboard. Credentials stay in `.env` on your machine. If the bank sends an SMS code, the page asks for it and the scrape continues.

Beinleumi and Visa CAL use the HTTPS client in [`@sergienko4/israeli-bank-scrapers`](https://www.npmjs.com/package/@sergienko4/israeli-bank-scrapers) `10.0.1` (Visa CAL is API-direct and does not launch Chromium). The Investments tab can pull Extrade Pro with Chromium (`puppeteer-core`) and Interactive Brokers through the official Flex Web Service REST API (no browser). The bank package license is PolyForm Noncommercial 1.0.0, which fits personal use on your own accounts.

A remembered device id is stored in the `auth-state` Docker volume. Later runs may skip the SMS step. The bank can still ask for a code, and the page handles that when it happens. If login keeps failing after a password change, remove that volume with `docker compose down -v` and sign in again.

## Run

```bash
cp .env.example .env
```

Edit `.env` and set your Beinleumi internet username and password:

```bash
BANK_USERNAME=your-username
BANK_PASSWORD=your-password
DAYS_BACK=30
PORT=3001
EXTRADE_LOGIN_URL=https://extradepro.xnes.co.il/login
EXTRADE_USERNAME=your-extrade-username
EXTRADE_PASSWORD=your-extrade-password
IBKR_FLEX_TOKEN=your-flex-token
IBKR_QUERY_ID=your-flex-query-id
CAL_USERNAME=your-cal-username
CAL_PASSWORD=your-cal-password
```

Start both services:

```bash
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173). **מצב חשבון** has Beinleumi and כאל (Visa CAL). **השקעות** has Extrade Pro and Interactive Brokers. If required env values are empty, that provider shows a warning and the server does not contact the bank or the broker. While a job is running, the page polls every 2 seconds. If a status is `AWAITING_OTP`, enter the SMS code and submit it.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/scrape` | Starts a Beinleumi scrape. Uses `.env`, or `username`, `password`, and `daysBack` from the JSON body. Returns `{ "status": "STARTED" }`. |
| `GET` | `/api/status` | Beinleumi state: `IDLE`, `SCRAPING`, `AWAITING_OTP`, `SUCCESS`, or `ERROR`, plus accounts when the run finishes. |
| `POST` | `/api/otp` | Body `{ "otpCode": "123456" }`. Resolves the pending Beinleumi SMS prompt. |
| `POST` | `/api/cal/scrape` | Starts a Visa CAL scrape. Returns `{ "status": "STARTED" }`, or `MISSING_CREDENTIALS` when CAL env values are empty. |
| `GET` | `/api/cal/status` | CAL state, plus card accounts when the run finishes. |
| `POST` | `/api/cal/otp` | Body `{ "otpCode": "123456" }`. Resolves a pending CAL SMS prompt if one appears. |
| `POST` | `/api/investments/scrape` | Starts an Extrade Pro fetch. Returns `{ "status": "STARTED" }`, or `MISSING_CREDENTIALS` when the Extrade env values are empty. |
| `GET` | `/api/investments/status` | Extrade investments state, plus the portfolio when the run finishes. |
| `POST` | `/api/investments/otp` | Body `{ "otpCode": "123456" }`. Resolves the pending Extrade SMS prompt. |
| `POST` | `/api/investments/ibkr/sync` | Starts an Interactive Brokers Flex sync. Returns `{ "status": "STARTED" }`, or `MISSING_CREDENTIALS` when the IBKR env values are empty. |
| `GET` | `/api/investments/ibkr/status` | IBKR sync state, plus the Flex portfolio when the run finishes. |

The backend listens on port `3001`. The Vite dev server on port `5173` proxies `/api` to it.
