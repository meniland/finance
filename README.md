# Beinleumi local account viewer

A local Docker app that reads First International Bank of Israel (Beinleumi) balances and transactions into a small React dashboard. Credentials stay in `.env` on your machine. If the bank sends an SMS code, the page asks for it and the scrape continues.

Beinleumi login uses the HTTPS client in [`@sergienko4/israeli-bank-scrapers`](https://www.npmjs.com/package/@sergienko4/israeli-bank-scrapers) `10.0.1`. The Investments tab signs in to Extrade Pro with Chromium (`puppeteer-core`) and reads the portfolio from the account responses. The bank package license is PolyForm Noncommercial 1.0.0, which fits personal use on your own accounts.

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
```

Start both services:

```bash
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173). **מצב חשבון** fetches Beinleumi. **השקעות** fetches Extrade Pro. If a username or password is empty, that tab shows a warning and the server does not contact the bank or the broker. While a job is running, the page polls every 2 seconds. If the status is `AWAITING_OTP`, enter the SMS code and submit it.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/scrape` | Starts a scrape. Uses `.env`, or `username`, `password`, and `daysBack` from the JSON body. Returns `{ "status": "STARTED" }`. |
| `GET` | `/api/status` | `IDLE`, `SCRAPING`, `AWAITING_OTP`, `SUCCESS`, or `ERROR`, plus accounts when the run finishes. |
| `POST` | `/api/otp` | Body `{ "otpCode": "123456" }`. Resolves the pending bank SMS prompt. |
| `POST` | `/api/investments/scrape` | Starts an Extrade Pro fetch. Returns `{ "status": "STARTED" }`, or `MISSING_CREDENTIALS` when the Extrade env values are empty. |
| `GET` | `/api/investments/status` | Investments state, plus the portfolio when the run finishes. |
| `POST` | `/api/investments/otp` | Body `{ "otpCode": "123456" }`. Resolves the pending Extrade SMS prompt. |

The backend listens on port `3001`. The Vite dev server on port `5173` proxies `/api` to it.
