const OpenAI = require('openai');
const cfg = require('../config');

const client = new OpenAI({ apiKey: cfg.openai.apiKey });

async function expandQuery(userQuery) {
  const prompt = `You generate e-commerce search expansions for finding exact products across marketplaces.\nReturn concise JSON.\nInput: ${JSON.stringify(userQuery)}\nJSON fields: canonical.brand, canonical.model, canonical.variant, aliases[], negative_terms[], expansions[], site_operators {facebook[], vinted[], depop[], discogs[], google[]}.`;

  const res = await client.chat.completions.create({
    model: cfg.openai.llmModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2
  });

  let data;
  try { data = JSON.parse(res.choices[0].message.content); } catch { data = { expansions: [userQuery], negative_terms: [] }; }
  return data;
}

async function embed(text) {
  const res = await client.embeddings.create({ model: cfg.openai.embeddingsModel, input: text });
  return res.data[0].embedding;
}

module.exports = { expandQuery, embed };
