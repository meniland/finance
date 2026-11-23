import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { getInvestmentsState, startInvestmentsScrape, submitInvestmentsOtp } from './scrapers/extradePro.js';
import { getIbkrState, startIbkrSync } from './scrapers/ibkr.js';
import { getMeitavState, startMeitavScrape, submitMeitavOtp } from './scrapers/meitavTrade.js';
import { getHarelState, startHarelScrape, submitHarelOtp } from './scrapers/harel.js';
import {
  getMeitavPensionState,
  startMeitavPensionScrape,
  submitMeitavPensionOtp,
} from './scrapers/meitavPension.js';
import { getCalState, startCalScrape, submitCalOtp } from './scrapers/visaCal.js';
import { getState, startScrape, submitOtp } from './scraper.js';

const app = express();
const port = Number(process.env.PORT) || 3001;
const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({ origin: origins }));
app.use(express.json({ limit: '32kb' }));
app.use((req, _res, next) => {
  console.info(`${req.method} ${req.path}`);
  next();
});

function sendError(res, error, fallback) {
  res.status(error.status || 500).json({
    error: error.message || fallback,
    message: error.messageText || error.message || fallback,
    errorCode: error.errorCode || '20261116.401030',
  });
}

app.get('/api/status', (_req, res) => {
  res.json(getState());
});

app.post('/api/scrape', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = startScrape({
      username: body.username,
      password: body.password,
      daysBack: body.daysBack,
    });
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the scrape.');
  }
});

app.post('/api/otp', (req, res) => {
  const otpCode = String(req.body?.otpCode ?? '').trim();
  if (!/^\d{4,10}$/.test(otpCode)) {
    res.status(400).json({
      error: 'Enter the 4 to 10 digit SMS code.',
      message: 'Enter the 4 to 10 digit SMS code.',
      errorCode: '20261116.401026',
    });
    return;
  }

  try {
    submitOtp(otpCode);
    res.json({ status: 'ACCEPTED' });
  } catch (error) {
    sendError(res, error, 'Could not submit the SMS code.');
  }
});

app.get('/api/cal/status', (_req, res) => {
  res.json(getCalState());
});

app.post('/api/cal/scrape', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = startCalScrape({ daysBack: body.daysBack });
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the CAL scrape.');
  }
});

app.post('/api/cal/otp', (req, res) => {
  const otpCode = String(req.body?.otpCode ?? '').trim();
  if (!/^\d{4,10}$/.test(otpCode)) {
    res.status(400).json({
      error: 'Enter the 4 to 10 digit SMS code.',
      message: 'Enter the 4 to 10 digit SMS code.',
      errorCode: '20261117.401626',
    });
    return;
  }

  try {
    submitCalOtp(otpCode);
    res.json({ status: 'ACCEPTED' });
  } catch (error) {
    sendError(res, error, 'Could not submit the CAL SMS code.');
  }
});

app.get('/api/investments/status', (_req, res) => {
  res.json(getInvestmentsState());
});

app.post('/api/investments/scrape', (_req, res) => {
  try {
    const result = startInvestmentsScrape();
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the investments scrape.');
  }
});

app.post('/api/investments/otp', (req, res) => {
  const otpCode = String(req.body?.otpCode ?? '').trim();
  if (!/^\d{4,10}$/.test(otpCode)) {
    res.status(400).json({
      error: 'Enter the 4 to 10 digit SMS code.',
      message: 'Enter the 4 to 10 digit SMS code.',
      errorCode: '20261116.401058',
    });
    return;
  }

  try {
    submitInvestmentsOtp(otpCode);
    res.json({ status: 'ACCEPTED' });
  } catch (error) {
    sendError(res, error, 'Could not submit the SMS code.');
  }
});

app.get('/api/investments/ibkr/status', (_req, res) => {
  res.json(getIbkrState());
});

app.post('/api/investments/ibkr/sync', (_req, res) => {
  try {
    const result = startIbkrSync();
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the Interactive Brokers sync.');
  }
});

app.get('/api/investments/meitav/status', (_req, res) => {
  res.json(getMeitavState());
});

app.post('/api/investments/meitav/scrape', (_req, res) => {
  try {
    const result = startMeitavScrape();
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the Meitav Trade scrape.');
  }
});

app.post('/api/investments/meitav/otp', (req, res) => {
  const otpCode = String(req.body?.otpCode ?? '').trim();
  if (!/^\d{4,10}$/.test(otpCode)) {
    res.status(400).json({
      error: 'Enter the 4 to 10 digit SMS code.',
      message: 'Enter the 4 to 10 digit SMS code.',
      errorCode: '20261117.401738',
    });
    return;
  }

  try {
    submitMeitavOtp(otpCode);
    res.json({ status: 'ACCEPTED' });
  } catch (error) {
    sendError(res, error, 'Could not submit the Meitav Trade SMS code.');
  }
});

app.get('/api/pension/harel/status', (_req, res) => {
  res.json(getHarelState());
});

app.post('/api/pension/harel/scrape', (_req, res) => {
  try {
    const result = startHarelScrape();
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the Harel pension scrape.');
  }
});

app.post('/api/pension/harel/otp', (req, res) => {
  const otpCode = String(req.body?.otpCode ?? '').trim();
  if (!/^\d{4,10}$/.test(otpCode)) {
    res.status(400).json({
      error: 'Enter the 4 to 10 digit SMS code.',
      message: 'Enter the 4 to 10 digit SMS code.',
      errorCode: '20261122.401206',
    });
    return;
  }

  try {
    submitHarelOtp(otpCode);
    res.json({ status: 'ACCEPTED' });
  } catch (error) {
    sendError(res, error, 'Could not submit the Harel SMS code.');
  }
});

app.get('/api/pension/meitav/status', (_req, res) => {
  res.json(getMeitavPensionState());
});

app.post('/api/pension/meitav/scrape', (_req, res) => {
  try {
    const result = startMeitavPensionScrape();
    res.status(202).json(result);
  } catch (error) {
    sendError(res, error, 'Could not start the Meitav pension scrape.');
  }
});

app.post('/api/pension/meitav/otp', (req, res) => {
  const otpCode = String(req.body?.otpCode ?? '').trim();
  if (!/^\d{4,10}$/.test(otpCode)) {
    res.status(400).json({
      error: 'Enter the 4 to 10 digit SMS code.',
      message: 'Enter the 4 to 10 digit SMS code.',
      errorCode: '20261123.401221',
    });
    return;
  }

  try {
    submitMeitavPensionOtp(otpCode);
    res.json({ status: 'ACCEPTED' });
  } catch (error) {
    sendError(res, error, 'Could not submit the Meitav pension SMS code.');
  }
});

app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({
      error: 'Request body must be JSON.',
      message: 'Request body must be JSON.',
      errorCode: '20261116.401029',
    });
    return;
  }
  console.error(`unexpected ${error.message}`);
  res.status(500).json({
    error: 'Unexpected server error.',
    message: 'Unexpected server error.',
    errorCode: '20261116.401030',
  });
});

app.listen(port, '0.0.0.0', () => {
  console.info(`backend listening on ${port}`);
});
