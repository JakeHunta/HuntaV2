// Minimal smoke test; recommend adding nock fixtures for stability
const request = require('node:http');

describe('search integration', () => {
  it('returns a basic response shape', async () => {
    const { search } = require('../src/services/searchService');
    const out = await search({ search_term: 'test', sources: [] });
    expect(out).toHaveProperty('items');
    expect(out).toHaveProperty('expansion');
  });
});
