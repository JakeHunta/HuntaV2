const morgan = require('morgan');

const jsonFormat = (tokens, req, res) => JSON.stringify({
  method: tokens.method(req, res),
  url: tokens.url(req, res),
  status: Number(tokens.status(req, res)),
  contentLength: tokens.res(req, res, 'content-length'),
  responseTimeMs: Number(tokens['response-time'](req, res))
});

module.exports = {
  httpLogger: morgan(jsonFormat)
};
