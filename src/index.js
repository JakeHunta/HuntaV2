const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { httpLogger } = require('./utils/logger');
const cfg = require('./config');
const rateLimit = require('./middlewares/rateLimit');

const searchRoute = require('./routes/search');
const healthRoute = require('./routes/health');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(httpLogger);
app.use(rateLimit);

app.get('/', (req, res) => res.json({ name: 'Hunta Backend v2', env: cfg.env }));
app.use('/search', searchRoute);
app.use('/health', healthRoute);

app.use((err, req, res, next) => {
  console.error(err); // keep simple; wire to logger if desired
  res.status(500).json({ error: 'Internal error' });
});

app.listen(cfg.port, () => {
  console.log(`Hunta backend running on :${cfg.port}`);
});
